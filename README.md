# pi-telegram

> [!IMPORTANT]
> ## 📦 This project has moved
>
> **`pi-telegram` is archived and no longer maintained.** Development has moved to **Pigram**, a clean-architecture rewrite published on npm:
>
> ### 👉 [github.com/jetmiky/pigram](https://github.com/jetmiky/pigram)
>
> ```bash
> pi install npm:@jetmiky/pigram
> ```
>
> Pigram carries this project's ideas forward — session-local bridge, rich-text Telegram output, one-step setup — with a reliable `/new`, live streaming previews, file attachments, and a published, versioned npm package. It reads your existing `telegram.json` and migrates it automatically.
>
> This repository remains available for reference only. Please file issues and use the new project at the link above.

---

![pi-telegram screenshot](screenshot.png)

> Full pi build session: [View the session transcript](https://pi.dev/session/#14acfe07b7844c8abec55ed9fbddc17f), which captures the full pi session in which `pi-telegram` was built.

Telegram DM bridge for pi.

## Install

From git:

```bash
pi install git:github.com/badlogic/pi-telegram
```

Or for a single run:

```bash
pi -e git:github.com/badlogic/pi-telegram
```

## Configure

### Telegram

1. Open [@BotFather](https://t.me/BotFather)
2. Run `/newbot`
3. Pick a name and username
4. Copy the bot token

### pi

Start pi, then run:

```bash
/telegram-setup
```

Choose where to store the Telegram config, then paste the bot token when prompted:

```text
Project-local: .pi/telegram.json
Global: ~/.pi/agent/telegram.json
```

You can also skip the wizard:

```bash
/telegram-setup local
/telegram-setup global
```

Project-local setup stores config in:

```text
.pi/telegram.json
```

Project-local setup also appends these entries to the project root `.gitignore`, or creates `.gitignore` if missing:

```gitignore
# pi-telegram local secrets/cache
.pi/telegram.json
.pi/tmp/telegram/
```

Global setup stores config in:

```text
~/.pi/agent/telegram.json
```

Global setup does not modify the project `.gitignore`.

If the project does not have `.pi/telegram.json`, `pi-telegram` falls back to the global config when connecting automatically.

Optional settings:

```json
{
  "streamPreviews": false
}
```

Set `streamPreviews` to `false` to disable Telegram preview streaming and keep only the typing indicator plus the final reply.

`/telegram-status` shows whether the current session is using project-local or global storage, plus the active config and temp paths.

## Connect a pi session

The Telegram bridge is session-local. Connect it only in the pi session that should own the bot:

```bash
/telegram-connect
```

By default, connect uses project-local config first, then global config as a fallback. You can force either scope:

```bash
/telegram-connect local
/telegram-connect global
```

To stop polling in the current session:

```bash
/telegram-disconnect
```

Check status:

```bash
/telegram-status
```

## Pair your Telegram account

After token setup and `/telegram-connect`:

1. Open the DM with your bot in Telegram
2. Send `/start`
3. The bot replies that pairing succeeded and includes the Telegram command list plus a BotFather `/setcommands` block you can copy

The first DM user becomes the allowed Telegram user for the bridge. The extension only accepts messages from that user.

## Usage

Chat with your bot in Telegram DMs.

### Send text

Send any message in the bot DM. It is forwarded into pi with a `[telegram]` prefix.

### Send images and files

Send images, albums, or files in the DM.

The extension:
- downloads them to `.pi/tmp/telegram` when project-local config is active
- otherwise uses the legacy global temp dir `~/.pi/agent/tmp/telegram`
- includes local file paths in the prompt
- forwards inbound images as image inputs to pi

### Ask for files back

If you ask pi for a file or generated artifact, pi should call the `telegram_attach` tool. The extension then sends those files with the next Telegram reply.

Examples:
- `summarize this image`
- `read this README and summarize it`
- `write me a markdown file with the plan and send it back`
- `generate a shell script and attach it`

### Telegram commands

In Telegram DM, these commands are supported:

- `/new [name]` — start a fresh pi session, reconnect Telegram, and optionally set the new session name
- `/status` — show session name, idle/busy status, active directory, loaded Telegram config scope/path, model, thinking level, usage, cost, and context status
- `/model <model-id> [thinking-level]` — switch model within current provider and reply with the active model and thinking level (example reply: `active model: gpt-5.4 high`)
- `/thinking <off|minimal|low|medium|high|xhigh>` — change thinking level
- `/compact` — trigger compaction when pi is idle
- `/resend` — resend the latest successful assistant text reply from the current Pi session without calling the LLM again
- `stop` or `/stop` — abort active turn
- `/help` — show help plus a BotFather `/setcommands` copy block
- `/start` — pair on first use, then show normal help on later use
- `/git <status|log|nb>` — run safe git shortcuts in current Pi cwd (`git status --short --branch`, `git log --oneline --decorate -20`, `git switch -c <branch>`)

On first pairing, the `/start` reply includes:

- `Telegram bridge paired with this account.`
- the normal Telegram command list
- a BotFather-ready `/setcommands` block in `command - description` format

`/help` always includes the BotFather block again so you can retrieve it later.

Unknown slash commands return:

```text
invalid command, type /help if you need help
```

### Queue follow-ups

If you send more Telegram messages while pi is busy, they are queued and processed in order.

## Streaming

By default, the extension streams assistant text previews back to Telegram while pi is generating.

It tries Telegram draft streaming first with `sendMessageDraft`. If that is not supported for your bot, it falls back to `sendMessage` plus `editMessageText`.

If `streamPreviews` is set to `false` in the active Telegram config file (`.pi/telegram.json` or the legacy `~/.pi/agent/telegram.json` fallback), the extension skips preview streaming and shows only the typing indicator until the final reply is ready.

## Parallel bots per project

You can run multiple pi sessions in parallel with different Telegram bots by configuring each project separately:

```bash
cd project-a
pi
/telegram-setup
/telegram-connect

cd project-b
pi
/telegram-setup
/telegram-connect
```

Each project should use a different bot token. `/telegram-setup local` will also keep the project-local Telegram config and downloads out of git by updating the project `.gitignore`.

## Notes

- Only one pi session should be connected to a given bot at a time
- Different projects can use different Telegram bots in parallel
- Replies are sent as normal Telegram messages, not quote-replies
- Long replies are split below Telegram's 4096 character limit
- Outbound files are sent via `telegram_attach`

## License

MIT
