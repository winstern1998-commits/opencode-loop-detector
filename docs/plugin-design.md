# opencode-loop-detector 设计文档

## 功能

插件监听 opencode 的流式事件，将 reasoning / text 的 delta 同时喂入两类检测器：

**Loop 检测器**（精确字符循环）：在缓冲区中从大到小尝试所有可能的重复周期（period），对末尾 `min_repeats` 个 period 长度的文本块做归一化（空白折叠）后比较：全部相同则判定为循环。要求重复 ≥ `min_repeats` 次而非 2 次，可避免路径、标识符等天然重复 2 次的结构被误判为循环。

**Spiral 检测器**（推理螺旋）：在滑动窗口内按句子分割文本，统计重复句子占比。当重复率超过 `spiral_dup_threshold`（默认 0.5）时触发。用于捕获 loop 检测器无法检测的"语义螺旋"——模型在推理中反复规划同样的行动但从不执行，每次措辞略有不同，不构成精确字符重复，但句子级重复率高达 50% 以上。

两类检测器并行运行，任一触发即进入 nudge/abort 流程。

检测到循环后的处理策略由 `max_nudges` 控制：

- **nudge**（nudgeCount < max_nudges）：中断当前生成 → 等待 abort 落地 → 发送可见的提醒消息（TUI 可见，以原 agent/model 继续）→ 模型重新生成；session agent 无法确定时跳过发送（仅中断 + error toast，不消耗 nudge 额度）
- **abort**（nudgeCount ≥ max_nudges）：中断当前生成 → 等待 abort 落地 → 显示 toast 通知 → 清理会话

### 配置参数

| 参数 | 默认值 | 含义 |
|------|--------|------|
| `min_chars` | 200 | 累计字符数达到此值后才开始检测 |
| `check_interval` | 100 | 每隔多少字符执行一次检测 |
| `min_period` | 20 | 最小重复周期（字符数） |
| `max_period` | 2000 | 最大重复周期（缓冲区 = min_repeats × max_period） |
| `similarity` | 1.0 | 相似度阈值，1.0 = 归一化后完全匹配 |
| `min_repeats` | 4 | 末尾需匹配的重复段数，低于此值不触发（防止路径等天然 2 次重复误报） |
| `max_nudges` | 2 | 最大 nudge 次数，超过后直接 abort |
| `spiral_min_chars` | 2000 | spiral 检测器启动门槛，累计字符数达到此值后才开始检测 |
| `spiral_check_interval` | 100 | spiral 检测器检查间隔（字符数） |
| `spiral_window_size` | 8000 | spiral 检测器滑动窗口大小（字符数） |
| `spiral_dup_threshold` | 0.5 | spiral 检测器重复率阈值，超过此值触发 |
| `spiral_min_sentence_len` | 15 | spiral 检测器忽略过短句子（归一化后长度） |
| `spiral_min_sentences` | 20 | spiral 检测器窗口内最少句子数，不够则不判断 |
| `stats_path` | `~/.loop-detector/stats.json` | 统计数据落盘路径，一般无需修改 |

### similarity 计算

- `similarity: 1.0`（当前配置）：两个归一化后的文本块必须**完全相同**
- `similarity < 1.0`：逐字符位置比较，`matches / max_length` 达标即可

## Nudge 消息的可见性

`TextPartInput` 有一个可选字段 `synthetic?: boolean`：设为 `true` 时消息仍然作为对话上下文发送给模型，但不会渲染在 TUI 聊天界面中（适合注入用户无需看到的系统级指令）。

插件**不使用** `synthetic`：nudge 消息是一条普通 user 消息，模型和用户都能看到，提醒文本以 `[Loop Detector]` 前缀标识来源，text part 带 `metadata: { source: "loop-detector" }` 机器可读标记（E2E 检测、其它插件的用户活动识别均可据此区分插件注入与真实用户消息）。`tui.showToast` 在消息发送成功后弹出，文案反映实际结果：正常路径为 warning 级 "Reminder sent to redirect."；abort 等待超时路径为 error 级 "Reminder sent while the session is still aborting; it may not take effect."。

插件在发送提醒前会等待 `session.abort` 的 HTTP 调用完全返回（`state.abortPromise`，上限 `ABORT_WAIT_MS = 10000ms`）。`session.idle` 事件可能先于 abort 落地到达，若此时立刻发送新消息，新生成会被同一波 abort 级联杀死（新 assistant 消息 0 tokens、MessageAbortedError）。等待超时后仍 best-effort 发送（消息可见是核心价值），由 error 级 toast 说明提醒可能失效；该次发送**计入** nudge 额度（见下方计数语义）。

executePendingAction 执行期间到达的重复/滞后 `session.idle`（`pendingAction` 已被同步清空、`aborting` 仍为 true，例如 runner cancel 与自然结束竞争双发 idle）会被**忽略**，不会重置 `nudgeCount` 与 `aborting`。否则升级计数被清零，会反复 nudge 而永不 abort。

