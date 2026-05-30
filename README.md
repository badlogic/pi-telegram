# pi-telegram

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

Paste the bot token when prompted.

Existing installs continue to use the legacy config file:

```text
~/.pi/agent/telegram.json
```

Named profile configs are stored in:

```text
~/.pi/agent/telegram/<profile>.json
```

## Connect a pi session

The Telegram bridge is session-local. Connect it only in the pi session that should own the bot:

```bash
/telegram-connect
```

You can also connect a named profile explicitly:

```bash
/telegram-connect my-project
```

To stop polling in the current session:

```bash
/telegram-disconnect
```

Check status:

```bash
/telegram-status
```

## One bot per project

To use separate Telegram bots/chats for separate projects, create one profile per project:

```bash
cd /home/lane/projects/srm
pi
/telegram-setup srm
/telegram-connect srm
```

When run from a project directory, `/telegram-setup` without an argument defaults to the current directory basename, so this also creates `srm`:

```bash
/telegram-setup
```

Profile resolution uses this order:

1. explicit command argument, for example `/telegram-connect srm`
2. `PI_TELEGRAM_PROFILE`, for example `PI_TELEGRAM_PROFILE=srm pi`
3. a config matching the current directory basename, for example `srm` for `/home/lane/projects/srm`
4. legacy `~/.pi/agent/telegram.json`

For `/telegram-setup`, the current directory basename is used even before the profile file exists. For `/telegram-connect` and session startup, once `~/.pi/agent/telegram/srm.json` exists, running from `/home/lane/projects/srm` selects it automatically. If no matching profile exists, existing legacy config remains the fallback.

A lightweight lock file prevents two pi sessions from polling the same profile at once:

```text
~/.pi/agent/telegram/<profile>.lock
```

## Pair your Telegram account

After token setup and `/telegram-connect`:

1. Open the DM with your bot in Telegram
2. Send `/start`

The first DM user becomes the allowed Telegram user for the bridge. The extension only accepts messages from that user.

## Usage

Chat with your bot in Telegram DMs.

### Send text

Send any message in the bot DM. It is forwarded into pi with a `[telegram]` prefix.

### Send images and files

Send images, albums, or files in the DM.

The extension:
- downloads them to `~/.pi/agent/tmp/telegram`
- includes local file paths in the prompt
- forwards inbound images as image inputs to pi

### Ask for files back

If you ask pi for a file or generated artifact, pi should call the `telegram_attach` tool. The extension then sends those files with the next Telegram reply.

Examples:
- `summarize this image`
- `read this README and summarize it`
- `write me a markdown file with the plan and send it back`
- `generate a shell script and attach it`

### Stop a run

In Telegram, send:

```text
stop
```

or:

```text
/stop
```

That aborts the active pi turn.

### Queue follow-ups

If you send more Telegram messages while pi is busy, they are queued and processed in order.

## Streaming

The extension streams assistant text previews back to Telegram while pi is generating.

It tries Telegram draft streaming first with `sendMessageDraft`. If that is not supported for your bot, it falls back to `sendMessage` plus `editMessageText`.

## Notes

- Only one pi session should be connected to the bot at a time
- Replies are sent as normal Telegram messages, not quote-replies
- Long replies are split below Telegram's 4096 character limit
- Outbound files are sent via `telegram_attach`

## License

MIT
