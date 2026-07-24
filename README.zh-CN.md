[English](README.md) | 中文

# opencode-loop-detector

一个 [opencode](https://opencode.ai) 插件，在推理/文本生成阶段实时检测 LLM 循环并采取纠正措施（nudge → abort）。

## 工作原理

插件监听 opencode 事件系统的流式 delta。当模型陷入重复相同内容时（推理阶段或文本阶段均可），滑动窗口检测器识别出重复模式并介入：

1. **Nudge（轻推）** — 中断当前生成，注入一条合成提醒，告诉模型停止重复并尝试不同方法。
2. **Abort（中止）** — 如果模型在被 nudge 后（最多 `max_nudges` 次）再次循环，则中止 session 并弹出 toast 通知。

检测算法要求尾部出现 ≥ `min_repeats`（默认 5）次重复才触发，而非仅 2 次，从而避免对路径、标识符等自然重复结构的误报。

## 安装

### 项目级

将 `opencode-loop-detector.ts` 和 `loop.ts` 放在项目根目录，然后在 `.opencode/opencode.jsonc` 中添加：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["../opencode-loop-detector.ts", {}]
  ]
}
```

> **路径说明**：`.opencode/opencode.jsonc` 中的插件路径是**相对于 `.opencode/` 目录**解析的，不是相对于项目根目录。插件文件在项目根目录时用 `../`。

### 全局

将文件放在 `~/.config/opencode/plugins/`，在全局 `opencode.jsonc` 中引用：

```jsonc
{
  "plugin": [
    ["~/.config/opencode/plugins/opencode-loop-detector.ts", {}]
  ]
}
```

## 配置

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
    ["../opencode-loop-detector.ts", {
      "max_nudges": 2,
      "min_repeats": 6,
      "reminder": "Stop repeating (period ~{period} chars). Try a different approach."
    }]
  ]
}
```

## 不适用场景

以下场景输出本身具有自然重复性，可能导致误报：

- **结构化数据** — CSV、JSON 数组、YAML 列表、SQL 批处理
- **批量代码生成** — CRUD 操作、测试用例、模型定义
- **表格/日志** — Markdown 表格行、日志条目、配置块
- **模板内容** — 邮件合并、报告生成
- **长列表/枚举** — 大量格式相似的列表项

如需在这些场景下使用，可调大 `min_period`（50+）、`min_repeats`（6+）或 `min_chars`（500+）以降低误报，或设 `enabled: false` 临时禁用。

## 文件

| 文件 | 说明 |
|------|------|
| `loop.ts` | 纯检测算法（零依赖） |
| `opencode-loop-detector.ts` | 插件入口（事件监听 + abort/nudge 执行） |
| `test.ts` | 单元测试 |
| `test-e2e.ts` | E2E 测试脚本（通过 SDK 连接 opencode serve） |
| `docs/plugin-design.md` | 设计文档（含完整 nudge 流程） |

## 日志

插件将调试日志写入 `~/.loop-detector/detector.log`。

## 开发

```bash
# 安装依赖
cd .opencode && bun install && cd ..

# 运行单元测试
bun test ./test.ts
```

## 许可证

MIT