abort 等待**超时**后 best-effort 继续时，旧 abort 仍可能在途：当它最终落地，服务端可能补发一个滞后 idle（此时 `pendingAction` 已清空、`aborting` 也已复位，会落入"正常完成"分支）。插件在超时分支给旧 abort promise 挂上标记 → `state.pendingStaleIdle = true`；该 idle 到达时消费标记、跳过本次 reset（下一次正常 idle 再 reset），避免抹掉 `nudgeCount`。

`handleDetected` **不等待** abort promise：把 promise 存入 `state.abortPromise` 后立即 arm 5 秒 idle 兜底计时器。否则 abort 调用挂起且 `session.idle` 不到达时，`handleDetected` 会一直阻塞在 await 上、兜底计时器永不 arm，session 将永久处于 `aborting` 静音状态。等待 abort 由 `executePendingAction` 负责（带超时上限），`handleDetected` 无需再等。

同时，`promptAsync` 必须显式传入 `agent`（以及可用的 `model` / `variant`）：不传 `agent` 时 opencode 的 `createUserMessage` 会回退到默认 agent 并通过 `setAgentModel` 永久改写 session 的 agent 记录，使 nudge 触发的新生成以错误 agent 身份运行（opencode 自己的 task tool 继续 subagent 时也会显式传 `agent: "<subagent 名>"`）。`variant` 会做归一：服务端未设置 variant 时以字面量 `"default"` 落库，快照（session.updated）与恢复（session.get）两处都将其归一为 `undefined`，不透传字面量。快照缺失时的兜底与拒绝策略：

1. `executePendingAction` 发送前发现无快照 `agent` → 调用 `client.session.get({ path: { id } })` 查询 session 记录（**带 5 秒超时**，超时按查询失败处理），查到则用查到的 `agent`（及 `model` / `variant`）补全 body 后发送
2. 查询失败或记录中也没有 `agent` → **放弃本次 nudge**：不发送、不递增 `nudgeCount`、不计入统计；重置检测器并清除 `aborting`，写日志说明跳过原因，同时弹 error 级 toast（标题 "Loop Detected — Nudge Skipped" / "Spiral Detected — Nudge Skipped"）

计数语义（防无限累积与防风暴）：

- `promptAsync` 成功返回（含 abort 等待超时后的 best-effort 发送）→ 递增 `nudgeCount` 与统计。超时发送的消息确实进入了会话历史（模型下一轮有机会读到），若不计入，反复超时会导致"每次检测都发可见 nudge 却永不升级到 abort"；代价是消息真被 abort 吞掉时，升级到 abort 会提前一次
- `promptAsync` 带 5 秒上限（`PROMPT_SEND_TIMEOUT_MS`）：race 超时按"已发起、未确认"处理，同样**计入** `nudgeCount` 与统计（日志标注 `promptAsync timed out (counted)`），避免挂起的发送让 session 永久静音、且不计数造成无限累积；超时后原 promise 的迟到 rejection 被吞掉（不产生 unhandled rejection）
- `promptAsync` 抛异常（发送失败）或 agent 无法确定（跳过）→ **不消耗** nudge 额度，各自写日志/toast

状态迁移顺序：nudge 成功/超时/跳过后，4 个检测器 reset 与 `aborting = false` 先于 toast 执行；abort（终止）分支同样先 `sessions.delete` 再弹 toast。所有 toast 都是 fire-and-forget（`void ... .catch(...)`），挂起的 toast 不会阻塞状态机、不会让 session 保持静音。

`ABORT_WAIT_MS = 10000`（abort 落地实测 ~2.2s，5s 余量偏小）。最坏情况下 nudge 延迟 = `IDLE_TIMEOUT_MS`（5s）+ `ABORT_WAIT_MS`（10s），可接受。

## Nudge 完整流程

### 触发条件

检测器在 `feed(delta)` 后返回 outcome，表示发现重复模式：

- Loop 检测器（`reasoningDetector` / `textDetector`）返回 `LoopOutcome`（精确字符重复）
- Spiral 检测器（`reasoningSpiralDetector` / `textSpiralDetector`）返回 `SpiralOutcome`（句子级重复率超阈值）

### 决策：nudge 还是 abort

```
recovery(nudgeCount, { max_nudges, period })
  → nudgeCount < max_nudges ? "nudge" : "abort"
```

默认配置 `max_nudges: 2`：前两次检测 → nudge，第三次检测 → abort。

### Nudge 路径（第一次检测）

