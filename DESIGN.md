# opencode-loop-detector 设计文档

检测 LLM 在 reasoning（思考）和 text（输出）阶段陷入死循环的 opencode 插件。

将 opencode 的 loop detection 内置实现（PR #21112，`feat: implement loop detection for thinking and text`）改造为纯插件形式，无需修改 opencode 源码。

---

## 1. 背景与目标

### 1.1 问题

GLM-5/5.2、Kimi K2.5 等模型在 reasoning 或 text 生成阶段可能陷入死循环：持续输出相同或相似内容，无法自行停止，浪费 token 且无法完成任务。opencode 原有的 doom loop guard 只捕获**工具调用循环**，捕获不到"模型只在 thinking 里反复绕、不实际执行工具"的情况。

### 1.2 PR #21112 的内置方案

PR #21112 在 opencode 核心代码中实现了 thinking/text loop 检测，改动 9 个文件、+980 行。它：

- 在 `session/processor.ts` 的 Stream 管道里挂检测器，监听 `reasoning-delta` / `text-delta`
- 检测到循环后，在 `session/prompt.ts` 的主循环里决定 nudge（插入 synthetic user message 让模型换方向）还是 abort（报 LoopError 退出）
- 通过 `config.ts` 的 `experimental.loop` 配置段控制，默认开启

### 1.3 为什么要改成插件

- 不修改 opencode 源码，不依赖 PR 合入或特定版本
- 可独立分发、按需安装
- 可自定义检测参数和 nudge 文案

### 1.4 设计目标

- 检测算法与 PR #21112 完全一致（原样移植 `loop.ts`）
- nudge→abort 两级策略与 PR #21112 语义等价
- 通过插件 API（event hook + SDK client）实现，零源码改动

---

## 2. PR #21112 内置实现分析

以下是对 PR #21112 各组件的逆向分析，是插件移植的基础。

### 2.1 `session/loop.ts`（新建，155 行）— 核心检测器

纯函数模块，不依赖 opencode 内部，可原样移植。

**DEFAULTS**：
```typescript
{
  min_period: 10,      // 最小重复块长度（字符）
  max_period: 2000,    // 最大重复块长度（字符）
  similarity: 1.0,     // 相似度阈值（1.0 = 精确匹配）
  check_interval: 100, // 每隔多少字符检查一次
  min_chars: 200,      // 累积多少字符后才开始检测
  max_nudges: 1,       // nudge 次数上限，耗尽后 abort
}
```

**REMINDER 模板**：
```
<system-reminder>
Your output is repeating in a loop with period ~{period} characters. Stop repeating and take a different, concrete action.
</system-reminder>
```

**`create(options)` 工厂函数**：创建有状态检测器实例。

内部状态：
- `buffer: string` — 滑窗缓冲区，容量 = `2 * max_period`，只保留尾部
- `total: number` — 累计接收字符数
- `last: number` — 上次检查时的累计字符数

**`feed(delta): LoopOutcome | undefined`**：喂入流式增量文本。

逻辑：
1. `buffer += delta`，`total += delta.length`
2. 如果 `buffer.length > capacity`，截断保留尾部 `capacity` 字符
3. 如果 `total < min_chars`，返回 undefined（还没到检测门槛）
4. 如果 `total - last < check_interval`，返回 undefined（距上次检查不够远）
5. 更新 `last = total`，调用 `detect()`

**`detect(): LoopOutcome | undefined`**：在 buffer 末尾扫描重复模式。

逻辑：
1. 如果 `buffer.length < 2 * min_period`，返回 undefined
2. 从最长候选 period（`min(floor(length/2), max_period)`）到最短（`min_period`）逐个扫描
3. 对每个候选 period，先做**两点快速预检**（O(1) 拒绝 ~99.95% 非重复 period）：
   - 比较 `buffer[tail]` 与 `buffer[tail - period]`（尾字符）
   - 比较 `buffer[mid]` 与 `buffer[mid - period]`（第二段中点）
   - 任一不匹配则 `continue`
