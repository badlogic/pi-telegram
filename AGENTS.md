# CLAUDE.md

## What is pi-telegram?

A Telegram DM bridge extension for the [pi](https://pi.dev) AI agent platform. It lets users chat with a pi session via Telegram — sending text, images, files, and receiving streaming replies back.

## Commands

```bash
# There is no build step or test runner in this project.
# The extension is loaded dynamically by pi via the "pi.extensions" field in package.json.

# Run locally (single-use)
pi -e .

# Install from local checkout
pi install .

# Type-check only (if you have the pi peer deps available)
pnx tsc --noEmit
```

The extension has **zero runtime deps** — it uses only Node built-ins (`node:fs/promises`, `node:path`, `node:os`) and the `fetch` API for Telegram Bot API calls. All pi types are peer dependencies loaded at runtime.

## Code Architecture

A single-file TypeScript extension (`index.ts`) that exports a default function `(pi: ExtensionAPI) => void`.

### Core Concepts

**Extension lifecycle** — pi loads this module and calls the default export with the `ExtensionAPI` handle. The extension registers commands, tools, and event handlers during initialization.

**Telegram Bot API** — uses long-polling (`getUpdates` with `timeout: 30`) rather than webhooks. Config stored in `~/.pi/agent/telegram.json`. The bot identity is confirmed via `getMe` during setup.

**Message flow:**
1. Polling loop receives updates from Telegram
2. `handleUpdate` checks chat type (private only), authorization (first `/start` sender becomes the paired user)
3. `dispatchAuthorizedTelegramMessages` handles special commands (`stop`, `/compact`, `/status`, `/help`/`/start`) or queues the message as a pi turn
4. Media groups (albums) are debounced for 1200ms before processing as one turn
5. Messages are prefixed with `[telegram]` and injected as pi user messages

**Streaming output:**
- Tries `sendMessageDraft` (Telegram draft API) first; falls back to `sendMessage` + `editMessageText` if drafts are unsupported
- Preview text throttled at 750ms intervals
- On `agent_end`, the preview is finalized and any queued attachments are sent

### File Handling

- Inbound: downloads Telegram files (photo, document, video, audio, voice, animation, sticker) to `~/.pi/agent/tmp/telegram/`. Images are inlined as base64 `ImageContent` blocks.
- Outbound: pi calls the `telegram_attach` tool to queue files; the extension sends them via `sendPhoto`/`sendDocument` after the text reply. Max 10 attachments per turn.

### Turn Queueing

If the user sends multiple messages while pi is busy, they queue up. When pi finishes the current turn, the next queued turn fires automatically. If a turn is aborted (`stop` or `/stop`), remaining queued turns can be preserved as history context.

### Registered pi Slash Commands

| Command | Purpose |
|---|---|
| `/telegram-setup` | Prompt for bot token, validate via `getMe`, save config |
| `/telegram-connect` | Read config and start polling |
| `/telegram-disconnect` | Stop polling loop |
| `/telegram-status` | Show bot/connection/turn status in pi |

### Registered pi Tool

`telegram_attach` — called by pi itself when the user asks for a file back. Takes an array of local file paths and queues them for the next Telegram reply.

### Event Handlers

| Event | Behavior |
|---|---|
| `session_start` | Read config, create temp dir |
| `session_shutdown` | Clear state, stop polling |
| `before_agent_start` | Append Telegram-specific system prompt suffix |
| `agent_start` | Dequeue next turn, start typing indicator |
| `message_start` | Finalize any in-flight preview before new message |
| `message_update` | Throttled streaming preview to Telegram |
| `agent_end` | Finalize preview, send attachments, dequeue next turn |

### Key Constants (in index.ts)

- `CONFIG_PATH` = `~/.pi/agent/telegram.json`
- `TEMP_DIR` = `~/.pi/agent/tmp/telegram`
- `MAX_MESSAGE_LENGTH` = 4096 (Telegram's character limit per message)
- `PREVIEW_THROTTLE_MS` = 750
- `TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS` = 1200
- `MAX_ATTACHMENTS_PER_TURN` = 10

### Important Patterns

- Long replies are split by paragraph boundaries (never mid-word) into chunks under 4096 chars
- `AbortController` manages the polling loop; `ctx.abort()` aborts the active pi turn
- `pi.sendUserMessage()` triggers a new pi agent turn from the extension side
- The `preserveQueuedTurnsAsHistory` flag ensures aborted turns' queued messages become context for the next turn instead of being dropped
