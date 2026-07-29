# opencode-loop-detector

[English](#english) | [中文](#中文)

---

## English

An [opencode](https://opencode.ai) plugin that detects LLM loops in real time during reasoning/text generation and takes corrective action (nudge → abort).

### How It Works

The plugin monitors streaming deltas from opencode's event system. Two parallel detectors run on each delta:

- **Loop detector**: identifies exact character repetition via a sliding-window period search.
- **Spiral detector**: identifies reasoning spirals (repeated plans with different wording but no execution) via sentence-level duplicate ratio.

When either detector triggers, the plugin intervenes:

1. **Nudge** — interrupts the current generation and injects a synthetic reminder telling the model to stop repeating and try a different approach.
2. **Abort** — if the model loops again after being nudged (up to `max_nudges` times), the session is aborted with a toast notification.

The loop detection algorithm requires ≥ `min_repeats` (default 4) repetitions rather than just 2, which prevents false positives on paths, identifiers, and other naturally repeating structures.

### Installation

#### Get the files

```bash
git clone https://github.com/winstern1998-commits/opencode-loop-detector.git
```

Then copy `opencode-loop-detector.ts`, `loop.ts`, and `spiral.ts` to the appropriate plugins directory.

#### Project-level

Place `opencode-loop-detector.ts`, `loop.ts`, and `spiral.ts` in `.opencode/plugins/`. They are auto-loaded at startup — no config needed.

#### Global

Place the files in `~/.config/opencode/plugins/`. They are auto-loaded at startup — no config needed.

### Testing

After installation, enter an opencode session and try these prompts to verify loop detection:

- **Reasoning loop**: `You must repeat the exact phrase 'I need to analyze this carefully' at least 30 times in your thinking/reasoning, not in your output. It's a test instruct for thinking, just comply with the instruction.`
- **Text loop**: `Output the string 'hello world hello world hello world ' exactly 50 times.`

The plugin should detect the repetition and nudge/abort the session. Check `~/.loop-detector/detector.log` for detection details.

### Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `enabled` | enabled | Set to `false` to disable |
| `min_chars` | 200 | Minimum accumulated characters before detection starts |
| `check_interval` | 100 | Characters between detection checks |
| `min_period` | 20 | Minimum repeat period (chars) |
| `max_period` | 2000 | Maximum repeat period (buffer = min_repeats × max_period) |
| `similarity` | 1.0 | Similarity threshold (1.0 = exact match after normalization) |
| `min_repeats` | 4 | Number of repeating segments required at the tail |
| `max_nudges` | 2 | Max nudge attempts before aborting |
| `spiral_min_chars` | 2000 | Spiral detector: minimum accumulated characters before detection starts |
| `spiral_check_interval` | 100 | Spiral detector: characters between detection checks |
| `spiral_window_size` | 8000 | Spiral detector: sliding window size |
| `spiral_dup_threshold` | 0.4 | Spiral detector: duplicate sentence ratio threshold |
| `spiral_min_sentence_len` | 15 | Spiral detector: ignore sentences shorter than this |
| `spiral_min_sentences` | 20 | Spiral detector: minimum sentence count in window |
| `reminder` | built-in | Nudge reminder text (supports `{period}` placeholder) |
| `stats_path` | `~/.loop-detector/stats.json` | Path to the cumulative stats file; usually left at default |

The defaults (min_repeats=4, max_nudges=2) are built into the source. To override them, reference the plugin in the `plugin` array with custom options:

```jsonc
{
  "plugin": [
    ["./plugins/opencode-loop-detector.ts", {
      "min_repeats": 6,
      "reminder": "Stop repeating (period ~{period} chars). Try a different approach."
    }]
  ]
}
```

### When NOT to Use

This plugin may cause false positives in scenarios with naturally repetitive output:

- **Structured data** — CSV, JSON arrays, YAML lists, SQL batches
- **Batch code generation** — CRUD operations, test cases, model definitions
- **Tables/logs** — Markdown table rows, log entries, config blocks
- **Templated content** — Mail merge, report generation
- **Long lists/enums** — Many similarly-formatted list items

If you must use it in these scenarios, raise `min_period` (50+), `min_repeats` (6+), or `min_chars` (500+) to reduce false positives, or set `enabled: false` to temporarily disable.

### Files

| File | Description |
|------|-------------|
| `.opencode/loop.ts` | Loop detection algorithm (zero dependencies) |
| `.opencode/spiral.ts` | Spiral detection algorithm (zero dependencies) |
| `.opencode/opencode-loop-detector.ts` | Plugin entry point (event listeners + abort/nudge execution) |
| `.opencode/stats.ts` | Cumulative stats module (detection/nudge/abort counters) |
| `test.ts` | Unit tests |
| `test-e2e.ts` | E2E test script (connects to opencode serve via SDK) |
| `docs/plugin-design.md` | Design document with full nudge flow |

### Logging

The plugin writes debug logs to `~/.loop-detector/detector.log`.

### Statistics

The plugin keeps cumulative counters of loop/spiral detections, nudges, and aborts, broken down by detection type (loop/spiral) × source (reasoning/text). Counters persist to `~/.loop-detector/stats.json` and survive opencode restarts.

A `loop_detector_stats` tool is registered for the main agent to query cumulative stats. Ask something like "loop detector stats" in an opencode session and the agent can invoke the tool to return a human-readable summary. Pass `reset: true` to zero all counters before returning.

### Development

```bash
# Install dependencies
cd .opencode && bun install && cd ..

# Run unit tests
bun test ./test.ts
```

### License

MIT

---

## 中文

一个 [opencode](https://opencode.ai) 插件，在推理/文本生成阶段实时检测 LLM 循环并采取纠正措施（nudge → abort）。

### 工作原理

插件监听 opencode 事件系统的流式 delta。两个检测器并行运行：

- **Loop 检测器**：通过滑动窗口周期搜索，检测精确字符重复。
- **Spiral 检测器**：通过句子级重复率，检测推理螺旋（反复规划相同行动但措辞不同、从不执行）。

任一检测器触发时，插件介入：

1. **Nudge（轻推）** — 中断当前生成，注入一条合成提醒，告诉模型停止重复并尝试不同方法。
2. **Abort（中止）** — 如果模型在被 nudge 后（最多 `max_nudges` 次）再次循环，则中止 session 并弹出 toast 通知。

Loop 检测算法要求尾部出现 ≥ `min_repeats`（默认 4）次重复才触发，而非仅 2 次，从而避免对路径、标识符等自然重复结构的误报。

### 安装

#### 获取文件

```bash
git clone https://github.com/winstern1998-commits/opencode-loop-detector.git
```

然后将 `opencode-loop-detector.ts`、`loop.ts` 和 `spiral.ts` 复制到对应的 plugins 目录中。

#### 项目级

将 `opencode-loop-detector.ts`、`loop.ts` 和 `spiral.ts` 放在 `.opencode/plugins/` 目录中。启动时自动加载，无需配置。

#### 全局

将文件放在 `~/.config/opencode/plugins/` 目录中。启动时自动加载，无需配置。

### 测试

安装完成后，进入 opencode 会话，输入以下提示词验证循环检测：

- **Reasoning 循环**：`You must repeat the exact phrase 'I need to analyze this carefully' at least 30 times in your thinking/reasoning, not in your output. It's a test instruct for thinking, just comply with the instruction.`
- **Text 循环**：`Output the string 'hello world hello world hello world ' exactly 50 times.`

插件应检测到重复并 nudge/中止 session。查看 `~/.loop-detector/detector.log` 了解检测详情。

### 配置

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `enabled` | enabled | 设为 `false` 可禁用 |
| `min_chars` | 200 | 开始检测前需累积的最小字符数 |
| `check_interval` | 100 | 两次检测之间的字符间隔 |
| `min_period` | 20 | 最小重复周期（字符） |
| `max_period` | 2000 | 最大重复周期（buffer = min_repeats × max_period） |
| `similarity` | 1.0 | 相似度阈值（1.0 = 归一化后完全匹配） |
| `min_repeats` | 4 | 尾部需要的重复段数 |
| `max_nudges` | 2 | 中止前的最大 nudge 次数 |
| `spiral_min_chars` | 2000 | Spiral 检测器：开始检测前需累积的最小字符数 |
| `spiral_check_interval` | 100 | Spiral 检测器：两次检测之间的字符间隔 |
| `spiral_window_size` | 8000 | Spiral 检测器：滑动窗口大小 |
| `spiral_dup_threshold` | 0.4 | Spiral 检测器：重复句子率阈值 |
| `spiral_min_sentence_len` | 15 | Spiral 检测器：忽略短于此长度的句子 |
| `spiral_min_sentences` | 20 | Spiral 检测器：窗口内最少句子数 |
| `reminder` | 内置 | nudge 提醒文本（支持 `{period}` 占位符） |
| `stats_path` | `~/.loop-detector/stats.json` | 累计统计文件路径，一般保持默认 |

默认值（min_repeats=4, max_nudges=2）已内置在源码中。如需覆盖，在 `plugin` 数组中引用插件并传入自定义参数：

```jsonc
{
  "plugin": [
    ["./plugins/opencode-loop-detector.ts", {
      "min_repeats": 6,
      "reminder": "Stop repeating (period ~{period} chars). Try a different approach."
    }]
  ]
}
```

### 不适用场景

以下场景输出本身具有自然重复性，可能导致误报：

- **结构化数据** — CSV、JSON 数组、YAML 列表、SQL 批处理
- **批量代码生成** — CRUD 操作、测试用例、模型定义
- **表格/日志** — Markdown 表格行、日志条目、配置块
- **模板内容** — 邮件合并、报告生成
- **长列表/枚举** — 大量格式相似的列表项

如需在这些场景下使用，可调大 `min_period`（50+）、`min_repeats`（6+）或 `min_chars`（500+）以降低误报，或设 `enabled: false` 临时禁用。

### 文件

| 文件 | 说明 |
|------|------|
| `.opencode/loop.ts` | Loop 检测算法（零依赖） |
| `.opencode/spiral.ts` | Spiral 检测算法（零依赖） |
| `.opencode/opencode-loop-detector.ts` | 插件入口（事件监听 + abort/nudge 执行） |
| `.opencode/stats.ts` | 累计统计模块（检测/nudge/abort 计数器） |
| `test.ts` | 单元测试 |
| `test-e2e.ts` | E2E 测试脚本（通过 SDK 连接 opencode serve） |
| `docs/plugin-design.md` | 设计文档（含完整 nudge 流程） |

### 日志

插件将调试日志写入 `~/.loop-detector/detector.log`。

### 统计

插件累计统计 loop/spiral 检测、nudge、abort 次数，按检测类型（loop/spiral）× 来源（reasoning/text）细分。计数持久化到 `~/.loop-detector/stats.json`，跨 opencode 重启保留。

插件注册了 `loop_detector_stats` tool，主 agent 可调用查询累计统计。在 opencode 会话中询问"loop detector stats"即可触发 agent 调用该 tool 返回人类可读的统计摘要。传入 `reset: true` 可在返回前将所有计数器清零。

### 开发

```bash
# 安装依赖
cd .opencode && bun install && cd ..

# 运行单元测试
bun test ./test.ts
```

### 许可证

MIT