```
1. handleDetected(sessionID, outcome)
   │
   ├── state.aborting = true                    ← 阻止后续 delta 喂入检测器
    ├── recovery(0) → { action: "nudge", reminder: "[Loop Detector] ..." }
    ├── recordStat(stats, type, source, "detect")   ← 记录检测次数
    ├── 快照 agent / modelRef / variant            ← promptAsync 不显式传 agent 会触发 createUserMessage→setAgentModel 改写 session 记录
    ├── state.pendingAction = { type: "nudge", reminder, agent, modelRef, variant, ... }
   │
   ├── abortSession(sessionID, "interrupt")      ← 不 await，promise 存入 state.abortPromise
   │   └── client.session.abort({ path: { id: sessionID } })
   │       ← 中断当前流式回复（非 abort，仅 interrupt），服务器发送 session.idle 事件
   │
   └── 立即 arm 5 秒超时计时器 (idleTimeout)      ← 即使 abort 调用挂起也必须 arm，否则 session 被永久静音
       ← 如果 session.idle 未到达，超时后强制执行 pendingAction

2. session.idle 事件到达（或超时触发）
   │
   ├── pendingAction 为空且 aborting=true（execute 等待 abort 期间的滞后 idle）→ 忽略，不重置 nudgeCount
   ├── pendingAction 为空、aborting=false 但 pendingStaleIdle=true（abort 等待超时后补发的滞后 idle）→ 消费标记、跳过 reset
   │
   └── executePendingAction(sessionID, state)
       │
       ├── state.pendingAction = null            ← 立即清空，防止并发 session.idle 导致重复执行
       ├── 清除 idleTimeout
       │
       ├── await state.abortPromise              ← 等 abort HTTP 调用完全落地（上限 ABORT_WAIT_MS = 10000ms）
       │   ← session.idle 可能先于 abort 落地到达；立即发消息会被 abort 级联杀死（0 token 消息）
       │   ← 等待超时则写日志并继续 best-effort 发送；该次发送计入 nudge 额度（防无限累积）
       │   ← 超时时给旧 abort promise 挂 pendingStaleIdle 标记，消费其迟到 idle
       │
       ├── 若无快照 agent：client.session.get({ path: { id } }) 查询 session 记录（5s 超时按失败处理）
       │   ├── 查到 agent → 用查到的 agent（及 model / variant）补全 body 后继续
       │   └── 查不到 / 查询失败 / 超时 → 跳过本次 nudge：不发送、不计数、error toast
       │
       ├── client.session.promptAsync({          ← 发送 nudge 消息（普通 user 消息，TUI 可见；5s 上限）
       │     path: { id: sessionID },
       │     body: {
       │       agent: "<快照或查询到的 agent，如 ascend-op>",   ← 必须显式传，否则回退默认 agent 并改写 session 记录
       │       model: { providerID, modelID },          ← 快照/查询存在时传
       │       variant: "<快照/查询的 variant>",          ← 快照/查询存在时传（"default" 归一为不传）
       │       parts: [{
       │         type: "text",
       │         text: "[Loop Detector] Your output is repeating in a loop with period ~{period} characters. Stop repeating and take a different, concrete action.",
       │         metadata: { source: "loop-detector" }  ← 机器可读标记，供 E2E / 其它插件识别插件注入消息
       │       }]
       │     }
       │   })
       │   ← 服务器收到新消息 → 触发第二次流式回复
       │   ← 超时（已发起未确认）同样计入额度，日志标注 promptAsync timed out (counted)
       │
        ├── nudgeCount++                          ← promptAsync 返回或超时（已发起未确认）时 +1；reject / 跳过不计
        ├── recordStat(stats, type, source, "nudge")    ← 记录 nudge 次数（同上）
        ├── reasoningDetector.reset()             ← 状态机先复位（在 toast 之前）
        ├── textDetector.reset()
        ├── reasoningSpiralDetector.reset()
        ├── textSpiralDetector.reset()
        ├── state.aborting = false                ← 允许后续 delta 喂入检测器
        │
        └── client.tui.showToast(...).catch(...)  ← fire-and-forget，不阻塞状态机；文案反映实际结果
            title: 正常/超时为 "Loop Detected — Nudge" 或 "Spiral Detected — Nudge"；
                   跳过时为 "Loop Detected — Nudge Skipped" 或 "Spiral Detected — Nudge Skipped"
            message: 正常路径 "... Reminder sent to redirect."（warning）
                     超时路径 "... Reminder sent while the session is still aborting; it may not take effect."（error）
                     跳过路径 "... Reminder skipped: session agent unknown; sending it would rewrite the session agent."（error）
```

### Abort 路径（nudge 后再次检测到循环）

