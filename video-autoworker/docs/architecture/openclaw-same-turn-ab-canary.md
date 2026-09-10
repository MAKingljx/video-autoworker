# OpenClaw 同轮大工具结果 2×2 A/B canary

## 目的

该 canary 专门验证单个真实 OpenClaw Agent turn 内连续大工具结果的影响，不替代既有的跨轮 transcript/compaction rich canary。矩阵固定为：

| midTurnPrecheck | transcript projection | 单元 ID |
| --- | --- | --- |
| 关 | 关 | `precheck-off_projection-off` |
| 关 | 开 | `precheck-off_projection-on` |
| 开 | 关 | `precheck-on_projection-off` |
| 开 | 开 | `precheck-on_projection-on` |

默认每格要求 `10` 次工具结果，每次精确 `24 KiB`；允许范围为 `8–12` 次、每次 `20–32 KiB`。工具结果携带下一次调用 nonce，模型只有读取本次真实结果后才能继续，因此不能并行提交、跳号或预先生成整批调用。

## 真实证据边界

入口为 `scripts/test-openclaw-same-turn-ab-canary.mjs`。它必须同时满足以下条件，否则退出码非零并输出 `evidenceClass=none-fail-closed`：

- Node.js 必须为 `22.22.3`；
- OpenClaw 默认必须为 `2026.7.1-2`，可显式调整期望版本用于后续独立兼容研究，但版本不同不能沿用旧结论；
- 必须提供可访问的真实 OpenAI-compatible 模型端点和真实模型 ID；
- 四格都必须启动隔离的真实 OpenClaw Gateway，使用 `chat.send` 和 `agent.wait` 进入真实 Agent loop；
- `CANARY_EVIDENCE_CLASS=scripted-structural-only` 只用于本地协议回归；即使四格全部运行，它也必须使顶层验收失败，不能冒充真实模型证据。默认值才是 `live-model-real-openclaw-loop`。

透明 loopback 代理只转发模型请求并记录尺寸，不生成或改写模型响应。真实 API key 仅从进程环境转发给上游，不写入临时 OpenClaw 配置、报告或命令参数。

## 工具集合门禁

四格都使用 `tools.profile=full`，额外授权现有 `aiworker_analyze_video`、`aiworker_director_brain` 和隔离 canary 工具 `aiworker_same_turn_stress`。每格压力前后分别读取完整 `tools.catalog` 与带真实 session key 的 `tools.effective`；任何删除、隐藏、单元间差异或运行中变化都会使矩阵失败。

projection-off 只存在于临时隔离插件副本：它保留 `aiworker_director_brain` 工具和 `before_agent_reply`，仅不注册 `tool_result_persist`、`before_message_write`。仓库内生产插件没有增加可关闭投影的运行开关。

## 指标

每格报告：

- 实际执行的大工具结果次数、序号和每次原始 UTF-8 字节数；
- 压力轮全部模型请求的峰值 request bytes、messages bytes、tools bytes 与模型调用次数；
- 压力轮最终 `stopReason`；
- 每条工具结果实际写入 transcript 的字节数；
- 压力轮前、压力轮后和下一轮结束后的 transcript 文件大小；
- 下一轮模型请求的 request/messages bytes；
- precheck 相关日志事件数；
- 四格前后完整工具 ID 清单。

这些数据能区分两类影响：projection hook 位于持久化链，只应改变落盘副本和下一轮请求；同轮峰值与停止原因若发生变化，必须由真实结果说明，不能从“未来轮投影”推断。`midTurnPrecheck` 是否改善同轮峰值同样只接受该矩阵的实测结果。

## 2026-09-04 真实单格观察与限制

首次 qwen38 隔离单格（`precheck=false`、`projection=false`、8 次 × 20 KiB、medium thinking）完成了 8 次串行调用并返回 `STRESS_OK`，主 run 用时 `191692 ms`。下一轮 precheck 估算为 `87536` tokens（预算 `78304`），随后真实 safeguard compaction 用时 `116888 ms`，messages `20→4`、history text `128251→16013` chars、tool-result text `128000→16000` chars、估算 tokens `32975→4443`。

该单格运行时未显式设置 `truncateAfterCompaction`；OpenClaw `2026.7.1-2` schema 记录其默认值为 `false`，日志也显示 `activeTranscriptBytes` / `maxActiveTranscriptBytes` 未参与该次 preflight。因此这是一条真实但不与生产字节门合同等价的诊断观察，不能进入最终 2×2 接受结论。canary 现已显式设置 `truncateAfterCompaction=true`，后续真实矩阵必须重跑。该单格的 `keepRecentTokens=4096` 也不能用来比较或否定生产候选 `8192`；没有同输入可比实证时保持生产现状。

本次没有得到可审计的约 57 KiB thinking bytes，也没有完成 26-call 事故回放；两项均明确记为未覆盖，不能由 medium thinking 配置或日志事件数量代替。

## 隔离 compaction model 基准

在同一份 `154702 B` 活跃 transcript、53 条消息、`45695` history chars、约 `11435` tokens 输入上，均显式使用 `truncateAfterCompaction=true`，并且只设置 `compaction.model`，未设置 `provider`：

