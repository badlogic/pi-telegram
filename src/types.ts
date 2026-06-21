import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

export interface TelegramConfig {
	botToken?: string;
	botUsername?: string;
	botId?: number;
	allowedUserId?: number;
	lastUpdateId?: number;
}

export interface TelegramApiResponse<T> {
	ok: boolean;
	result?: T;
	description?: string;
	error_code?: number;
}

export interface TelegramUser {
	id: number;
	is_bot: boolean;
	first_name: string;
	username?: string;
}

export interface TelegramChat {
	id: number;
	type: string;
}

export interface TelegramPhotoSize {
	file_id: string;
	file_size?: number;
}

export interface TelegramDocument {
	file_id: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

export interface TelegramVideo {
	file_id: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

export interface TelegramAudio {
	file_id: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

export interface TelegramVoice {
	file_id: string;
	mime_type?: string;
	file_size?: number;
}

export interface TelegramAnimation {
	file_id: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

export interface TelegramSticker {
	file_id: string;
	emoji?: string;
}

export interface TelegramFileInfo {
	file_id: string;
	fileName: string;
	mimeType?: string;
	isImage: boolean;
}

export interface TelegramMessage {
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

export interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
	edited_message?: TelegramMessage;
}

export interface TelegramGetFileResult {
	file_path: string;
}

export interface TelegramSentMessage {
	message_id: number;
}

export interface DownloadedTelegramFile {
	path: string;
	fileName: string;
	isImage: boolean;
	mimeType?: string;
}

export interface PendingTelegramTurn {
	chatId: number;
	replyToMessageId: number;
	queuedAttachments: QueuedAttachment[];
	content: Array<TextContent | ImageContent>;
	historyText: string;
}

export type ActiveTelegramTurn = PendingTelegramTurn;

export interface QueuedAttachment {
	path: string;
	fileName: string;
}

export interface TelegramPreviewState {
	mode: "draft" | "message";
	draftId?: number;
	messageId?: number;
	pendingText: string;
	lastSentText: string;
	flushTimer?: ReturnType<typeof setTimeout>;
}

export interface TelegramMediaGroupState {
	messages: TelegramMessage[];
	flushTimer?: ReturnType<typeof setTimeout>;
}