4. 通过预检后，取两个相邻的 period 长度段，做**归一化比较**：
   - `first = normalize(buffer.slice(length - 2*period, length - period))`
   - `second = normalize(buffer.slice(length - period))`
   - `normalize` = 折叠所有空白为单空格 + trim（应对多余换行/缩进漂移）
5. 计算相似度：
   - `similarity >= 1.0` 时：`first === second` ? 1.0 : 0（精确匹配）
   - `similarity < 1.0` 时：字符级逐位比较，`matches / max_length`
6. 如果 `score < threshold`，`continue`
7. **字母数字过滤**：如果 `second` 不含任何 Unicode 字母或数字（`\p{L}\p{N}`），`continue`（过滤 `---`、`| --- |` 等结构化模式，支持 CJK）
8. 返回 `{ type: "loop", period, source }`

从最长扫到最短，所以报告的是**最长重复单元**（最有意义的）。

**`recovery(attempt, options)`**：决定 nudge 还是 abort。

```typescript
function recovery(attempt, options) {
  const nudges = options?.max_nudges ?? 1
  if (attempt < nudges) {
    return { action: "nudge", reminder: REMINDER.replace("{period}", String(period)) }
  }
  return { action: "abort", period, attempts: attempt + 1 }
}
```

默认 `max_nudges = 1`：第 1 次检测到 → nudge；第 2 次还循环 → abort。

**`LoopOutcome` 类型**：
```typescript
type LoopOutcome = { type: "loop"; period: number; source: "reasoning" | "text" }
```

### 2.2 `session/processor.ts`（+33 行）— 流接入

在 `SessionProcessor.process` 函数里：

1. 从 config 读 `experimental.loop` 配置
2. `loop?.enabled !== false` 时，为 reasoning 和 text 各创建一个检测器实例：
   ```typescript
   const reasoning = createLoop({ source: "reasoning", ...loop })
   const text = createLoop({ source: "text", ...loop })
   ```
3. 通过 `Stream.tap` 挂到 LLM 事件流：
   - `reasoning-start` / `text-start` → 调 `reset()`
   - `reasoning-delta` → 调 `reasoning.feed(event.text)`，若返回 outcome 存入 `ctx.loopOutcome`
   - `text-delta` → 调 `text.feed(event.text)`，同理
4. `Stream.takeUntil(() => ctx.needsCompaction || !!ctx.loopOutcome)` — 检测到循环立即中断流
5. `process` 返回时优先返回 `ctx.loopOutcome`

**关键点**：内置方案在 Stream 管道**内部**用 `takeUntil` 同步中断流，时序确定。

### 2.3 `session/prompt.ts`（+52 行）— nudge/abort 决策

在 `SessionPrompt` 的主循环 `while (true)` 里，每次 model call 后检查返回值：

```typescript
let loopAttempt = 0

while (true) {
  // ... model call ...
  const result = yield* processor.process(streamInput)

  if (isLoopOutcome(result)) {
    const decision = loopRecovery(loopAttempt, { max_nudges, reminder, period: result.period })
    loopAttempt++

    if (decision.action === "nudge") {
      // 创建一条 synthetic user message
      const reminder = yield* sessions.updateMessage({
        id: MessageID.ascending(), role: "user", sessionID,
        time: { created: Date.now() }, agent: lastUser.agent, model: lastUser.model,
        format: lastUser.format, tools: lastUser.tools, system: lastUser.system,
        variant: lastUser.model.variant,
      })
      // 往这条 message 里加 text part，内容是 reminder，标记 synthetic: true
      yield* sessions.updatePart({
        id: PartID.ascending(), messageID: reminder.id, sessionID,
        type: "text", text: decision.reminder, synthetic: true,
      })
      return "continue"  // 让 while 循环跑下一轮 model call
    }

    // abort 路径
    handle.message.error = new MessageV2.LoopError({ ... }).toObject()
    handle.message.finish = "error"
    yield* sessions.updateMessage(handle.message)
    return "break"  // 退出 while 循环
  }

  loopAttempt = 0  // 正常完成，重置计数
  // ... 正常流程 ...
}
```

**关键点**：内置方案的 nudge = 插入一条 `synthetic: true` 的 user message（内容是 reminder），然后 `return "continue"` 让 while 循环跑下一轮 model call。模型在新一轮里会看到这条 reminder。

