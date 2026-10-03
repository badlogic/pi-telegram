/**
 * Markdown -> Telegram `parse_mode: "HTML"` conversion.
 *
 * Telegram rich messages render Markdown natively, but they are not available for
 * every bot (and can be turned off with `richMessages: false`). The plain-text
 * fallback path used to hand Telegram raw Markdown, which it shows verbatim:
 * `**bold**`, `| a | b |` tables and ``` fences all leaked into the chat.
 *
 * This module converts the subset of Markdown that pi replies actually use into
 * the HTML tags the Bot API supports, so formatting survives the fallback.
 *
 * The conversion is deliberately tolerant. Streaming previews hand it partial
 * Markdown, so an unterminated code fence is closed, and unmatched inline
 * delimiters stay literal instead of throwing a parse error that would drop the
 * reply. Anything this module gets wrong degrades to plain text, never to a
 * lost message: callers retry without `parse_mode` when Telegram rejects HTML.
 *
 * Supported tags (Bot API "HTML style"): b, strong, i, em, u, ins, s, strike,
 * del, span.tg-spoiler, tg-spoiler, a[href], tg-emoji, tg-time, code, pre,
 * code[class=language-*] inside pre, blockquote (incl. `expandable`).
 * Telegram has no list or table tags, so both are rendered as text.
 */

const FENCE_PATTERN = /^\s*(`{3,}|~{3,})\s*([A-Za-z0-9_+#.-]*)\s*$/;
const HEADING_PATTERN = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const BLOCKQUOTE_PATTERN = /^\s{0,3}>\s?(.*)$/;
const LIST_PATTERN = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const HR_PATTERN = /^\s{0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/;
const TABLE_ROW_PATTERN = /^\s*\|(.+)\|\s*$/;
const TABLE_SEPARATOR_PATTERN = /^\s*\|?[\s:|-]+\|[\s:|-]*$/;
const SAFE_URL_PATTERN = /^(?:https?:|mailto:|tg:)/i;

/** Inline constructs, tried left to right. Group numbers are documented per branch. */
const INLINE_SOURCE = [
	"(`+)([\\s\\S]*?)\\1", // 1,2: code span
	"!?\\[([^\\]]*)\\]\\(\\s*<?([^)\\s>]+)>?(?:\\s+\"[^\"]*\")?\\s*\\)", // 3,4: link or image
	"(?<![\\w*])\\*\\*(?=\\S)([^\\n]+?)(?<=\\S)\\*\\*(?![\\w*])", // 5: bold **
	"(?<![\\w_])__(?=\\S)([^\\n]+?)(?<=\\S)__(?![\\w_])", // 6: bold __
	"~~(?=\\S)([^\\n]+?)(?<=\\S)~~", // 7: strikethrough
	"(?<![\\w*])\\*(?=\\S)([^*\\n]+?)(?<=\\S)\\*(?![\\w*])", // 8: italic *
	"(?<![\\w*])_(?=\\S)([^_\\n]+?)(?<=\\S)_(?![\\w*])", // 9: italic _
].join("|");

/**
 * A fresh pattern per call. `inlineToTelegramHtml` recurses into emphasis content, and
 * a shared global regex would let the inner call clobber the outer call's `lastIndex`,
 * which makes the outer scan restart forever.
 */
function createInlinePattern(): RegExp {
	return new RegExp(INLINE_SOURCE, "g");
}

