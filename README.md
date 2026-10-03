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

The extension stores config in:

```text
~/.pi/agent/telegram.json
```

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

It tries Telegram draft streaming first with `sendRichMessageDraft` (or `sendMessageDraft`). If
that is not supported for your bot, it falls back to `sendMessage` plus `editMessageText`.

## Formatting

Replies render as Markdown through three tiers, each of which degrades instead of failing:

1. **Rich messages** (`sendRichMessage`, Bot API 10.1+). Markdown renders natively, up to 32768 characters.
2. **HTML fallback.** When rich messages are unavailable, or `richMessages` is `false`, replies are converted
to Telegram's `parse_mode: "HTML"` with `markdown.ts`: bold, italic, strikethrough, inline code, fenced code,
links, headings, blockquotes, lists and pipe tables. Tables become aligned monospace blocks because Telegram
has no table tags.
3. **Plain text.** If Telegram still rejects the message, it is retried unformatted, so a formatting bug can
never cost you a reply.

Set `richMessages: false` in `~/.pi/agent/telegram.json` to force the HTML fallback path.

### Table rendering limits

Tables are the weakest part of the HTML fallback, and both limits are accepted rather than worked around:

- **Wide tables wrap, and wrapping breaks the alignment.** Telegram wraps `<pre>` lines at the bubble width
  (~44 monospace columns on a phone). A sample of 671 real tables from local session transcripts found
  67% of rendered rows wider than that, so most tables align only on their narrow rows. The table is still
  kept as one `<pre>` block because it groups the content and gives the client a copy button.
- **Emoji width cannot be predicted.** `displayWidth()` counts East Asian wide characters as two columns and
  assumes one emoji glyph is two columns, but clients disagree: a ZWJ sequence such as `👨👩👧` renders as one
  glyph on some clients and as three separate glyphs (man, woman, girl) on others. Expect a misaligned row
  whenever a cell contains emoji.

Use rich messages (`richMessages` left at its default) for real tables: Telegram renders Markdown tables
natively there.

## Notes

- Only one pi session should be connected to the bot at a time
- Replies are sent as normal Telegram messages, not quote-replies
- Long replies are split below Telegram's limit (32768 characters for rich messages, 4096 otherwise)
- Outbound files are sent via `telegram_attach`

## Development

```bash
npm test
```

`markdown.ts` is pure and has no pi dependencies, so it can be run and tested directly with Node.

## License

MIT