### 2.4 其他文件

| 文件 | 作用 | 插件能否复刻 |
|---|---|---|
| `config/config.ts` | `experimental.loop` zod schema | 用 PluginOptions 替代 ✅ |
| `session/message-v2.ts` | `LoopError` 错误类型 | 不能改消息类型 ❌ 用 showToast + 日志降级 |
| `session/compaction.ts` | compaction 流程里也检测 loop | 插件无法介入 compaction 内部流 ❌ 接受丢失 |
| `sdk/js/src/v2/gen/types.gen.ts` | SDK 类型生成 | 不需要（插件用自己的类型） |

---

## 3. 插件 API 能力分析

基于本地 `@opencode-ai/plugin` 和 `@opencode-ai/sdk` 的类型定义（`node_modules/@opencode-ai/plugin/dist/index.d.ts` 和 `node_modules/@opencode-ai/sdk/dist/v2/gen/`）。

### 3.1 插件入口

```typescript
import type { Plugin } from "@opencode-ai/plugin"

const LoopDetector: Plugin = async (ctx, options) => {
  // ctx.client    — 完整 opencode SDK 客户端（createOpencodeClient 返回值）
  // ctx.serverUrl — 服务器 URL
  // ctx.directory — 项目目录
  // options       — PluginOptions（来自 opencode.json 的 plugin 配置）
  return { /* Hooks */ }
}
export default LoopDetector
```

### 3.2 关键 Hooks

| Hook | 用途 |
|---|---|
| `event` | 接收所有 opencode 事件（SSE），包括 `message.part.delta`、`message.part.updated`、`session.idle` |
| `chat.message` | 新消息接收时触发（可用于感知新一轮开始） |

### 3.3 关键 SDK 方法（`ctx.client`）

**`session.abort`** — 中断活跃 session（等同用户按 Esc）：
```typescript
client.session.abort({ sessionID: string })
// 文档原文：Abort an active session and stop any ongoing AI processing or command execution.
```

**`session.promptAsync`** — 异步发消息，立即返回，触发 AI 响应：
```typescript
client.session.promptAsync({
  sessionID: string,
  parts?: Array<TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput>,
  // TextPartInput 支持 synthetic?: boolean —— 可标记 nudge 消息为 synthetic
})
// 文档原文：Create and send a new message to a session asynchronously, starting the session if needed and returning immediately.
```

**`tui.showToast`** — 通知用户：
```typescript
client.tui.showToast({ title?: string, message?: string, variant?: "info"|"success"|"warning"|"error" })
```

### 3.4 关键事件类型

**`message.part.updated`** — part 创建/更新时触发，带完整 part 对象：
```typescript
type EventMessagePartUpdated = {
  type: "message.part.updated"
  properties: { sessionID: string; part: Part; time: number }
}
// Part 联合类型包含 TextPart (type: "text") 和 ReasoningPart (type: "reasoning")
```

**`message.part.delta`** — part 内容增量，带 partID：
```typescript
type EventMessagePartDelta = {
  type: "message.part.delta"
  properties: { sessionID: string; messageID: string; partID: string; field: string; delta: string }
}
// field 字段不区分 reasoning/text（两者都是往 text 字段写 delta）
// 必须通过 partID 查 message.part.updated 建立的映射来区分
```

**`session.idle`** — session 进入空闲（AI 处理完成或被 abort）：
```typescript
type EventSessionIdle = {
  type: "session.idle"
  properties: { sessionID: string }
}
```

---

## 4. 映射设计：PR #21112 → 插件

### 4.1 映射总表