const MAX_INLINE_DEPTH = 8;
const MAX_TABLE_COLUMNS = 20;

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtmlAttribute(text: string): string {
	return escapeHtml(text).replace(/"/g, "&quot;");
}

/** Language names end up in a class attribute, so keep them to a safe alphabet. */
function sanitizeLanguage(language: string): string | undefined {
	const cleaned = language.trim().toLowerCase().replace(/[^a-z0-9_+#.-]/g, "");
	return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Approximate terminal width of a string, counting East Asian wide and emoji
 * code points as two columns. Used to align table cells inside `<pre>`.
 */
function displayWidth(text: string): number {
	let width = 0;
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		const wide =
			(code >= 0x1100 && code <= 0x115f) ||
			(code >= 0x2e80 && code <= 0x303e) ||
			(code >= 0x3041 && code <= 0x33ff) ||
			(code >= 0x3400 && code <= 0x4dbf) ||
			(code >= 0x4e00 && code <= 0x9fff) ||
			(code >= 0xa000 && code <= 0xa4cf) ||
			(code >= 0xac00 && code <= 0xd7a3) ||
			(code >= 0xf900 && code <= 0xfaff) ||
			(code >= 0xfe30 && code <= 0xfe6f) ||
			(code >= 0xff00 && code <= 0xff60) ||
			(code >= 0xffe0 && code <= 0xffe6) ||
			(code >= 0x1f300 && code <= 0x1faff) ||
			(code >= 0x20000 && code <= 0x3fffd);
		width += wide ? 2 : 1;
	}
	return width;
}

function padTo(text: string, width: number): string {
	const padding = width - displayWidth(text);
	return padding > 0 ? text + " ".repeat(padding) : text;
}

/** Strip inline Markdown so text can be embedded where nested tags are not allowed. */
function stripInlineMarkdown(text: string): string {
	return text
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/(`+)([\s\S]*?)\1/g, "$2")
		.replace(/\*\*|__|~~/g, "")
		.replace(/(?<![\w*])\*([^*\n]+?)\*(?![\w*])/g, "$1")
		.replace(/(?<![\w*])_([^_\n]+?)_(?![\w*])/g, "$1")
		.replace(/^\s{0,3}#{1,6}\s+/, "");
}

/**
 * Convert inline Markdown (emphasis, code spans, links) in a single line or
 * cell. Unmatched delimiters are emitted as literal text.
 */
function inlineToTelegramHtml(text: string, depth: number = 0): string {
	if (text.length === 0) return "";
	if (depth >= MAX_INLINE_DEPTH) return escapeHtml(text);

	let html = "";
	let cursor = 0;
	const pattern = createInlinePattern();

	for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
		html += escapeHtml(text.slice(cursor, match.index));
		cursor = match.index + match[0].length;

		if (match[1] !== undefined) {
			html += `<code>${escapeHtml(match[2] ?? "")}</code>`;
			continue;
		}
		if (match[3] !== undefined) {
			const label = match[3];
			const url = match[4] ?? "";
			if (SAFE_URL_PATTERN.test(url)) {
				const inner = label.length > 0 ? inlineToTelegramHtml(label, depth + 1) : escapeHtml(url);
				html += `<a href="${escapeHtmlAttribute(url)}">${inner}</a>`;
			} else {
				html += escapeHtml(match[0]);
			}
			continue;
		}

		// Remaining branches are emphasis wrappers: recurse into their content.
		const inner = match[5] ?? match[6] ?? match[7] ?? match[8] ?? match[9] ?? "";
		const converted = inlineToTelegramHtml(inner, depth + 1);
		if (match[5] !== undefined || match[6] !== undefined) html += `<b>${converted}</b>`;
		else if (match[7] !== undefined) html += `<s>${converted}</s>`;
		else html += `<i>${converted}</i>`;
	}

	html += escapeHtml(text.slice(cursor));
	return html;
}

function isTableRow(line: string): boolean {
	const match = TABLE_ROW_PATTERN.exec(line);
	return match !== null && match[1].includes("|");
}

function isTableSeparator(line: string): boolean {
	return TABLE_SEPARATOR_PATTERN.test(line) && line.includes("-");
}

function splitTableRow(line: string): string[] {
	const inner = TABLE_ROW_PATTERN.exec(line)?.[1] ?? line;
	return inner.split("|").map((cell) => stripInlineMarkdown(cell.trim()));
}

/** Render a pipe table as an aligned monospace block; Telegram has no table tags. */
function renderTable(rows: string[][]): string {
	const columnCount = Math.min(
		Math.max(...rows.map((row) => row.length)),
		MAX_TABLE_COLUMNS,
	);
	const widths = new Array<number>(columnCount).fill(0);
	for (const row of rows) {
		for (let column = 0; column < columnCount; column++) {
			widths[column] = Math.max(widths[column], displayWidth(row[column] ?? ""));
		}
	}

	const rendered = rows.map((row) => {
		const cells: string[] = [];
		for (let column = 0; column < columnCount; column++) {
			cells.push(padTo(row[column] ?? "", widths[column]));
		}
		return cells.join("  ").trimEnd();
	});

	return `<pre>${escapeHtml(rendered.join("\n"))}</pre>`;
}

/**
 * Convert a Markdown document (or a streamed prefix of one) into Telegram HTML.
 * Output is always well-formed for the tags the Bot API supports.
 */
export function markdownToTelegramHtml(markdown: string): string {
	const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
	const blocks: string[] = [];
	let index = 0;
	let blankPending = false;

	const push = (block: string): void => {
		if (block.length === 0) return;
		if (blankPending && blocks.length > 0) blocks.push("");
		blankPending = false;
		blocks.push(block);
	};

	while (index < lines.length) {
		const line = lines[index] ?? "";

		if (line.trim().length === 0) {
			blankPending = true;
			index++;
			continue;
		}

		const fence = FENCE_PATTERN.exec(line);
		if (fence) {
			const marker = fence[1] ?? "```";
			const language = sanitizeLanguage(fence[2] ?? "");
			const body: string[] = [];
			index++;
			while (index < lines.length && !isClosingFence(lines[index] ?? "", marker)) {
				body.push(lines[index] ?? "");
				index++;
			}
			// A streamed preview can end inside an open fence; nothing to consume then.
			if (index < lines.length) index++;
			const code = escapeHtml(body.join("\n"));
			push(language ? `<pre><code class="language-${language}">${code}</code></pre>` : `<pre>${code}</pre>`);
			continue;
		}

		if (isTableRow(line)) {
			// Accept a table with or without the `| --- |` separator row: a chunk split can
			// orphan the header, and prose-style tables often omit the separator entirely.
			let lookahead = index + 1;
			const rows: string[][] = [splitTableRow(line)];
			if (isTableSeparator(lines[lookahead] ?? "")) lookahead++;
			while (lookahead < lines.length && isTableRow(lines[lookahead] ?? "")) {
				rows.push(splitTableRow(lines[lookahead] ?? ""));
				lookahead++;
			}
			if (rows.length >= 2) {
				push(renderTable(rows));
				index = lookahead;
				continue;
			}
		}

		const heading = HEADING_PATTERN.exec(line);
		if (heading) {
			push(`<b>${inlineToTelegramHtml((heading[2] ?? "").trim())}</b>`);
			index++;
			continue;
		}

		if (HR_PATTERN.test(line)) {
			push("———");
			index++;
			continue;
		}

		if (BLOCKQUOTE_PATTERN.test(line)) {
			const quoted: string[] = [];
			while (index < lines.length) {
				const quote = BLOCKQUOTE_PATTERN.exec(lines[index] ?? "");
				if (!quote) break;
				quoted.push(inlineToTelegramHtml((quote[1] ?? "").trim()));
				index++;
			}
			push(`<blockquote>${quoted.join("\n")}</blockquote>`);
			continue;
		}

		const listItem = LIST_PATTERN.exec(line);
		if (listItem) {
			const indent = " ".repeat(Math.floor((listItem[1] ?? "").replace(/\t/g, "  ").length / 2) * 2);
			const marker = listItem[2] ?? "-";
			const bullet = /^\d/.test(marker) ? marker.replace(/[.)]$/, ".") : "•";
			push(`${indent}${bullet} ${inlineToTelegramHtml(listItem[3] ?? "")}`);
			index++;
			continue;
		}

		push(inlineToTelegramHtml(line));
		index++;
	}

	return blocks.join("\n");
}

function isClosingFence(line: string, marker: string): boolean {
	const trimmed = line.trim();
	return trimmed.length >= marker.length && /^[`~]+$/.test(trimmed) && trimmed.startsWith(marker[0] ?? "`");
}

/**
 * Number of characters Telegram counts for an HTML payload. The API measures the text
 * after entity parsing, so tags disappear and an entity such as `&amp;` counts as the
 * single character it renders as. Verified against the live API: a 17,746 byte payload
 * with 4096 visible characters is accepted, 4097 is rejected with "message is too long",
 * and 4096 astral code points (8192 UTF-16 units) are accepted - so the count is code
 * points, not UTF-16 code units.
 */
export function telegramVisibleLength(html: string): number {
	const text = html.replace(/<[^>]*>/g, "").replace(/&(?:lt|gt|amp|quot);/g, "x");
	return [...text].length;
}
