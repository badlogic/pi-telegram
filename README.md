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

By default, the extension stores config in:

```text
~/.pi/agent/telegram.json
```

For an isolated Pi process, set `PI_TELEGRAM_CONFIG` and `PI_TELEGRAM_TMP_DIR` to separate paths. The config file is written with owner-only permissions. `PI_TELEGRAM_AUTOSTART=1` starts polling at session startup only when that config already contains a bot token; leave it unset for interactive/manual connections. Use a distinct Telegram bot token per Pi session.

## Connect a pi session

The Telegram bridge is session-local. Connect it only in the pi session that should own the bot:

```bash
/telegram-connect
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

## Voice notes

Local voice automation is controlled from Telegram with `/voice status`, `/voice on`, and `/voice off`. The default profile enables it; profiles using `PI_TELEGRAM_CONFIG` default to off and must also set `PI_TELEGRAM_VOICE_ENABLED=1` to expose/allow the command. Incoming Telegram voice/audio messages are transcribed locally with whisper.cpp, subject to a 10 MiB file and 2-minute duration limit. Short replies are synthesized locally with Kokoro (`am_michael`) and sent as Telegram voice notes; long or potentially sensitive text is skipped. Text replies remain available.

The runtime uses the locally installed whisper.cpp, Opus tools, Kokoro model/voice, mlx-audio Python environment, and phonemization dependencies. Paths can be overridden with `PI_TELEGRAM_WHISPER_CLI`, `PI_TELEGRAM_WHISPER_MODEL`, `PI_TELEGRAM_OPUSDEC`, `PI_TELEGRAM_OPUSENC`, `PI_TELEGRAM_MLX_PYTHON`, `PI_TELEGRAM_KOKORO_MODEL`, `PI_TELEGRAM_KOKORO_VOICE`, and `PI_TELEGRAM_TTS_PYTHONPATH`. Audio temp directories are owner-only, and downloads are size-bounded.

## Notes

- Only one pi session should poll a given bot; use a separate bot token for each independent Pi session
- Replies are sent as normal Telegram messages, not quote-replies
- Long replies are split below Telegram's 4096 character limit
- Outbound files are sent via `telegram_attach`

## License

MIT
