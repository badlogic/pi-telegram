import { join } from "node:path";
import { homedir } from "node:os";

export const CONFIG_PATH = join(homedir(), ".pi", "agent", "telegram.json");
export const TEMP_DIR = join(homedir(), ".pi", "agent", "tmp", "telegram");
export const TELEGRAM_PREFIX = "[telegram]";
export const MAX_MESSAGE_LENGTH = 4096;
export const MAX_ATTACHMENTS_PER_TURN = 10;
export const PREVIEW_THROTTLE_MS = 750;
export const TELEGRAM_DRAFT_ID_MAX = 2_147_483_647;
export const TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS = 1200;

export const SYSTEM_PROMPT_SUFFIX = `

Telegram bridge extension is active.
- Messages forwarded from Telegram are prefixed with "[telegram]".
- [telegram] messages may include local temp file paths for Telegram attachments. Read those files as needed.
- If a [telegram] user asked for a file or generated artifact, use the telegram_attach tool with the local file path so the extension can send it with your next final reply.
- Do not assume mentioning a local file path in plain text will send it to Telegram. Use telegram_attach.`;
