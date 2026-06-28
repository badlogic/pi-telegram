import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import {
	ensureProjectTelegramGitIgnore,
	getProjectTelegramPaths,
	parseTelegramStorageScopeArg,
	readTelegramConfig,
	resolveTelegramStorage,
	writeTelegramConfig,
} from "./storage";
import type { TelegramConfig, TelegramStorage, TelegramStorageScope } from "./storage";
import { markdownToTelegramHtml, chunkTelegramHtml } from "./markdown";

interface TelegramApiResponse<T> {
	ok: boolean;
	result?: T;
	description?: string;
	error_code?: number;
}

interface TelegramUser {
	id: number;
	is_bot: boolean;
	first_name: string;
	username?: string;
}

interface TelegramChat {
	id: number;
	type: string;
}

interface TelegramPhotoSize {
	file_id: string;
	file_size?: number;
}

interface TelegramDocument {
	file_id: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

interface TelegramVideo {
	file_id: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

interface TelegramAudio {
	file_id: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

interface TelegramVoice {
	file_id: string;
	mime_type?: string;
	file_size?: number;
}

interface TelegramAnimation {
	file_id: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

interface TelegramSticker {
	file_id: string;
	emoji?: string;
}

interface TelegramFileInfo {
	file_id: string;
	fileName: string;
	mimeType?: string;
	isImage: boolean;
}

interface TelegramMessage {
	message_id: number;
	chat: TelegramChat;
	from?: TelegramUser;
	text?: string;
	caption?: string;
	media_group_id?: string;
	photo?: TelegramPhotoSize[];
	document?: TelegramDocument;
	video?: TelegramVideo;
	audio?: TelegramAudio;
	voice?: TelegramVoice;
	animation?: TelegramAnimation;
	sticker?: TelegramSticker;
}

interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
	edited_message?: TelegramMessage;
}

interface TelegramGetFileResult {
	file_path: string;
}

interface TelegramSentMessage {
	message_id: number;
}

interface DownloadedTelegramFile {
	path: string;
	fileName: string;
	isImage: boolean;
	mimeType?: string;
}

interface PendingTelegramTurn {
	chatId: number;
	replyToMessageId: number;
	queuedAttachments: QueuedAttachment[];
	content: Array<TextContent | ImageContent>;
	historyText: string;
}

type ActiveTelegramTurn = PendingTelegramTurn;

interface QueuedAttachment {
	path: string;
	fileName: string;
}

interface TelegramPreviewState {
	mode: "draft" | "message";
	draftId?: number;
	messageId?: number;
	pendingText: string;
	lastSentText: string;
	flushTimer?: ReturnType<typeof setTimeout>;
}

export function areTelegramPreviewsEnabled(config: TelegramConfig): boolean {
	return config.streamPreviews !== false;
}

export function isTelegramRichTextEnabled(config: TelegramConfig): boolean {
	return config.richText !== false;
}

export function createTelegramPreviewState(
	config: TelegramConfig,
	draftSupport: "unknown" | "supported" | "unsupported",
): TelegramPreviewState | undefined {
	if (!areTelegramPreviewsEnabled(config)) return undefined;
	return {
		mode: draftSupport === "unsupported" ? "message" : "draft",
		pendingText: "",
		lastSentText: "",
	};
}

export function getTelegramFinalDeliveryMode(config: TelegramConfig, finalText?: string): "preview" | "text" | "none" {
	if (!finalText) return "none";
	if (areTelegramPreviewsEnabled(config) && finalText.length <= MAX_MESSAGE_LENGTH) return "preview";
	return "text";
}

interface TelegramMediaGroupState {
	messages: TelegramMessage[];
	flushTimer?: ReturnType<typeof setTimeout>;
}

interface TelegramReconnectRequest {
	requestId: string;
	chatId: number;
	replyToMessageId: number;
	sessionName?: string;
	truncated?: boolean;
}

interface TelegramReconnectConsumed {
	requestId: string;
}

export interface TelegramSessionContextStore<T> {
	get(): T | undefined;
	set(ctx: T): void;
	clear(): void;
}

export interface TelegramNewSessionContext<T> {
	newSession(options?: {
		parentSession?: string;
		setup?: (...args: any[]) => Promise<void>;
		withSession?: (ctx: T) => Promise<void>;
	}): Promise<{ cancelled: boolean }>;
}

export function createTelegramSessionContextStore<T>(): TelegramSessionContextStore<T> {
	let current: T | undefined;
	return {
		get: () => current,
		set: (ctx) => {
			current = ctx;
		},
		clear: () => {
			current = undefined;
		},
	};
}

export async function createTelegramNewSessionWithFreshContext<T extends TelegramNewSessionContext<T>>(
	store: TelegramSessionContextStore<T>,
	options?: Parameters<T["newSession"]>[0],
): Promise<{ cancelled: boolean }> {
	const ctx = store.get();
	if (!ctx) throw new Error("No Telegram session context is available");
	return ctx.newSession({
		...options,
		withSession: async (replacementCtx) => {
			store.set(replacementCtx);
			await options?.withSession?.(replacementCtx);
		},
	});
}

const telegramCommandContextStore = createTelegramSessionContextStore<ExtensionCommandContext>();

const TELEGRAM_PREFIX = "[telegram]";
const MAX_MESSAGE_LENGTH = 4096;
const MAX_ATTACHMENTS_PER_TURN = 10;
const PREVIEW_THROTTLE_MS = 750;
const TELEGRAM_DRAFT_ID_MAX = 2_147_483_647;
const TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS = 1200;
export const MAX_NEW_SESSION_NAME_LENGTH = 80;
export const TELEGRAM_RECONNECT_REQUEST_ENTRY_TYPE = "telegram-reconnect-request";
export const TELEGRAM_RECONNECT_CONSUMED_ENTRY_TYPE = "telegram-reconnect-consumed";
const TELEGRAM_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const TELEGRAM_USER_COMMANDS = [
	"/new [name] - start a fresh pi session",
	"/status - show session, directory, model, usage, cost, and context",
	"/model [provider/]model-id [thinking-level] - switch model, optionally including provider",
	"/thinking <level> - change thinking level",
	"/compact - compact context",
	"/resend - resend the latest assistant reply from this session",
	"/stop - abort active turn",
	"/help - show help",
	"/git <status|log|nb> - run safe git shortcuts in current cwd",
] as const;
const TELEGRAM_BOTFATHER_COMMANDS = [
	"new - start a fresh pi session, optionally with a name",
	"status - show session, directory, model, usage, cost, and context",
	"model - switch model, optionally including provider and thinking level",
	"thinking - change thinking level",
	"compact - compact context",
	"resend - resend the latest assistant reply from this session",
	"stop - abort active turn",
	"help - show help",
	"git - run safe git shortcuts in current cwd",
] as const;

type TelegramThinkingLevel = (typeof TELEGRAM_THINKING_LEVELS)[number];

const SYSTEM_PROMPT_SUFFIX = `

Telegram bridge extension is active.
- Messages forwarded from Telegram are prefixed with "[telegram]".
- [telegram] messages may include local temp file paths for Telegram attachments. Read those files as needed.
- If a [telegram] user asked for a file or generated artifact, use the telegram_attach tool with the local file path so the extension can send it with your next final reply.
- Do not assume mentioning a local file path in plain text will send it to Telegram. Use telegram_attach.`;

function isTelegramPrompt(prompt: string): boolean {
	return prompt.trimStart().startsWith(TELEGRAM_PREFIX);
}

function sanitizeFileName(name: string): string {
	return name.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function guessExtensionFromMime(mimeType: string | undefined, fallback: string): string {
	if (!mimeType) return fallback;
	const normalized = mimeType.toLowerCase();
	if (normalized === "image/jpeg") return ".jpg";
	if (normalized === "image/png") return ".png";
	if (normalized === "image/webp") return ".webp";
	if (normalized === "image/gif") return ".gif";
	if (normalized === "audio/ogg") return ".ogg";
	if (normalized === "audio/mpeg") return ".mp3";
	if (normalized === "audio/wav") return ".wav";
	if (normalized === "video/mp4") return ".mp4";
	if (normalized === "application/pdf") return ".pdf";
	return fallback;
}

function guessMediaType(path: string): string | undefined {
	const ext = extname(path).toLowerCase();
	if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
	if (ext === ".png") return "image/png";
	if (ext === ".webp") return "image/webp";
	if (ext === ".gif") return "image/gif";
	return undefined;
}

function isImageMimeType(mimeType: string | undefined): boolean {
	return mimeType?.toLowerCase().startsWith("image/") ?? false;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export function parseTelegramNewSessionName(text: string): { name?: string; truncated: boolean } {
	const rawName = text.slice(4).trim();
	if (rawName.length === 0) return { name: undefined, truncated: false };
	if (rawName.length <= MAX_NEW_SESSION_NAME_LENGTH) return { name: rawName, truncated: false };
	return {
		name: rawName.slice(0, MAX_NEW_SESSION_NAME_LENGTH),
		truncated: true,
	};
}

export function formatNewSessionConfirmation(result: { name?: string; truncated: boolean }): string {
	if (!result.name) return "Started new session.";
	if (!result.truncated) return `Started new session: ${result.name}`;
	return `Started new session: ${result.name} (name truncated to ${MAX_NEW_SESSION_NAME_LENGTH} chars).`;
}

export function shouldWaitForTelegramPollingToStop(isHandlingTelegramUpdate: boolean): boolean {
	return !isHandlingTelegramUpdate;
}

function isTelegramThinkingLevel(value: string): value is TelegramThinkingLevel {
	return TELEGRAM_THINKING_LEVELS.includes(value as TelegramThinkingLevel);
}

export type TelegramModelCommand =
	| { ok: true; modelSpecifier: string; thinkingLevel?: TelegramThinkingLevel }
	| { ok: false; message: string };

export function parseTelegramModelCommand(
	tokens: string[],
): TelegramModelCommand {
	if (tokens.length !== 2 && tokens.length !== 3) {
		return { ok: false, message: "model change failed: usage: /model [provider/]model-id [thinking-level]" };
	}
	const modelSpecifier = tokens[1];
	if (!modelSpecifier) {
		return { ok: false, message: "model change failed: usage: /model [provider/]model-id [thinking-level]" };
	}
	if (tokens.length === 2) {
		return { ok: true, modelSpecifier };
	}
	const requestedThinkingLevel = (tokens[2] || "").toLowerCase();
	if (!isTelegramThinkingLevel(requestedThinkingLevel)) {
		return {
			ok: false,
			message: `model change failed: invalid thinking level: ${tokens[2]}; use ${TELEGRAM_THINKING_LEVELS.join("|")}`,
		};
	}
	return { ok: true, modelSpecifier, thinkingLevel: requestedThinkingLevel };
}

interface TelegramModelLookupModel {
	provider: string;
	id: string;
}

interface TelegramModelRegistryLookup<TModel extends TelegramModelLookupModel> {
	getAll(): readonly TModel[];
	find(provider: string, modelId: string): TModel | undefined;
}

export function resolveTelegramModelCommandTarget<TModel extends TelegramModelLookupModel>(options: {
	modelRegistry: TelegramModelRegistryLookup<TModel>;
	currentProvider: string;
	modelSpecifier: string;
}): { ok: true; model: TModel } | { ok: false; message: string } {
	const { modelRegistry, currentProvider, modelSpecifier } = options;

	// Build case-insensitive provider lookup
	const allModels = modelRegistry.getAll();
	const providerMap = new Map<string, string>();
	for (const m of allModels) {
		providerMap.set(m.provider.toLowerCase(), m.provider);
	}

	const slashIndex = modelSpecifier.indexOf("/");

	if (slashIndex === -1) {
		// No slash: exact match under current provider
		const model = modelRegistry.find(currentProvider, modelSpecifier);
		if (model) return { ok: true, model };
		return { ok: false, message: `model change failed: model not found: ${modelSpecifier}` };
	}

	// Has slash: try provider prefix
	const maybeProvider = modelSpecifier.substring(0, slashIndex);
	const canonicalProvider = providerMap.get(maybeProvider.toLowerCase());

	if (canonicalProvider) {
		// Known provider prefix: split on first slash, exact match
		const remainingModelId = modelSpecifier.substring(slashIndex + 1);
		const model = modelRegistry.find(canonicalProvider, remainingModelId);
		if (model) return { ok: true, model };
		return { ok: false, message: `model change failed: model not found: ${modelSpecifier} (provider: ${canonicalProvider})` };
	}

	// Unknown provider prefix: treat whole specifier as model id under current provider
	const model = modelRegistry.find(currentProvider, modelSpecifier);
	if (model) return { ok: true, model };
	return { ok: false, message: `model change failed: model not found: ${modelSpecifier}` };
}

export type TelegramGitCommand =
	| { ok: true; kind: "status" }
	| { ok: true; kind: "log" }
	| { ok: true; kind: "nb"; branchName: string }
	| { ok: false; message: string };

export function parseTelegramGitCommand(tokens: string[]): TelegramGitCommand {
	if (tokens.length < 2) return { ok: false, message: "usage: /git <status|log|nb>" };
	const sub = (tokens[1] || "").toLowerCase();
	if (sub === "status") return { ok: true, kind: "status" };
	if (sub === "log") return { ok: true, kind: "log" };
	if (sub === "nb") {
		if (tokens.length < 3) return { ok: false, message: "usage: /git nb <branch-name>" };
		if (tokens.length > 3) return { ok: false, message: "usage: /git nb <branch-name>" };
		const branchName = tokens[2]!;
		if (branchName.startsWith("-")) return { ok: false, message: "branch name cannot start with a dash" };
		return { ok: true, kind: "nb", branchName };
	}
	return { ok: false, message: "usage: /git <status|log|nb>" };
}

export function formatTelegramBotFatherCommands(): string {
	return TELEGRAM_BOTFATHER_COMMANDS.join("\n");
}

function escapeTelegramHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function formatTelegramHelpReply(options: { includeBotFatherCommands?: boolean } = {}): string {
	const sections = [
		"Send me a message and I will forward it to pi.",
		`Commands:\n${TELEGRAM_USER_COMMANDS.map(escapeTelegramHtml).join("\n")}`,
	];
	if (options.includeBotFatherCommands) {
		sections.push(`Copy this into BotFather /setcommands:\n\n<pre>${escapeTelegramHtml(formatTelegramBotFatherCommands())}</pre>`);
	}
	return sections.join("\n\n");
}

export function formatTelegramPairedReply(): string {
	return `Telegram bridge paired with this account.\n\n${formatTelegramHelpReply({ includeBotFatherCommands: true })}`;
}

export type TelegramGitExecStep = { args: string[]; failureTitle?: string };

export type TelegramGitExecSpec = { title: string; steps: TelegramGitExecStep[] };

export function getTelegramGitExecSpec(command: Extract<TelegramGitCommand, { ok: true }>): TelegramGitExecSpec {
	if (command.kind === "status") return { title: "git status", steps: [{ args: ["status", "--short", "--branch"] }] };
	if (command.kind === "log") return { title: "git log", steps: [{ args: ["log", "--oneline", "--decorate", "-20"] }] };
	return {
		title: `git nb ${command.branchName}`,
		steps: [
			{ args: ["check-ref-format", "--branch", command.branchName], failureTitle: "invalid branch name" },
			{ args: ["switch", "-c", command.branchName] },
		],
	};
}

export function formatTelegramGitReply(input: { title: string; exitCode: number; stdout: string; stderr: string }): string {
	const output = input.stdout || input.stderr;
	const body = output.length > 0 ? output : "(no output)";
	let reply = `${input.title}\n\n${body}`;
	if (reply.length > MAX_MESSAGE_LENGTH) {
		reply = reply.slice(0, MAX_MESSAGE_LENGTH - "\n\n[output truncated]".length) + "\n\n[output truncated]";
	}
	return reply;
}

export function formatTelegramActiveModelReply(
	model: { provider: string; id: string },
	thinkingLevel: TelegramThinkingLevel,
): string {
	return `active model: ${model.provider}/${model.id}; thinking: ${thinkingLevel}`;
}

export type TelegramStatusState = "idle" | "busy";

export function formatTelegramStatusReply(options: {
	sessionName?: string;
	status: TelegramStatusState;
	directory: string;
	telegramConfig?: { scope: "project" | "global"; path: string };
	model?: { provider: string; id: string };
	thinkingLevel: string;
	usageLine?: string;
	costLine?: string;
	contextLine: string;
}): string {
	const lines = [`Session: ${options.sessionName ?? "unnamed"}`, `Status: ${options.status}`, `Directory: ${options.directory}`];
	if (options.telegramConfig) {
		lines.push(`Telegram config: ${options.telegramConfig.scope === "project" ? "local" : "global"} (${options.telegramConfig.path})`);
	}
	if (options.model) {
		lines.push(`Model: ${options.model.provider}/${options.model.id}`);
	}
	lines.push(`Thinking: ${options.thinkingLevel}`);
	if (options.usageLine) lines.push(options.usageLine);
	if (options.costLine) lines.push(options.costLine);
	lines.push(options.contextLine);
	return lines.join("\n");
}

function getAgentMessageText(message: unknown): string {
	const value = message as Record<string, unknown>;
	const content = Array.isArray(value.content) ? value.content : [];
	return content
		.filter((block): block is { type: string; text?: string } => typeof block === "object" && block !== null && "type" in block)
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("")
		.trim();
}

export function findLastResendableAssistantText(entries: Array<{ type?: string; message?: unknown }>): string | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
		const message = entry.message as Record<string, unknown>;
		if (message.role !== "assistant") continue;
		if (message.stopReason === "error") continue;
		const text = getAgentMessageText(message);
		if (text.length === 0) continue;
		return text;
	}
	return undefined;
}

export function getTelegramResendReply(options: {
	isIdle: boolean;
	entries: Array<{ type?: string; message?: unknown }>;
}): { ok: true; text: string } | { ok: false; message: string } {
	if (!options.isIdle) {
		return { ok: false, message: 'resend failed: pi is busy; send "stop" first' };
	}
	const text = findLastResendableAssistantText(options.entries);
	if (!text) {
		return { ok: false, message: "No previous reply to resend." };
	}
	return { ok: true, text };
}

export function findPendingTelegramReconnectRequest(entries: Array<{ type?: string; customType?: string; data?: unknown }>): TelegramReconnectRequest | undefined {
	const consumed = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== TELEGRAM_RECONNECT_CONSUMED_ENTRY_TYPE || !entry.data || typeof entry.data !== "object") {
			continue;
		}
		const requestId = (entry.data as TelegramReconnectConsumed).requestId;
		if (typeof requestId === "string" && requestId.length > 0) consumed.add(requestId);
	}
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry.type !== "custom" || entry.customType !== TELEGRAM_RECONNECT_REQUEST_ENTRY_TYPE || !entry.data || typeof entry.data !== "object") {
			continue;
		}
		const request = entry.data as TelegramReconnectRequest;
		if (typeof request.requestId !== "string" || consumed.has(request.requestId)) continue;
		if (typeof request.chatId !== "number" || typeof request.replyToMessageId !== "number") continue;
		return request;
	}
	return undefined;
}

