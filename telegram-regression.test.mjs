import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function waitFor(predicate, timeoutMs = 5000) {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("condition timed out");
}

/**
 * Boot the extension with a mocked Telegram API and a mocked pi runtime.
 * `sessions` are the session files the /resume picker should offer.
 */
async function setup({ sessions = [] } = {}) {
	const home = await mkdtemp(join(tmpdir(), "pi-telegram-"));
	process.env.HOME = home;
	const dir = join(home, ".pi", "agent");
	await mkdir(join(dir, "sessions"), { recursive: true });
	await writeFile(join(dir, "telegram.json"), JSON.stringify({ botToken: "test", allowedUserId: 7, lastUpdateId: 0 }));

	for (const session of sessions) {
		const lines = [
			{ type: "session", version: 3, id: session.id, timestamp: session.modified, cwd: home },
			{
				type: "message",
				id: session.id + "-m1",
				parentId: null,
				timestamp: session.modified,
				message: { role: "user", content: session.first },
			},
		];
		await writeFile(join(dir, "sessions", session.file), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
	}

	const calls = [];
	let updates = [];
	globalThis.fetch = async (url, init = {}) => {
		const method = String(url).split("/").pop();
		let body = {};
		try {
			body = JSON.parse(init.body);
		} catch {}
		calls.push({ method, body });
		if (method === "getUpdates") {
			const batch = updates;
			updates = [];
			await new Promise((resolve) => {
				const timer = setTimeout(resolve, 3);
				init.signal?.addEventListener("abort", () => {
					clearTimeout(timer);
					resolve();
				}, { once: true });
			});
			if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
			return Response.json({ ok: true, result: batch });
		}
		return Response.json({ ok: true, result: method === "sendMessage" ? { message_id: 99 } : true });
	};

	const { default: extension } = await import("./index.ts?test=" + Math.random());
	const handlers = {};
	const commands = {};
	const sent = [];
	let idle = true;
	let sessionDir = join(dir, "sessions");
	let newSessionCalls = [];
	let switchSessionCalls = [];
	const models = [{ provider: "test-provider", id: "model-a", contextWindow: 4096 }];
	const ctx = {
		isIdle: () => idle,
		model: models[0],
		cwd: home,
		modelRegistry: {
			find: (provider, id) => models.find((m) => m.provider === provider && m.id === id),
			getAvailable: () => models,
			isUsingOAuth: () => false,
		},
		getContextUsage: () => ({ tokens: 123, contextWindow: 4096, percent: 3 }),
		sessionManager: {
			getEntries: () => [],
			getSessionFile: () => "/current.json",
			getSessionDir: () => sessionDir,
		},
		ui: { theme: { fg: (_c, s) => s }, setStatus() {} },
		newSession: async (options) => {
			newSessionCalls.push(options);
			await options?.withSession?.(ctx);
			return { cancelled: false };
		},
		switchSession: async (path, options) => {
			switchSessionCalls.push({ path, options });
			await options?.withSession?.(ctx);
			return { cancelled: false };
		},
	};
	const pi = {
		on: (n, fn) => (handlers[n] = fn),
		registerCommand: (n, c) => (commands[n] = c),
		registerTool() {},
		sendUserMessage: (content, opts) => sent.push({ content, opts }),
	};
	extension(pi);
	await handlers.session_start({}, ctx);
	await new Promise((r) => setTimeout(r, 20));

	return {
		home,
		calls,
		handlers,
		commands,
		ctx,
		sent,
		newSessionCalls,
		switchSessionCalls,
		connect: () => commands["telegram-connect"].handler("", ctx),
		setIdle: (v) => (idle = v),
		setUpdates: (v) => (updates = v),
		cleanup: () => rm(home, { recursive: true, force: true }),
	};
}

const message = (id, text) => ({ message_id: id, chat: { id: 7, type: "private" }, from: { id: 7, is_bot: false, first_name: "A" }, text });

const sentText = (calls) =>
	calls
		.filter((c) => ["sendMessage", "editMessageText", "sendRichMessage"].includes(c.method))
		.map((c) => c.body.text ?? c.body.rich_message?.markdown ?? "")
		.join("\n");

test("Telegram /new dispatches the session command instead of forwarding a prompt", async () => {
	const h = await setup();
	try {
		await h.connect();
		h.setUpdates([{ update_id: 1, message: message(1, "/new") }]);
		await waitFor(() => h.sent.length === 1);
		assert.equal(h.sent.length, 1);
		assert.equal(h.sent[0].content, "/telegram-new");
		assert.equal(h.sent[0].opts.expandPromptTemplates, true);
		assert.equal(h.newSessionCalls.length, 0, "the plain handler must not switch sessions itself");
	} finally {
		await h.handlers.session_shutdown({}, h.ctx);
		await h.cleanup();
	}
});

test("the telegram-new command starts a new session and reports back", async () => {
	const h = await setup();
	try {
		await h.connect();
		h.setUpdates([{ update_id: 1, message: message(1, "/new") }]);
		await waitFor(() => h.sent.length === 1);
		await h.commands["telegram-new"].handler("", h.ctx);
		assert.equal(h.newSessionCalls.length, 1);
		assert.equal(h.newSessionCalls[0].parentSession, "/current.json", "the previous session is recorded as parent");
		await waitFor(() => sentText(h.calls).includes("Started a new session"));
	} finally {
		await h.handlers.session_shutdown({}, h.ctx);
		await h.cleanup();
	}
});

test("Telegram /resume lists recent sessions and switches by number", async () => {
	const sessions = [
		{ file: "older.jsonl", id: "aaaaaaaa", modified: "2026-10-20T10:00:00.000Z", first: "older session topic" },
		{ file: "newer.jsonl", id: "bbbbbbbb", modified: "2026-10-21T10:00:00.000Z", first: "newer session topic" },
	];
	const h = await setup({ sessions });
	try {
		await h.connect();
		h.setUpdates([{ update_id: 1, message: message(1, "/resume") }]);
		await waitFor(() => sentText(h.calls).includes("Recent sessions"));
		const listing = sentText(h.calls);
		assert.match(listing, /1\./);
		assert.match(listing, /2\./);
		assert.ok(listing.indexOf("newer session topic") < listing.indexOf("older session topic"), "most recent session must be listed first");

		h.setUpdates([{ update_id: 2, message: message(2, "2") }]);
		await waitFor(() => h.sent.length === 1);
		assert.equal(h.sent[0].content, "/telegram-resume 2");
		await h.commands["telegram-resume"].handler("2", h.ctx);
		assert.equal(h.switchSessionCalls.length, 1);
		assert.ok(h.switchSessionCalls[0].path.endsWith("older.jsonl"), "index 2 maps to the older session");
	} finally {
		await h.handlers.session_shutdown({}, h.ctx);
		await h.cleanup();
	}
});

test("Telegram /resume rejects an out-of-range selection", async () => {
	const sessions = [{ file: "only.jsonl", id: "cccccccc", modified: "2026-10-21T10:00:00.000Z", first: "only session" }];
	const h = await setup({ sessions });
	try {
		await h.connect();
		h.setUpdates([{ update_id: 1, message: message(1, "/resume") }]);
		await waitFor(() => sentText(h.calls).includes("Recent sessions"));
		h.setUpdates([{ update_id: 2, message: message(2, "9") }]);
		await waitFor(() => sentText(h.calls).includes("Invalid selection"));
		assert.equal(h.switchSessionCalls.length, 0);
	} finally {
		await h.handlers.session_shutdown({}, h.ctx);
		await h.cleanup();
	}
});

test("Telegram /new is refused while pi is busy", async () => {
	const h = await setup();
	try {
		await h.connect();
		h.setIdle(false);
		h.setUpdates([{ update_id: 1, message: message(1, "/new") }]);
		await waitFor(() => sentText(h.calls).includes("busy"));
		assert.equal(h.sent.length, 0, "a busy bridge must not dispatch a session switch");
	} finally {
		await h.handlers.session_shutdown({}, h.ctx);
		await h.cleanup();
	}
});

test("the bridge resumes polling after a session switch", async () => {
	const h = await setup();
	try {
		await h.connect();
		const before = h.calls.filter((c) => c.method === "getUpdates").length;
		await h.handlers.session_shutdown({}, h.ctx);
		await h.handlers.session_start({}, h.ctx);
		await waitFor(() => h.calls.filter((c) => c.method === "getUpdates").length > before);
		assert.ok(
			h.calls.filter((c) => c.method === "getUpdates").length > before,
			"polling must resume after the session was replaced",
		);
	} finally {
		await h.handlers.session_shutdown({}, h.ctx);
		await h.cleanup();
	}
});

test("the reconnect intent is persisted in the config file, not only in memory", async () => {
	const h = await setup();
	try {
		await h.connect();
		h.setUpdates([{ update_id: 1, message: message(1, "/new") }]);
		await waitFor(() => h.sent.length === 1);
		await h.commands["telegram-new"].handler("", h.ctx);
		const config = JSON.parse(await readFile(join(h.home, ".pi", "agent", "telegram.json"), "utf8"));
		assert.equal(config.reconnectAfterSessionSwitch, true, "the intent must survive in the config file");
	} finally {
		await h.handlers.session_shutdown({}, h.ctx);
		await h.cleanup();
	}
});
