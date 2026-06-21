import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { TEMP_DIR } from "./constants";
import { sanitizeFileName } from "./utils";
import type { TelegramApiResponse, TelegramGetFileResult } from "./types";

export async function callTelegram<TResponse>(
	botToken: string,
	method: string,
	body: Record<string, unknown>,
	options?: { signal?: AbortSignal },
): Promise<TResponse> {
	if (!botToken) throw new Error("Telegram bot token is not configured");
	const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
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

export async function callTelegramMultipart<TResponse>(
	botToken: string,
	method: string,
	fields: Record<string, string>,
	fileField: string,
	filePath: string,
	fileName: string,
	options?: { signal?: AbortSignal },
): Promise<TResponse> {
	if (!botToken) throw new Error("Telegram bot token is not configured");
	const form = new FormData();
	for (const [key, value] of Object.entries(fields)) {
		form.set(key, value);
	}
	const buffer = await readFile(filePath);
	form.set(fileField, new Blob([buffer]), fileName);
	const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
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

export async function downloadTelegramFile(botToken: string, fileId: string, suggestedName: string): Promise<string> {
	if (!botToken) throw new Error("Telegram bot token is not configured");
	const file = await callTelegram<TelegramGetFileResult>(botToken, "getFile", { file_id: fileId });
	await mkdir(TEMP_DIR, { recursive: true });
	const targetPath = join(TEMP_DIR, `${Date.now()}-${sanitizeFileName(suggestedName)}`);
	const response = await fetch(`https://api.telegram.org/file/bot${botToken}/${file.file_path}`);
	if (!response.ok) throw new Error(`Failed to download Telegram file: ${response.status}`);
	const arrayBuffer = await response.arrayBuffer();
	await writeFile(targetPath, Buffer.from(arrayBuffer));
	return targetPath;
}