function chunkParagraphs(text: string): string[] {
	if (text.length <= MAX_MESSAGE_LENGTH) return [text];

	const normalized = text.replace(/\r\n/g, "\n");
	const paragraphs = normalized.split(/\n\n+/);
	const chunks: string[] = [];
	let current = "";

	const flushCurrent = (): void => {
		if (current.trim().length > 0) chunks.push(current);
		current = "";
	};

	const splitLongBlock = (block: string): string[] => {
		if (block.length <= MAX_MESSAGE_LENGTH) return [block];
		const lines = block.split("\n");
		const lineChunks: string[] = [];
		let lineCurrent = "";
		for (const line of lines) {
			const candidate = lineCurrent.length === 0 ? line : `${lineCurrent}\n${line}`;
			if (candidate.length <= MAX_MESSAGE_LENGTH) {
				lineCurrent = candidate;
				continue;
			}
			if (lineCurrent.length > 0) {
				lineChunks.push(lineCurrent);
				lineCurrent = "";
			}
			if (line.length <= MAX_MESSAGE_LENGTH) {
				lineCurrent = line;
				continue;
			}
			for (let i = 0; i < line.length; i += MAX_MESSAGE_LENGTH) {
				lineChunks.push(line.slice(i, i + MAX_MESSAGE_LENGTH));
			}
		}
		if (lineCurrent.length > 0) lineChunks.push(lineCurrent);
		return lineChunks;
	};

	for (const paragraph of paragraphs) {
		if (paragraph.length === 0) continue;
		const parts = splitLongBlock(paragraph);
		for (const part of parts) {
			const candidate = current.length === 0 ? part : `${current}\n\n${part}`;
			if (candidate.length <= MAX_MESSAGE_LENGTH) {
				current = candidate;
			} else {
				flushCurrent();
				current = part;
			}
		}
	}
	flushCurrent();
	return chunks;
}