| PR #21112 组件 | 内置机制 | 插件替代方案 | 等价性 |
|---|---|---|---|
| `loop.ts` create/feed/detect/recovery | 纯函数 | **原样移植** | 100% |
| `processor.ts` Stream.tap | Stream 管道内同步 tap | `event` hook 监听 `message.part.delta` | 功能等价 |
| `processor.ts` Stream.takeUntil | Stream 管道内同步中断 | `client.session.abort`（HTTP 信号） | 功能等价，时序略异 |
| `processor.ts` reasoning/text 区分 | LLM.Event 的 `reasoning-delta`/`text-delta` 事件类型 | `message.part.updated` 建立 partID→type 映射，delta 时查映射 | 等价 |
| `prompt.ts` nudge（synthetic user message + continue） | 在 while 循环内插消息 + return "continue" | `session.abort` + 等 `session.idle` + `session.promptAsync(synthetic reminder)` | 语义等价 |
| `prompt.ts` abort（LoopError + break） | 设 message.error + return "break" | `session.abort` + `tui.showToast` + 日志 | 降级（无 LoopError 类型） |
| `config.ts` experimental.loop | zod schema in config | PluginOptions | 100% |
| `message-v2.ts` LoopError | 消息错误类型 | 做不到，用 showToast + 日志替代 | 降级 |
| `compaction.ts` loop 检测 | compaction 流程内检测 | 做不到，接受丢失 | 丢失（边缘场景） |
| `loopAttempt` 状态 | while 循环内局部变量 | per-session nudgeCount 状态 | 等价 |

### 4.2 nudge 的等价性详解

**内置方案**（prompt.ts）：
1. processor 检测到循环，takeUntil 中断当前流
2. prompt.ts 主循环收到 LoopOutcome
3. 创建 synthetic user message（内容 = reminder），return "continue"
4. while 循环下一轮：model call 带上这条 synthetic message，模型看到 reminder

**插件方案**：
1. event hook 检测到循环
2. 调 `session.abort` 中断当前流（等同 takeUntil 的效果）
3. 等 `session.idle` 确认中断完成
4. 调 `session.promptAsync({ parts: [{ type: "text", text: reminder, synthetic: true }] })`
5. opencode 创建 user message + 触发新一轮 model call，模型看到 reminder

两者都是"中断当前生成 + 插入一条 synthetic user message（reminder）+ 触发新一轮 model call"。语义完全等价。`TextPartInput` 支持 `synthetic: true`，与内置方案一致。

### 4.3 中断机制差异

| | 内置（takeUntil） | 插件（session.abort） |
|---|---|---|
| 中断位置 | Stream 管道内部，同步 | HTTP 信号传到 server 再中断 |
| 时序确定性 | 高（同步） | 依赖信号传播，有延迟 |
| "杀不干净"风险 | 低 | 有（需 HTTP fallback + 等 idle 确认） |
| 重发控制 | while 循环内 return "continue" | promptAsync + 等 idle |

插件方案通过 **abort → 等 session.idle → promptAsync** 的串行时序来保证可靠性。`session.idle` 事件是"中断已完成"的确认信号。

---

## 5. 检测算法（从 loop.ts 移植）

以下逻辑原样移植自 PR #21112 的 `loop.ts`，不修改算法。

### 5.1 常量与类型

```typescript
export type LoopOutcome = {
  type: "loop"
  period: number
  source: "reasoning" | "text"
}

export const DEFAULTS = {
  min_period: 10,
  max_period: 2000,
  similarity: 1.0,
  check_interval: 100,
  min_chars: 200,
  max_nudges: 1,
} as const

const REMINDER =
  "<system-reminder>\nYour output is repeating in a loop with period ~{period} characters. " +
  "Stop repeating and take a different, concrete action.\n</system-reminder>"

const ALPHANUMERIC = /[\p{L}\p{N}]/u
```

### 5.2 辅助函数

```typescript
// 折叠空白 + trim，应对 LLM 输出中多余的换行/缩进漂移
function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

// 字符级相似度（逐位比较）
function similarity(first: string, second: string, threshold: number): number {
  const length = Math.max(first.length, second.length)
  if (length === 0) return 1.0
  if (Math.abs(first.length - second.length) > (1 - threshold) * length) return 0
  let matches = 0
  const shorter = Math.min(first.length, second.length)
  for (let i = 0; i < shorter; i++) {
    if (first[i] === second[i]) matches++
  }
  return matches / length
}
```

### 5.3 create 工厂

