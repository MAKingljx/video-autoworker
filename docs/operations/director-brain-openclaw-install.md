# 导演脑 OpenClaw 安装与回滚

`scripts/install-aiworker-director-brain.sh` 只在明确指定的 OpenClaw profile 上安装三项载荷：

- `aiworker-director-brain` 插件：注册一个可选工具，并为目标 Agent 注册
  `before_agent_reply`、`tool_result_persist`、`before_message_write` 三个 hook；安装器同时设置
  `plugins.entries.aiworker-director-brain.hooks.allowConversationAccess=true`，允许非 bundled 插件使用官方会话短路 hook；
- 插件私有的飞书导演脑服务代码和无密钥 schema；
- 目标 agent workspace 中的 `aiworker-director-brain` Skill。

安装器同时只为目标 agent 授权 `aiworker_director_brain`，不提供全局授权。它不会复制 App Secret 或本地 catalog，不连接远端，不操作任务队列、n8n、素材或数据库，也不会重启 Gateway。剪辑、DaVinci、时间线、渲染和导出不在安装载荷或工具能力内。

OpenClaw `2026.7.1-2` 不允许同一 Agent scope 同时设置 `tools.allow` 与 `tools.alsoAllow`，而 optional
插件工具只写入 `allow` 又不能越过既有 profile 过滤。因此安装器只接受 profile + `alsoAllow` 形态；若发现
历史显式 `allow`，会在任何备份或写入前失败关闭。把任意 allowlist 转换成 profile + deny 必须另做带真实
`tools.effective` 基线的能力迁移，安装器不会猜测转换或缩减原有工具。

## 预检

必须显式给出 profile 名、其 state 目录、agent workspace 和 agent ID。先执行 dry-run：

```bash
bash scripts/install-aiworker-director-brain.sh \
  --dry-run \
  --profile qwen-current \
  --state-dir /absolute/path/to/.openclaw-qwen-current \
  --workspace /absolute/path/to/agent-workspace \
  --agent second-original
```

dry-run 只创建并清理本机临时校验目录，不修改 profile、workspace 或备份目录。

`0.4.0` 的运行时服务要求飞书导演脑 catalog 已显式迁移到 schema v3。当前测试 catalog 仍为 v2
时，只允许先执行迁移 dry-run、生成权限受控的全表备份、完成 v2 → v3 追加迁移并用真实 API 回读；
安装器自身不会迁移或回填飞书 catalog，也不会打开生产 SQLite。不得先在 v2 catalog 上加载
`0.4.0` 再把插件安装成功当成导演脑可用。

## 安装

确认预检结果后，先选取一个由真实入站对话建立、属于 `second-original` 的现有会话。会话键只放入
当前短进程环境，不写入基线、日志或文档；基线仅保存其 SHA-256 绑定。OpenClaw
`2026.7.1-2` 的 `tools.effective` 会拒绝不存在或 Agent 不匹配的会话，因此不能使用临时拼接或 synthetic
会话键冒充真实用户工具集合。若该会话的 MCP 目录尚未连接、未完成列举、已经过期或有工具 schema
被隔离，`tools.effective` 会携带 notice，基线采集同样失败；应先让该真实会话完成一次正常 Agent 运行。

```bash
read -r -s -p 'Existing qwen-current session key: ' AIWORKER_OPENCLAW_RUNTIME_SESSION_KEY
export AIWORKER_OPENCLAW_RUNTIME_SESSION_KEY
bash scripts/apply-openclaw-runtime-convergence.sh --capture-tool-baseline
```

保存命令返回的 `0600` 绝对基线路径，再把导演脑安装器的 `--dry-run` 改为 `--apply`。有变化时，安装器先验证备份根必须为绝对、非宽泛、非 Git 工作树，且不得等于 state 或 workspace。允许使用 state 下专用的 `backups/aiworker-director-brain/` 子目录，但备份根不得位于受管目标内或包含受管源/目标，也不得与源码、Git 工作树或事务路径形成危险重叠；默认在该专用子目录创建 `0700` 回滚点。清单精确覆盖目录、普通文件、权限、文件摘要和成员集合。插件、Skill 与配置分别通过原子换名或硬链接激活，并由失败补偿恢复整体状态；三项并不是一个文件系统级原子事务。配置还绑定激活 inode，并在最终校验和提交完成前再次核对，防止同内容替换绕过检测。相同内容重复执行是无写入操作，不生成新备份。已有 `plugins.allow` 只保留原名单并追加导演脑插件，不会把原先排除的其他已启用插件重新放通。

