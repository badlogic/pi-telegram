import { extname } from "node:path";

import type { AgentMessage } from "@mariozechner/pi-agent-core";

import { MAX_MESSAGE_LENGTH, TELEGRAM_PREFIX } from "./constants";
import type { TelegramFileInfo, TelegramMessage } from "./types";

export function isTelegramPrompt(prompt: string): boolean {
	return prompt.trimStart().startsWith(TELEGRAM_PREFIX);
}

export function sanitizeFileName(name: string): string {
	return name.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

export function guessExtensionFromMime(mimeType: string | undefined, fallback: string): string {
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

export function guessMediaType(path: string): string | undefined {
	const ext = extname(path).toLowerCase();
	if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
	if (ext === ".png") return "image/png";
	if (ext === ".webp") return "image/webp";
	if (ext === ".gif") return "image/gif";
	return undefined;
}

export function isImageMimeType(mimeType: string | undefined): boolean {
	return mimeType?.toLowerCase().startsWith("image/") ?? false;
}

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export function chunkParagraphs(text: string): string[] {
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

export function isAssistantMessage(message: AgentMessage): boolean {
	return (message as unknown as { role?: string }).role === "assistant";
}

export function getMessageText(message: AgentMessage): string {
	const value = message as unknown as Record<string, unknown>;
	const content = Array.isArray(value.content) ? value.content : [];
	return content
		.filter((block): block is { type: string; text?: string } => typeof block === "object" && block !== null && "type" in block)
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("")
		.trim();
}

export function extractAssistantText(messages: AgentMessage[]): { text?: string; stopReason?: string; errorMessage?: string } {
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

export function collectTelegramFileInfos(messages: TelegramMessage[]): TelegramFileInfo[] {
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