```typescript
export function create(options: {
  source: "reasoning" | "text"
  min_period?: number
  max_period?: number
  similarity?: number
  check_interval?: number
  min_chars?: number
  on_detected?: (outcome: LoopOutcome) => void
}) {
  const minPeriod = options.min_period ?? DEFAULTS.min_period
  const maxPeriod = options.max_period ?? DEFAULTS.max_period
  const threshold = options.similarity ?? DEFAULTS.similarity
  const interval = options.check_interval ?? DEFAULTS.check_interval
  const minChars = options.min_chars ?? DEFAULTS.min_chars
  const capacity = 2 * maxPeriod
  const source = options.source

  let buffer = ""
  let total = 0
  let last = 0

  function detect(): LoopOutcome | undefined {
    const length = buffer.length
    if (length < 2 * minPeriod) return undefined

    const upper = Math.min(Math.floor(length / 2), maxPeriod)
    const lower = minPeriod

    for (let period = upper; period >= lower; period--) {
      // 两点快速预检
      const tail = length - 1
      const mid = length - 1 - Math.floor(period / 2)
      if (buffer[tail] !== buffer[tail - period]) continue
      if (buffer[mid] !== buffer[mid - period]) continue

      // 完整归一化比较
      const first = normalize(buffer.slice(length - 2 * period, length - period))
      const second = normalize(buffer.slice(length - period))

      const score = threshold >= 1.0
        ? (first === second ? 1.0 : 0)
        : similarity(first, second, threshold)
      if (score < threshold) continue

      // 字母数字过滤
      if (!ALPHANUMERIC.test(second)) continue

      const outcome: LoopOutcome = { type: "loop", period, source }
      options.on_detected?.(outcome)
      return outcome
    }
    return undefined
  }

  return {
    feed(delta: string): LoopOutcome | undefined {
      buffer += delta
      total += delta.length
      if (buffer.length > capacity) buffer = buffer.slice(buffer.length - capacity)
      if (total < minChars) return undefined
      if (total - last < interval) return undefined
      last = total
      return detect()
    },
    reset() {
      buffer = ""
      total = 0
      last = 0
    },
  }
}
```

### 5.4 recovery 函数

```typescript
export function recovery(
  attempt: number,
  options?: { max_nudges?: number; reminder?: string; period?: number },
): { action: "nudge"; reminder: string } | { action: "abort"; period: number; attempts: number } {
  const nudges = options?.max_nudges ?? DEFAULTS.max_nudges
  const period = options?.period ?? 0

  if (attempt < nudges) {
    const template = options?.reminder ?? REMINDER
    return { action: "nudge", reminder: template.replace("{period}", String(period)) }
  }
  return { action: "abort", period, attempts: attempt + 1 }
}
```

---

## 6. 事件处理与状态管理

### 6.1 per-session 状态

```typescript
interface SessionState {
  // partID → "text" | "reasoning" 映射，通过 message.part.updated 事件建立
  partTypes: Map<string, "text" | "reasoning">

  // 两个独立检测器（与 PR #21112 一致，分别检测 reasoning 和 text）
  reasoningDetector: ReturnType<typeof create>
  textDetector: ReturnType<typeof create>

  // nudge 计数（跨 message，nudge 链中保持，正常完成时重置）
  nudgeCount: number

  // abort 后的待执行动作（nudge 或 abort），等 session.idle 时执行
  pendingAction: { type: "nudge"; reminder: string; period: number; source: string }
                  | { type: "abort"; period: number; attempts: number; source: string }
                  | null

  // 防止重入：abort 发出后到 idle 之间忽略 delta
  aborting: boolean
}
```

状态存储：`Map<sessionID, SessionState>`，在 `session.idle` 时按条件清理。

### 6.2 事件处理流程

#### `message.part.updated` 事件

建立 partID → type 映射：

```
收到 message.part.updated
  → 取 properties.part
  → 如果 part.type === "text" 或 part.type === "reasoning"
  → state.partTypes.set(part.id, part.type)
```

#### `message.part.delta` 事件

核心检测入口：