export default function (pi: ExtensionAPI) {
	let config: TelegramConfig = {};
	let storage: TelegramStorage = getProjectTelegramPaths(process.cwd());
	let pollingController: AbortController | undefined;
	let pollingPromise: Promise<void> | undefined;
	let queuedTelegramTurns: PendingTelegramTurn[] = [];
	let activeTelegramTurn: ActiveTelegramTurn | undefined;
	let typingInterval: ReturnType<typeof setInterval> | undefined;
	let currentAbort: (() => void) | undefined;
	let preserveQueuedTurnsAsHistory = false;
	let setupInProgress = false;
	let previewState: TelegramPreviewState | undefined;
	let draftSupport: "unknown" | "supported" | "unsupported" = "unknown";
	let nextDraftId = 0;
	let handlingTelegramUpdate = false;
	let shuttingDown = false;
	const mediaGroups = new Map<string, TelegramMediaGroupState>();

	async function refreshStorage(cwd: string, scope?: TelegramStorageScope): Promise<void> {
		storage = await resolveTelegramStorage(cwd, { scope });
	}

	async function readConfig(): Promise<TelegramConfig> {
		config = await readTelegramConfig(storage);
		return config;
	}

	async function writeConfig(): Promise<void> {
		await writeTelegramConfig(storage, config);
	}

	function allocateDraftId(): number {
		nextDraftId = nextDraftId >= TELEGRAM_DRAFT_ID_MAX ? 1 : nextDraftId + 1;
		return nextDraftId;
	}

	function updateStatus(ctx: ExtensionContext, error?: string): void {
		const theme = ctx.ui.theme;
		const label = theme.fg("accent", "telegram");
		if (error) {
			ctx.ui.setStatus("telegram", `${label} ${theme.fg("error", "error")} ${theme.fg("muted", error)}`);
			return;
		}
		if (!config.botToken) {
			ctx.ui.setStatus("telegram", `${label} ${theme.fg("muted", "not configured")}`);
			return;
		}
		if (!pollingPromise) {
			ctx.ui.setStatus("telegram", `${label} ${theme.fg("muted", "disconnected")}`);
			return;
		}
		if (!config.allowedUserId) {
			ctx.ui.setStatus("telegram", `${label} ${theme.fg("warning", "awaiting pairing")}`);
			return;
		}
		if (activeTelegramTurn || queuedTelegramTurns.length > 0) {
			const queued = queuedTelegramTurns.length > 0 ? theme.fg("muted", ` +${queuedTelegramTurns.length} queued`) : "";
			ctx.ui.setStatus("telegram", `${label} ${theme.fg("accent", "processing")}${queued}`);
			return;
		}
		ctx.ui.setStatus("telegram", `${label} ${theme.fg("success", "connected")}`);
	}

	async function callTelegram<TResponse>(
		method: string,
		body: Record<string, unknown>,
		options?: { signal?: AbortSignal },
	): Promise<TResponse> {
		if (!config.botToken) throw new Error("Telegram bot token is not configured");
		const response = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: options?.signal,
		});
			const data = (await response.json()) as TelegramApiResponse<TResponse>;
		if (!data.ok || data.result === undefined) {
			throw new Error(data.description || `Telegram API ${method} failed`);
		}
		return data.result;
	}

	async function callTelegramMultipart<TResponse>(
		method: string,
		fields: Record<string, string>,
		fileField: string,
		filePath: string,
		fileName: string,
		options?: { signal?: AbortSignal },
	): Promise<TResponse> {
		if (!config.botToken) throw new Error("Telegram bot token is not configured");
		const form = new FormData();
		for (const [key, value] of Object.entries(fields)) {
			form.set(key, value);
		}
		const buffer = await readFile(filePath);
		form.set(fileField, new Blob([buffer]), fileName);
		const response = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
			method: "POST",
			body: form,
			signal: options?.signal,
		});
		const data = (await response.json()) as TelegramApiResponse<TResponse>;
		if (!data.ok || data.result === undefined) {
			throw new Error(data.description || `Telegram API ${method} failed`);
		}
		return data.result;
	}

	async function downloadTelegramFile(fileId: string, suggestedName: string): Promise<string> {
		if (!config.botToken) throw new Error("Telegram bot token is not configured");
		const file = await callTelegram<TelegramGetFileResult>("getFile", { file_id: fileId });
		await mkdir(storage.tempDir, { recursive: true });
		const targetPath = join(storage.tempDir, `${Date.now()}-${sanitizeFileName(suggestedName)}`);
		const response = await fetch(`https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`);
		if (!response.ok) throw new Error(`Failed to download Telegram file: ${response.status}`);
		const arrayBuffer = await response.arrayBuffer();
		await writeFile(targetPath, Buffer.from(arrayBuffer));
		return targetPath;
	}

	function startTypingLoop(ctx: ExtensionContext, chatId?: number): void {
		const targetChatId = chatId ?? activeTelegramTurn?.chatId;
		if (typingInterval || targetChatId === undefined) return;

		const sendTyping = async (): Promise<void> => {
			try {
				await callTelegram("sendChatAction", { chat_id: targetChatId, action: "typing" });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				updateStatus(ctx, `typing failed: ${message}`);
			}
		};

		void sendTyping();
		typingInterval = setInterval(() => {
			void sendTyping();
		}, 4000);
	}

	function stopTypingLoop(): void {
		if (!typingInterval) return;
		clearInterval(typingInterval);
		typingInterval = undefined;
	}

	function isAssistantMessage(message: AgentMessage): boolean {
		return (message as unknown as { role?: string }).role === "assistant";
	}

	function getMessageText(message: AgentMessage): string {
		return getAgentMessageText(message);
	}

	async function clearPreview(chatId: number): Promise<void> {
		const state = previewState;
		if (!state) return;
		if (state.flushTimer) {
			clearTimeout(state.flushTimer);
			state.flushTimer = undefined;
		}
		previewState = undefined;
		if (state.mode === "draft" && state.draftId !== undefined) {
			try {
				await callTelegram("sendMessageDraft", { chat_id: chatId, draft_id: state.draftId, text: "" });
			} catch {
				// ignore
			}
		}
	}

	async function flushPreview(chatId: number): Promise<void> {
		const state = previewState;
		if (!state) return;
		state.flushTimer = undefined;
		const text = state.pendingText.trim();
		if (!text || text === state.lastSentText) return;
		const truncated = text.length > MAX_MESSAGE_LENGTH ? text.slice(0, MAX_MESSAGE_LENGTH) : text;

		if (draftSupport !== "unsupported") {
			const draftId = state.draftId ?? allocateDraftId();
			state.draftId = draftId;
			try {
				await callTelegram("sendMessageDraft", { chat_id: chatId, draft_id: draftId, text: truncated });
				draftSupport = "supported";
				state.mode = "draft";
				state.lastSentText = truncated;
				return;
			} catch {
				draftSupport = "unsupported";
			}
		}

		if (state.messageId === undefined) {
			const sent = await callTelegram<TelegramSentMessage>("sendMessage", { chat_id: chatId, text: truncated });
			state.messageId = sent.message_id;
			state.mode = "message";
			state.lastSentText = truncated;
			return;
		}
		await callTelegram("editMessageText", { chat_id: chatId, message_id: state.messageId, text: truncated });
		state.mode = "message";
		state.lastSentText = truncated;
	}

	function schedulePreviewFlush(chatId: number): void {
		if (!previewState || previewState.flushTimer) return;
		previewState.flushTimer = setTimeout(() => {
			void flushPreview(chatId);
		}, PREVIEW_THROTTLE_MS);
	}

	async function finalizePreview(chatId: number): Promise<boolean> {
		const state = previewState;
		if (!state) return false;
		await flushPreview(chatId);
		const finalText = (state.pendingText.trim() || state.lastSentText).trim();
		if (!finalText) {
			await clearPreview(chatId);
			return false;
		}
		if (state.mode === "draft") {
			await callTelegram<TelegramSentMessage>("sendMessage", { chat_id: chatId, text: finalText });
			await clearPreview(chatId);
			return true;
		}
		previewState = undefined;
		return state.messageId !== undefined;
	}

	function runGit(args: string[], cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
		return new Promise((resolve) => {
			execFile("git", args, { cwd }, (error, stdout, stderr) => {
				resolve({
					exitCode: error ? (error as { code?: number }).code ?? 1 : 0,
					stdout: typeof stdout === "string" ? stdout : "",
					stderr: typeof stderr === "string" ? stderr : "",
				});
			});
		});
	}

	async function sendTextReply(chatId: number, _replyToMessageId: number, text: string, parseMode?: "HTML"): Promise<number | undefined> {
		// Use richText formatting if enabled and parseMode not explicitly set
		const useRichText = !parseMode && isTelegramRichTextEnabled(config);
		
		let chunks: string[];
		let effectiveParseMode: "HTML" | undefined;
		
		if (useRichText) {
			// Convert markdown to Telegram HTML and chunk with tag balancing
			const html = markdownToTelegramHtml(text);
			chunks = chunkTelegramHtml(html);
			effectiveParseMode = "HTML";
		} else {
			// Use plain text chunking
			chunks = chunkParagraphs(text);
			effectiveParseMode = parseMode;
		}
		
		let lastMessageId: number | undefined;
		for (const chunk of chunks) {
			const body: Record<string, unknown> = { chat_id: chatId, text: chunk };
			if (effectiveParseMode) body.parse_mode = effectiveParseMode;
			
			try {
				const sent = await callTelegram<TelegramSentMessage>("sendMessage", body);
				lastMessageId = sent.message_id;
			} catch (error) {
				// If HTML parse error, fall back to plain text for this chunk
				if (useRichText && error instanceof Error && error.message.toLowerCase().includes("parse")) {
					const plainBody: Record<string, unknown> = { chat_id: chatId, text: chunk };
					const sent = await callTelegram<TelegramSentMessage>("sendMessage", plainBody);
					lastMessageId = sent.message_id;
				} else {
					throw error;
				}
			}
		}
		return lastMessageId;
	}

	async function sendQueuedAttachments(turn: ActiveTelegramTurn): Promise<void> {
		for (const attachment of turn.queuedAttachments) {
			try {
				const mediaType = guessMediaType(attachment.path);
				const method = mediaType ? "sendPhoto" : "sendDocument";
				const fieldName = mediaType ? "photo" : "document";
				await callTelegramMultipart<TelegramSentMessage>(
					method,
					{
						chat_id: String(turn.chatId),
					},
					fieldName,
					attachment.path,
					attachment.fileName,
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				await sendTextReply(turn.chatId, turn.replyToMessageId, `Failed to send attachment ${attachment.fileName}: ${message}`);
			}
		}
	}

	function extractAssistantText(messages: AgentMessage[]): { text?: string; stopReason?: string; errorMessage?: string } {
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i] as unknown as Record<string, unknown>;
			if (message.role !== "assistant") continue;
			const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
			const errorMessage = typeof message.errorMessage === "string" ? message.errorMessage : undefined;
			const text = getAgentMessageText(message);
			return { text: text || undefined, stopReason, errorMessage };
		}
		return {};
	}

	function collectTelegramFileInfos(messages: TelegramMessage[]): TelegramFileInfo[] {
		const files: TelegramFileInfo[] = [];
		for (const message of messages) {
			if (Array.isArray(message.photo) && message.photo.length > 0) {
				const photo = [...message.photo].sort((a, b) => (a.file_size ?? 0) - (b.file_size ?? 0)).pop();
				if (photo) {
					files.push({
						file_id: photo.file_id,
						fileName: `photo-${message.message_id}.jpg`,
						mimeType: "image/jpeg",
						isImage: true,
					});
				}
			}
			if (message.document) {
				const fileName = message.document.file_name || `document-${message.message_id}${guessExtensionFromMime(message.document.mime_type, "")}`;
				files.push({
					file_id: message.document.file_id,
					fileName,
					mimeType: message.document.mime_type,
					isImage: isImageMimeType(message.document.mime_type),
				});
			}
			if (message.video) {
				const fileName = message.video.file_name || `video-${message.message_id}${guessExtensionFromMime(message.video.mime_type, ".mp4")}`;
				files.push({
					file_id: message.video.file_id,
					fileName,
					mimeType: message.video.mime_type,
					isImage: false,
				});
			}
			if (message.audio) {
				const fileName = message.audio.file_name || `audio-${message.message_id}${guessExtensionFromMime(message.audio.mime_type, ".mp3")}`;
				files.push({
					file_id: message.audio.file_id,
					fileName,
					mimeType: message.audio.mime_type,
					isImage: false,
				});
			}
			if (message.voice) {
				files.push({
					file_id: message.voice.file_id,
					fileName: `voice-${message.message_id}${guessExtensionFromMime(message.voice.mime_type, ".ogg")}`,
					mimeType: message.voice.mime_type,
					isImage: false,
				});
			}
			if (message.animation) {
				const fileName = message.animation.file_name || `animation-${message.message_id}${guessExtensionFromMime(message.animation.mime_type, ".mp4")}`;
				files.push({
					file_id: message.animation.file_id,
					fileName,
					mimeType: message.animation.mime_type,
					isImage: false,
				});
			}
			if (message.sticker) {
				files.push({
					file_id: message.sticker.file_id,
					fileName: `sticker-${message.message_id}.webp`,
					mimeType: "image/webp",
					isImage: true,
				});
			}
		}
		return files;
	}

	async function buildTelegramFiles(messages: TelegramMessage[]): Promise<DownloadedTelegramFile[]> {
		const downloaded: DownloadedTelegramFile[] = [];
		for (const file of collectTelegramFileInfos(messages)) {
			const path = await downloadTelegramFile(file.file_id, file.fileName);
			downloaded.push({ path, fileName: file.fileName, isImage: file.isImage, mimeType: file.mimeType });
		}
		return downloaded;
	}

	async function selectSetupScope(ctx: ExtensionContext): Promise<TelegramStorageScope | undefined> {
		const choice = await ctx.ui.select("Where should Telegram config be stored?", [
			"Project-local: .pi/telegram.json",
			"Global: ~/.pi/agent/telegram.json",
		]);
		if (!choice) return undefined;
		return choice.startsWith("Global:") ? "global" : "project";
	}

	async function promptForConfig(ctx: ExtensionContext, requestedScope?: TelegramStorageScope): Promise<void> {
		if (!ctx.hasUI || setupInProgress) return;
		setupInProgress = true;
		try {
			const setupScope = requestedScope ?? (await selectSetupScope(ctx));
			if (!setupScope) return;
			await refreshStorage(ctx.cwd, setupScope);
			config = await readConfig();
			const token = await ctx.ui.input("Telegram bot token", "123456:ABCDEF...");
			if (!token) return;

			const nextConfig: TelegramConfig = { ...config, botToken: token.trim() };
			const response = await fetch(`https://api.telegram.org/bot${nextConfig.botToken}/getMe`);
			const data = (await response.json()) as TelegramApiResponse<TelegramUser>;
			if (!data.ok || !data.result) {
				ctx.ui.notify(data.description || "Invalid Telegram bot token", "error");
				return;
			}

			nextConfig.botId = data.result.id;
			nextConfig.botUsername = data.result.username;
			config = nextConfig;
			if (storage.scope === "project") {
				await ensureProjectTelegramGitIgnore(ctx.cwd);
			}
			await writeConfig();
			ctx.ui.notify(`Telegram bot connected: @${config.botUsername ?? "unknown"}`, "info");
			ctx.ui.notify(`Stored config in ${storage.configPath}`, "info");
			if (storage.scope === "project") {
				ctx.ui.notify("Updated project .gitignore for Telegram local secrets/cache.", "info");
			}
			ctx.ui.notify("Send /start to your bot in Telegram to pair this extension with your account.", "info");
			await startPolling(ctx);
			updateStatus(ctx);
		} finally {
			setupInProgress = false;
		}
	}

	async function stopPolling(options: { wait?: boolean } = {}): Promise<void> {
		const wait = options.wait ?? true;
		const promise = pollingPromise;
		stopTypingLoop();
		pollingController?.abort();
		pollingController = undefined;
		if (wait) await promise?.catch(() => undefined);
		pollingPromise = undefined;
	}

	function formatTelegramHistoryText(rawText: string, files: DownloadedTelegramFile[]): string {
		let summary = rawText.length > 0 ? rawText : "(no text)";
		if (files.length > 0) {
			summary += `\nAttachments:`;
			for (const file of files) {
				summary += `\n- ${file.path}`;
			}
		}
		return summary;
	}

	async function createTelegramTurn(
		messages: TelegramMessage[],
		historyTurns: PendingTelegramTurn[] = [],
	): Promise<PendingTelegramTurn> {
		const firstMessage = messages[0];
		if (!firstMessage) throw new Error("Missing Telegram message for turn creation");
		const rawText = messages.map((message) => (message.text || message.caption || "").trim()).filter(Boolean).join("\n\n");
		const files = await buildTelegramFiles(messages);
		const content: Array<TextContent | ImageContent> = [];
		let prompt = `${TELEGRAM_PREFIX}`;

		if (historyTurns.length > 0) {
			prompt += `\n\nEarlier Telegram messages arrived after an aborted turn. Treat them as prior user messages, in order:`;
			for (const [index, turn] of historyTurns.entries()) {
				prompt += `\n\n${index + 1}. ${turn.historyText}`;
			}
			prompt += `\n\nCurrent Telegram message:`;
		}

		if (rawText.length > 0) {
			prompt += historyTurns.length > 0 ? `\n${rawText}` : ` ${rawText}`;
		}
		if (files.length > 0) {
			prompt += `\n\nTelegram attachments were saved locally:`;
			for (const file of files) {
				prompt += `\n- ${file.path}`;
			}
		}
		content.push({ type: "text", text: prompt });

		for (const file of files) {
			if (!file.isImage) continue;
			const mediaType = file.mimeType || guessMediaType(file.path);
			if (!mediaType) continue;
			const buffer = await readFile(file.path);
			content.push({
				type: "image",
				data: buffer.toString("base64"),
				mimeType: mediaType,
			});
		}

		return {
			chatId: firstMessage.chat.id,
			replyToMessageId: firstMessage.message_id,
			queuedAttachments: [],
			content,
			historyText: formatTelegramHistoryText(rawText, files),
		};
	}

	async function dispatchAuthorizedTelegramMessages(messages: TelegramMessage[], ctx: ExtensionContext): Promise<void> {
		const firstMessage = messages[0];
		if (!firstMessage) return;
		const rawText = messages.map((message) => (message.text || message.caption || "").trim()).find((text) => text.length > 0) || "";
		const textCommandSource = messages.map((message) => (message.text || "").trim()).find((text) => text.length > 0) || "";
		const tokens = rawText.trim().split(/\s+/).filter(Boolean);
		const command = (tokens[0] || "").toLowerCase();
		const arg = tokens[1];
		const textCommand = (textCommandSource.split(/\s+/, 1)[0] || "").toLowerCase();

		if (command === "/new") {
			if (textCommand !== "/new") {
				await sendTextReply(firstMessage.chat.id, firstMessage.message_id, "new session failed: /new must be sent as a text message.");
				return;
			}
			if (!ctx.isIdle()) {
				await sendTextReply(firstMessage.chat.id, firstMessage.message_id, 'new session failed: pi is busy; send "stop" first');
				return;
			}
			const sessionCommandContext = telegramCommandContextStore.get();
			if (!sessionCommandContext) {
				await sendTextReply(firstMessage.chat.id, firstMessage.message_id, "new session failed: run /telegram-connect in pi and retry.");
				return;
			}
			const parsedName = parseTelegramNewSessionName(textCommandSource);
			queuedTelegramTurns = [];
			preserveQueuedTurnsAsHistory = false;
			const request: TelegramReconnectRequest = {
				requestId: crypto.randomUUID(),
				chatId: firstMessage.chat.id,
				replyToMessageId: firstMessage.message_id,
				sessionName: parsedName.name,
				truncated: parsedName.truncated,
			};
			const result = await createTelegramNewSessionWithFreshContext(telegramCommandContextStore, {
				parentSession: sessionCommandContext.sessionManager.getSessionFile(),
				setup: async (sessionManager) => {
					const writableSessionManager = sessionManager as {
						appendSessionInfo(name: string): void;
						appendCustomEntry(customType: string, data?: unknown): void;
					};
					if (request.sessionName) writableSessionManager.appendSessionInfo(request.sessionName);
					writableSessionManager.appendCustomEntry(TELEGRAM_RECONNECT_REQUEST_ENTRY_TYPE, request);
				},
			});
			if (result.cancelled) {
				await sendTextReply(firstMessage.chat.id, firstMessage.message_id, "New session cancelled.");
			}
			return;
		}

		if (command === "stop" || command === "/stop") {
			if (currentAbort) {
				if (queuedTelegramTurns.length > 0) {
					preserveQueuedTurnsAsHistory = true;
				}
				currentAbort();
				updateStatus(ctx);
				await sendTextReply(firstMessage.chat.id, firstMessage.message_id, "Aborted current turn.");
			} else {
				await sendTextReply(firstMessage.chat.id, firstMessage.message_id, "No active turn.");
			}
			return;
		}

		if (command === "/compact") {
			if (!ctx.isIdle()) {
				await sendTextReply(firstMessage.chat.id, firstMessage.message_id, "Cannot compact while pi is busy. Send \"stop\" first.");
				return;
			}
			ctx.compact({
				onComplete: () => {
					void sendTextReply(firstMessage.chat.id, firstMessage.message_id, "Compaction completed.");
				},
				onError: (error) => {
					const message = error instanceof Error ? error.message : String(error);
					void sendTextReply(firstMessage.chat.id, firstMessage.message_id, `Compaction failed: ${message}`);
				},
			});
			await sendTextReply(firstMessage.chat.id, firstMessage.message_id, "Compaction started.");
			return;
		}

		if (command === "/resend") {
			const resend = getTelegramResendReply({
				isIdle: ctx.isIdle(),
				entries: ctx.sessionManager.getEntries(),
			});
			await sendTextReply(firstMessage.chat.id, firstMessage.message_id, resend.ok ? resend.text : resend.message);
			return;
		}

		if (command === "/status") {
			let totalInput = 0;
			let totalOutput = 0;
			let totalCacheRead = 0;
			let totalCacheWrite = 0;
			let totalCost = 0;

			for (const entry of ctx.sessionManager.getEntries()) {
				if (entry.type !== "message" || entry.message.role !== "assistant") continue;
				totalInput += entry.message.usage.input;
				totalOutput += entry.message.usage.output;
				totalCacheRead += entry.message.usage.cacheRead;
				totalCacheWrite += entry.message.usage.cacheWrite;
				totalCost += entry.message.usage.cost.total;
			}

			const usage = ctx.getContextUsage();
			const tokenParts: string[] = [];
			if (totalInput) tokenParts.push(`↑${formatTokens(totalInput)}`);
			if (totalOutput) tokenParts.push(`↓${formatTokens(totalOutput)}`);
			if (totalCacheRead) tokenParts.push(`R${formatTokens(totalCacheRead)}`);
			if (totalCacheWrite) tokenParts.push(`W${formatTokens(totalCacheWrite)}`);
			const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
			let contextLine = "Context: unknown";
			if (usage) {
				const contextWindow = usage.contextWindow ?? ctx.model?.contextWindow ?? 0;
				const percent = usage.percent !== null ? `${usage.percent.toFixed(1)}%` : "?";
				contextLine = `Context: ${percent}/${formatTokens(contextWindow)}`;
			}
			await sendTextReply(
				firstMessage.chat.id,
				firstMessage.message_id,
				formatTelegramStatusReply({
					sessionName: pi.getSessionName() ?? "unnamed",
					status: ctx.isIdle() ? "idle" : "busy",
					directory: ctx.cwd || process.cwd(),
					telegramConfig: { scope: storage.scope, path: storage.configPath },
					model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
					thinkingLevel: pi.getThinkingLevel(),
					usageLine: tokenParts.length > 0 ? `Usage: ${tokenParts.join(" ")}` : undefined,
					costLine: totalCost || usingSubscription ? `Cost: $${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}` : undefined,
					contextLine,
				}),
			);
			return;
		}

		if (command === "/model") {
			if (!ctx.isIdle()) {
				await sendTextReply(firstMessage.chat.id, firstMessage.message_id, 'model change failed: pi is busy; send "stop" first');
				return;
			}
			const parsed = parseTelegramModelCommand(tokens);
			if (!parsed.ok) {
				await sendTextReply(firstMessage.chat.id, firstMessage.message_id, parsed.message);
				return;
			}
			if (!ctx.model) {
				await sendTextReply(
					firstMessage.chat.id,
					firstMessage.message_id,
					"model change failed: No model is selected. In pi, run /settings → Model to pick one, then retry /model [provider/]model-id.",
				);
				return;
			}
			const resolved = resolveTelegramModelCommandTarget({
				modelRegistry: ctx.modelRegistry,
				currentProvider: ctx.model.provider,
				modelSpecifier: parsed.modelSpecifier,
			});
			if (!resolved.ok) {
				await sendTextReply(firstMessage.chat.id, firstMessage.message_id, resolved.message);
				return;
			}
			const nextModel = resolved.model;
			const changed = await pi.setModel(nextModel);
			if (!changed) {
				await sendTextReply(
					firstMessage.chat.id,
					firstMessage.message_id,
					`model change failed: auth not configured for provider ${nextModel.provider}`,
				);
				return;
			}
			if (parsed.thinkingLevel) {
				pi.setThinkingLevel(parsed.thinkingLevel);
			}
			await sendTextReply(
				firstMessage.chat.id,
				firstMessage.message_id,
				formatTelegramActiveModelReply({ provider: nextModel.provider, id: nextModel.id }, pi.getThinkingLevel()),
			);
			return;
		}

		if (command === "/thinking") {
			if (!ctx.isIdle()) {
				await sendTextReply(firstMessage.chat.id, firstMessage.message_id, 'thinking change failed: pi is busy; send "stop" first');
				return;
			}
			const requested = (arg || "").toLowerCase();
			if (!isTelegramThinkingLevel(requested)) {
				await sendTextReply(firstMessage.chat.id, firstMessage.message_id, "thinking change failed: usage: /thinking <off|minimal|low|medium|high|xhigh>");
				return;
			}
			pi.setThinkingLevel(requested);
			const actual = pi.getThinkingLevel();
			if (actual === requested) {
				await sendTextReply(firstMessage.chat.id, firstMessage.message_id, `thinking successfully changed: ${actual}`);
			} else {
				await sendTextReply(firstMessage.chat.id, firstMessage.message_id, `thinking successfully changed (clamped to ${actual})`);
			}
			return;
		}

		if (command === "/help") {
			await sendTextReply(firstMessage.chat.id, firstMessage.message_id, formatTelegramHelpReply({ includeBotFatherCommands: true }), "HTML");
			if (config.allowedUserId === undefined && firstMessage.from) {
				config.allowedUserId = firstMessage.from.id;
				await writeConfig();
				updateStatus(ctx);
			}
			return;
		}

		if (command === "/start") {
			await sendTextReply(firstMessage.chat.id, firstMessage.message_id, formatTelegramHelpReply({ includeBotFatherCommands: true }), "HTML");
			if (config.allowedUserId === undefined && firstMessage.from) {
				config.allowedUserId = firstMessage.from.id;
				await writeConfig();
				updateStatus(ctx);
			}
			return;
		}

		if (command === "/git") {
			const parsed = parseTelegramGitCommand(tokens);
			if (!parsed.ok) {
				await sendTextReply(firstMessage.chat.id, firstMessage.message_id, parsed.message);
				return;
			}
			if (parsed.kind === "nb" && !ctx.isIdle()) {
				await sendTextReply(firstMessage.chat.id, firstMessage.message_id, "git nb failed: pi is busy; send \"stop\" first");
				return;
			}
			const spec = getTelegramGitExecSpec(parsed);
			const gitCwd = ctx.cwd || process.cwd();
			let result: { exitCode: number; stdout: string; stderr: string } | undefined;
			for (const step of spec.steps) {
				result = await runGit(step.args, gitCwd);
				if (result.exitCode !== 0) {
					const title = step.failureTitle || `${spec.title} failed`;
					await sendTextReply(firstMessage.chat.id, firstMessage.message_id, formatTelegramGitReply({ title, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }));
					return;
				}
			}
			await sendTextReply(firstMessage.chat.id, firstMessage.message_id, formatTelegramGitReply({ title: spec.title, exitCode: result!.exitCode, stdout: result!.stdout, stderr: result!.stderr }));
			return;
		}

		if (command.startsWith("/")) {
			await sendTextReply(firstMessage.chat.id, firstMessage.message_id, "invalid command, type /help if you need help");
			return;
		}

		const historyTurns = preserveQueuedTurnsAsHistory ? queuedTelegramTurns.splice(0) : [];
		preserveQueuedTurnsAsHistory = false;
		const turn = await createTelegramTurn(messages, historyTurns);
		queuedTelegramTurns.push(turn);
		if (ctx.isIdle()) {
			startTypingLoop(ctx, turn.chatId);
			updateStatus(ctx);
			pi.sendUserMessage(turn.content);
		}
	}

	async function handleAuthorizedTelegramMessage(message: TelegramMessage, ctx: ExtensionContext): Promise<void> {
		if (message.media_group_id) {
			const key = `${message.chat.id}:${message.media_group_id}`;
			const existing = mediaGroups.get(key) ?? { messages: [] };
			existing.messages.push(message);
			if (existing.flushTimer) clearTimeout(existing.flushTimer);
			existing.flushTimer = setTimeout(() => {
				const state = mediaGroups.get(key);
				mediaGroups.delete(key);
				if (!state) return;
				void dispatchAuthorizedTelegramMessages(state.messages, ctx);
			}, TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS);
			mediaGroups.set(key, existing);
			return;
		}

		await dispatchAuthorizedTelegramMessages([message], ctx);
	}

	async function handleUpdate(update: TelegramUpdate, ctx: ExtensionContext): Promise<void> {
		const message = update.message || update.edited_message;
		if (!message || message.chat.type !== "private" || !message.from || message.from.is_bot) return;
		if (update.edited_message && !update.message && message.text?.trim().toLowerCase().startsWith("/new")) return;

		if (config.allowedUserId === undefined) {
			config.allowedUserId = message.from.id;
			await writeConfig();
			updateStatus(ctx);
			const command = ((message.text || "").trim().split(/\s+/, 1)[0] || "").toLowerCase();
			if (command === "/start" || command === "/help") {
				await sendTextReply(message.chat.id, message.message_id, formatTelegramPairedReply(), "HTML");
				return;
			}
			await sendTextReply(message.chat.id, message.message_id, "Telegram bridge paired with this account.");
		}

		if (message.from.id !== config.allowedUserId) {
			await sendTextReply(message.chat.id, message.message_id, "This bot is not authorized for your account.");
			return;
		}

		await handleAuthorizedTelegramMessage(message, ctx);
	}

	async function pollLoop(ctx: ExtensionContext, signal: AbortSignal): Promise<void> {
		if (!config.botToken) return;

		try {
			await callTelegram("deleteWebhook", { drop_pending_updates: false }, { signal });
		} catch {
			// ignore
		}

		if (config.lastUpdateId === undefined) {
			try {
				const updates = await callTelegram<TelegramUpdate[]>("getUpdates", { offset: -1, limit: 1, timeout: 0 }, { signal });
				const last = updates.at(-1);
				if (last) {
					config.lastUpdateId = last.update_id;
					await writeConfig();
				}
			} catch {
				// ignore
			}
		}

		while (!signal.aborted) {
			try {
				const updates = await callTelegram<TelegramUpdate[]>(
					"getUpdates",
					{
						offset: config.lastUpdateId !== undefined ? config.lastUpdateId + 1 : undefined,
						limit: 10,
						timeout: 30,
						allowed_updates: ["message", "edited_message"],
					},
					{ signal },
				);
				for (const update of updates) {
					if (signal.aborted) return;
					config.lastUpdateId = update.update_id;
					await writeConfig();
					handlingTelegramUpdate = true;
					try {
						await handleUpdate(update, ctx);
					} finally {
						handlingTelegramUpdate = false;
					}
					if (signal.aborted) return;
				}
			} catch (error) {
				if (signal.aborted) return;
				if (error instanceof DOMException && error.name === "AbortError") return;
				const message = error instanceof Error ? error.message : String(error);
				updateStatus(ctx, message);
				await new Promise((resolve) => setTimeout(resolve, 3000));
				updateStatus(ctx);
			}
		}
	}

	async function startPolling(ctx: ExtensionContext): Promise<void> {
		if (!config.botToken || pollingPromise) return;
		pollingController = new AbortController();
		pollingPromise = pollLoop(ctx, pollingController.signal).finally(() => {
			pollingPromise = undefined;
			pollingController = undefined;
			if (!shuttingDown) updateStatus(ctx);
		});
		updateStatus(ctx);
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
			if (!activeTelegramTurn) {
				throw new Error("telegram_attach can only be used while replying to an active Telegram turn");
			}
			const added: string[] = [];
			for (const inputPath of params.paths) {
				const stats = await stat(inputPath);
				if (!stats.isFile()) {
					throw new Error(`Not a file: ${inputPath}`);
				}
				if (activeTelegramTurn.queuedAttachments.length >= MAX_ATTACHMENTS_PER_TURN) {
					throw new Error(`Attachment limit reached (${MAX_ATTACHMENTS_PER_TURN})`);
				}
				activeTelegramTurn.queuedAttachments.push({ path: inputPath, fileName: basename(inputPath) });
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
		handler: async (args, ctx) => {
			const parsed = parseTelegramStorageScopeArg(args);
			if (!parsed.ok) {
				ctx.ui.notify("usage: /telegram-setup [local|global]", "error");
				return;
			}
			await promptForConfig(ctx, parsed.scope);
		},
	});

	pi.registerCommand("telegram-status", {
		description: "Show Telegram bridge status",
		handler: async (_args, ctx) => {
			const status = [
				`bot: ${config.botUsername ? `@${config.botUsername}` : "not configured"}`,
				`allowed user: ${config.allowedUserId ?? "not paired"}`,
				`storage: ${storage.scope}`,
				`config: ${storage.configPath}`,
				`temp: ${storage.tempDir}`,
				`polling: ${pollingPromise ? "running" : "stopped"}`,
				`active telegram turn: ${activeTelegramTurn ? "yes" : "no"}`,
				`queued telegram turns: ${queuedTelegramTurns.length}`,
			];
			ctx.ui.notify(status.join(" | "), "info");
		},
	});

	pi.registerCommand("telegram-connect", {
		description: "Start the Telegram bridge in this pi session",
		handler: async (args, ctx) => {
			const parsed = parseTelegramStorageScopeArg(args);
			if (!parsed.ok) {
				ctx.ui.notify("usage: /telegram-connect [local|global]", "error");
				return;
			}
			telegramCommandContextStore.set(ctx);
			await refreshStorage(ctx.cwd, parsed.scope);
			config = await readConfig();
			if (!config.botToken) {
				await promptForConfig(ctx, parsed.scope);
				return;
			}
			await mkdir(storage.tempDir, { recursive: true });
			await startPolling(ctx);
			updateStatus(ctx);
		},
	});

	pi.registerCommand("telegram-disconnect", {
		description: "Stop the Telegram bridge in this pi session",
		handler: async (_args, ctx) => {
			await stopPolling();
			updateStatus(ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		shuttingDown = false;
		await refreshStorage(ctx.cwd);
		config = await readConfig();
		await mkdir(storage.tempDir, { recursive: true });
		updateStatus(ctx);

		const reconnectRequest = findPendingTelegramReconnectRequest(ctx.sessionManager.getEntries());
		if (!reconnectRequest) return;
		try {
			await startPolling(ctx);
			await sendTextReply(
				reconnectRequest.chatId,
				reconnectRequest.replyToMessageId,
				formatNewSessionConfirmation({ name: reconnectRequest.sessionName, truncated: reconnectRequest.truncated ?? false }),
			);
			pi.appendEntry(TELEGRAM_RECONNECT_CONSUMED_ENTRY_TYPE, { requestId: reconnectRequest.requestId } satisfies TelegramReconnectConsumed);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Telegram reconnect after /new failed: ${message}`, "error");
		}
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		shuttingDown = true;
		queuedTelegramTurns = [];
		for (const state of mediaGroups.values()) {
			if (state.flushTimer) clearTimeout(state.flushTimer);
		}
		mediaGroups.clear();
		if (activeTelegramTurn) {
			await clearPreview(activeTelegramTurn.chatId);
		}
		activeTelegramTurn = undefined;
		currentAbort = undefined;
		preserveQueuedTurnsAsHistory = false;
		await stopPolling({ wait: shouldWaitForTelegramPollingToStop(handlingTelegramUpdate) });
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
		currentAbort = () => ctx.abort();
		if (!activeTelegramTurn && queuedTelegramTurns.length > 0) {
			const nextTurn = queuedTelegramTurns.shift();
			if (nextTurn) {
				activeTelegramTurn = { ...nextTurn };
				previewState = createTelegramPreviewState(config, draftSupport);
				startTypingLoop(ctx);
			}
		}
		updateStatus(ctx);
	});

	pi.on("message_start", async (event, _ctx) => {
		if (!activeTelegramTurn || !isAssistantMessage(event.message)) return;
		if (!areTelegramPreviewsEnabled(config)) return;
		if (previewState && (previewState.pendingText.trim().length > 0 || previewState.lastSentText.trim().length > 0)) {
			await finalizePreview(activeTelegramTurn.chatId);
		}
		previewState = createTelegramPreviewState(config, draftSupport);
	});

	pi.on("message_update", async (event, _ctx) => {
		if (!activeTelegramTurn || !isAssistantMessage(event.message)) return;
		if (!areTelegramPreviewsEnabled(config)) return;
		if (!previewState) {
			previewState = createTelegramPreviewState(config, draftSupport);
		}
		if (!previewState) return;
		previewState.pendingText = getMessageText(event.message);
		schedulePreviewFlush(activeTelegramTurn.chatId);
	});

	pi.on("agent_end", async (event, ctx) => {
		const turn = activeTelegramTurn;
		currentAbort = undefined;
		stopTypingLoop();
		activeTelegramTurn = undefined;
		updateStatus(ctx);
		if (!turn) return;

		const assistant = extractAssistantText(event.messages);
		if (assistant.stopReason === "aborted") {
			await clearPreview(turn.chatId);
			return;
		}
		if (assistant.stopReason === "error") {
			await clearPreview(turn.chatId);
			await sendTextReply(turn.chatId, turn.replyToMessageId, assistant.errorMessage || "Telegram bridge: pi failed while processing the request.");
			return;
		}

		const finalText = assistant.text;
		if (previewState) {
			previewState.pendingText = finalText ?? previewState.pendingText;
		}

		const deliveryMode = getTelegramFinalDeliveryMode(config, finalText);
		if (deliveryMode === "preview") {
			await finalizePreview(turn.chatId);
		} else {
			await clearPreview(turn.chatId);
			if (deliveryMode === "text" && finalText) {
				await sendTextReply(turn.chatId, turn.replyToMessageId, finalText);
			} else if (turn.queuedAttachments.length > 0) {
				await sendTextReply(turn.chatId, turn.replyToMessageId, "Attached requested file(s).");
			}
		}

		await sendQueuedAttachments(turn);

		if (queuedTelegramTurns.length > 0 && !preserveQueuedTurnsAsHistory) {
			const nextTurn = queuedTelegramTurns[0];
			startTypingLoop(ctx, nextTurn.chatId);
			updateStatus(ctx);
			pi.sendUserMessage(nextTurn.content);
		}
	});
}
