# OpenClaw 长会话韧性与 transcript 投影

## 状态边界

本文记录 `qwen-current / second-original` 的本地候选方案，不代表生产已安装或启用。
目标是修复长会话中工具结果和工具参数持续进入 transcript，最终使 OpenClaw 内置上下文压缩超过
可恢复边界的问题，同时保证当前轮工具能力、业务结果和用户回复不受影响。

脱敏故障样本中，单轮共发生 `26` 次工具调用：`read 15` 次、导演脑 `5` 次、`exec 5` 次、
memory `1` 次；工具结果累计约 `111 KB`，thinking 约 `57 KB`，最终
`stopReason=length`。各次参数不同，因此重复调用检测没有触发；该轮输入没有达到 mid-turn 预检阈值，
所以预检没有介入。失败轮随后把完整结果和 thinking 写入 transcript，下一条消息才触发约 `28K tokens`
的预压缩；本地 Qwen 超过默认 `180s` 后被 OpenClaw 主动中止。这说明故障链是同轮工具规划失控、
输出预算耗尽和压缩模型超时叠加，不是工具不可用或普通对话额度不足。

## 单一路径

```text
模型调用工具（完整参数）
        ↓
工具执行（完整结果）
        ↓
当前轮继续推理并回复（完整可用）
        ↓
tool_result_persist / before_message_write
        ↓
仅写入 transcript 的副本被去标识、限长
        ↓
OpenClaw 内置 safeguard 后续读取精简 transcript
```

方案不注册自定义压缩 provider，不增加压缩 RPC、激活回执、探针、队列或旁路状态机。长期会话仍由
OpenClaw `2026.7.1-2` 的内置 safeguard 管理。

## 投影合同

导演脑插件为 `second-original` 注册三项 hook：

- `before_agent_reply`：对导演脑系统原理问题做单次 canonical blueprint 硬路由，使用真实 `ctx.agentId` 限定 `second-original`，命中后直接返回 synthetic reply，在模型运行和自动压缩前结束本轮；
- `tool_result_persist`：在工具结果写入 transcript 前替换落盘副本；
- `before_message_write`：作为所有最终消息写入前的最后防线。

三项 hook 都在插件内部再次核对 `context.agentId`，其他 agent 不会受到路由或投影影响。
按 OpenClaw `2026.7.1-2` 的真实写入链复核，`tool_result_persist` 先处理工具结果，随后
`before_message_write` 会收到最终待写消息，最后才追加 JSONL。第二层不是只处理 assistant/toolCall：它能
独立压缩仍为原始形态的 `toolResult`，也能对第一层已经压缩的结果再次处理且输出保持相同。这样即使第一层
因版本偏差、插件竞争或上下文异常没有改写，目标 Agent 的大结果仍不会直接进入长期会话；无法核实
`context.agentId` 时则不跨 Agent 修改消息。
OpenClaw 对同名同步消息 hook 按优先级从高到低执行，因此两项投影都显式使用低优先级，作为其他正常
消息处理后的收口层；系统问答则由宿主的 `eligibleTriggers=['user']` 与 handler 内部检查共同排除 heartbeat。

投影只影响落盘副本：

- `aiworker_director_brain` 和 `aiworker_analyze_video` 保留有导演价值且通过白名单的叙事语义，再附加固定成功/失败状态；
- 其他工具只保留固定成功/失败状态，不复制任意工具正文；
- assistant 工具调用只保留配对所需的 `id`、工具名和通过严格格式校验的 action；input/arguments 仅保留 action 空壳，不落盘其他参数、synthetic、路径、thinking、reasoning 或 signature；
- `details` 完全移除；
- 单条工具结果和工具调用 envelope 都有固定字节上限；异常时 fail closed 为安全状态，不回退原始内容。

这不会缩减任何工具，也不会改变工具收到的参数、工具返回给当前轮模型的结果或最终用户可见回复。

## 有界配置收敛

运行时 manifest 显式管理七个相互依赖的 compaction 字段。真实隔离基准显示主模型
`qwen38-local/default_model` 在 180 秒内无法完成同一压缩，而
`qwen36-tools-local/default_model` 可完成；生产等价三次事故形状复测为 83.951/85.295/167.901 秒，
因此压缩模型与 240 秒失败边界也纳入同一合同：

```json
{
  "agents": {
    "defaults": {
      "compaction": {
        "model": "qwen36-tools-local/default_model",
        "timeoutSeconds": 240,
        "keepRecentTokens": 8192,
        "recentTurnsPreserve": 4,
        "truncateAfterCompaction": true,
        "maxActiveTranscriptBytes": "128kb",
        "midTurnPrecheck": {
          "enabled": true
        }
      }
    }
  }
}
```