- `qwen38-local/default_model` + `timeoutSeconds=180`：`180000 ms` 超时失败，`compactionDelta=0`，没有 checkpoint 或 successor rotation；
- `qwen36-tools-local/default_model` + 候选上限 `timeoutSeconds=300`：`45830 ms` 成功，messages `53→19`、history chars `45695→18222`、checkpoint tokens `11496→6118`，successor rotation 成功，活跃 transcript `154702→74489 B`。

qwen36 的压缩后回答没有通过严格语义锚点检查，缺少 `director-principle`、`operations-plan`、`long-form-summary`、`task-continuity` 的完整细节。因此这里只能证明该次压缩可用性和时延，不能声称压缩质量合格。生产只读复核显示 compaction 尚未显式指定独立模型，因而会随主模型使用 Qwen3.8；候选将其收敛为 `qwen36-tools-local/default_model`。随后按生产精确保留窗注入 26 次工具调用、约 126 KiB 结果和 57 KiB 合成 thinking 的三次独立复测均成功，耗时 `83.951/85.295/167.901 s`；180 秒对慢尾只剩 6.7% 余量，因此候选采用仍然有界的 `timeoutSeconds=240`。这不是 p95 或摘要质量声明，300 秒仍未获支持。

同一基准还在 `153624 B` transcript 上验证了导演脑单意图系统问答 hook：canonical answer 命中，`modelFetches=0`、`compactionStarts=0`，且没有运行 preflight。原始脱敏报告保存在本地 `.canary-results/qwen38-compaction-180s.json` 和 `.canary-results/qwen36-compaction-300s.json`，对比摘要及 SHA-256 在 `.canary-results/compaction-model-comparison.json`；这些运行证据不进入发布包或 Git。

## 生产精确参数的 3-seed 事故形状复测

隔离复测使用生产精确合同：`keepRecentTokens=8192`、`recentTurnsPreserve=4`、`truncateAfterCompaction=true`、`maxActiveTranscriptBytes=128kb`、`compaction.model=qwen36-tools-local/default_model`、`timeoutSeconds=180`。每个独立临时 profile/new session 注入同一无敏感合成事故形状：一个 user turn 下 26 个 assistant tool-call message 与 26 个匹配 tool-result message，tool-result 正文合计 `126556 B`，thinking 正文合计 `58368 B`，各项大小不等。这里的 thinking 是明确注入并计量的合成 transcript 负载，不是模型生成 thinking，不能扩大解释为真实模型思考覆盖。

3 次真实 qwen36 compaction 均成功并生成 checkpoint/successor rotation：

- seed 1：`85295 ms`，active transcript `209659→45554 B`，checkpoint tokens `46602→7873`；
- seed 2：`83951 ms`，active transcript `209659→46021 B`，checkpoint tokens `46602→7902`；
- seed 3：`167901 ms`，active transcript `209659→45540 B`，checkpoint tokens `46602→7882`。

成功率为 `3/3`，median `85295 ms`，mean `112382.33 ms`，max `167901 ms`。三次完整 tools.effective / tools.catalog fingerprint v2 均保持一致；三次 over-limit 系统问答 hook 均 canonical handled，preflight/model fetch/compaction start 都是 `0`。功能结论通过，但 seed 3 距 180 秒超时仅剩 `12099 ms`，时延余量不能称为稳健。最终生产建议为 qwen36 + `timeoutSeconds=240`：相对本次最大值保留 `72099 ms` 且仍严格有界；代价是实际卡死时失败关闭与 lane 释放最多延后 60 秒，必须保持单次 compaction attempt 并监控尾延迟。240 秒本身未在本任务另跑长测，因此它是基于 3-seed 尾部实测的配置建议，不是已验收证据；本文不修改生产。摘要权威仍来自重新读取导演脑，不对 compaction summary 完整性作额外承诺。

三份 `0600` 原始报告及带 SHA-256 的脱敏汇总保存在本地 `.canary-results/qwen36-accident-replay-seed-{1,2,3}.json` 与 `.canary-results/qwen36-accident-replay-3seed-summary.json`，不进入 Git 或发布包。

## 运行

```bash
PATH=/Users/phoenix/.local/node-v22/bin:$PATH \
OPENCLAW_BIN=/absolute/path/to/openclaw-2026.7.1-2 \
CANARY_MODEL_BASE_URL=http://127.0.0.1:18092 \
CANARY_MODEL_ID=default_model \
node scripts/test-openclaw-same-turn-ab-canary.mjs
```

可选变量：`CANARY_MODEL_API_KEY`、`CANARY_TOOL_CALLS`、`CANARY_TOOL_RESULT_BYTES`、`CANARY_GATEWAY_PORT_BASE`。报告只输出脱敏计数和工具 ID，不包含提示正文、工具正文、模型正文、token 或 transcript。

当前本机没有监听 `18091/18092` 的真实模型服务，且全局 OpenClaw 为 `2026.8.1`，因此本地只能验证框架、语法和 fail-closed 行为；不能据此给出四格性能或停止原因结论。
