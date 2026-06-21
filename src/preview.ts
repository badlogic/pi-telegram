import type { BridgeState } from "./state";
import { MAX_MESSAGE_LENGTH, PREVIEW_THROTTLE_MS, TELEGRAM_DRAFT_ID_MAX } from "./constants";
import type { TelegramSentMessage } from "./types";

export function createPreviewController(opts: {
  state: BridgeState;
  call: <T = unknown>(method: string, body: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<T>;
}) {
  async function clearPreview(chatId: number): Promise<void> {
    const ps = opts.state.previewState;
    if (!ps) return;
    if (ps.flushTimer) {
      clearTimeout(ps.flushTimer);
      ps.flushTimer = undefined;
    }
    opts.state.previewState = undefined;
    if (ps.mode === "draft" && ps.draftId !== undefined) {
      try {
        await opts.call("sendMessageDraft", { chat_id: chatId, draft_id: ps.draftId, text: "" });
      } catch {
        // ignore
      }
    }
  }

  async function flushPreview(chatId: number): Promise<void> {
    const ps = opts.state.previewState;
    if (!ps) return;
    ps.flushTimer = undefined;
    const text = ps.pendingText.trim();
    if (!text || text === ps.lastSentText) return;
    const truncated = text.length > MAX_MESSAGE_LENGTH ? text.slice(0, MAX_MESSAGE_LENGTH) : text;

    if (opts.state.draftSupport !== "unsupported") {
      if (ps.draftId === undefined) {
        opts.state.nextDraftId = opts.state.nextDraftId >= TELEGRAM_DRAFT_ID_MAX ? 1 : opts.state.nextDraftId + 1;
        ps.draftId = opts.state.nextDraftId;
      }
      const draftId = ps.draftId;
      try {
        await opts.call("sendMessageDraft", { chat_id: chatId, draft_id: draftId, text: truncated });
        opts.state.draftSupport = "supported";
        ps.mode = "draft";
        ps.lastSentText = truncated;
        return;
      } catch {
        opts.state.draftSupport = "unsupported";
      }
    }

    if (ps.messageId === undefined) {
      const sent = await opts.call<TelegramSentMessage>("sendMessage", { chat_id: chatId, text: truncated });
      ps.messageId = sent.message_id;
      ps.mode = "message";
      ps.lastSentText = truncated;
      return;
    }
    await opts.call("editMessageText", { chat_id: chatId, message_id: ps.messageId, text: truncated });
    ps.mode = "message";
    ps.lastSentText = truncated;
  }

  function schedulePreviewFlush(chatId: number): void {
    if (!opts.state.previewState || opts.state.previewState.flushTimer) return;
    opts.state.previewState.flushTimer = setTimeout(() => {
      void flushPreview(chatId);
    }, PREVIEW_THROTTLE_MS);
  }

  async function finalizePreview(chatId: number): Promise<boolean> {
    const ps = opts.state.previewState;
    if (!ps) return false;
    await flushPreview(chatId);
    const finalText = (ps.pendingText.trim() || ps.lastSentText).trim();
    if (!finalText) {
      await clearPreview(chatId);
      return false;
    }
    if (ps.mode === "draft") {
      await opts.call<TelegramSentMessage>("sendMessage", { chat_id: chatId, text: finalText });
      await clearPreview(chatId);
      return true;
    }
    opts.state.previewState = undefined;
    return ps.messageId !== undefined;
  }

  return { clearPreview, flushPreview, schedulePreviewFlush, finalizePreview };
}
