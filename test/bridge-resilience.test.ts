import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/**
 * Regression test for "Extension ... error: fetch failed" surfacing from the pi host.
 *
 * Drives the real extension through a full Telegram turn while every Telegram API
 * call fails with a network error. Neither the registered event handlers nor the
 * background dispatch may reject or leave an unhandled rejection: a Telegram
 * outage must degrade to the status bar, never to a host error.
 */

const fakeHome = await mkdtemp(join(tmpdir(), "pi-telegram-bridge-test-"));
process.env.HOME = fakeHome;
await mkdir(join(fakeHome, ".pi", "agent"), { recursive: true });
await writeFile(
	join(fakeHome, ".pi", "agent", "telegram.json"),
	JSON.stringify({ botToken: "TEST-TOKEN", allowedUserId: 42, lastUpdateId: 0 }),
);

const unhandledRejections: unknown[] = [];
process.on("unhandledRejection", (error) => unhandledRejections.push(error));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("timed out waiting for condition");
		await sleep(20);
	}
}

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

function telegramTextMessage(updateId: number, messageId: number, text: string, mediaGroupId?: string) {
	return {
		update_id: updateId,
		message: {
			message_id: messageId,
			date: 0,
			chat: { id: 42, type: "private" },
			from: { id: 42, is_bot: false, first_name: "T" },
			text,
			...(mediaGroupId ? { media_group_id: mediaGroupId } : {}),
		},
	};
}

let updateBatches = 0;
globalThis.fetch = (async (input: unknown) => {
	const url = String(input);
	if (url.includes("getUpdates")) {
		updateBatches += 1;
		if (updateBatches === 1) {
			return jsonResponse({ ok: true, result: [telegramTextMessage(1, 10, "hello")] });
		}
		if (updateBatches === 3) {
			// A media-group message dispatches from a debounce timer with no awaiter.
			return jsonResponse({ ok: true, result: [telegramTextMessage(2, 11, "stop", "mg-1")] });
		}
		await sleep(30);
		return jsonResponse({ ok: true, result: [] });
	}
	throw new TypeError("fetch failed");
}) as typeof fetch;

const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
const commands = new Map<string, (args: unknown, ctx: unknown) => Promise<unknown>>();
const userMessages: unknown[] = [];
const piMock = {
	on(event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) {
		handlers.set(event, handler);
	},
	registerTool() {},
	registerCommand(name: string, definition: { handler: (args: unknown, ctx: unknown) => Promise<unknown> }) {
		commands.set(name, definition.handler);
	},
	sendUserMessage(content: unknown) {
		userMessages.push(content);
		return Promise.resolve();
	},
	sendMessage() {
		return Promise.resolve();
	},
};

const ctxMock = {
	ui: {
		theme: { fg: (_role: string, text: string) => text },
		setStatus() {},
		notify() {},
	},
	isIdle: () => true,
	abort() {},
	compact() {},
	sessionManager: { getEntries: () => [] },
	getContextUsage: () => ({}),
};

const extension = (await import("../index.ts")).default;
extension(piMock as unknown as ExtensionAPI);

const handlerRejections: string[] = [];
async function invoke(name: string, event: unknown): Promise<void> {
	const handler = handlers.get(name);
	assert.ok(handler, `handler ${name} is registered`);
	try {
		await handler(event, ctxMock);
	} catch (error) {
		handlerRejections.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

test("Telegram outages never surface as extension errors", async () => {
	await invoke("session_start", {});
	await commands.get("telegram-connect")!(undefined, ctxMock);
	await waitFor(() => userMessages.length > 0, 15_000);

	// A full agent turn over the bridge while the network is down.
	await invoke("agent_start", {});
	await invoke("message_update", {
		message: { role: "assistant", content: [{ type: "text", text: "partial answer" }] },
	});
	await invoke("message_start", {
		message: { role: "assistant", content: [{ type: "text", text: "next" }] },
	});
	await invoke("agent_end", {
		messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "final answer" }] }],
	});

	// Let the media-group debounce timer dispatch its background turn.
	await sleep(1800);

	await invoke("session_shutdown", {});
	await sleep(100);

	assert.deepEqual(handlerRejections, [], "event handlers must not reject towards the host");
	assert.deepEqual(
		unhandledRejections.map((error) => (error instanceof Error ? error.message : String(error))),
		[],
		"background dispatch must not produce unhandled rejections",
	);
});