```
1. handleDetected(sessionID, outcome)
   │
   ├── state.aborting = true
   ├── recovery(2) → { action: "abort", period, attempts: 3 }
   │   ← nudgeCount(2) >= max_nudges(2)，决定 abort
   ├── state.pendingAction = { type: "abort", ... }
   └── abortSession(sessionID, "abort")          ← promise 同样存入 state.abortPromise，idleTimeout 立即 arm

2. session.idle 事件到达
   │
   └── executePendingAction(sessionID, state)
       │
       ├── state.pendingAction = null
       ├── await state.abortPromise              ← 等 abort 完全落地（上限 10s）
       ├── recordStat(stats, type, source, "abort")   ← 记录 abort 次数
       ├── sessions.delete(sessionID)            ← 先清理会话状态（在 toast 之前）
       └── client.tui.showToast(...).catch(...)  ← fire-and-forget 最终 abort 通知
           title: "Loop Detected" 或 "Spiral Detected"（按检测类型区分）
           message: "Repetitive {source} output detected (period ~{period} chars / duplicate sentence ratio ~{ratio}%) after {attempts} attempt(s). Session aborted."
           variant: "warning"
```

### 用户在 TUI 中观察到的现象

| 阶段 | 用户看到 |
|------|---------|
| 模型开始生成 | 流式回复正常显示 |
| 循环检测到 | 流式回复被中断（interrupted） |
| Nudge toast | 提醒消息发送成功后，TUI 右下角出现通知：正常路径为 warning（"Loop Detected — Nudge" / "Spiral Detected — Nudge"，含 "Reminder sent to redirect."）；abort 等待超时路径为 error（含 "may not take effect"）；快照与查询都拿不到 agent 时为 error（标题含 "Nudge Skipped"，含 "session agent unknown"） |
| Nudge 消息 | 一条带 `[Loop Detector]` 前缀的普通 user 消息（TUI 可见，text part 带 `metadata.source = "loop-detector"`）；agent 无法确定时**不发送**，仅显示上述 error toast |
| 第二次流式回复 | 模型以原 agent/model 重新生成，流式回复正常显示 |
| 再次检测到循环 | 流式回复再次被中断 |
| Abort toast | TUI 右下角出现警告通知：Loop 显示 "Loop Detected"，Spiral 显示 "Spiral Detected" |
| 会话结束 | 不再生成 |

## 统计计数

插件累计统计检测/nudge/abort 次数，持久化到 `~/.loop-detector/stats.json`，跨 opencode 重启保留。

检测/触发日志写入 `~/.loop-detector/detector.log`，附带 session 的 title、model、agent。每次检测触发时，触发时的文本内容保存到 `~/.loop-detector/triggers/` 目录下的 `.txt` 文件（文件名含时间戳、session ID、检测类型、来源），文件头部含 session 元信息，后接原始缓冲区内容。

### 计数维度

按 detection type × source × action 三维细分，共 4 个 cell × 3 个 action：

| detection type | source | detect / nudge / abort |
|----------------|--------|------------------------|
| loop | reasoning | loop/reasoning 的检测/nudge/abort 次数 |
| loop | text | loop/text 的检测/nudge/abort 次数 |
| spiral | reasoning | spiral/reasoning 的检测/nudge/abort 次数 |
| spiral | text | spiral/text 的检测/nudge/abort 次数 |

另维护 `totals`（按 action 汇总，不分 type/source）、`firstSeen` / `lastSeen`（首次/末次计数时间）。

### 计数触发点

| action | 触发位置 | 说明 |
|--------|---------|------|
| `detect` | `handleDetected` 中检测器触发时 | 每次 loop/spiral 检测器（reasoning 或 text）触发时 +1 |
| `nudge` | `executePendingAction` 的 nudge 分支 | `promptAsync` 返回或 5s 超时（已发起未确认）时 +1；`promptAsync` reject、agent 无法确定而跳过均不计入 |
| `abort` | `executePendingAction` 的 abort 分支 | 最终 abort 时 +1 |

### 持久化文件

计数落盘到 `~/.loop-detector/stats.json`，可用配置参数 `stats_path` 覆盖（一般无需修改，主要用于测试隔离）。

### `loop_detector_stats` tool

插件注册了 opencode tool `loop_detector_stats`，主 agent 可调用查询累计统计：

- 参数：`reset?: boolean`（可选，默认 `false`；设 `true` 则重置所有计数器为零后返回）
- 返回：人类可读的统计文本

### stats.json 结构示例

```json
{
  "counts": {
    "loop": { "reasoning": { "detect": 2, "nudge": 1, "abort": 1 }, "text": { "detect": 0, "nudge": 0, "abort": 0 } },
    "spiral": { "reasoning": { "detect": 1, "nudge": 1, "abort": 0 }, "text": { "detect": 0, "nudge": 0, "abort": 0 } }
  },
  "totals": { "detect": 3, "nudge": 2, "abort": 1 },
  "firstSeen": "2026-07-29T10:00:00.000Z",
  "lastSeen": "2026-07-29T12:00:00.000Z"
}
```
