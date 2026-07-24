# opencode-loop-detector 实现计划

本文档是 [DESIGN.md](./DESIGN.md) 的配套实现指南，供 opencode 会话照此实现。

**开始实现前，必须先完整阅读 `DESIGN.md`。** 本文档只规定文件结构、步骤和验收标准，算法细节和设计原理见 DESIGN.md。

---

## 1. 项目结构

```
opencode-loop-detector/
├── DESIGN.md                          # 设计文档（已完成，必读）
├── PLAN.md                            # 本文件
├── opencode-loop-detector.ts          # 插件主文件（待实现）
├── loop.ts                            # 检测算法（从 PR #21112 移植，待实现）
└── test.ts                            # 测试文件（待实现）
```

### 文件职责

| 文件 | 职责 | 依赖 |
|---|---|---|
| `loop.ts` | 检测算法：`create()`、`feed()`、`detect()`、`recovery()`、`DEFAULTS`、`LoopOutcome` 类型。纯函数，零外部依赖 | 无 |
| `opencode-loop-detector.ts` | 插件入口：event hook、状态管理、abort/promptAsync 时序、配置加载 | `loop.ts`、`@opencode-ai/plugin`、`@opencode-ai/sdk` |
| `test.ts` | 测试：检测算法单元测试 + 时序模拟 | `loop.ts` |

### 为什么拆两个文件

`loop.ts` 是纯算法，与 PR #21112 的 `session/loop.ts` 一一对应，可独立测试。`opencode-loop-detector.ts` 是插件胶水层，依赖 opencode API。拆分后算法可单独验证，不受插件运行时影响。

---

## 2. 实现阶段

### Phase 1：移植检测算法（`loop.ts`）

**目标**：把 PR #21112 的 `session/loop.ts` 原样移植为独立模块。

**步骤**：

1. 创建 `loop.ts`
2. 定义类型和常量：
   - `LoopOutcome` 类型
   - `DEFAULTS` 常量（min_period=10, max_period=2000, similarity=1.0, check_interval=100, min_chars=200, max_nudges=1）
   - `REMINDER` 模板字符串
   - `ALPHANUMERIC` 正则
3. 实现辅助函数：
   - `normalize(text)` — 折叠空白 + trim
   - `similarity(first, second, threshold)` — 字符级逐位相似度
   - `hasAlphanumeric(text)` — Unicode 字母/数字检测
4. 实现 `create(options)` 工厂：
   - 内部状态：`buffer`、`total`、`last`
   - `detect()` — 两点预检 + 归一化比较 + 字母数字过滤，从长到短扫描 period
   - 返回 `{ feed, reset }`
5. 实现 `recovery(attempt, options)` — nudge/abort 决策
6. 实现 `isLoopOutcome(value)` — 类型守卫

**参考**：DESIGN.md 第 5 节有完整伪代码，直接对照实现。

**验收**：
- `loop.ts` 无外部依赖（不 import opencode 任何模块）
- `create()` 返回的检测器，喂入重复文本能返回 `LoopOutcome`，喂入正常文本返回 `undefined`
- `recovery(0, { max_nudges: 1 })` 返回 nudge，`recovery(1, { max_nudges: 1 })` 返回 abort

---

### Phase 2：插件骨架与配置（`opencode-loop-detector.ts` 基础部分）

**目标**：搭出插件入口、配置加载、日志、状态结构。

**步骤**：

1. 创建 `opencode-loop-detector.ts`
2. import `Plugin` 类型和 `loop.ts` 的 `create`、`recovery`、`DEFAULTS`、`LoopOutcome`
3. 定义 `LoopDetectorConfig` 接口（见 DESIGN.md 第 8 节）
4. 定义 `SessionState` 接口（见 DESIGN.md 第 6.1 节）
5. 实现配置加载：
   - 从 `options`（PluginOptions）读取配置，合并 DEFAULTS
   - 如果 `enabled === false`，返回空 hooks
6. 实现日志函数（写文件 `~/.loop-detector/detector.log`，参考 think-loop-detector 的日志方式但独立目录）
7. 实现 per-session 状态管理：
   - `sessions: Map<string, SessionState>`
   - `getOrCreateState(sessionID)` — 获取或创建 SessionState
   - `createDetectors(config)` — 用 `loop.create()` 创建 reasoning 和 text 两个检测器
8. 导出默认 Plugin 函数，返回 `{ event, dispose }` hooks

**验收**：
- 插件能被 opencode 加载（`opencode.json` 配置后不报错）
- 日志文件能写入
- `event` hook 能收到事件并打印日志

---

### Phase 3：事件处理与检测接入

**目标**：在 `event` hook 里监听事件、建立 partType 映射、喂 delta 给检测器。

**步骤**：

