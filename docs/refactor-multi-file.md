# 重构需求:将 `index.ts` 拆分为多模块文件

> **状态**:草案 · **基线**:`index.ts` @ `cb34008`(1130 行) · **最后更新**:2026-06-21

---

## 1. 背景与动机

当前 extension 实现集中在单个 `index.ts`(1130 行)。pi 通过 **jiti** 在运行时直接加载 TypeScript,无需编译步骤,入口只需满足 **default export `(pi: ExtensionAPI) => void`**。`package.json` 中的 `"pi": { "extensions": ["./index.ts"] }` 已满足规范;拆分后无需改动该字段。

> **规范依据**:pi 官方 [Extensions 文档](https://pi.dev/docs/latest/extensions) 的 "Extension Styles" 一节明确支持多文件入口(`index.ts` + 同目录辅助模块)。

### 1.1 当前问题

1. **可读性**:1130 行单文件,关注点混杂(类型 / 常量 / 工具函数 / Telegram API / 状态 / 事件处理 / 命令注册)。
2. **闭包耦合**:所有函数定义在工厂函数 `(pi) => { ... }` 内部,共享 12 个 `let` 可变状态(`config`、`pollingController`、`previewState` 等),阻碍独立测试和模块化。
3. **不可测**:无测试运行器,纯函数与副作用函数纠缠,无法对 `chunkParagraphs`、`callTelegram` 等做单元测试。
4. **认知负担**:新读者难以快速定位"流式预览逻辑在哪里""轮询循环如何工作"。

### 1.2 不做什么(Non-Goals)

- ❌ 不改变任何运行时行为(消息流、附件处理、命令语义)
- ❌ 不升级依赖或更换 pi peer 包名
- ❌ 不引入构建步骤(保持 jiti 直接加载 `.ts`)
- ❌ 不引入测试框架以外的运行时依赖
- ❌ 不重写算法,仅做结构迁移

### 1.3 重构原则

| 原则 | 含义 |
|---|---|
| **行为保持** | 每个 PR 后 `pi -e .` 行为与基线完全一致 |
| **小步快走** | 每阶段独立可交付、可回滚、可验收 |
| **状态显式化** | 闭包 `let` 变量逐步收敛到显式 state 对象,降低隐式耦合 |
| **零新依赖** | 仅用 Node 内建 + 现有 peer 依赖 |
| **类型先行** | 类型与常量优先抽出,为后续迁移提供稳定契约 |

---

## 2. 目标目录结构

重构完成后的最终形态(7 个阶段逐步达成):

```text
pi-telegram/
├── index.ts                 # 入口:工厂函数,注册命令/工具/事件,协调各模块(~250 行)
├── src/
│   ├── types.ts             # 全部 interface / type 声明
│   ├── constants.ts         # 路径、阈值、SYSTEM_PROMPT_SUFFIX
│   ├── utils.ts             # 纯工具函数(sanitize/guess/format/chunk 等)
│   ├── config.ts            # readConfig / writeConfig
│   ├── telegram-api.ts      # callTelegram / callTelegramMultipart / downloadTelegramFile
│   ├── state.ts             # BridgeState:集中持有可变运行时状态
│   ├── preview.ts           # 流式预览(draft / message 双模式)
│   ├── polling.ts           # 长轮询循环 + update 分发
│   └── dispatch.ts          # 命令分发(stop/compact/status/help) + turn 构造
├── test/
│   ├── utils.test.ts        # 纯函数单元测试
│   └── telegram-api.test.ts # API 层 mock 测试
├── package.json
└── docs/refactor-multi-file.md
```

> 是否使用 `src/` 子目录:阶段 5 决定。若倾向于扁平结构,所有模块直接放仓库根目录。**默认推荐 `src/`**,与 pi extension template 一致。

---

## 3. 全局验收标准(Definition of Done)

整个重构在以下条件全部满足时视为完成:

- [ ] **A1 行为等价**:`git diff` 仅涉及文件移动与导入语句,无逻辑改动(用 `git diff --stat` + 人工 review 确认)
- [ ] **A2 类型检查通过**:`pnx tsc --noEmit` 零错误
- [ ] **A3 入口不变**:`package.json` 的 `"pi": { "extensions": ["./index.ts"] }` 未改动
- [ ] **A4 运行时回归**:在真实 Telegram bot 上完成 §3.1 冒烟测试清单,全部通过
- [ ] **A5 文件粒度**:单文件不超过 400 行;`index.ts` 不超过 300 行
- [ ] **A6 无循环依赖**:模块依赖图为 DAG(用 `madge --circular` 验证,或人工审查)
- [ ] **A7 文档同步**:`AGENTS.md`/`CLAUDE.md` 的 "Code Architecture" 一节更新为新结构

### 3.1 冒烟测试清单(每个阶段结束后执行)

> 手动执行,记录到 PR 描述。每阶段至少跑通以下场景:

| # | 场景 | 预期 |
|---|---|---|
| S1 | `/telegram-setup` 输入有效 token | 提示连接成功,`/telegram-status` 显示 connected |
| S2 | Telegram DM 发送 `/start` | 回复帮助文本;首个发送者被配对 |
| S3 | 配对用户发送纯文本 | pi 收到 `[telegram] ...` 消息并回复 |
| S4 | 发送单张图片 | 图片下载到 tmp,pi 收到 image content |
| S5 | 发送 2 张图片的 album | 1200ms 后作为单 turn 处理 |
| S6 | 回复期间发送 `stop` | 中止当前 turn,回复 "Aborted current turn." |
| S7 | 询问 pi 要文件,触发 `telegram_attach` | 文件以 sendPhoto/sendDocument 发回 |
| S8 | pi 回复超过 4096 字符 | 按段落切分为多条消息 |
| S9 | 流式生成期间 | Telegram 看到 draft/edit 的渐进式预览 |
| S10 | `/telegram-disconnect` | 轮询停止,status 显示 disconnected |

---

## 4. 阶段总览

| 阶段 | 名称 | 风险 | 预计改动行数 | 依赖前置 |
|---|---|---|---|---|
| P0 | 基线锁定与脚手架 | 低 | 0(新增) | — |
| P1 | 抽取类型与常量 | 极低 | ~200 | P0 |
| P2 | 抽取纯工具函数 | 极低 | ~120 | P1 |
| P3 | 抽取 config 模块 | 低 | ~30 | P1 |
| P4 | 抽取 Telegram API 层 | 中 | ~80 | P1, P2 |
| P5 | 抽取 state 与纯化函数 | 中高 | ~150 | P1–P4 |
| P6 | 抽取 preview / polling / dispatch | 高 | ~400 | P5 |
| P7 | 收尾:测试、文档、清理 | 低 | ~100 | P6 |

每个阶段对应一个独立 PR / commit。**严禁跨阶段合并提交**。

---

## 5. 阶段详解

### 阶段 P0 — 基线锁定与脚手架

**目标**:为后续重构建立可回滚的安全网,不改动任何业务代码。

**前置条件**:
- 工作区干净(`git status` 干净,`AGENTS.md`/`CLAUDE.md` 已提交或 stash)
- Node 与 pi CLI 可用

**步骤**:
1. 在 main 分支基础上创建分支 `refactor/multi-file`。
2. 记录基线度量到 `docs/refactor-baseline.txt`:
   - `wc -l index.ts` → 1130
   - `pnx tsc --noEmit` 输出(应为 0 错误,若有则记录)
   - 当前 commit hash `cb34008`
3. 执行 §3.1 冒烟测试 S1–S10,**手工记录通过情况**作为基线。
4. 创建 `src/`、`test/`、`docs/` 空目录(占位 `.gitkeep`)。
5. 提交 commit `chore: lock refactor baseline and scaffolding`。

**产出物**:
- `docs/refactor-baseline.txt`(基线度量快照)
- `src/.gitkeep`、`test/.gitkeep`
- 新分支 `refactor/multi-file`

**验收标准**:
- [ ] `git diff main..HEAD -- index.ts` 为空(index.ts 未改动)
- [ ] 基线冒烟测试全部通过(S1–S10),结果写入 `docs/refactor-baseline.txt`
- [ ] `pnx tsc --noEmit` 错误数 ≤ 基线值

**回滚**:删除分支即可,无业务影响。

---

### 阶段 P1 — 抽取类型与常量

**目标**:把全部 `interface`/`type` 声明与常量从 `index.ts` 移到独立模块。这是风险最低的一步,因为类型与常量**零运行时状态**。

**前置条件**:P0 完成。

**步骤**:
1. 新建 `src/types.ts`,将下列声明从 `index.ts` 剪切过去(**行号锚点以 `cb34008` 为准**):
   - `TelegramConfig`(L10–16)
   - `TelegramApiResponse<T>`(L18–23)
   - `TelegramUser`(L25–30)
   - `TelegramChat`(L32–35)
   - `TelegramPhotoSize`(L37–40)
   - `TelegramDocument`(L42–47)
   - `TelegramVideo`(L49–54)
   - `TelegramAudio`(L56–61)
   - `TelegramVoice`(L63–67)
   - `TelegramAnimation`(L69–74)
   - `TelegramSticker`(L76–79)
   - `TelegramFileInfo`(L81–86)
   - `TelegramMessage`(L88–102)
   - `TelegramUpdate`(L104–108)
   - `TelegramGetFileResult`(L110–112)
   - `TelegramSentMessage`(L114–116)
   - `DownloadedTelegramFile`(L118–123)
   - `PendingTelegramTurn`(L125–131)
   - `ActiveTelegramTurn`(L133)
   - `QueuedAttachment`(L135–138)
   - `TelegramPreviewState`(L140–147)
   - `TelegramMediaGroupState`(L149–152)
2. 在 `src/types.ts` 顶部补充必要的 type-only import:
   ```ts
   import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
   import type { AgentMessage } from "@mariozechner/pi-agent-core";
   ```
3. 新建 `src/constants.ts`,迁移:
   - `CONFIG_PATH`、`TEMP_DIR`(L154–155)
   - `TELEGRAM_PREFIX`、`MAX_MESSAGE_LENGTH`、`MAX_ATTACHMENTS_PER_TURN`、`PREVIEW_THROTTLE_MS`、`TELEGRAM_DRAFT_ID_MAX`、`TELEGRAM_MEDIA_GROUP_DEBOUNCE_MS`(L156–161)
   - `SYSTEM_PROMPT_SUFFIX`(L163–169)
4. `index.ts` 顶部新增:
   ```ts
   import type { /* 全部类型 */ } from "./src/types";
   import { CONFIG_PATH, TEMP_DIR, TELEGRAM_PREFIX, /* ... */ SYSTEM_PROMPT_SUFFIX } from "./src/constants";
   ```
5. 删除 `index.ts` 中已迁移的声明。
6. 运行 `pnx tsc --noEmit`。

**产出物**:
- `src/types.ts`(~150 行)
- `src/constants.ts`(~20 行)
- `index.ts`(1130 → ~960 行)

**验收标准**:
- [ ] `pnx tsc --noEmit` 零新增错误
- [ ] `grep -E "^(interface|type) " index.ts` 输出为空(类型全部迁出)
- [ ] `grep -E "^const (CONFIG_PATH|TEMP_DIR|MAX_MESSAGE_LENGTH|SYSTEM_PROMPT_SUFFIX)" index.ts` 输出为空
- [ ] 冒烟测试 S1、S3、S8 通过(验证常量与类型被正确引用)
- [ ] `git diff` 中 `index.ts` 的改动仅为"删除 + 新增 import",无逻辑变化

**回滚**:`git revert <commit>`。

---

### 阶段 P2 — 抽取纯工具函数

**目标**:把无副作用、无状态依赖的纯函数移到 `src/utils.ts`。

**前置条件**:P1 完成。

**步骤**:
1. 新建 `src/utils.ts`。
2. 迁移以下**模块级**纯函数(注意:这些位于工厂函数**外部**,行号 L171–270):
   - `isTelegramPrompt`(L171–173)
   - `sanitizeFileName`(L175–177)
   - `guessExtensionFromMime`(L179–192)
   - `guessMediaType`(L194–200)
   - `isImageMimeType`(L202–205)
   - `formatTokens`(L207–213)
   - `chunkParagraphs`(L215–270)
3. 这些函数依赖 `MAX_MESSAGE_LENGTH` 常量 → `src/utils.ts` 顶部 `import { MAX_MESSAGE_LENGTH } from "./constants";`。
4. `index.ts` 改为 `import { chunkParagraphs, formatTokens, /* ... */ } from "./src/utils";`。
5. **工厂函数内部**的纯辅助函数(`isAssistantMessage` L417、`getMessageText` L421、`extractAssistantText` L543)本轮**不迁**,留到 P5(它们引用 `AgentMessage` 且语义上属于"消息处理",与 state 相关)。
6. 运行 `pnx tsc --noEmit`。

**产出物**:
- `src/utils.ts`(~110 行)
- `index.ts`(~960 → ~850 行)

**验收标准**:
- [ ] `pnx tsc --noEmit` 零新增错误
- [ ] `grep -nE "^function (isTelegramPrompt|sanitizeFileName|guessExtensionFromMime|guessMediaType|isImageMimeType|formatTokens|chunkParagraphs)" index.ts` 输出为空
- [ ] 新增 `test/utils.test.ts` 覆盖以下用例并通过:
  - `chunkParagraphs("a".repeat(5000))` → 多个 chunk,每个 ≤ 4096
  - `chunkParagraphs` 不在单词中间断开
  - `formatTokens(0)` → `"0"`、`formatTokens(1500)` → `"1.5k"`、`formatTokens(2_500_000)` → `"2.5M"`
  - `guessExtensionFromMime("image/jpeg", ".bin")` → `".jpg"`
  - `sanitizeFileName("a b/c")` → `"a_b_c"`
- [ ] 冒烟测试 S3、S8 通过(长回复切分路径)

**回滚**:`git revert <commit>`。

---

### 阶段 P3 — 抽取 config 模块

**目标**:`readConfig` / `writeConfig` 已是模块级函数,迁移到 `src/config.ts`。

**前置条件**:P1 完成(P3 可与 P2 并行)。

**步骤**:
1. 新建 `src/config.ts`。
2. 迁移 `readConfig`(L272–280)、`writeConfig`(L282–285)。
3. 在 `src/config.ts` 顶部:
   ```ts
   import { readFile, writeFile, mkdir } from "node:fs/promises";
   import { join } from "node:path";
   import { homedir } from "node:os";
   import { CONFIG_PATH } from "./constants";
   import type { TelegramConfig } from "./types";
   ```
4. `index.ts` 删除原函数,新增 `import { readConfig, writeConfig } from "./src/config";`。
5. 运行 `pnx tsc --noEmit`。

**产出物**:
- `src/config.ts`(~20 行)
- `index.ts`(~850 → ~840 行)

**验收标准**:
- [ ] `pnx tsc --noEmit` 零新增错误
- [ ] `grep -nE "^async function (readConfig|writeConfig)" index.ts` 输出为空
- [ ] 冒烟测试 S1、S2 通过(setup 写 config,start 读 config 配对)
- [ ] `~/.pi/agent/telegram.json` 的读写行为与基线一致(文件格式、字段名不变)

**回滚**:`git revert <commit>`。

---

### 阶段 P4 — 抽取 Telegram API 层

**目标**:把 `callTelegram` / `callTelegramMultipart` / `downloadTelegramFile` 迁出。这是**第一次触碰闭包耦合**——这三个函数当前从闭包读 `config.botToken`。

**前置条件**:P1、P2 完成。

**步骤**:
1. 新建 `src/telegram-api.ts`。
2. **签名变更**(消除对闭包 `config` 的依赖):
   - `callTelegram<T>(botToken, method, body, options?)`
   - `callTelegramMultipart<T>(botToken, method, fields, fileField, filePath, fileName, options?)`
   - `downloadTelegramFile(botToken, fileId, suggestedName)` —— 同时把对 `TEMP_DIR` 的依赖改为显式参数 `tempDir` 或从 constants 导入
3. 在 `src/telegram-api.ts` 顶部:
   ```ts
   import { readFile, writeFile, mkdir } from "node:fs/promises";
   import { join } from "node:path";
   import { TEMP_DIR } from "./constants";
   import { sanitizeFileName } from "./utils";
   import type { TelegramApiResponse, TelegramGetFileResult } from "./types";
   ```
4. `index.ts` 中所有调用点改为显式传 `config.botToken`:
   ```ts
   // 旧:await callTelegram("sendChatAction", { ... })
   // 新:await callTelegram(config.botToken!, "sendChatAction", { ... })
   ```
   统一封装一个闭包内 helper 避免散落 `!`:
   ```ts
   function call<T>(method: string, body: Record<string, unknown>, options?) {
     return callTelegram<T>(config.botToken!, method, body, options);
   }
   ```
5. 运行 `pnx tsc --noEmit`。

**产出物**:
- `src/telegram-api.ts`(~70 行)
- `index.ts`(~840 → ~770 行)

**验收标准**:
- [ ] `pnx tsc --noEmit` 零新增错误
- [ ] `src/telegram-api.ts` 中**无任何**对 `config` 闭包变量的引用(`grep "config" src/telegram-api.ts` 仅匹配参数名)
- [ ] 新增 `test/telegram-api.test.ts`:用 `global.fetch` mock 验证:
  - `callTelegram` 在 `data.ok === true` 时返回 `result`
  - `callTelegram` 在 `data.ok === false` 时抛出含 `description` 的 Error
  - `callTelegram` 在 `botToken` 为空时抛出 "Telegram bot token is not configured"
- [ ] 冒烟测试 S3、S4、S7、S9 通过(覆盖 getFile / sendMessage / multipart / draft)

**回滚**:`git revert <commit>`。注意:签名变更会影响调用点,revert 后需确认调用点已还原。

---

### 阶段 P5 — 抽取 state 与纯化内部函数(关键阶段)

**目标**:把工厂函数内部散落的 12 个 `let` 可变状态收敛到一个显式 `BridgeState` 对象;把引用了这些状态的纯辅助函数(`isAssistantMessage`、`getMessageText`、`extractAssistantText`、`collectTelegramFileInfos`)迁出闭包。

**前置条件**:P1–P4 完成。

**步骤**:
1. 新建 `src/state.ts`,定义:
   ```ts
   export interface BridgeState {
     config: TelegramConfig;
     pollingController: AbortController | undefined;
     pollingPromise: Promise<void> | undefined;
     queuedTelegramTurns: PendingTelegramTurn[];
     activeTelegramTurn: ActiveTelegramTurn | undefined;
     typingInterval: ReturnType<typeof setInterval> | undefined;
     currentAbort: (() => void) | undefined;
     preserveQueuedTurnsAsHistory: boolean;
     setupInProgress: boolean;
     previewState: TelegramPreviewState | undefined;
     draftSupport: "unknown" | "supported" | "unsupported";
     nextDraftId: number;
     mediaGroups: Map<string, TelegramMediaGroupState>;
   }
   export function createState(): BridgeState { /* 返回全零初始值 */ }
   ```
2. `index.ts` 工厂函数顶部:`const state = createState();`,把所有 `let config = ...` 替换为 `state.config = ...`。
   > **迁移策略**:用全局替换。例如 `config` → `state.config`、`previewState` → `state.previewState`。**务必全量替换**,避免残留旧名导致 shadowing。
3. 把 `allocateDraftId`(L302–305)改为接收并返回 state 的纯函数,迁移到 `src/state.ts` 或 `src/preview.ts`。
4. 新建 `src/messages.ts`,迁移以下**原本在闭包内**的纯函数(它们只依赖入参 + `AgentMessage`/`TelegramMessage` 类型):
   - `isAssistantMessage`(L417–419)
   - `getMessageText`(L421–430)
   - `extractAssistantText`(L543–559)
   - `collectTelegramFileInfos`(L561–629)
   - `buildTelegramFiles` —— 改为接收 `botToken` 参数
5. 运行 `pnx tsc --noEmit`。

**产出物**:
- `src/state.ts`(~40 行)
- `src/messages.ts`(~140 行)
- `index.ts`(~770 → ~600 行)

**验收标准**:
- [ ] `pnx tsc --noEmit` 零新增错误
- [ ] `grep -nE "^\s+let (config|pollingController|pollingPromise|queuedTelegramTurns|activeTelegramTurn|typingInterval|currentAbort|preserveQueuedTurnsAsHistory|setupInProgress|previewState|draftSupport|nextDraftId)" index.ts` 输出为空(所有状态已收敛到 `state.*`)
- [ ] `grep -c "state\." index.ts` ≥ 30(状态访问已显式化)
- [ ] `src/state.ts`、`src/messages.ts` 中**无** `ExtensionAPI` / `ExtensionContext` / `pi` 引用(纯逻辑,无 pi 耦合)
- [ ] 冒烟测试 S1–S10 **全部通过**(此阶段改动面最大,必须全量回归)

**回滚**:`git revert <commit>`。这是高风险阶段,revert 后**必须**重跑全量冒烟测试。

---

### 阶段 P6 — 抽取 preview / polling / dispatch

**目标**:把三大块业务逻辑从 `index.ts` 闭包迁出,`index.ts` 仅保留工厂函数骨架与事件注册。

**前置条件**:P5 完成且冒烟测试全绿。

**步骤**(每个子模块独立提交):

#### P6.1 — `src/preview.ts`
1. 迁移 `clearPreview`、`flushPreview`、`schedulePreviewFlush`、`finalizePreview`、`allocateDraftId`(L302–506)。
2. 这些函数依赖:`state`(preview 部分)、`callTelegram`、`MAX_MESSAGE_LENGTH`、`PREVIEW_THROTTLE_MS`。改为接收 `state` 与 `callTelegram` 引用作为参数,或导出工厂函数:
   ```ts
   export function createPreviewController(opts: {
     state: BridgeState;
     call: <T>(method: string, body: Record<string, unknown>) => Promise<T>;
   }) { /* 返回 { clearPreview, flushPreview, schedulePreviewFlush, finalizePreview } */ }
   ```
3. 验收:冒烟 S9 通过(draft/message 双模式)。

#### P6.2 — `src/polling.ts`
1. 迁移 `pollLoop`、`startPolling`、`stopPolling`、`startTypingLoop`、`stopTypingLoop`、`handleUpdate`、`handleAuthorizedTelegramMessage`(L392–945 散落)。
2. 依赖:`state`、`call`、`ctx`、`dispatch`。用同样的工厂函数模式注入依赖。
3. 验收:冒烟 S1、S2、S3、S6 通过。

#### P6.3 — `src/dispatch.ts`
1. 迁移 `dispatchAuthorizedTelegramMessages`、`createTelegramTurn`、`formatTelegramHistoryText`、`buildTelegramFiles`、`sendTextReply`、`sendQueuedAttachments`(L508–846)。
2. 验收:冒烟 S3、S5、S6、S7、S8 通过。

**产出物**:
- `src/preview.ts`(~120 行)
- `src/polling.ts`(~150 行)
- `src/dispatch.ts`(~200 行)
- `index.ts`(~600 → ~250 行)

**验收标准**:
- [ ] `pnx tsc --noEmit` 零新增错误
- [ ] `index.ts` ≤ 300 行,仅包含:imports、`export default function`、`createState()`、依赖注入装配、`pi.registerTool`、`pi.registerCommand` ×4、`pi.on` ×7
- [ ] `grep -nE "(clearPreview|flushPreview|pollLoop|dispatchAuthorized)" index.ts` 仅出现在"装配 / 注入"上下文,无函数定义体
- [ ] 各模块间无循环依赖(`npx madge --circular --extensions ts src/ index.ts` 输出 "No circular dependencies")
- [ ] 冒烟测试 S1–S10 **全部通过**

**回滚**:按子阶段 P6.1/P6.2/P6.3 分别 revert,无需整体回滚。

---

### 阶段 P7 — 收尾:测试、文档、清理

**目标**:补齐测试覆盖、同步文档、清理临时文件,正式收尾。

**前置条件**:P6 完成。

**步骤**:
1. **测试补齐**:
   - `test/utils.test.ts`:覆盖率 ≥ 90%(纯函数易测)
   - `test/telegram-api.test.ts`:覆盖 ok/未授权/multipart 三条路径
   - `test/messages.test.ts`:覆盖 `extractAssistantText`、`collectTelegramFileInfos`(用 fixture 消息)
   - 配置 `package.json` `"scripts": { "test": "node --test test/**/*.test.ts" }`(或沿用项目既有约定;若 pi 生态有 `pnx test` 则用之)
2. **文档同步**:
   - 更新 `AGENTS.md`/`CLAUDE.md` 的 "Code Architecture" 一节:
     - "A single-file TypeScript extension" → "A multi-module TypeScript extension"
     - 新增 §"Module Layout" 小节,列出 `src/` 各文件职责
     - "Key Constants (in index.ts)" → "Key Constants (in `src/constants.ts`)"
   - 在 `README.md` 顶部 "Build session" 段落后新增指向 `docs/refactor-multi-file.md` 的链接(可选)
3. **清理**:
   - 删除 `docs/refactor-baseline.txt`(基线已沉淀到 git 历史)
   - 删除 `src/.gitkeep`、`test/.gitkeep`(目录已有实际文件)
   - 移除所有临时 `console.log` / TODO 注释
4. **最终全量回归**:S1–S10。

**产出物**:
- `test/*.test.ts` 完整测试套件
- 更新后的 `AGENTS.md`、`CLAUDE.md`、`README.md`
- 最终 `index.ts` + `src/` 结构

**验收标准**:
- [ ] `pnx tsc --noEmit` 零错误
- [ ] 测试套件全部通过,纯函数覆盖率 ≥ 90%
- [ ] `AGENTS.md` 的 Code Architecture 节描述与新结构一致(人工 review)
- [ ] 全局 DoD §3 的 A1–A7 全部勾选
- [ ] PR 描述包含:最终 `wc -l` 统计、模块依赖图、冒烟测试结果

**回滚**:N/A(收尾阶段)。如测试不通过,单独修复 commit。

---

## 6. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 闭包变量替换遗漏 | 运行时 `ReferenceError` 或 shadowing 静默 bug | P5 用 `grep` 强校验 + 全量冒烟回归 |
| `this` / 闭包语义改变 | 函数迁出后 `this` 失绑 | 全部用箭头函数 / 显式参数注入,禁止 `this` |
| jiti 路径解析差异 | `./src/types` 在某些环境下加载失败 | 用相对路径 + `.ts` 扩展(jiti 支持),P0 基线即验证 `pi -e .` 可加载 |
| 签名变更(P4)引入 `!` 断言 | 运行时 `undefined` | 用 helper `call()` 封装,集中一处断言;API 层内部显式 throw |
| 阶段间分支冲突 | 多人协作时 merge 冲突 | 严格串行 PR,后一阶段基于前一阶段分支 rebase |
| 回归未被发现 | 行为漂移 | 每阶段强制冒烟测试;P5、P6 强制全量 S1–S10 |

---

## 7. 度量与追踪

### 7.1 进度看板

| 阶段 | 状态 | PR | index.ts 行数 | 冒烟结果 | 完成日期 |
|---|---|---|---|---|---|
| P0 | ☐ 待开始 | — | 1130 | — | — |
| P1 | ☐ | — | — | — | — |
| P2 | ☐ | — | — | — | — |
| P3 | ☐ | — | — | — | — |
| P4 | ☐ | — | — | — | — |
| P5 | ☐ | — | — | — | — |
| P6.1 | ☐ | — | — | — | — |
| P6.2 | ☐ | — | — | — | — |
| P6.3 | ☐ | — | — | — | — |
| P7 | ☐ | — | ~250 | — | — |

### 7.2 关键指标(每阶段记录)

```bash
# 行数
wc -l index.ts src/*.ts

# 类型检查
pnx tsc --noEmit 2>&1 | tail -5

# 依赖图(需安装 madge,可选)
npx madge --circular --extensions ts index.ts src/
```

---

## 8. 决策记录(待确认项)

> 以下决策需在 P0 启动前与维护者确认。

| # | 议题 | 选项 | 推荐 |
|---|---|---|---|
| D1 | 模块目录 | (a) 扁平 `/utils.ts` (b) `src/utils.ts` | **(b)**,与 pi extension template 一致 |
| D2 | 状态封装 | (a) 裸 `BridgeState` 对象 (b) `class Bridge` | **(a)**,迁移成本最低,后续可演进 |
| D3 | 测试框架 | (a) Node 内建 `node:test` (b) vitest (c) 不引入 | **(a)**,零依赖,符合项目"零运行时依赖"原则 |
| D4 | 分支策略 | (a) 单分支多 commit (b) 每阶段一个 PR | **(b)**,便于 review 与回滚 |
| D5 | P6 拆分粒度 | (a) 三个子 PR (b) 合并为一个 PR | **(a)**,降低 review 负担 |
| D6 | 是否对齐 peer 包名 | (a) 顺手改为 `@earendil-works/...` (b) 维持现状 | **(b)**,超出重构范围,单独 issue 处理 |

---

## 9. 附录

### 9.1 现有闭包变量清单(P5 迁移依据)

| 变量 | 类型 | 初值 | 行号 |
|---|---|---|---|
| `config` | `TelegramConfig` | `{}` | L288 |
| `pollingController` | `AbortController \| undefined` | `undefined` | L289 |
| `pollingPromise` | `Promise<void> \| undefined` | `undefined` | L290 |
| `queuedTelegramTurns` | `PendingTelegramTurn[]` | `[]` | L291 |
| `activeTelegramTurn` | `ActiveTelegramTurn \| undefined` | `undefined` | L292 |
| `typingInterval` | `setInterval return \| undefined` | `undefined` | L293 |
| `currentAbort` | `(() => void) \| undefined` | `undefined` | L294 |
| `preserveQueuedTurnsAsHistory` | `boolean` | `false` | L295 |
| `setupInProgress` | `boolean` | `false` | L296 |
| `previewState` | `TelegramPreviewState \| undefined` | `undefined` | L297 |
| `draftSupport` | `"unknown" \| "supported" \| "unsupported"` | `"unknown"` | L298 |
| `nextDraftId` | `number` | `0` | L299 |
| `mediaGroups` | `Map<string, TelegramMediaGroupState>` | `new Map()` | L300 |

### 9.2 函数迁移映射表

| 函数 | 当前行号 | 目标模块 | 阶段 |
|---|---|---|---|
| `isTelegramPrompt` | L171 | `utils.ts` | P2 |
| `sanitizeFileName` | L175 | `utils.ts` | P2 |
| `guessExtensionFromMime` | L179 | `utils.ts` | P2 |
| `guessMediaType` | L194 | `utils.ts` | P2 |
| `isImageMimeType` | L203 | `utils.ts` | P2 |
| `formatTokens` | L207 | `utils.ts` | P2 |
| `chunkParagraphs` | L215 | `utils.ts` | P2 |
| `readConfig` | L272 | `config.ts` | P3 |
| `writeConfig` | L282 | `config.ts` | P3 |
| `callTelegram` | L334(闭包内) | `telegram-api.ts` | P4 |
| `callTelegramMultipart` | L353 | `telegram-api.ts` | P4 |
| `downloadTelegramFile` | L380 | `telegram-api.ts` | P4 |
| `isAssistantMessage` | L417 | `messages.ts` | P5 |
| `getMessageText` | L421 | `messages.ts` | P5 |
| `extractAssistantText` | L543 | `messages.ts` | P5 |
| `collectTelegramFileInfos` | L561 | `messages.ts` | P5 |
| `buildTelegramFiles` | L631 | `messages.ts` / `dispatch.ts` | P5/P6 |
| `allocateDraftId` | L302 | `state.ts` / `preview.ts` | P5/P6 |
| `clearPreview` | L432 | `preview.ts` | P6.1 |
| `flushPreview` | L449 | `preview.ts` | P6.1 |
| `schedulePreviewFlush` | L483 | `preview.ts` | P6.1 |
| `finalizePreview` | L490 | `preview.ts` | P6.1 |
| `sendTextReply` | L508 | `dispatch.ts` | P6.3 |
| `sendQueuedAttachments` | L521 | `dispatch.ts` | P6.3 |
| `formatTelegramHistoryText` | L676 | `dispatch.ts` | P6.3 |
| `createTelegramTurn` | L687 | `dispatch.ts` | P6.3 |
| `dispatchAuthorizedTelegramMessages` | L738 | `dispatch.ts` | P6.3 |
| `handleAuthorizedTelegramMessage` | L848 | `polling.ts` | P6.2 |
| `handleUpdate` | L867 | `polling.ts` | P6.2 |
| `pollLoop` | L886 | `polling.ts` | P6.2 |
| `startPolling` | L936 | `polling.ts` | P6.2 |
| `stopPolling` | L668 | `polling.ts` | P6.2 |
| `startTypingLoop` | L392 | `polling.ts` | P6.2 |
| `stopTypingLoop` | L411 | `polling.ts` | P6.2 |
| `updateStatus` | L307 | `index.ts`(保留) | — |
| `promptForConfig` | L640 | `index.ts`(保留)或 `polling.ts` | P6.2 |

### 9.3 参考资料

- [pi Extensions 官方文档](https://pi.dev/docs/latest/extensions)
- [pi Packages 文档](https://pi.dev/docs/latest/packages)
- [sysid/pi-extensions HowTo](https://github.com/sysid/pi-extensions/blob/main/HowTo.md)
- 基线 commit:`cb34008`
