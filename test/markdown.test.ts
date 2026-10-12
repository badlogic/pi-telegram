import assert from "node:assert/strict";
import { test } from "node:test";

import { markdownToTelegramHtml, telegramVisibleLength } from "../markdown.ts";

const ALLOWED_TAGS = new Set([
	"b",
	"strong",
	"i",
	"em",
	"u",
	"ins",
	"s",
	"strike",
	"del",
	"span",
	"tg-spoiler",
	"a",
	"code",
	"pre",
	"blockquote",
	"tg-emoji",
	"tg-time",
]);

/** Every tag the converter emits must be one Telegram accepts, and must be balanced. */
function assertTelegramSafe(html: string): void {
	const stack: string[] = [];
	const tagPattern = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^>]*)?)>/g;
	let stripped = "";
	let cursor = 0;
	for (const match of html.matchAll(tagPattern)) {
		stripped += html.slice(cursor, match.index);
		cursor = (match.index ?? 0) + match[0].length;
		const closing = match[1] === "/";
		const name = (match[2] ?? "").toLowerCase();
		assert.ok(ALLOWED_TAGS.has(name), `tag <${name}> is not supported by Telegram`);
		if (closing) {
			assert.equal(stack.pop(), name, `unbalanced </${name}> in:\n${html}`);
		} else {
			stack.push(name);
		}
	}
	stripped += html.slice(cursor);
	assert.deepEqual(stack, [], `unclosed tags in:\n${html}`);
	assert.ok(!stripped.includes("<"), `unescaped '<' outside a tag in:\n${html}`);
	assert.ok(
		!stripped.replace(/&(?:amp|lt|gt|quot);/g, "").includes("&"),
		`unescaped '&' in:\n${html}`,
	);
}

function convert(markdown: string): string {
	const html = markdownToTelegramHtml(markdown);
	assertTelegramSafe(html);
	return html;
}

test("inline emphasis, code and strikethrough", () => {
	assert.equal(convert("**bold** and *italic* and ~~gone~~"), "<b>bold</b> and <i>italic</i> and <s>gone</s>");
	assert.equal(convert("__bold__ and _italic_"), "<b>bold</b> and <i>italic</i>");
	assert.equal(convert("run `npm test` now"), "run <code>npm test</code> now");
	assert.equal(convert("**bold with `code` inside**"), "<b>bold with <code>code</code> inside</b>");
	assert.equal(convert("**bold *italic* bold**"), "<b>bold <i>italic</i> bold</b>");
});

test("markdown that must stay literal", () => {
	assert.equal(convert("file_name_here and other_name_end"), "file_name_here and other_name_end");
	assert.equal(convert("2*3*4 = 24"), "2*3*4 = 24");
	assert.equal(convert("a ** b"), "a ** b");
	assert.equal(convert("unclosed **bold"), "unclosed **bold");
});

test("html special characters are escaped", () => {
	assert.equal(convert("a < b & c > d"), "a &lt; b &amp; c &gt; d");
	assert.equal(convert("<script>alert(1)</script>"), "&lt;script&gt;alert(1)&lt;/script&gt;");
	assert.equal(convert("`<T>&`"), "<code>&lt;T&gt;&amp;</code>");
});

test("links are kept only for safe schemes", () => {
	assert.equal(
		convert("see [the docs](https://example.com/a?b=1&c=2)"),
		'see <a href="https://example.com/a?b=1&amp;c=2">the docs</a>',
	);
	assert.equal(convert("[mail](mailto:me@example.com)"), '<a href="mailto:me@example.com">mail</a>');
	assert.equal(convert("[x](javascript:alert(1))"), "[x](javascript:alert(1))");
	assert.equal(convert("![cap](https://example.com/i.png)"), '<a href="https://example.com/i.png">cap</a>');
});

test("links cannot break out of the href attribute", () => {
	const html = convert('[x](https://example.com/"onmouseover="alert(1))');
	assert.ok(!html.includes('onmouseover="alert'), html);
	assertTelegramSafe(html);
});

test("headings, rules and blockquotes", () => {
	assert.equal(convert("# Title\n\n## Sub **bold**"), "<b>Title</b>\n\n<b>Sub <b>bold</b></b>");
	assert.equal(convert("---"), "———");
	assert.equal(convert("> quoted line\n> second"), "<blockquote>quoted line\nsecond</blockquote>");
});