1. 在 `event` hook 里处理三类事件：

   **`message.part.updated`**：
   - 取 `properties.part`
   - 如果 `part.type === "text"` 或 `part.type === "reasoning"`：
     - `state.partTypes.set(part.id, part.type)`

   **`message.part.delta`**：
   - 取 `{ sessionID, partID, delta }`
   - `getOrCreateState(sessionID)`
   - 如果 `state.aborting` 或 `state.pendingAction !== null` → return
   - `source = state.partTypes.get(partID)`
   - 如果 source 未定义 → return（等 part.updated 建立映射）
   - `outcome = source === "reasoning" ? state.reasoningDetector.feed(delta) : state.textDetector.feed(delta)`
   - 如果 `outcome` → 调用 `handleLoopDetected(sessionID, outcome)`

   **`session.idle`**：
   - 取 `{ sessionID }`
   - 获取 state（不存在则 return）
   - 按 `pendingAction` 类型处理（见 DESIGN.md 第 6.2 节 session.idle 分支）

2. 实现 `handleLoopDetected(sessionID, outcome)`：
   - `state.aborting = true`
   - `decision = recovery(state.nudgeCount, { max_nudges, reminder, period: outcome.period })`
   - 设 `state.pendingAction`（nudge 或 abort）
   - 调 `client.session.abort({ sessionID })`
   - catch 失败 → HTTP fallback `fetch(\`${serverUrl}/session/${sessionID}/abort\`, { method: "POST" })`
   - 日志记录

**验收**：
- 模型正常生成时，日志显示 delta 被喂入检测器，无 outcome
- 模型循环时，日志显示 LoopOutcome 检测到，abort 被调用
- partTypes 映射正确建立（日志可查）

---

### Phase 4：nudge→abort 完整流程

**目标**：实现 nudge（promptAsync 发 reminder）和 abort（showToast 通知）的完整时序。

**步骤**：

1. 在 `session.idle` 事件处理中实现 pendingAction 分支：

   **pendingAction === null（正常结束）**：
   - `reasoningDetector.reset()`、`textDetector.reset()`
   - `nudgeCount = 0`、`aborting = false`

   **pendingAction.type === "nudge"**：
   - `client.session.promptAsync({ sessionID, parts: [{ type: "text", text: pendingAction.reminder, synthetic: true }] })`
   - `nudgeCount++`
   - `reasoningDetector.reset()`、`textDetector.reset()`
   - `aborting = false`、`pendingAction = null`
   - 日志记录 nudge 发送

   **pendingAction.type === "abort"**：
   - `client.tui.showToast({ title: "Loop Detected", message: "...", variant: "warning" })`
   - `sessions.delete(sessionID)` — 清理状态
   - 日志记录最终 abort

2. 加超时兜底（可选但建议）：
   - abort 后设一个 5 秒超时
   - 如果 5 秒内没收到 `session.idle`，直接执行 pendingAction（不等 idle）
   - 防止 idle 事件丢失导致卡死

**验收**：
- 循环触发 nudge → 模型换方向 → 正常完成（nudgeCount 归零）
- nudge 后仍循环 → 最终 abort → showToast → 状态清理
- 无 pendingAction 的正常 idle → 检测器重置

---

### Phase 5：测试（`test.ts`）

**目标**：验证检测算法和时序逻辑。

**步骤**：

1. **检测算法单元测试**（纯函数，用 bun test）：
   - 精确重复检测：喂入 `"ABCABCABC"`（period=3），应检测到
   - 空白归一化：喂入 `"A B C\nA B C\nA B C"`，应检测到
   - 字母数字过滤：喂入 `"---\n---\n---"`，不应检测到
   - min_chars 门槛：总字符不足 200 时不检测
   - check_interval 间隔：距上次检查不足 100 字符时不检测
   - 正常文本不误报：喂入一段不重复的长文本，应返回 undefined
   - recovery：nudge/abort 决策正确

2. **时序模拟测试**（mock client）：
   - 模拟 delta 事件流 → 检测到循环 → 验证 abort 被调用
   - 模拟 idle 事件 → 验证 promptAsync 被调用（nudge 路径）
   - 模拟二次循环 → 验证 showToast 被调用（abort 路径）

**验收**：
- `bun run test.ts` 全部通过
- 检测算法的边界情况覆盖（短文本、长重复、空白变体、结构化模式）

---

## 3. 关键实现细节备忘

### 3.1 配置读取

插件 options 通过 Plugin 函数的第二个参数传入：
```typescript
const LoopDetector: Plugin = async (ctx, options) => {
  const config = { ...DEFAULTS, ...(options as LoopDetectorConfig) }
  // ...
}
```

如果 options 为 undefined（用户没在 opencode.json 里配参数），用 DEFAULTS。

### 3.2 client 的 abort 调用形式

SDK 类型定义中 `session.abort` 的参数是 `{ sessionID: string }`。但 think-loop-detector 用的是 `client.session.abort({ path: { id: sessionId } })`（旧版形式）。实现时以本地 SDK 类型定义为准：

```typescript
// 优先尝试新版形式
await client.session.abort({ sessionID })
// 如果报错，fallback 到旧版形式
await client.session.abort({ path: { id: sessionID } })
```