```
收到 message.part.delta
  → 取 { sessionID, messageID, partID, delta }
  → 获取（或创建）sessionState
  → 如果 sessionState.aborting → 忽略（abort 信号已发出，等 idle）
  → 如果 sessionState.pendingAction !== null → 忽略（已有待处理动作）
  → 查 partTypes.get(partID) 确定 source：
      "reasoning" → outcome = reasoningDetector.feed(delta)
      "text"      → outcome = textDetector.feed(delta)
      未知的 partID → 忽略（等 part.updated 建立映射后再处理后续 delta）
  → 如果 outcome !== undefined：
      → 调用 handleLoopDetected(sessionID, outcome)
```

#### `session.idle` 事件

处理 pendingAction 或清理：

```
收到 session.idle
  → 取 { sessionID }
  → 获取 sessionState
  → 如果 sessionState.pendingAction === null：
      // 正常结束（无循环），重置检测器和计数
      → reasoningDetector.reset()
      → textDetector.reset()
      → nudgeCount = 0
      → aborting = false
  → 如果 sessionState.pendingAction.type === "nudge"：
      // abort 已完成，发 nudge 消息触发新一轮
      → client.session.promptAsync({
          sessionID,
          parts: [{ type: "text", text: pendingAction.reminder, synthetic: true }]
        })
      → nudgeCount++
      → reasoningDetector.reset()
      → textDetector.reset()
      → aborting = false
      → pendingAction = null
  → 如果 sessionState.pendingAction.type === "abort"：
      // nudge 耗尽，最终终止
      → client.tui.showToast({
          title: "Loop Detected",
          message: `Repetitive ${source} output detected (period ~${period} chars) after ${attempts} attempts. Session aborted.`,
          variant: "warning"
        })
      → 清理 sessionState（从 Map 中删除）
```

### 6.3 handleLoopDetected 函数

```
handleLoopDetected(sessionID, outcome):
  → state.aborting = true
  → decision = recovery(state.nudgeCount, {
      max_nudges: config.max_nudges,
      reminder: config.reminder,
      period: outcome.period
    })
  → if decision.action === "nudge":
      → state.pendingAction = { type: "nudge", reminder: decision.reminder, period, source: outcome.source }
  → else (abort):
      → state.pendingAction = { type: "abort", period, attempts: decision.attempts, source: outcome.source }
  → 调用 client.session.abort({ sessionID })
  → 如果 abort 失败（catch），HTTP fallback：
      → fetch(`${serverUrl}/session/${sessionID}/abort`, { method: "POST" })
  → 日志记录
```

---

## 7. nudge→abort 完整时序

### 7.1 正常 nudge→恢复 时序

```
[模型生成中，reasoning 循环]
  message.part.delta (reasoning) → feed → detect → LoopOutcome!
    → handleLoopDetected:
      → aborting = true
      → pendingAction = { type: "nudge", reminder, ... }
      → client.session.abort({ sessionID })
  [后续 delta 被忽略，因为 aborting=true]

[abort 信号传播，流中断]
  session.idle
    → pendingAction.type === "nudge"
    → client.session.promptAsync({ parts: [{ type:"text", text: reminder, synthetic: true }] })
    → nudgeCount = 1
    → reset detectors, aborting = false, pendingAction = null

[模型新一轮生成，看到 reminder 后换方向]
  message.part.updated (reasoning part) → partTypes 更新
  message.part.delta (reasoning) → feed → detect → undefined（正常）
  ...
  session.idle
    → pendingAction === null → 正常重置，nudgeCount = 0
```

### 7.2 nudge 耗尽→abort 时序（max_nudges=1）

```
[第 1 次循环]
  detect → LoopOutcome!
    → recovery(0) = nudge
    → abort + pendingAction = nudge
  session.idle → promptAsync(reminder) → nudgeCount = 1

[第 2 次循环（nudge 后仍循环）]
  detect → LoopOutcome!
    → recovery(1) = abort（因为 1 >= max_nudges=1）
    → abort + pendingAction = abort
  session.idle
    → pendingAction.type === "abort"
    → showToast("Loop Detected, session aborted")
    → 清理 sessionState
```

### 7.3 重入防护

- `aborting = true`：abort 发出后到 idle 之间，所有 delta 被忽略，防止重复触发检测
- `pendingAction !== null`：已有待处理动作时，新 delta 被忽略，防止重复 abort
- `abortedSessions` Set（可选额外层）：防止极端情况下同一 session 被多次 abort

