import type { BridgeState } from "./state";
import type { TelegramUpdate, TelegramMessage, TelegramConfig } from "./types";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS } from "./constants";

export function createPollingController(opts: {
  state: BridgeState;
  call: <TResponse>(method: string, body: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<TResponse>;
  writeConfig: (config: TelegramConfig) => Promise<void>;
  updateStatus: (ctx: ExtensionContext, error?: string) => void;
  sendTextReply: (chatId: number, replyToMessageId: number, text: string) => Promise<number | undefined>;
  dispatchAuthorizedTelegramMessages: (messages: TelegramMessage[], ctx: ExtensionContext) => Promise<void>;
  stopTypingLoop: () => void;
}) {
  async function handleAuthorizedTelegramMessage(message: TelegramMessage, ctx: ExtensionContext): Promise<void> {
    if (message.media_group_id) {
      const key = `${message.chat.id}:${message.media_group_id}`;
      const existing = opts.state.mediaGroups.get(key) ?? { messages: [] };
      existing.messages.push(message);
      if (existing.flushTimer) clearTimeout(existing.flushTimer);
      existing.flushTimer = setTimeout(() => {
        const groupState = opts.state.mediaGroups.get(key);
        opts.state.mediaGroups.delete(key);
        if (!groupState) return;
        void opts.dispatchAuthorizedTelegramMessages(groupState.messages, ctx);
      }, TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS);
      opts.state.mediaGroups.set(key, existing);
      return;
    }

    await opts.dispatchAuthorizedTelegramMessages([message], ctx);
  }

  async function handleUpdate(update: TelegramUpdate, ctx: ExtensionContext): Promise<void> {
    const message = update.message || update.edited_message;
    if (!message || message.chat.type !== "private" || !message.from || message.from.is_bot) return;

    if (opts.state.config.allowedUserId === undefined) {
      opts.state.config.allowedUserId = message.from.id;
      await opts.writeConfig(opts.state.config);
      opts.updateStatus(ctx);
      await opts.sendTextReply(message.chat.id, message.message_id, "Telegram bridge paired with this account.");
    }

    if (message.from.id !== opts.state.config.allowedUserId) {
      await opts.sendTextReply(message.chat.id, message.message_id, "This bot is not authorized for your account.");
      return;
    }

    await handleAuthorizedTelegramMessage(message, ctx);
  }

  async function pollLoop(ctx: ExtensionContext, signal: AbortSignal): Promise<void> {
    if (!opts.state.config.botToken) return;

    try {
      await opts.call("deleteWebhook", { drop_pending_updates: false }, { signal });
    } catch {
      // ignore
    }

    if (opts.state.config.lastUpdateId === undefined) {
      try {
        const updates = await opts.call<TelegramUpdate[]>("getUpdates", { offset: -1, limit: 1, timeout: 0 }, { signal });
        const last = updates.at(-1);
        if (last) {
          opts.state.config.lastUpdateId = last.update_id;
          await opts.writeConfig(opts.state.config);
        }
      } catch {
        // ignore
      }
    }

    while (!signal.aborted) {
      try {
        const updates = await opts.call<TelegramUpdate[]>(
          "getUpdates",
          {
            offset: opts.state.config.lastUpdateId !== undefined ? opts.state.config.lastUpdateId + 1 : undefined,
            limit: 10,
            timeout: 30,
            allowed_updates: ["message", "edited_message"],
          },
          { signal },
        );
        for (const update of updates) {
          opts.state.config.lastUpdateId = update.update_id;
          await opts.writeConfig(opts.state.config);
          await handleUpdate(update, ctx);
        }
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof DOMException && error.name === "AbortError") return;
        const message = error instanceof Error ? error.message : String(error);
        opts.updateStatus(ctx, message);
        await new Promise((resolve) => setTimeout(resolve, 3000));
        opts.updateStatus(ctx);
      }
    }
  }

  async function startPolling(ctx: ExtensionContext): Promise<void> {
    if (!opts.state.config.botToken || opts.state.pollingPromise) return;
    opts.state.pollingController = new AbortController();
    opts.state.pollingPromise = pollLoop(ctx, opts.state.pollingController.signal).finally(() => {
      opts.state.pollingPromise = undefined;
      opts.state.pollingController = undefined;
      opts.updateStatus(ctx);
    });
    opts.updateStatus(ctx);
  }

  async function stopPolling(): Promise<void> {
    opts.stopTypingLoop();
    opts.state.pollingController?.abort();
    opts.state.pollingController = undefined;
    await opts.state.pollingPromise?.catch(() => undefined);
    opts.state.pollingPromise = undefined;
  }

  return { startPolling, stopPolling };
}
