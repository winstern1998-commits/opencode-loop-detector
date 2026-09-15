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
| `.opencode/opencode-loop-detector.ts` | 插件入口，事件监听 + abort/nudge 执行 + stats tool |
| `.opencode/stats.ts` | 累计计数模块（检测/nudge/abort，按类型×来源细分），零依赖 |
| `test.ts` | 单元测试（82 个） |
| `test-e2e.ts` | E2E 测试脚本（通过 SDK 连接 opencode serve） |
| `.opencode/opencode.jsonc` | 插件配置 + 模型设定 |
| `docs/plugin-design.md` | 功能描述、配置参数、nudge 完整流程 |

## opencode 事件系统

opencode 1.17.x 的流式 delta 通过 `message.part.delta` 事件传递（不是 `message.part.updated` 的 `delta` 字段）。插件需要：

1. 监听 `message.part.updated` → 记录 `partID → type`（reasoning / text）映射
2. 监听 `message.part.delta` → 用 `partID` 查 type，喂入对应检测器

## Nudge 流程要点

- nudge 消息不使用 `synthetic`，是 TUI 可见的普通 user 消息，文本以 `[Loop Detector]` 前缀标识来源；text part 带 `metadata: { source: "loop-detector" }` 机器可读标记；toast 在发送处理后调用（正常 warning，abort 等待超时 / 无 agent 跳过为 error），且为 fire-and-forget
- agent 兜底：快照缺失时先 `client.session.get` 查询 session 记录补全 agent/model/variant（查询带 5s 超时）；查询失败/超时或记录无 agent 时**放弃本次 nudge**（不发送、不递增 nudgeCount、不计入统计，error toast + 日志），绝不允许裸发导致 session agent 被改写
- `variant` 为字面量 `"default"` 时归一为不传（session.updated 快照与 session.get 恢复两处，`normalizeVariant`）
- `nudgeCount` / nudge 统计在 `promptAsync` 返回或 5s 超时（`PROMPT_SEND_TIMEOUT_MS`，按"已发起未确认"）时递增（含 abort 等待超时的 best-effort 发送，防止反复超时导致永不升级到 abort）；`promptAsync` 抛异常与 agent 跳过不消耗额度
- `handleDetected` 不 await abort（否则 abort 挂起时 idle 兜底计时器永不 arm、session 永久静音），promise 存入 `state.abortPromise` 后立即 arm `idleTimeout`
- `session.idle` 可能先于 `session.abort` 落地到达，executePendingAction 必须等待 `state.abortPromise`（上限 `ABORT_WAIT_MS = 10000ms`）后再发消息，否则新生成会被 abort 级联杀死；等待超时仍 best-effort 发送（计入额度）。最坏 nudge 延迟 = 5s + 10s
- executePendingAction 等待期间到达的滞后 `session.idle`（`pendingAction` 已清空、`aborting` 仍为 true）必须忽略，不得重置 `nudgeCount` / `aborting`，否则升级计数被破坏、永不 abort
- abort 等待超时后给旧 abort promise 挂 `pendingStaleIdle` 标记；其最终落地补发的 idle（落入"正常完成"分支）消费标记并跳过 reset，防止超时窗口抹掉 nudgeCount
- 状态迁移先于 toast：4 个检测器 reset + `aborting = false`（nudge 分支）、`sessions.delete`（abort 分支）都在 toast 之前执行，toast 不 await
- `promptAsync` 显式传检测时快照的 `agent` / `model` / `variant`，避免 opencode 回退默认 agent 并永久改写 session 的 agent 记录

## 日志

插件运行日志写入 `~/.loop-detector/detector.log`，可用于调试和验证。检测/触发日志附带 session 的 title、model、agent。

每次检测触发时，触发时的文本内容保存到 `~/.loop-detector/triggers/` 目录下的 `.txt` 文件（文件名含时间戳、session ID、检测类型、来源）。

累计计数（检测/nudge/abort 次数）持久化到 `~/.loop-detector/stats.json`，跨重启保留。注册了 `loop_detector_stats` tool 供主 agent 查询（支持 `reset` 参数清零）。

## 文档同步

代码改动后必须同步更新配套文档，包括：

- `README.md`（英文 + 中文双语）：文件表、安装说明、配置参数表、工作原理
- `docs/plugin-design.md`：配置参数表、Nudge 流程图中的 toast 文案/函数名、观察现象表
- `AGENTS.md`：关键文件表、测试数量

需要同步的改动类型：新增源码文件、新增配置参数、toast/日志文案变更、检测器行为变更、函数重命名。提交前检查文档与代码是否一致。
