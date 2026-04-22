# PR #4: Race Condition & Fetch Error Handling

**Repository:** badlogic/pi-telegram  
**Branch:** 3DAlgoLab:main → badlogic:main  
**Status:** ✅ Created

---

## Changes

### 1. Race Condition Fix (Veteran's Analysis)
Added `flushing` boolean to `TelegramPreviewState` to prevent concurrent `flushPreview` calls during heavy streaming.

### 2. Fetch JSON Parse Error Handling
Wrapped `response.json()` in try/catch for both:
- `callTelegram` - for JSON payloads
- `callTelegramMultipart` - for multipart/form-data responses

---

## Fix Details

| File | Change |
|------|--------|
| `index.ts:147` | Added `flushing: boolean` to `TelegramPreviewState` |
| `index.ts:440-442` | Added `flushing` guard in `clearPreview` |
| `index.ts:453-498` | Wrapped `flushPreview` with lock (try/finally) |
| `index.ts:496-500` | Re-schedule logic in finally block |

---

## Testing

No crashes during:
- Concurrent message sending (5 parallel messages)
- Large YouTube transcript (~20KB, 447 lines)
- `"fetch failed"` error scenarios

---

**PR Link:** https://github.com/badlogic/pi-telegram/pull/4