主对话模型仍保持原值；只有 compaction 使用独立 Qwen3.6。收敛会显式删除已经退役的
`identifierInstructions`，其余未受管的 `agents.defaults.compaction` 字段全部原样保留。`truncateAfterCompaction=true` 是
`maxActiveTranscriptBytes` 真正轮换活动 transcript 的前置项，两者必须成对安装和验收。现有 agent `tools` 对象、插件配置、模型、
Gateway、channel、binding 和凭据引用也必须原样保留。官方 `config patch` 的 dry-run 和 apply 负载只能
包含 manifest 声明的字段；发布前后必须按工具 ID、来源、插件、channel 与 schema/描述语义摘要对账，
不能只看 ID，也不能用“必需工具仍存在”代替“没有工具被减少或替换”。

这些字段位于 `agents.defaults.compaction`，所以当前合同只允许 `qwen-current` 的 `agents.list` 包含且仅包含
`second-original`。基线采集、dry-run、apply、运行证明、重复验证和 rollback 都必须从受保护的同一份配置
快照重验这一单 Agent 不变量；出现第二个 Agent、缺失目标 Agent 或列表漂移时失败关闭，不创建新基线、
不覆盖漂移后的配置。未来若要在该 profile 增加 Agent，必须先把 compaction 改为 Agent 局部策略或拆分
profile，再另行评审和迁移，不能让默认策略静默扩散到新 Agent。

`keepRecentTokens=4096` 的早期隔离观察没有显式启用 `truncateAfterCompaction`，也没有与生产
`8192` 做等价对照，因此不能作为改动生产保留窗口的证据。本次保持生产的 `8192` 与
`recentTurnsPreserve=4`，避免无依据缩短人类对话连续性。`128kb` 是独立于 token 估算的预压缩触发阈值，不是对当前
同轮内存或 JSONL 文件的硬物理上限。`midTurnPrecheck` 必须保持开启：它虽然没有命中本次低于阈值的
故障轮，但仍是其他工具密集轮次的原生保护层；不能因为一个未命中样本而关闭。后续调整任一值都必须
重新跑相同 A/B、完整工具能力对账和跨轮恢复测试。

配置收敛只解决物理长度，不能把模型摘要当成业务记忆。隔离测试中，即使追加压缩指令，旧工具结果中的
人物与镜头动作仍可能丢失。导演脑的长期语义连续性必须按当前问题从权威数据源重新读取：系统原理问题用
`explain` 单次读取已审核蓝图，作品问题按唯一作品重新执行 `search`/`assemble`；不得依赖聊天摘要复原
任意旧 tool result，也不得用 `read`、`exec` 或 memory 回退拼答案。

## 激活与发布顺序

插件代码不是配置热更新。安装前必须先对真实既有会话保存工具基线；安装新插件树后只对
`qwen-current` 做一次 fresh restart，再执行配置
收敛：

1. 选取一个由真实入站建立且属于 `second-original` 的既有会话，同时保存全量 `tools.catalog` 与带该
   `sessionKey` 的 `tools.effective`；私有基线只保存会话键 SHA-256，不保存明文；
2. 安装 `aiworker-director-brain 0.4.0`，确认安装包含 `director-context-summary.js` 与
   `transcript-tool-result-projection.js`；
3. fresh restart `qwen-current`；
4. 从真实 `18889` listener、`gateway status --deep --require-rpc`、插件 runtime inspection、全量
   `tools.catalog` 和同一真实会话的 `tools.effective` 建立一致证据；
5. 确认 Gateway 启动时间严格晚于插件树最后变化后的下一整秒，三个 hook 均已加载；
6. 对比跨 restart 基线：删除集合必须为空，新增只能是 `aiworker_director_brain`；
7. 对 manifest 声明的有界配置 patch 先 dry-run，再以 inode、摘要和进程证据做 CAS；
8. apply 后证明 listener PID、进程启动身份、插件树摘要、catalog 和 session-effective 工具集合逐项不变。

配置 patch 走 OpenClaw 官方热更新，不允许调用 Gateway start/stop/restart，也不允许触碰 n8n、3017、
模型、video worker、任务、数据库或媒体文件。