---

## 8. 配置设计

通过 PluginOptions 传递（在 `opencode.json` 的 `plugin` 数组里配置）：

```typescript
interface LoopDetectorConfig {
  enabled?: boolean         // 默认 true，设为 false 禁用
  min_period?: number       // 默认 10，最小重复块长度
  max_period?: number       // 默认 2000，最大重复块长度
  similarity?: number       // 默认 1.0（精确匹配），0-1
  check_interval?: number   // 默认 100，检测间隔字符数
  min_chars?: number        // 默认 200，开始检测的最低字符数
  max_nudges?: number       // 默认 1，nudge 次数上限
  reminder?: string         // 自定义 nudge 文本（可用 {period} 占位符）
}
```

opencode.json 配置示例：
```json
{
  "plugin": [
    ["~/.config/opencode/plugins/opencode-loop-detector.ts", {
      "min_period": 10,
      "max_period": 2000,
      "max_nudges": 2,
      "reminder": "<system-reminder>\n你正在重复输出（周期约 {period} 字符）。请停止重复，采取不同的具体行动。\n</system-reminder>"
    }]
  ]
}
```

**注意**：插件路径必须使用完整路径，不能用插件名，否则 options 无法传递。

---

## 9. 已知限制与降级

### 9.1 做不到的部分

| 功能 | 原因 | 降级方案 |
|---|---|---|
| `LoopError` 消息类型 | 插件不能修改 opencode 的 MessageV2 类型系统 | 用 `tui.showToast` 通知用户 + 日志记录 |
| compaction 流程内检测 | compaction 是 opencode 内部流程，插件无法介入其流处理 | 接受丢失（compaction 循环是边缘场景） |
| Stream 管道内同步中断 | 插件没有 Stream 管道访问权 | 用 `session.abort` + 等 `session.idle` 串行化 |

### 9.2 可靠性注意点

- **abort 延迟**：`session.abort` 是 HTTP 信号，传播到 server 再中断流有延迟。通过 `aborting` 标记 + 等 `session.idle` 确认来保证时序。如果 SDK abort 失败，fallback 到直接 `fetch POST /session/{id}/abort`。
- **session.idle 保证**：abort 后 opencode 应该会触发 `session.idle` 事件。如果极端情况下没触发，需要加超时兜底（如 abort 后 5 秒未收到 idle，直接发 promptAsync 或清理状态）。
- **nudge 消息在历史中可见**：`promptAsync` 发的 synthetic user message 会出现在对话历史里。`synthetic: true` 标记让 opencode 知道这是系统注入的，但用户在 TUI 里可能看到。这与内置方案行为一致（内置也用 `synthetic: true`）。

---

## 10. 需要实现时确认的点

以下点在设计中已给出方案，但实现时建议验证：

1. **`message.part.delta` 的 `field` 字段值**：设计上不依赖 field 区分 reasoning/text（用 partTypes 映射），但实现时可打印 field 值用于调试。如果 field 本身就能区分（如 "reasoning" vs "text"），可简化为不维护 partTypes 映射。

2. **`session.promptAsync` 是否需要指定 agent/model**：设计中只传 `sessionID` + `parts`，依赖 session 默认 agent/model。实现时确认不传 agent/model 是否正常工作。如果需要，可从 `chat.message` hook 或 `session.get` 获取当前 agent/model。

3. **abort 后 `session.idle` 是否一定触发**：设计依赖 idle 作为"abort 完成"信号。实现时验证 abort 后是否稳定收到 idle。如果不稳定，加超时兜底。

4. **`promptAsync` 发消息后的事件序列**：确认 promptAsync 后的事件流是 `message.part.updated`（新 part）→ `message.part.delta`（delta）→ `session.idle`（完成），还是有其他事件。这影响检测器重置时机。

5. **subagent 场景**：subagent 的生成是否也通过 `message.part.delta` 事件传到插件？如果是，插件会检测到 subagent 的循环。如果 subagent 用独立 session，则插件只检测主 session。实现时验证。
