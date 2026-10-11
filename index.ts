import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { homedir } from "node:os";

import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { markdownToTelegramHtml, telegramVisibleLength } from "./markdown.ts";

interface TelegramConfig {
	botToken?: string;
	botUsername?: string;
	botId?: number;
	allowedUserId?: number;
	lastUpdateId?: number;
	/** Render replies as Telegram rich messages (Bot API 10.1+) so Markdown renders natively. Defaults to true. */
	richMessages?: boolean;
	/** Transcribe inbound Telegram voice notes to text. Defaults to true. */
	voiceTranscription?: boolean;
	/** MLX Whisper model repo used for voice transcription. */
	voiceModel?: string;
	/** Language hint for voice transcription; "auto" lets Whisper detect it. Defaults to "auto". */
	voiceLanguage?: string;
}

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
	isVoice?: boolean;
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
	isVoice?: boolean;
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

/**
 * Raised when the transcription toolchain itself cannot run (`uv` or the interpreter is
 * missing). Only this permanently disables voice transcription; a clip that merely fails
 * to decode stays a per-message problem.
 */
class VoiceToolingUnavailableError extends Error {}

interface TelegramPreviewState {
	mode: "rich-draft" | "draft" | "message";
	draftId?: number;
	messageId?: number;
	pendingText: string;
	lastSentText: string;
	flushTimer?: ReturnType<typeof setTimeout>;
}

interface TelegramMediaGroupState {
	messages: TelegramMessage[];
	flushTimer?: ReturnType<typeof setTimeout>;
}

const VOICE_TRANSCRIBE_TIMEOUT_MS = 120_000;
const DEFAULT_VOICE_MODEL = "mlx-community/whisper-small-mlx";
// Whisper renders Chinese as Traditional by default; this biases it to Simplified.
const SIMPLIFIED_CHINESE_PROMPT = "以下是普通话的句子。";

// Piped to `uv run ... python -` on stdin, so the extension stays a single file and we
// never have to resolve a sibling script path through the extension loader.
const VOICE_TRANSCRIBE_SCRIPT = `
import json
import os
import sys

os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")


def fail(message):
    print(json.dumps({"error": message}, ensure_ascii=False))
    sys.exit(1)


def main():
    if len(sys.argv) < 2:
        fail("usage: transcribe <audio-path> [model] [language]")
    path = sys.argv[1]
    model = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else "mlx-community/whisper-small-mlx"
    language = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else "auto"

    try:
        import av
        import mlx_whisper
        import numpy as np
    except Exception as exc:
        fail("missing python dependency: " + str(exc))

    # Decode with PyAV, which bundles its own FFmpeg libraries, so no system
    # ffmpeg binary is required to read Telegram's Ogg/Opus voice notes.
    try:
        container = av.open(path)
        stream = container.streams.audio[0]
        resampler = av.AudioResampler(format="fltp", layout="mono", rate=16000)
        blocks = []
        for frame in container.decode(stream):
            for resampled in resampler.resample(frame):
                blocks.append(resampled.to_ndarray())
        container.close()
    except Exception as exc:
        fail("could not decode audio: " + str(exc))

    if not blocks:
        fail("no audio samples decoded")

    audio = np.concatenate(blocks, axis=1).flatten().astype(np.float32)

    options = {"path_or_hf_repo": model}
    if language != "auto":
        options["language"] = language
    if language == "auto" or language.lower().startswith("zh"):
        options["initial_prompt"] = ${JSON.stringify(SIMPLIFIED_CHINESE_PROMPT)}

    try:
        result = mlx_whisper.transcribe(audio, **options)
    except Exception as exc:
        fail("transcription failed: " + str(exc))

    print(json.dumps({
        "text": (result.get("text") or "").strip(),
        "language": result.get("language"),
        "durationSeconds": round(float(audio.shape[0]) / 16000.0, 2),
    }, ensure_ascii=False))


main()
`;

