import { mkdir, stat } from "node:fs/promises";
import { basename } from "node:path";

import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import type {
	TelegramConfig,
	TelegramApiResponse,
	TelegramUser,
	TelegramMessage,
	TelegramUpdate,
} from "./src/types";

import {
	TEMP_DIR,
	TELEGRAM_PREFIX,
	MAX_MESSAGE_LENGTH,
	MAX_ATTACHMENTS_PER_TURN,
	TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS,
	SYSTEM_PROMPT_SUFFIX,
} from "./src/constants";

import {
	extractAssistantText,
	getMessageText,
	isAssistantMessage,
	isTelegramPrompt,
} from "./src/utils";

import { readConfig, writeConfig } from "./src/config";
import { callTelegram, callTelegramMultipart, downloadTelegramFile } from "./src/telegram-api";
import { createState } from "./src/state";
import { createDispatchController } from "./src/dispatch";
import { createPollingController } from "./src/polling";
import { createPreviewController } from "./src/preview";

export default function (pi: ExtensionAPI) {
	const state = createState();

	function updateStatus(ctx: ExtensionContext, error?: string): void {
		const theme = ctx.ui.theme;
		const label = theme.fg("accent", "telegram");
		if (error) {
			ctx.ui.setStatus("telegram", `${label} ${theme.fg("error", "error")} ${theme.fg("muted", error)}`);
			return;
		}
		if (!state.config.botToken) {
			ctx.ui.setStatus("telegram", `${label} ${theme.fg("muted", "not configured")}`);
			return;
		}
		if (!state.pollingPromise) {
			ctx.ui.setStatus("telegram", `${label} ${theme.fg("muted", "disconnected")}`);
			return;
		}
		if (!state.config.allowedUserId) {
			ctx.ui.setStatus("telegram", `${label} ${theme.fg("warning", "awaiting pairing")}`);
			return;
		}
		if (state.activeTelegramTurn || state.queuedTelegramTurns.length > 0) {
			const queued = state.queuedTelegramTurns.length > 0 ? theme.fg("muted", ` +${state.queuedTelegramTurns.length} queued`) : "";
			ctx.ui.setStatus("telegram", `${label} ${theme.fg("accent", "processing")}${queued}`);
			return;
		}
		ctx.ui.setStatus("telegram", `${label} ${theme.fg("success", "connected")}`);
	}

	function call<TResponse>(
		method: string,
		body: Record<string, unknown>,
		options?: { signal?: AbortSignal },
	): Promise<TResponse> {
		return callTelegram<TResponse>(state.config.botToken!, method, body, options);
	}

	const dispatch = createDispatchController({
		state,
		call,
		callMultipart: (method, fields, fileField, filePath, fileName, options?) =>
			callTelegramMultipart<unknown>(state.config.botToken!, method, fields, fileField, filePath, fileName, options),
		downloadTelegramFile: (fileId, suggestedName) =>
			downloadTelegramFile(state.config.botToken!, fileId, suggestedName),
		sendUserMessage: (content) => pi.sendUserMessage(content),
		updateStatus,
		writeConfig,
	});

	const polling = createPollingController({
		state,
		call,
		writeConfig,
		updateStatus,
		sendTextReply: dispatch.sendTextReply,
		dispatchAuthorizedTelegramMessages: dispatch.dispatchAuthorizedTelegramMessages,
		stopTypingLoop: dispatch.stopTypingLoop,
	});

	const preview = createPreviewController({ state, call });

	async function promptForConfig(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI || state.setupInProgress) return;
		state.setupInProgress = true;
		try {
			const token = await ctx.ui.input("Telegram bot token", "123456:ABCDEF...");
			if (!token) return;

			const nextConfig: TelegramConfig = { ...state.config, botToken: token.trim() };
			const response = await fetch(`https://api.telegram.org/bot${nextConfig.botToken}/getMe`);
			const data = (await response.json()) as TelegramApiResponse<TelegramUser>;
			if (!data.ok || !data.result) {
				ctx.ui.notify(data.description || "Invalid Telegram bot token", "error");
				return;
			}

			nextConfig.botId = data.result.id;
			nextConfig.botUsername = data.result.username;
			state.config = nextConfig;
			await writeConfig(state.config);
			ctx.ui.notify(`Telegram bot connected: @${state.config.botUsername ?? "unknown"}`, "info");
			ctx.ui.notify("Send /start to your bot in Telegram to pair this extension with your account.", "info");
			await polling.startPolling(ctx);
			updateStatus(ctx);
		} finally {
			state.setupInProgress = false;
		}
	}

	pi.registerTool({
		name: "telegram_attach",
		label: "Telegram Attach",
		description: "Queue one or more local files to be sent with the next Telegram reply.",
		promptSnippet: "Queue local files to be sent with the next Telegram reply.",
		promptGuidelines: [
			"When handling a [telegram] message and the user asked for a file or generated artifact, call telegram_attach with the local path instead of only mentioning the path in text.",
		],
		parameters: Type.Object({
			paths: Type.Array(Type.String({ description: "Local file path to attach" }), { minItems: 1, maxItems: MAX_ATTACHMENTS_PER_TURN }),
		}),
		async execute(_toolCallId, params) {
			if (!state.activeTelegramTurn) {
				throw new Error("telegram_attach can only be used while replying to an active Telegram turn");
			}
			const added: string[] = [];
			for (const inputPath of params.paths) {
				const stats = await stat(inputPath);
				if (!stats.isFile()) {
					throw new Error(`Not a file: ${inputPath}`);
				}
				if (state.activeTelegramTurn.queuedAttachments.length >= MAX_ATTACHMENTS_PER_TURN) {
					throw new Error(`Attachment limit reached (${MAX_ATTACHMENTS_PER_TURN})`);
				}
				state.activeTelegramTurn.queuedAttachments.push({ path: inputPath, fileName: basename(inputPath) });
				added.push(inputPath);
			}
			return {
				content: [{ type: "text", text: `Queued ${added.length} Telegram attachment(s).` }],
				details: { paths: added },
			};
		},
	});

	pi.registerCommand("telegram-setup", {
		description: "Configure Telegram bot token",
		handler: async (_args, ctx) => {
			await promptForConfig(ctx);
		},
	});

	pi.registerCommand("telegram-status", {
		description: "Show Telegram bridge status",
		handler: async (_args, ctx) => {
			const status = [
				`bot: ${state.config.botUsername ? `@${state.config.botUsername}` : "not configured"}`,
				`allowed user: ${state.config.allowedUserId ?? "not paired"}`,
				`polling: ${state.pollingPromise ? "running" : "stopped"}`,
				`active telegram turn: ${state.activeTelegramTurn ? "yes" : "no"}`,
				`queued telegram turns: ${state.queuedTelegramTurns.length}`,
			];
			ctx.ui.notify(status.join(" | "), "info");
		},
	});

	pi.registerCommand("telegram-connect", {
		description: "Start the Telegram bridge in this pi session",
		handler: async (_args, ctx) => {
			state.config = await readConfig();
			if (!state.config.botToken) {
				await promptForConfig(ctx);
				return;
			}
			await polling.startPolling(ctx);
			updateStatus(ctx);
		},
	});

	pi.registerCommand("telegram-disconnect", {
		description: "Stop the Telegram bridge in this pi session",
		handler: async (_args, ctx) => {
			await polling.stopPolling();
			updateStatus(ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		state.config = await readConfig();
		await mkdir(TEMP_DIR, { recursive: true });
		updateStatus(ctx);
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		state.queuedTelegramTurns = [];
		for (const groupState of state.mediaGroups.values()) {
			if (groupState.flushTimer) clearTimeout(groupState.flushTimer);
		}
		state.mediaGroups.clear();
		if (state.activeTelegramTurn) {
			await preview.clearPreview(state.activeTelegramTurn.chatId);
		}
		state.activeTelegramTurn = undefined;
		state.currentAbort = undefined;
		state.preserveQueuedTurnsAsHistory = false;
		await polling.stopPolling();
	});

	pi.on("before_agent_start", async (event) => {
		const suffix = isTelegramPrompt(event.prompt)
			? `${SYSTEM_PROMPT_SUFFIX}\n- The current user message came from Telegram.`
			: SYSTEM_PROMPT_SUFFIX;
		return {
			systemPrompt: event.systemPrompt + suffix,
		};
	});

	pi.on("agent_start", async (_event, ctx) => {
		state.currentAbort = () => ctx.abort();
		if (!state.activeTelegramTurn && state.queuedTelegramTurns.length > 0) {
			const nextTurn = state.queuedTelegramTurns.shift();
			if (nextTurn) {
				state.activeTelegramTurn = { ...nextTurn };
				state.previewState = { mode: state.draftSupport === "unsupported" ? "message" : "draft", pendingText: "", lastSentText: "" };
				dispatch.startTypingLoop(ctx);
			}
		}
		updateStatus(ctx);
	});

	pi.on("message_start", async (event, _ctx) => {
		if (!state.activeTelegramTurn || !isAssistantMessage(event.message)) return;
		if (state.previewState && (state.previewState.pendingText.trim().length > 0 || state.previewState.lastSentText.trim().length > 0)) {
			await preview.finalizePreview(state.activeTelegramTurn.chatId);
		}
		state.previewState = { mode: state.draftSupport === "unsupported" ? "message" : "draft", pendingText: "", lastSentText: "" };
	});

	pi.on("message_update", async (event, _ctx) => {
		if (!state.activeTelegramTurn || !isAssistantMessage(event.message)) return;
		if (!state.previewState) {
			state.previewState = { mode: state.draftSupport === "unsupported" ? "message" : "draft", pendingText: "", lastSentText: "" };
		}
		state.previewState.pendingText = getMessageText(event.message);
		preview.schedulePreviewFlush(state.activeTelegramTurn.chatId);
	});

	pi.on("agent_end", async (event, ctx) => {
		const turn = state.activeTelegramTurn;
		state.currentAbort = undefined;
		dispatch.stopTypingLoop();
		state.activeTelegramTurn = undefined;
		updateStatus(ctx);
		if (!turn) return;

		const assistant = extractAssistantText(event.messages);
		if (assistant.stopReason === "aborted") {
			await preview.clearPreview(turn.chatId);
			return;
		}
		if (assistant.stopReason === "error") {
			await preview.clearPreview(turn.chatId);
			await dispatch.sendTextReply(turn.chatId, turn.replyToMessageId, assistant.errorMessage || "Telegram bridge: pi failed while processing the request.");
			return;
		}

		const finalText = assistant.text;
		if (state.previewState) {
			state.previewState.pendingText = finalText ?? state.previewState.pendingText;
		}

		if (finalText && finalText.length <= MAX_MESSAGE_LENGTH) {
			const finalized = await preview.finalizePreview(turn.chatId);
			if (!finalized && turn.queuedAttachments.length > 0 && !finalText) {
				await dispatch.sendTextReply(turn.chatId, turn.replyToMessageId, "Attached requested file(s).");
			}
		} else {
			await preview.clearPreview(turn.chatId);
			if (finalText) {
				await dispatch.sendTextReply(turn.chatId, turn.replyToMessageId, finalText);
			} else if (turn.queuedAttachments.length > 0) {
				await dispatch.sendTextReply(turn.chatId, turn.replyToMessageId, "Attached requested file(s).");
			}
		}

		await dispatch.sendQueuedAttachments(turn);

		if (state.queuedTelegramTurns.length > 0 && !state.preserveQueuedTurnsAsHistory) {
			const nextTurn = state.queuedTelegramTurns[0];
			dispatch.startTypingLoop(ctx, nextTurn.chatId);
			updateStatus(ctx);
			pi.sendUserMessage(nextTurn.content);
		}
	});
}