runtime RPC 鉴权只复用 profile 已配置的 Gateway exec SecretRef。解析值只通过短进程
`OPENCLAW_GATEWAY_TOKEN` 环境变量传给 status、runtime inspection 和 catalog 调用；调用结束立即释放，
并在所有子进程入口清除父环境中的 `OPENCLAW_GATEWAY_TOKEN`、`GATEWAY_TOKEN`、
`OPENCLAW_GATEWAY_PASSWORD` 和 `GATEWAY_PASSWORD`，避免 token/password 来源冲突。解析值不进入
argv、输出、临时文件或父进程环境。解析失败即关闭发布门，不另建第二套鉴权。

## 失败门禁

以下任一情况都必须在配置写入前拒绝；若已经创建备份则保留 `0600` 回滚点：

- `gateway status` PID 与 `18889` 唯一 listener 不一致；
- RPC、health、bind host、端口或 stale PID 不健康；
- 插件版本、必需 hook、安装文件或可选工具绑定不匹配；
- `tools.effective` 的真实会话不存在、Agent 不匹配或与安装前基线不是同一 SHA-256 绑定；
- session-scoped effective inventory 携带 MCP 未连接、未列举、过期或工具 schema 隔离 notice；
- Gateway 未在插件安装后 fresh restart；
- 插件树、配置 inode、listener PID 或工具列表在验证窗口内漂移；
- 原有任一工具在 apply 前或热更新后消失；
- 官方 patch 修改了唯一允许字段之外的配置；
- 配置文件不是目标用户拥有的单链接 `0600` 实体文件；
- 共享部署锁被占用。

apply 后验证失败时，只恢复 apply 前的完整配置；并发写入导致 CAS 失效时拒绝自动覆盖，转人工检查。

## 回滚

回滚只接受安装器生成且通过实体文件、权限、身份与 JSON 校验的显式绝对备份路径。恢复后应再使用
导演脑安装器恢复上一版插件树，并 fresh restart `qwen-current`。回滚脚本本身不操作 Gateway 生命周期。

## 本地验证要求

至少覆盖：

- 投影语义、隐私、字节预算、循环对象、超量输入、取消和幂等，包括原始 `toolResult` 直接进入
  `before_message_write`、已投影结果再次进入、缺失工具名和异常 Agent 上下文；
- 目标 agent 与非目标 agent 的 hook 隔离；
- 安装包精确包含两个投影依赖文件且不包含测试、探针或激活回执；
- 单 Agent 配置通过、多 Agent 在 capture/dry-run/apply/proof/rollback 各边界失败关闭，并覆盖验证窗口内
  新增 Agent 后拒绝自动恢复覆盖；
- 配置精确收敛 `model=qwen36-tools-local/default_model`、`timeoutSeconds=240`、
  `keepRecentTokens=8192`、`recentTurnsPreserve=4`、
  `truncateAfterCompaction=true`、`maxActiveTranscriptBytes=128kb` 和 `midTurnPrecheck.enabled=true`，显式删除
  `identifierInstructions`，其余原 compaction 字段与完整
  tools 对象深比较相等；
- runtime proof 对 PID、插件树、配置 inode、hook 和完整 tools 列表的正反向故障注入；
- 插件安装前基线、fresh restart 后基线和热更新后基线使用同一真实会话，catalog/effective 任一工具减少均拒绝；
- dry-run 零配置写入、零备份，重复 apply 幂等；
- apply 失败恢复、并发写入保留、回滚与敏感输出抑制；
- rich canary 中当前轮完整工具结果可用，而持久化 transcript 只含安全投影；跨压缩后的导演业务问答
  必须通过 Director Brain canonical source 单次重取，不以摘要背诵旧工具结果作为通过标准。

生产验收必须另行完成，不能以本地 fixture、synthetic harness 或静态源码检查冒充。

## OpenClaw 升级边界

当前插件包、运行时 manifest 和收敛脚本只认可已完成本轮验证的 OpenClaw `2026.7.1-2`。
不能把包元数据中的最低版本误当成对未来版本的兼容承诺。OpenClaw 升级前必须在隔离环境重新验证：

- `before_agent_reply`、`tool_result_persist` 与 `before_message_write` 的事件、上下文和返回合同，以及非 bundled 插件的 `hooks.allowConversationAccess=true`；
- assistant toolCall 的 `input` / `arguments` envelope 与工具调用配对规则；
- `gateway status`、runtime inspection、`tools.catalog` 和带真实 `sessionKey` 的 `tools.effective` JSON 合同；
- Gateway exec SecretRef 的解析方式和 token 格式。

上述任一合同变化时，现有安装与配置收敛应失败关闭，不能跳过校验或在生产直接扩大版本范围。
完成兼容矩阵、长会话 canary、完整工具集前后对比和回滚演练后，才能在同一变更中更新插件约束、
manifest 与测试基线。