test("lists become text markers", () => {
	assert.equal(convert("- one\n- two\n  - nested"), "• one\n• two\n  • nested");
	assert.equal(convert("1. first\n2) second"), "1. first\n2. second");
});

test("fenced code keeps its language and content verbatim", () => {
	assert.equal(
		convert("```python\nprint('hi <&>')\n```"),
		'<pre><code class="language-python">print(\'hi &lt;&amp;&gt;\')</code></pre>',
	);
	assert.equal(convert("```\nplain\n```"), "<pre>plain</pre>");
	assert.equal(convert("~~~js\nlet a = 1;\n~~~"), '<pre><code class="language-js">let a = 1;</code></pre>');
	// Markdown inside a fence must survive untouched.
	assert.equal(convert("```\n**not bold**\n```"), "<pre>**not bold**</pre>");
});

test("an unterminated fence still produces valid html (streaming previews)", () => {
	const html = convert("text\n\n```js\nconst a = 1;");
	assert.equal(html, "text\n\n<pre><code class=\"language-js\">const a = 1;</code></pre>");
});

test("an unterminated inline span does not throw", () => {
	for (const partial of ["**bo", "`co", "[link](http", "text **bold** more **par"]) {
		assertTelegramSafe(markdownToTelegramHtml(partial));
	}
});

test("pipe tables render as aligned monospace blocks", () => {
	const table = ["| name | note |", "| --- | --- |", "| a | short |", "| longer | b |"].join("\n");
	const html = convert(table);
	assert.equal(html, "<pre>name    note\na       short\nlonger  b</pre>");
});

test("table alignment accounts for wide characters", () => {
	const table = ["| 名称 | note |", "| --- | --- |", "| ab | x |"].join("\n");
	// "名称" is four columns wide, so "ab" still needs two extra spaces to align.
	assert.equal(convert(table), "<pre>名称  note\nab    x</pre>");
});

test("tables drop inline markup that cannot nest inside pre", () => {
	const table = ["| a | b |", "| --- | --- |", "| **bold** | `code` |"].join("\n");
	assert.equal(convert(table), "<pre>a     b\nbold  code</pre>");
});

test("tables are recognised without a separator row too", () => {
	assert.equal(convert("| a | b |\n| c | d |"), "<pre>a  b\nc  d</pre>");
	// A lone pipe row is prose, not a table.
	assert.equal(convert("| a | b |"), "| a | b |");
});

test("telegramVisibleLength counts what Telegram counts", () => {
	assert.equal(telegramVisibleLength("plain"), 5);
	assert.equal(telegramVisibleLength("<b>bold</b>"), 4);
	assert.equal(telegramVisibleLength("a &lt; b &amp; c"), 9);
	assert.equal(telegramVisibleLength('<pre><code class="language-js">x</code></pre>'), 1);
	// Telegram counts code points: an astral emoji is one character, not two UTF-16 units.
	assert.equal(telegramVisibleLength("😀"), 1);
});

test("blank line runs collapse and trailing whitespace is dropped", () => {
	assert.equal(convert("one\n\n\n\ntwo"), "one\n\ntwo");
	assert.equal(convert("\n\nleading\n\n"), "leading");
	assert.equal(convert("one\n\ntwo\n"), "one\n\ntwo");
	assert.equal(convert(""), "");
});

test("a realistic assistant reply converts end to end", () => {
	const reply = [
		"## Summary",
		"",
		"Found the bug in `sendRichOrPlainText()` — it fell back to plain text.",
		"",
		"1. **Rich** messages render Markdown",
		"2. **Plain** fallback does *not*",
		"",
		"```ts",
		"await callTelegram(\"sendMessage\", { chat_id, text });",
		"```",
		"",
		"| path | status |",
		"| --- | --- |",
		"| index.ts | patched |",
		"",
		"> See [the docs](https://core.telegram.org/bots/api) for the tag list.",
	].join("\n");

	const html = convert(reply);
	assert.ok(html.includes("<b>Summary</b>"));
	assert.ok(html.includes("<code>sendRichOrPlainText()</code>"));
	assert.ok(html.includes('<pre><code class="language-ts">await callTelegram("sendMessage", { chat_id, text });</code></pre>'));
	assert.ok(html.includes('<a href="https://core.telegram.org/bots/api">the docs</a>'));
	assert.ok(html.includes("<blockquote>"));
	assert.ok(!html.includes("**"));
	assert.ok(!html.includes("```"));
});
