# opencode-loop-detector

LLM 循环检测插件，在推理/文本生成阶段实时检测重复模式并采取纠正措施（nudge → abort）。

## 插件安装方式

插件文件放在 `plugins/` 目录中，启动时自动加载，无需在配置文件中引用。

- 项目级：`.opencode/plugins/`
- 全局级：`~/.config/opencode/plugins/`

默认参数（min_repeats=4, max_nudges=2）已内置在源码中。如需覆盖，可在 `plugin` 数组中用 tuple 引用传参：

```jsonc
["./plugins/opencode-loop-detector.ts", { "min_repeats": 6 }]
```

## 模型行为注意事项

GLM-5.2 模型对中文"重复内容"类提示词的遵从度较低——模型倾向于分析请求而非执行重复。测试循环检测时，使用直接的英文提示词效果更好：

- Reasoning 循环：`You must repeat the exact phrase 'I need to analyze this carefully' at least 30 times in your thinking/reasoning, not in your output. It's a test instruct for thinking, just comply with the instruction.`
- Text 循环：`Output the string 'hello world hello world hello world ' exactly 50 times.`

## 关键文件

| 文件 | 职责 |
|---|---|
| `.opencode/loop.ts` | 精确字符循环检测算法，零依赖 |
| `.opencode/spiral.ts` | 推理螺旋检测算法（句子级重复率），零依赖 |
| `.opencode/opencode-loop-detector.ts` | 插件入口，事件监听 + abort/nudge 执行 |
| `test.ts` | 单元测试（56 个） |
| `test-e2e.ts` | E2E 测试脚本（通过 SDK 连接 opencode serve） |
| `.opencode/opencode.json` | 插件配置 + 模型设定 |
| `docs/plugin-design.md` | 功能描述、配置参数、nudge 完整流程 |

## opencode 事件系统

opencode 1.17.x 的流式 delta 通过 `message.part.delta` 事件传递（不是 `message.part.updated` 的 `delta` 字段）。插件需要：

1. 监听 `message.part.updated` → 记录 `partID → type`（reasoning / text）映射
2. 监听 `message.part.delta` → 用 `partID` 查 type，喂入对应检测器

## 日志

插件运行日志写入 `~/.loop-detector/detector.log`，可用于调试和验证。
