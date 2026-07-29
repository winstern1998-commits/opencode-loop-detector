# opencode-loop-detector 设计文档

## 功能

插件监听 opencode 的流式事件，将 reasoning / text 的 delta 同时喂入两类检测器：

**Loop 检测器**（精确字符循环）：在缓冲区中从大到小尝试所有可能的重复周期（period），对末尾 `min_repeats` 个 period 长度的文本块做归一化（空白折叠）后比较：全部相同则判定为循环。要求重复 ≥ `min_repeats` 次而非 2 次，可避免路径、标识符等天然重复 2 次的结构被误判为循环。

**Spiral 检测器**（推理螺旋）：在滑动窗口内按句子分割文本，统计重复句子占比。当重复率超过 `spiral_dup_threshold`（默认 0.4）时触发。用于捕获 loop 检测器无法检测的"语义螺旋"——模型在推理中反复规划同样的行动但从不执行，每次措辞略有不同，不构成精确字符重复，但句子级重复率高达 40-50%。

两类检测器并行运行，任一触发即进入 nudge/abort 流程。

检测到循环后的处理策略由 `max_nudges` 控制：

- **nudge**（nudgeCount < max_nudges）：中断当前生成 → 发送 synthetic 提醒消息 → 模型重新生成
- **abort**（nudgeCount ≥ max_nudges）：中断当前生成 → 显示 toast 通知 → 清理会话

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
| `spiral_dup_threshold` | 0.4 | spiral 检测器重复率阈值，超过此值触发 |
| `spiral_min_sentence_len` | 15 | spiral 检测器忽略过短句子（归一化后长度） |
| `spiral_min_sentences` | 20 | spiral 检测器窗口内最少句子数，不够则不判断 |
| `stats_path` | `~/.loop-detector/stats.json` | 统计数据落盘路径，一般无需修改 |

### similarity 计算

- `similarity: 1.0`（当前配置）：两个归一化后的文本块必须**完全相同**
- `similarity < 1.0`：逐字符位置比较，`matches / max_length` 达标即可

## `synthetic: true` 的含义

`TextPart` 和 `TextPartInput` 类型上有一个可选字段 `synthetic?: boolean`。当设置为 `true` 时：

- **TUI 行为**：该消息不会渲染在聊天界面中（对用户不可见）
- **模型行为**：该消息仍然作为对话上下文发送给模型，模型能看到并据此生成回复
- **用途**：插件注入系统级指令时，避免在用户聊天历史中产生干扰条目

插件在 nudge 时使用 `synthetic: true` 发送 `<system-reminder>` 包裹的提醒，模型能收到提醒但用户在 TUI 中看不到。为此，插件额外调用 `tui.showToast` 在 TUI 中显示一条临时通知，让用户知道 nudge 已发送。

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

当前配置 `max_nudges: 1`：第一次检测 → nudge，第二次检测 → abort。

### Nudge 路径（第一次检测）

```
1. handleDetected(sessionID, outcome)
   │
   ├── state.aborting = true                    ← 阻止后续 delta 喂入检测器
    ├── recovery(0) → { action: "nudge", reminder: "<system-reminder>..." }
    ├── recordStat(stats, type, source, "detect")   ← 记录检测次数
    ├── state.pendingAction = { type: "nudge", ... }
   │
   ├── abortSession(sessionID)
   │   └── client.session.abort({ path: { id: sessionID } })
   │       ← 中断当前流式回复，服务器发送 session.idle 事件
   │
   └── 启动 5 秒超时计时器 (idleTimeout)
       ← 如果 session.idle 未到达，超时后强制执行 pendingAction

2. session.idle 事件到达（或超时触发）
   │
   └── executePendingAction(sessionID, state)
       │
       ├── state.pendingAction = null            ← 立即清空，防止并发 session.idle 导致重复执行
       ├── 清除 idleTimeout
       │
        ├── client.tui.showToast({                ← 在 TUI 中显示通知（用户可见）
        │     title: "Loop Detected — Nudge" 或 "Spiral Detected — Nudge"（按检测类型区分）
        │     message: "Repetitive {source} output detected (period ~{period} chars / duplicate sentence ratio ~{ratio}%). Sending reminder to redirect.",
       │     variant: "warning"
       │   })
       │
       ├── client.session.promptAsync({          ← 发送 nudge 消息（synthetic，TUI 不渲染）
       │     path: { id: sessionID },
       │     body: {
       │       parts: [{
       │         type: "text",
       │         text: "<system-reminder>\nYour output is repeating in a loop with period ~{period} characters. Stop repeating and take a different, concrete action.\n</system-reminder>",
       │         synthetic: true
       │       }]
       │     }
       │   })
       │   ← 服务器收到新消息 → 触发第二次流式回复
       │
        ├── nudgeCount++                          ← 0 → 1
        ├── recordStat(stats, type, source, "nudge")    ← 记录 nudge 次数
        ├── reasoningDetector.reset()             ← 清空缓冲区，重新开始检测
        ├── textDetector.reset()
        ├── reasoningSpiralDetector.reset()
        ├── textSpiralDetector.reset()
        └── state.aborting = false                ← 允许后续 delta 喂入检测器
```

### Abort 路径（nudge 后再次检测到循环）

```
1. handleDetected(sessionID, outcome)
   │
   ├── state.aborting = true
   ├── recovery(1) → { action: "abort", period, attempts: 2 }
   │   ← nudgeCount(1) >= max_nudges(1)，决定 abort
   ├── state.pendingAction = { type: "abort", ... }
   └── abortSession(sessionID)

2. session.idle 事件到达
   │
   └── executePendingAction(sessionID, state)
       │
       ├── state.pendingAction = null
        ├── client.tui.showToast({                ← 最终 abort 通知
        │     title: "Loop Detected" 或 "Spiral Detected"（按检测类型区分）
        │     message: "Repetitive {source} output detected (period ~{period} chars / duplicate sentence ratio ~{ratio}%) after {attempts} attempt(s). Session aborted.",
       │     variant: "warning"
        │   })
        ├── recordStat(stats, type, source, "abort")   ← 记录 abort 次数
        └── sessions.delete(sessionID)            ← 清理会话状态
```

### 用户在 TUI 中观察到的现象

| 阶段 | 用户看到 |
|------|---------|
| 模型开始生成 | 流式回复正常显示 |
| 循环检测到 | 流式回复被中断（interrupted） |
| Nudge toast | TUI 右下角出现警告通知：Loop 显示 "Loop Detected — Nudge"，Spiral 显示 "Spiral Detected — Nudge" |
| Nudge 消息 | 不可见（synthetic，TUI 不渲染） |
| 第二次流式回复 | 模型重新生成，流式回复正常显示 |
| 再次检测到循环 | 流式回复再次被中断 |
| Abort toast | TUI 右下角出现警告通知：Loop 显示 "Loop Detected"，Spiral 显示 "Spiral Detected" |
| 会话结束 | 不再生成 |

## 统计计数

插件累计统计检测/nudge/abort 次数，持久化到 `~/.loop-detector/stats.json`，跨 opencode 重启保留。

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
| `nudge` | `executePendingAction` 的 nudge 分支 | nudge 成功执行时 +1 |
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