或者直接用 HTTP fallback：
```typescript
await fetch(`${serverUrl}/session/${sessionID}/abort`, { method: "POST" })
```

实现时先测试哪种形式可用，统一用一种。

### 3.3 promptAsync 的参数

```typescript
await client.session.promptAsync({
  sessionID,
  parts: [{
    type: "text",
    text: reminder,        // reminder 文本，含 <system-reminder> 标签
    synthetic: true,       // 标记为系统注入，与 PR #21112 一致
  }],
})
```

不传 `agent` / `model`，依赖 session 默认。如果实现时发现需要指定，从 `session.get` 或之前缓存的 `chat.message` hook 数据中获取。

### 3.4 日志

参考 think-loop-detector 的日志方式，但用独立目录避免冲突：
```typescript
const LOG_DIR = join(process.env.HOME || "/tmp", ".loop-detector")
const LOG_FILE = join(LOG_DIR, "detector.log")
```

关键日志点：
- 插件加载（serverUrl、config）
- partType 映射建立
- delta 喂入（可选，debug 级别）
- LoopOutcome 检测到（sessionID、period、source）
- abort 调用（成功/失败）
- session.idle 处理（pendingAction 类型）
- promptAsync 发送（nudge 次数）
- showToast（最终 abort）

### 3.5 内存管理

- `sessions` Map 在 `session.idle` 且 pendingAction 为 abort 时删除条目
- `partTypes` Map 在 session 清理时一并释放
- 可选：加 LRU 淘汰（如 think-loop-detector 的 `_MAX_TRACKED_THREADS`），防止异常情况下 Map 无限增长

---

## 4. 验收标准

### 4.1 功能验收

| 场景 | 预期行为 |
|---|---|
| 模型正常生成（无循环） | 无干预，检测器在 idle 时重置 |
| 模型 reasoning 循环 | 检测到 → nudge（发 reminder）→ 模型换方向或再次循环 |
| 模型 text 循环 | 同上 |
| nudge 后模型恢复 | 正常完成，nudgeCount 归零 |
| nudge 后仍循环（max_nudges 耗尽） | abort + showToast 通知用户 |
| enabled: false | 插件不干预，返回空 hooks |
| 自定义 reminder | 使用用户配置的 reminder 文本 |
| 自定义 max_nudges=2 | 两次 nudge 后才 abort |

### 4.2 可靠性验收

| 场景 | 预期行为 |
|---|---|
| abort SDK 调用失败 | HTTP fallback 成功中断 |
| session.idle 未触发 | 5 秒超时兜底执行 pendingAction |
| 同一 session 快速多次循环 | aborting 标记防止重入，不重复 abort |
| 正常对话多轮 | 每轮 idle 后检测器重置，nudgeCount 归零 |

### 4.3 性能验收

- 检测器 buffer 有界（2 × max_period），不会无限增长
- 检测频率受 check_interval 控制（默认每 100 字符一次）
- 两点预检 O(1) 拒绝大多数非重复 period，性能开销极低

---

## 5. 安装与配置

### 5.1 安装

```bash
# 把两个 .ts 文件放到插件目录
cp opencode-loop-detector.ts loop.ts ~/.config/opencode/plugins/
```

### 5.2 配置

在 `~/.config/opencode/opencode.json` 中添加：

```json
{
  "plugin": [
    ["~/.config/opencode/plugins/opencode-loop-detector.ts", {
      "max_nudges": 2,
      "reminder": "<system-reminder>\n你正在重复输出（周期约 {period} 字符）。请停止重复，采取不同的具体行动。\n</system-reminder>"
    }]
  ]
}
```

**注意**：路径必须用完整路径（`~/.config/opencode/plugins/...`），不能用插件名，否则 options 无法传递。

### 5.3 日志查看

```bash
tail -f ~/.loop-detector/detector.log
```

---

## 6. 与 PR #21112 的差异清单

实现完成后，以下是与 PR #21112 内置方案的已知差异（均为设计决策，非缺陷）：

| 差异点 | PR #21112 | 本插件 | 原因 |
|---|---|---|---|
| 中断机制 | Stream.takeUntil（同步） | session.abort（HTTP） | 插件无 Stream 管道访问权 |
| nudge 重发 | while 循环内 return "continue" | abort + 等 idle + promptAsync | 插件无 while 循环控制权 |
| LoopError 类型 | message-v2.ts 定义 | 无，用 showToast 替代 | 插件不能改消息类型系统 |
| compaction 检测 | compaction.ts 内检测 | 无 | 插件无法介入 compaction 内部流 |
| 配置入口 | experimental.loop | PluginOptions | 插件配置机制 |
| 中断时序 | 同步确定 | 依赖 abort 信号传播 + idle 确认 | 架构差异，通过串行化保证 |

检测算法（loop.ts）与 PR #21112 **完全一致**，无任何修改。