const CONFIG_PATH = join(homedir(), ".pi", "agent", "telegram.json");
const TEMP_DIR = join(homedir(), ".pi", "agent", "tmp", "telegram");
const TELEGRAM_PREFIX = "[telegram]";
const MAX_MESSAGE_LENGTH = 4096;
// Rich messages allow up to 32768 UTF-8 characters, i.e. 8x the plain-text limit.
const MAX_RICH_MESSAGE_LENGTH = 32768;
// Rich messages are only disabled permanently when Telegram says the bot cannot use
// them at all. Content-specific rejections fall back per message instead, so one
// unrenderable reply cannot force every later reply back to plain text.
const RICH_UNAVAILABLE_PATTERN = /not found|unknown method|method not found|not implemented|unsupported/i;
const MAX_ATTACHMENTS_PER_TURN = 10;
const PREVIEW_THROTTLE_MS = 750;
const TELEGRAM_DRAFT_ID_MAX = 2_147_483_647;
const TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS = 1200;

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

function chunkParagraphs(text: string, limit: number = MAX_MESSAGE_LENGTH): string[] {
	if (text.length <= limit) return [text];

	const normalized = text.replace(/\r\n/g, "\n");
	const paragraphs = normalized.split(/\n\n+/);
	const chunks: string[] = [];
	let current = "";

	const flushCurrent = (): void => {
		if (current.trim().length > 0) chunks.push(current);
		current = "";
	};

	const splitLongBlock = (block: string): string[] => {
		if (block.length <= limit) return [block];
		const lines = block.split("\n");
		const lineChunks: string[] = [];
		let lineCurrent = "";
		for (const line of lines) {
			const candidate = lineCurrent.length === 0 ? line : `${lineCurrent}\n${line}`;
			if (candidate.length <= limit) {
				lineCurrent = candidate;
				continue;
			}
			if (lineCurrent.length > 0) {
				lineChunks.push(lineCurrent);
				lineCurrent = "";
			}
			if (line.length <= limit) {
				lineCurrent = line;
				continue;
			}
			for (let i = 0; i < line.length; i += limit) {
				lineChunks.push(line.slice(i, i + limit));
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
			if (candidate.length <= limit) {
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

function isRichUnavailableError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return RICH_UNAVAILABLE_PATTERN.test(message);
}

function telegramErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// Telegram's servers, the proxies in between, and the local network all fail transiently.
// These failures say nothing about capabilities and must never crash the bridge or turn
// into a status error; they are retried or silently dropped.
const TRANSIENT_TELEGRAM_PATTERN =
	/bad gateway|service unavailable|gateway timeout|internal server error|too many requests|flood|rate limit|timed? ?out|network|fetch failed|socket hang up|econnreset|econnrefused|etimedout|epipe|other side closed|http 5\d\d|http 429/i;

// Errors that mean the update simply does not apply any more: the target message already
// shows this content, or it is gone. Neither deserves a retry or an error report.
const HARMLESS_TELEGRAM_PATTERN =
	/message is not modified|message to edit not found|message to delete not found|message can't be edited|message can't be deleted|message_id invalid|message identifier is not specified/i;

function isTransientTelegramError(error: unknown): boolean {
	return TRANSIENT_TELEGRAM_PATTERN.test(telegramErrorMessage(error));
}

function isHarmlessTelegramError(error: unknown): boolean {
	return HARMLESS_TELEGRAM_PATTERN.test(telegramErrorMessage(error));
}

const TRANSIENT_RETRY_DELAY_MS = 1500;

/**
 * One delayed retry for transient Telegram/network failures. Aborts and non-transient
 * errors propagate to the caller immediately.
 */
async function withTelegramRetry<T>(attempt: () => Promise<T>): Promise<T> {
	try {
		return await attempt();
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") throw error;
		if (!isTransientTelegramError(error)) throw error;
		await new Promise((resolve) => setTimeout(resolve, TRANSIENT_RETRY_DELAY_MS));
		return await attempt();
	}
}

async function readTelegramResponse<TResponse>(response: Response, method: string): Promise<TResponse> {
	// Telegram answers with JSON even for errors, but a failing proxy in between may return
	// an HTML error page, which response.json() rejects with a parse error.
	let data: TelegramApiResponse<TResponse> | undefined;
	try {
		data = (await response.json()) as TelegramApiResponse<TResponse>;
	} catch {
		// non-JSON body (e.g. a proxy's HTML error page)
	}
	if (data === undefined || !data.ok || data.result === undefined) {
		throw new Error(data?.description || `Telegram API ${method} failed (HTTP ${response.status})`);
	}
	return data.result;
}

async function readConfig(): Promise<TelegramConfig> {
	try {
		const content = await readFile(CONFIG_PATH, "utf8");
		const parsed = JSON.parse(content) as TelegramConfig;
		return parsed;
	} catch {
		return {};
	}
}

async function writeConfig(config: TelegramConfig): Promise<void> {
	await mkdir(join(homedir(), ".pi", "agent"), { recursive: true });
	await writeFile(CONFIG_PATH, JSON.stringify(config, null, "\t") + "\n", "utf8");
}

export default function (pi: ExtensionAPI) {
	let config: TelegramConfig = {};
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
	// Rich drafts drive the live streaming preview; rich messages drive persisted replies.
	// They are tracked separately because Telegram tolerates partial Markdown in drafts
	// but may still reject a final message, and vice versa.
	let richDraftSupport: "unknown" | "supported" | "unsupported" = "unknown";
	let richMessageSupport: "unknown" | "supported" | "unsupported" = "unknown";
	let lastRichError: string | undefined;
	// Probed lazily on the first voice note so a missing `uv` never slows startup.
	let voiceToolingSupport: "unknown" | "supported" | "unsupported" = "unknown";
	let nextDraftId = 0;
	const mediaGroups = new Map<string, TelegramMediaGroupState>();

	function richEnabled(): boolean {
		return config.richMessages !== false;
	}

	function voiceEnabled(): boolean {
		return config.voiceTranscription !== false;
	}

	/** Prefer the usual uv install location, then fall back to PATH lookup by spawn. */
	async function uvBinary(): Promise<string> {
		const local = join(homedir(), ".local", "bin", "uv");
		try {
			await stat(local);
			return local;
		} catch {
			return "uv";
		}
	}

	interface VoiceTranscript {
		text: string;
		language?: string;
		durationSeconds?: number;
	}

	/**
	 * Transcribes one audio file by piping the embedded Python script to `uv run`, which
	 * resolves MLX Whisper and PyAV in a cached throwaway environment.
	 */
	async function transcribeVoice(audioPath: string): Promise<VoiceTranscript> {
		const uv = await uvBinary();
		const model = config.voiceModel?.trim() || DEFAULT_VOICE_MODEL;
		const language = config.voiceLanguage?.trim() || "auto";
		const child = spawn(
			uv,
			["run", "--quiet", "--with", "mlx-whisper", "--with", "av", "--with", "numpy", "python", "-", audioPath, model, language],
			{ stdio: ["pipe", "pipe", "pipe"] },
		);

		const outcome = await new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>(
			(resolve) => {
				let stdout = "";
				let stderr = "";
				let settled = false;
				let timedOut = false;
				const finish = (code: number | null): void => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					resolve({ code, stdout, stderr, timedOut });
				};
				const timer = setTimeout(() => {
					timedOut = true;
					child.kill("SIGKILL");
				}, VOICE_TRANSCRIBE_TIMEOUT_MS);
				child.stdout?.on("data", (chunk) => {
					stdout += chunk.toString();
				});
				child.stderr?.on("data", (chunk) => {
					stderr += chunk.toString();
				});
				child.on("error", (error) => {
					stderr += error.message;
					finish(-1);
				});
				child.on("close", (code) => finish(code));
				child.stdin?.end(VOICE_TRANSCRIBE_SCRIPT);
			},
		);

		if (outcome.timedOut) throw new Error(`timed out after ${VOICE_TRANSCRIBE_TIMEOUT_MS / 1000}s`);

		// The script prints exactly one JSON object as its last stdout line; anything before
		// it is third-party noise from the Python environment.
		const lastLine = outcome.stdout.trim().split("\n").filter(Boolean).pop() ?? "";
		let parsed: { text?: string; error?: string; language?: string; durationSeconds?: number } | undefined;
		try {
			parsed = JSON.parse(lastLine);
		} catch {
			parsed = undefined;
		}

		if (parsed?.error) throw new Error(parsed.error);
		if (!parsed || typeof parsed.text !== "string") {
			const detail = (outcome.stderr || outcome.stdout).trim().split("\n").slice(-2).join(" ").slice(0, 200);
			if (/ENOENT/.test(outcome.stderr)) {
				throw new VoiceToolingUnavailableError(detail || "uv is not available");
			}
			throw new Error(detail || `transcription process exited with code ${outcome.code}`);
		}

		return { text: parsed.text, language: parsed.language, durationSeconds: parsed.durationSeconds };
	}

	/** Keeps Telegram's "typing…" indicator alive for slow work before a turn is queued. */
	async function withTypingIndicator<T>(chatId: number, work: () => Promise<T>): Promise<T> {
		const tick = (): void => {
			void callTelegram("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => undefined);
		};
		tick();
		const timer = setInterval(tick, 4000);
		try {
			return await work();
		} finally {
			clearInterval(timer);
		}
	}

	async function transcribeVoiceNotes(chatId: number, files: DownloadedTelegramFile[]): Promise<string[]> {
		const notes: string[] = [];
		const voiceFiles = files.filter((file) => file.isVoice);
		if (voiceFiles.length === 0) return notes;
		if (!voiceEnabled()) return notes;

		await withTypingIndicator(chatId, async () => {
			for (const file of voiceFiles) {
				if (voiceToolingSupport === "unsupported") {
					notes.push("Voice message (transcription unavailable in this environment).");
					continue;
				}
				try {
					const transcript = await transcribeVoice(file.path);
					voiceToolingSupport = "supported";
					notes.push(transcript.text.length > 0 ? `Voice message transcript: ${transcript.text}` : "Voice message (transcribed as empty audio).");
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					if (error instanceof VoiceToolingUnavailableError) voiceToolingSupport = "unsupported";
					notes.push(`Voice message (transcription failed: ${message.slice(0, 200)}).`);
				}
			}
		});

		return notes;
	}

	/**
	 * Longest reply that can be finalized in place from the streamed preview instead of
	 * being cleared and re-sent. Rich messages lift this to 32768 characters.
	 */
	function maxInPlaceReplyLength(): number {
		return richEnabled() && richMessageSupport !== "unsupported" ? MAX_RICH_MESSAGE_LENGTH : MAX_MESSAGE_LENGTH;
	}

	function allocateDraftId(): number {
		nextDraftId = nextDraftId >= TELEGRAM_DRAFT_ID_MAX ? 1 : nextDraftId + 1;
		return nextDraftId;
	}

	/** Status rendering must never crash the bridge: the ctx goes stale after session replacement. */
	function updateStatus(ctx: ExtensionContext, error?: string): void {
		try {
			updateStatusUnsafe(ctx, error);
		} catch {
			// stale ctx or transient UI failure
		}
	}

	function updateStatusUnsafe(ctx: ExtensionContext, error?: string): void {
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

	/**
	 * `pi.on` behind an error boundary. Handlers await Telegram calls, and a network
	 * failure must degrade to the status bar instead of surfacing as "Extension ... error"
	 * from the host. A rejected before_agent_start override simply falls through to the
	 * default system prompt.
	 */
	const onSafe = ((event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown>) => {
		pi.on(
			event as never,
			(async (event: unknown, ctx: ExtensionContext) => {
				try {
					return await handler(event, ctx);
				} catch (error) {
					updateStatus(ctx, telegramErrorMessage(error));
				}
			}) as never,
		);
	}) as unknown as ExtensionAPI["on"];

	async function callTelegram<TResponse>(
		method: string,
		body: Record<string, unknown>,
		options?: { signal?: AbortSignal },
	): Promise<TResponse> {
		if (!config.botToken) throw new Error("Telegram bot token is not configured");
		return withTelegramRetry(async () => {
			const response = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
				signal: options?.signal,
			});
			return readTelegramResponse<TResponse>(response, method);
		});
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
		return withTelegramRetry(async () => {
			const response = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
				method: "POST",
				body: form,
				signal: options?.signal,
			});
			return readTelegramResponse<TResponse>(response, method);
		});
	}

	async function downloadTelegramFile(fileId: string, suggestedName: string): Promise<string> {
		if (!config.botToken) throw new Error("Telegram bot token is not configured");
		const file = await callTelegram<TelegramGetFileResult>("getFile", { file_id: fileId });
		await mkdir(TEMP_DIR, { recursive: true });
		const targetPath = join(TEMP_DIR, `${Date.now()}-${sanitizeFileName(suggestedName)}`);
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
		const value = message as unknown as Record<string, unknown>;
		const content = Array.isArray(value.content) ? value.content : [];
		return content
			.filter((block): block is { type: string; text?: string } => typeof block === "object" && block !== null && "type" in block)
			.filter((block) => block.type === "text" && typeof block.text === "string")
			.map((block) => block.text as string)
			.join("")
			.trim();
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
		// Rich drafts cannot be dismissed the same way: Telegram rejects empty Markdown with
		// RICH_MESSAGE_MARKDOWN_INVALID. They expire on their own after ~30 seconds.
	}

	async function flushPreview(chatId: number): Promise<void> {
		const state = previewState;
		if (!state) return;
		state.flushTimer = undefined;
		const text = state.pendingText.trim();
		if (!text || text === state.lastSentText) return;

		// Prefer rich drafts so the live preview renders Markdown too. Telegram renders
		// partial/incomplete Markdown while streaming without erroring.
		if (richEnabled() && richDraftSupport !== "unsupported") {
			const draftId =
				state.mode === "rich-draft" && state.draftId !== undefined ? state.draftId : allocateDraftId();
			const richText = text.length > MAX_RICH_MESSAGE_LENGTH ? text.slice(0, MAX_RICH_MESSAGE_LENGTH) : text;
			try {
				await callTelegram("sendRichMessageDraft", {
					chat_id: chatId,
					draft_id: draftId,
					rich_message: { markdown: richText },
				});
				richDraftSupport = "supported";
				state.mode = "rich-draft";
				state.draftId = draftId;
				state.lastSentText = text;
				return;
			} catch (error) {
				state.draftId = undefined;
				// A transient failure says nothing about rich-draft support: keep it enabled and
				// let the next flush retry instead of falling back for the rest of the session.
				if (isTransientTelegramError(error)) return;
				richDraftSupport = "unsupported";
			}
		}

		const truncated = text.length > MAX_MESSAGE_LENGTH ? text.slice(0, MAX_MESSAGE_LENGTH) : text;

		if (draftSupport !== "unsupported") {
			const draftId = state.mode === "draft" && state.draftId !== undefined ? state.draftId : allocateDraftId();
			try {
				await sendMarkdownHtml("sendMessageDraft", { chat_id: chatId, draft_id: draftId }, truncated);
				draftSupport = "supported";
				state.mode = "draft";
				state.draftId = draftId;
				state.lastSentText = text;
				return;
			} catch (error) {
				state.draftId = undefined;
				if (isTransientTelegramError(error)) return;
				draftSupport = "unsupported";
			}
		}

		if (state.messageId === undefined) {
			try {
				const sent = await sendMarkdownHtml<TelegramSentMessage>("sendMessage", { chat_id: chatId }, truncated);
				state.messageId = sent.message_id;
				state.mode = "message";
				state.lastSentText = text;
			} catch {
				// The preview is disposable: drop it silently. finalizePreview still delivers the
				// full reply, and the next flush retries with the newer text.
			}
			return;
		}
		try {
			await sendMarkdownHtml("editMessageText", { chat_id: chatId, message_id: state.messageId }, truncated);
			state.mode = "message";
			state.lastSentText = text;
		} catch (error) {
			if (/message is not modified/i.test(telegramErrorMessage(error))) {
				// The preview already shows exactly this text.
				state.lastSentText = text;
			} else if (isHarmlessTelegramError(error)) {
				// The previewed message vanished or is no longer editable: start fresh on the
				// next flush instead of editing a message that will never change again.
				state.messageId = undefined;
			}
			// Transient and fatal errors alike just drop this preview update: a live preview
			// must never crash the process.
		}
	}

	function schedulePreviewFlush(chatId: number): void {
		if (!previewState || previewState.flushTimer) return;
		previewState.flushTimer = setTimeout(() => {
			void flushPreview(chatId).catch(() => undefined);
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
		if (state.mode === "rich-draft" || state.mode === "draft") {
			await sendRichOrPlainText(chatId, finalText);
			await clearPreview(chatId);
			return true;
		}
		previewState = undefined;
		if (
			state.messageId !== undefined &&
			state.lastSentText.trim() === finalText &&
			finalText.length <= MAX_MESSAGE_LENGTH
		) {
			// The preview message already carries the final reply verbatim.
			return true;
		}
		// The preview never became (or could not be brought to) the final reply. Deliver it as
		// a fresh message: a preview hiccup must never cost the user the reply. The stale
		// partial preview is dropped best-effort first.
		if (state.messageId !== undefined) {
			try {
				await callTelegram("deleteMessage", { chat_id: chatId, message_id: state.messageId });
			} catch {
				// ignore
			}
		}
		await sendRichOrPlainText(chatId, finalText);
		return true;
	}

	/**
	 * Sends text with `parse_mode: "HTML"` after converting Markdown. If Telegram rejects
	 * the message for any reason it is retried without formatting: a formatting bug must
	 * never cost the user a reply. The plain attempt's error propagates, so the callers
	 * that probe for capabilities still see the real reason a method is unavailable.
	 */
	async function sendMarkdownHtml<TResponse>(
		method: string,
		body: Record<string, unknown>,
		markdown: string,
	): Promise<TResponse> {
		try {
			return await callTelegram<TResponse>(method, {
				...body,
				text: markdownToTelegramHtml(markdown),
				parse_mode: "HTML",
			});
		} catch {
			return await callTelegram<TResponse>(method, { ...body, text: markdown });
		}
	}

	/**
	 * Sends one Markdown chunk as a new message. Telegram measures the text after entity
	 * parsing, and aligned table padding can make a converted chunk wider than its
	 * Markdown source, so a chunk that would not fit is halved and retried instead of
	 * being rejected by the API.
	 */
	async function sendMarkdownChunk(chatId: number, markdown: string, depth = 0): Promise<number | undefined> {
		const fits = telegramVisibleLength(markdownToTelegramHtml(markdown)) <= MAX_MESSAGE_LENGTH;
		if (!fits && markdown.length > 1 && depth < 4) {
			let lastMessageId: number | undefined;
			const half = Math.max(1, Math.ceil(markdown.length / 2));
			for (const part of chunkParagraphs(markdown, half)) {
				lastMessageId = (await sendMarkdownChunk(chatId, part, depth + 1)) ?? lastMessageId;
			}
			return lastMessageId;
		}
		const sent = await sendMarkdownHtml<TelegramSentMessage>("sendMessage", { chat_id: chatId }, markdown);
		return sent.message_id;
	}

	/**
	 * Sends text, preferring Telegram rich messages (Bot API 10.1+) so Markdown renders
	 * natively. Falls back to Markdown converted to Telegram HTML, and finally to plain
	 * text when even that is rejected, so a reply is never dropped.
	 */
	async function sendRichOrPlainText(chatId: number, text: string): Promise<number | undefined> {
		const richUsable = richEnabled() && richMessageSupport !== "unsupported";
		const chunks = chunkParagraphs(text, richUsable ? MAX_RICH_MESSAGE_LENGTH : MAX_MESSAGE_LENGTH);
		let lastMessageId: number | undefined;

		for (const chunk of chunks) {
			if (richEnabled() && richMessageSupport !== "unsupported") {
				try {
					const sent = await callTelegram<TelegramSentMessage>("sendRichMessage", {
						chat_id: chatId,
						rich_message: { markdown: chunk },
					});
					richMessageSupport = "supported";
					lastRichError = undefined;
					lastMessageId = sent.message_id;
					continue;
				} catch (error) {
					lastRichError = error instanceof Error ? error.message : String(error);
					if (isRichUnavailableError(error)) richMessageSupport = "unsupported";
				}
			}

			// A chunk sized for rich messages may exceed the plain-text limit, so re-split it.
			for (const plainChunk of chunk.length > MAX_MESSAGE_LENGTH ? chunkParagraphs(chunk) : [chunk]) {
				lastMessageId = (await sendMarkdownChunk(chatId, plainChunk)) ?? lastMessageId;
			}
		}

		return lastMessageId;
	}

	async function sendTextReply(chatId: number, _replyToMessageId: number, text: string): Promise<number | undefined> {
		return sendRichOrPlainText(chatId, text);
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
			const content = Array.isArray(message.content) ? message.content : [];
			const text = content
				.filter((block): block is { type: string; text?: string } => typeof block === "object" && block !== null && "type" in block)
				.filter((block) => block.type === "text" && typeof block.text === "string")
				.map((block) => block.text as string)
				.join("")
				.trim();
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
					isVoice: true,
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
			downloaded.push({ path, fileName: file.fileName, isImage: file.isImage, isVoice: file.isVoice, mimeType: file.mimeType });
		}
		return downloaded;
	}

	async function promptForConfig(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI || setupInProgress) return;
		setupInProgress = true;
		try {
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
			await writeConfig(config);
			ctx.ui.notify(`Telegram bot connected: @${config.botUsername ?? "unknown"}`, "info");
			ctx.ui.notify("Send /start to your bot in Telegram to pair this extension with your account.", "info");
			await startPolling(ctx);
			updateStatus(ctx);
		} finally {
			setupInProgress = false;
		}
	}

	async function stopPolling(): Promise<void> {
		stopTypingLoop();
		pollingController?.abort();
		pollingController = undefined;
		await pollingPromise?.catch(() => undefined);
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
		const voiceNotes = await transcribeVoiceNotes(firstMessage.chat.id, files);
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
		for (const note of voiceNotes) {
			prompt += `\n\n${note}`;
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
		const lower = rawText.toLowerCase();

		if (lower === "stop" || lower === "/stop") {
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

		if (lower === "/compact") {
			if (!ctx.isIdle()) {
				await sendTextReply(firstMessage.chat.id, firstMessage.message_id, "Cannot compact while pi is busy. Send \"stop\" first.");
				return;
			}
			ctx.compact({
				onComplete: () => {
					void sendTextReply(firstMessage.chat.id, firstMessage.message_id, "Compaction completed.").catch(
						() => undefined,
					);
				},
				onError: (error) => {
					const message = error instanceof Error ? error.message : String(error);
					void sendTextReply(firstMessage.chat.id, firstMessage.message_id, `Compaction failed: ${message}`).catch(
						() => undefined,
					);
				},
			});
			await sendTextReply(firstMessage.chat.id, firstMessage.message_id, "Compaction started.");
			return;
		}

		if (lower === "/status") {
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
			const lines: string[] = [];
			const richStatus = !richEnabled()
				? "off"
				: richMessageSupport === "unsupported"
					? "unavailable"
					: lastRichError
						? `fallback (${lastRichError})`
						: "on";
			lines.push(`Rich: ${richStatus}`);
			if (ctx.model) {
				lines.push(`Model: ${ctx.model.provider}/${ctx.model.id}`);
			}
			const tokenParts: string[] = [];
			if (totalInput) tokenParts.push(`↑${formatTokens(totalInput)}`);
			if (totalOutput) tokenParts.push(`↓${formatTokens(totalOutput)}`);
			if (totalCacheRead) tokenParts.push(`R${formatTokens(totalCacheRead)}`);
			if (totalCacheWrite) tokenParts.push(`W${formatTokens(totalCacheWrite)}`);
			if (tokenParts.length > 0) {
				lines.push(`Usage: ${tokenParts.join(" ")}`);
			}
			const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
			if (totalCost || usingSubscription) {
				lines.push(`Cost: $${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
			}
			if (usage) {
				const contextWindow = usage.contextWindow ?? ctx.model?.contextWindow ?? 0;
				const percent = usage.percent !== null ? `${usage.percent.toFixed(1)}%` : "?";
				lines.push(`Context: ${percent}/${formatTokens(contextWindow)}`);
			} else {
				lines.push("Context: unknown");
			}
			if (lines.length === 0) {
				lines.push("No usage data yet.");
			}
			await sendTextReply(firstMessage.chat.id, firstMessage.message_id, lines.join("\n"));
			return;
		}

		if (lower === "/help" || lower === "/start") {
			await sendTextReply(
				firstMessage.chat.id,
				firstMessage.message_id,
				`Send me a message and I will forward it to pi. Commands: /status, /compact, stop.`,
			);
			if (config.allowedUserId === undefined && firstMessage.from) {
				config.allowedUserId = firstMessage.from.id;
				await writeConfig(config);
				updateStatus(ctx);
			}
			return;
		}

		const historyTurns = preserveQueuedTurnsAsHistory ? queuedTelegramTurns.splice(0) : [];
		preserveQueuedTurnsAsHistory = false;
		const turn = await createTelegramTurn(messages, historyTurns);
		queuedTelegramTurns.push(turn);
		if (ctx.isIdle()) {
			startTypingLoop(ctx, turn.chatId);
			updateStatus(ctx);
			void Promise.resolve(pi.sendUserMessage(turn.content, { deliverAs: "followUp" })).catch(() => undefined);
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
				dispatchAuthorizedTelegramMessages(state.messages, ctx).catch((error) =>
					updateStatus(ctx, telegramErrorMessage(error)),
				);
			}, TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS);
			mediaGroups.set(key, existing);
			return;
		}

		await dispatchAuthorizedTelegramMessages([message], ctx);
	}

	async function handleUpdate(update: TelegramUpdate, ctx: ExtensionContext): Promise<void> {
		const message = update.message || update.edited_message;
		if (!message || message.chat.type !== "private" || !message.from || message.from.is_bot) return;

		if (config.allowedUserId === undefined) {
			config.allowedUserId = message.from.id;
			await writeConfig(config);
			updateStatus(ctx);
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
					await writeConfig(config);
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
					config.lastUpdateId = update.update_id;
					await writeConfig(config);
					await handleUpdate(update, ctx);
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
			updateStatus(ctx);
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
		handler: async (_args, ctx) => {
			await promptForConfig(ctx);
		},
	});

	pi.registerCommand("telegram-status", {
		description: "Show Telegram bridge status",
		handler: async (_args, ctx) => {
			const status = [
				`bot: ${config.botUsername ? `@${config.botUsername}` : "not configured"}`,
				`allowed user: ${config.allowedUserId ?? "not paired"}`,
				`polling: ${pollingPromise ? "running" : "stopped"}`,
				`active telegram turn: ${activeTelegramTurn ? "yes" : "no"}`,
				`queued telegram turns: ${queuedTelegramTurns.length}`,
			];
			ctx.ui.notify(status.join(" | "), "info");
		},
	});

	pi.registerCommand("telegram-connect", {
		description: "Start the Telegram bridge in this pi session",
		handler: async (_args, ctx) => {
			config = await readConfig();
			if (!config.botToken) {
				await promptForConfig(ctx);
				return;
			}
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

	onSafe("session_start", async (_event, ctx) => {
		config = await readConfig();
		await mkdir(TEMP_DIR, { recursive: true });
		updateStatus(ctx);
	});

	onSafe("session_shutdown", async (_event, _ctx) => {
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
		await stopPolling();
	});

	onSafe("before_agent_start", async (event) => {
		const suffix = isTelegramPrompt(event.prompt)
			? `${SYSTEM_PROMPT_SUFFIX}\n- The current user message came from Telegram.`
			: SYSTEM_PROMPT_SUFFIX;
		return {
			systemPrompt: event.systemPrompt + suffix,
		};
	});

	onSafe("agent_start", async (_event, ctx) => {
		currentAbort = () => ctx.abort();
		if (!activeTelegramTurn && queuedTelegramTurns.length > 0) {
			const nextTurn = queuedTelegramTurns.shift();
			if (nextTurn) {
				activeTelegramTurn = { ...nextTurn };
				previewState = { mode: draftSupport === "unsupported" ? "message" : "draft", pendingText: "", lastSentText: "" };
				startTypingLoop(ctx);
			}
		}
		updateStatus(ctx);
	});

	onSafe("message_start", async (event, _ctx) => {
		if (!activeTelegramTurn || !isAssistantMessage(event.message)) return;
		if (previewState && (previewState.pendingText.trim().length > 0 || previewState.lastSentText.trim().length > 0)) {
			await finalizePreview(activeTelegramTurn.chatId);
		}
		previewState = { mode: draftSupport === "unsupported" ? "message" : "draft", pendingText: "", lastSentText: "" };
	});

	onSafe("message_update", async (event, _ctx) => {
		if (!activeTelegramTurn || !isAssistantMessage(event.message)) return;
		if (!previewState) {
			previewState = { mode: draftSupport === "unsupported" ? "message" : "draft", pendingText: "", lastSentText: "" };
		}
		previewState.pendingText = getMessageText(event.message);
		schedulePreviewFlush(activeTelegramTurn.chatId);
	});

	onSafe("agent_end", async (event, ctx) => {
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

		if (finalText && finalText.length <= maxInPlaceReplyLength()) {
			const finalized = await finalizePreview(turn.chatId);
			if (!finalized && turn.queuedAttachments.length > 0 && !finalText) {
				await sendTextReply(turn.chatId, turn.replyToMessageId, "Attached requested file(s).");
			}
		} else {
			await clearPreview(turn.chatId);
			if (finalText) {
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
			void Promise.resolve(pi.sendUserMessage(nextTurn.content, { deliverAs: "followUp" })).catch(() => undefined);
		}
	});
}
