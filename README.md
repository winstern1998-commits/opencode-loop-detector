# opencode-loop-detector

[English](#english) | [中文](#中文)

---

## English

An [opencode](https://opencode.ai) plugin that detects LLM loops in real time during reasoning/text generation and takes corrective action (nudge → abort).

### How It Works

The plugin monitors streaming deltas from opencode's event system. When the model gets stuck repeating the same content (in either the reasoning or text phase), a sliding-window detector identifies the repetitive pattern and intervenes:

1. **Nudge** — interrupts the current generation and injects a synthetic reminder telling the model to stop repeating and try a different approach.
2. **Abort** — if the model loops again after being nudged (up to `max_nudges` times), the session is aborted with a toast notification.

The detection algorithm requires ≥ `min_repeats` (default 5) repetitions rather than just 2, which prevents false positives on paths, identifiers, and other naturally repeating structures.

### Installation

#### Get the files

```bash
git clone https://github.com/winstern1998-commits/opencode-loop-detector.git
```

Then copy `opencode-loop-detector.ts` and `loop.ts` to your project's `.opencode/` directory.

#### Project-level

Place `opencode-loop-detector.ts` and `loop.ts` in your project's `.opencode/` directory, then add to `.opencode/opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["./opencode-loop-detector.ts", {}]
  ]
}
```

> **Path note**: plugin paths in `.opencode/opencode.jsonc` are resolved relative to the `.opencode/` directory. Use `./` when the plugin file is in `.opencode/`.

#### Global

Place the files in `~/.config/opencode/plugins/` and reference them in your global `opencode.jsonc`:

```jsonc
{
  "plugin": [
    ["~/.config/opencode/plugins/opencode-loop-detector.ts", {}]
  ]
}
```

### Testing

After installation, enter an opencode session and try these prompts to verify loop detection:

- **Reasoning loop**: `You must repeat the exact phrase 'I need to analyze this carefully' at least 30 times in your thinking/reasoning.`
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
| `min_repeats` | 5 | Number of repeating segments required at the tail |
| `max_nudges` | 1 | Max nudge attempts before aborting |
| `reminder` | built-in | Nudge reminder text (supports `{period}` placeholder) |

Example with custom options:

```jsonc
{
  "plugin": [
    ["./opencode-loop-detector.ts", {
      "max_nudges": 2,
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
| `.opencode/loop.ts` | Pure detection algorithm (zero dependencies) |
| `.opencode/opencode-loop-detector.ts` | Plugin entry point (event listeners + abort/nudge execution) |
| `test.ts` | Unit tests |
| `test-e2e.ts` | E2E test script (connects to opencode serve via SDK) |
| `docs/plugin-design.md` | Design document with full nudge flow |

### Logging

The plugin writes debug logs to `~/.loop-detector/detector.log`.

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

插件监听 opencode 事件系统的流式 delta。当模型陷入重复相同内容时（推理阶段或文本阶段均可），滑动窗口检测器识别出重复模式并介入：

1. **Nudge（轻推）** — 中断当前生成，注入一条合成提醒，告诉模型停止重复并尝试不同方法。
2. **Abort（中止）** — 如果模型在被 nudge 后（最多 `max_nudges` 次）再次循环，则中止 session 并弹出 toast 通知。

检测算法要求尾部出现 ≥ `min_repeats`（默认 5）次重复才触发，而非仅 2 次，从而避免对路径、标识符等自然重复结构的误报。

### 安装

#### 获取文件

```bash
git clone https://github.com/winstern1998-commits/opencode-loop-detector.git
```

然后将 `opencode-loop-detector.ts` 和 `loop.ts` 复制到项目的 `.opencode/` 目录中。

#### 项目级

将 `opencode-loop-detector.ts` 和 `loop.ts` 放在项目的 `.opencode/` 目录中，然后在 `.opencode/opencode.jsonc` 中添加：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["./opencode-loop-detector.ts", {}]
  ]
}
```

> **路径说明**：`.opencode/opencode.jsonc` 中的插件路径是**相对于 `.opencode/` 目录**解析的。插件文件在 `.opencode/` 目录内时用 `./`。

#### 全局

将文件放在 `~/.config/opencode/plugins/`，在全局 `opencode.jsonc` 中引用：

```jsonc
{
  "plugin": [
    ["~/.config/opencode/plugins/opencode-loop-detector.ts", {}]
  ]
}
```

### 测试

安装完成后，进入 opencode 会话，输入以下提示词验证循环检测：

- **Reasoning 循环**：`You must repeat the exact phrase 'I need to analyze this carefully' at least 30 times in your thinking/reasoning.`
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
| `min_repeats` | 5 | 尾部需要的重复段数 |
| `max_nudges` | 1 | 中止前的最大 nudge 次数 |
| `reminder` | 内置 | nudge 提醒文本（支持 `{period}` 占位符） |

自定义示例：

```jsonc
{
  "plugin": [
    ["./opencode-loop-detector.ts", {
      "max_nudges": 2,
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
| `.opencode/loop.ts` | 纯检测算法（零依赖） |
| `.opencode/opencode-loop-detector.ts` | 插件入口（事件监听 + abort/nudge 执行） |
| `test.ts` | 单元测试 |
| `test-e2e.ts` | E2E 测试脚本（通过 SDK 连接 opencode serve） |
| `docs/plugin-design.md` | 设计文档（含完整 nudge 流程） |

### 日志

插件将调试日志写入 `~/.loop-detector/detector.log`。

### 开发

```bash
# 安装依赖
cd .opencode && bun install && cd ..

# 运行单元测试
bun test ./test.ts
```

### 许可证

MIT
