# OpenClaw Qwen 工具调用并发策略

## 适用范围

本策略适用于 `heisenbergs-1` 上的两套本地 Qwen OpenClaw profile：

- `qwen-current` / agent `second-original`
- `qwen-weixin-new` / agent `main`

Qwen provider 使用本地 `llama.cpp` 的 OpenAI 兼容入口
`http://127.0.0.1:18091/v1`。

## 根因

重复回复事故并非单纯由 Telegram、投递队列或 history loop detector 引起。本地 Qwen 能在同一条 assistant response 中生成多条完全相同的工具调用。

当 OpenAI 兼容请求未显式携带 `parallel_tool_calls` 时，`llama.cpp` 会按 chat template 的能力默认值允许并行工具调用。随后 OpenClaw 也以默认并行策略执行这一批调用。首条工具结果尚未写回历史时，其余副本已经通过循环检测，因而出现竞态和重复回复。

## 生产配置

每个受影响 agent 使用以下 OpenClaw 官方参数：

```json
{
  "params": {
    "parallel_tool_calls": false
  }
}
```

该字段存放在各 profile `openclaw.json` 的
`agents.list[].params.parallel_tool_calls`。OpenClaw 会正式将它注入
`openai-completions` 请求，`llama.cpp` 因此将单条 assistant response 的工具调用上限限制为 1。

这个设置不会禁用工具，也不会阻止多步骤任务在获得第一步结果后继续调用后续工具。过去被模型放在同一响应中的独立调用，会按正常 agent 回合拆开。当前 Qwen 服务本身已经只有一个模型并行槽位，因此这与实际运行能力一致。

## 运行边界

- 保留既有官方 `loopDetection`。它用于拦截跨多个模型回合的异常重复调用。
- 不要在 `openclaw.json` 写入 `toolExecution="sequential"`。它只是 agent-core 的内部构造参数，并非当前 OpenClaw profile 支持的配置项。
- 不要为这类问题修改 OpenClaw npm 包的 `dist/` 文件。若官方配置无法解决上游缺陷，必须使用带 Git 提交、测试和可复现构建的源码方案。
- 旧 loop-terminal 补丁脚本和备份只用于事故取证，不得在升级后自动执行。

## 验收

每次升级 OpenClaw 或 llama.cpp 后，均在不使用 `--deliver` 的前提下验证：

1. `openclaw --profile <profile> config get agents.list[0].params.parallel_tool_calls` 返回 `false`。
2. 直连 Qwen 的 tools 请求携带 `parallel_tool_calls=false` 时，恰好返回 1 条工具调用。
3. 隔离 `exec` 任务记录 1 条成功工具动作和 1 条最终回复。
4. `web_search` 与 `web_fetch` 均只调用一次且成功。
5. 三套 Gateway 与已绑定通道的 probe 均正常。

## 回滚

切换前的 profile 配置和受影响运行时文件归档于：

`~/ai-worker/backups/openclaw-root-cause-parallel-tool-calls-20260721-163028/`

常规维护不得选择性回写其中的运行时文件。只有经过确认的事故回滚方案才可使用该归档，并且恢复后必须重新完成上述验收矩阵。