安装完成不会自动重启 Gateway。插件代码和新增 hook 不是配置热更新；后续必须在独立受控步骤中
只对目标 profile 做一次 fresh restart，并通过 `plugins inspect`、`tools.catalog`、三项必需 hook 和真实
`health` 调用验收。重启前还必须重新确认真实运行目录、目标 profile、监听端口和进程。生产安装与
Gateway 重启属于独立风险阶段，必须重新通过运行硬门。若原配置没有 `plugins.allow`，安装器保持
插件发现模式，不会自行创建可能排除其他插件的新白名单；若已有白名单，只在原名单末尾追加导演脑。
安装前必须私有保存 `tools.catalog` 与目标会话 `tools.effective` 基线，fresh restart 后只允许新增
`aiworker_director_brain`，删除集合必须为空。对账使用工具 ID、来源、plugin/channel 所有权和描述、
optional、profile、risk、tags 的语义指纹，不能只比较 ID。`aiworker-video-command@0.5.14` 与
`aiworker-director-brain@0.4.0` 的完整安装树摘要也必须绑定进证明。后续五项有界 compaction 配置 patch 可走官方热更新，
但不能用它替代插件 fresh restart。

fresh restart 后继续复用同一短进程环境和基线路径；先执行 dry-run，再执行 apply：

```bash
bash scripts/apply-openclaw-runtime-convergence.sh \
  --dry-run \
  --tool-baseline /absolute/path/to/qwen-current-before-director-install-tools.json
bash scripts/apply-openclaw-runtime-convergence.sh \
  --apply \
  --tool-baseline /absolute/path/to/qwen-current-before-director-install-tools.json
unset AIWORKER_OPENCLAW_RUNTIME_SESSION_KEY
```

每次检查都同时读取全量 `tools.catalog` 与该真实会话的 `tools.effective`。安装前后允许的唯一新增项是
`aiworker_director_brain`；任一原有工具消失、出现其他新增工具、会话绑定变化或插件树漂移都会失败关闭。
apply 还必须证明 Gateway PID 未变化、`requiresRestart=false`、热加载状态为 active，且新日志只有成功的
compaction reload、没有 restart/reload failure。成功后产生 `0600` runtime convergence proof；导演发布门与
legacy final readiness 都必须引用并重新验证该证明。相同配置重复执行时显式传入
`--runtime-convergence-proof /absolute/path/to/proof` 复用仍有效的证明，不会生成空证明或无证据重新背书。

由于 compaction patch 写入 `agents.defaults`，capture、dry-run、apply、proof 验证和 rollback 的每个配置
快照都要求 `qwen-current.agents.list` 只有一个 `second-original`。任一阶段发现第二个 Agent 或列表漂移都
失败关闭；写入后才出现的多 Agent 漂移会保留现场并要求人工检查，不用旧备份自动覆盖。需要新增 Agent
时，先把 compaction 改为 Agent 局部配置或拆分 profile。本合同还会通过官方 merge patch 显式发送
`identifierInstructions=null` 删除退役字段，其他未知 compaction 字段保持原值。

## 回滚

使用安装输出中的绝对备份路径：

```bash
bash scripts/install-aiworker-director-brain.sh \
  --rollback \
  --profile qwen-current \
  --state-dir /absolute/path/to/.openclaw-qwen-current \
  --workspace /absolute/path/to/agent-workspace \
  --agent second-original \
  --backup /absolute/path/to/.openclaw-qwen-current/backups/aiworker-director-brain/YYYYMMDD-HHMMSS.XXXXXX
```

回滚先验证目录、普通文件、权限、摘要和精确成员集合；额外文件、空目录、缺失成员、漂移、符号链接和异常路径均拒绝。通过后，源备份会被原子认领到同一备份根下的 `0700` 私有兄弟目录，绑定根、state、清单、配置、插件和 Skill 身份；复制后再次验证源清单，并分别执行配置 `cmp` 与插件、Skill 全树比较。认领失败、复制失败或释放冲突时保留可恢复现场，不由 cleanup 删除未知对象。随后才为当前活动状态创建救援回滚点并进入事务替换；回滚同样不重启 Gateway。
