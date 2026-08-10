# AI-worker 视频入口 0.3 发布回滚

当且仅当 0.3 已完成生产安装、但真实 Telegram 私聊验收失败时，使用
`scripts/rollback-aiworker-video-release.sh` 作为唯一发布级回滚入口。它把插件和工作区视为同一份发布：插件恢复为显式备份中的 0.2，任务流技能、`AGENTS.md` 与 `MEMORY.md` 恢复为显式任务流备份中的安装前状态。不得分别手工回退其中一半。

先以同一组参数执行只读检查，再执行应用：

```bash
scripts/rollback-aiworker-video-release.sh --dry-run \
  --plugin-backup /Users/heisenbergs-1/ai-worker/backups/aiworker-video-command/upgrade-YYYYMMDD-HHMMSS.XXXXXX \
  --task-flow-backup /Users/heisenbergs-1/ai-worker/backups/aiworker-task-flow-skill/YYYYMMDD-HHMMSS.XXXXXX \
  --target-sha 0123456789abcdef0123456789abcdef01234567

scripts/rollback-aiworker-video-release.sh --apply \
  --plugin-backup /Users/heisenbergs-1/ai-worker/backups/aiworker-video-command/upgrade-YYYYMMDD-HHMMSS.XXXXXX \
  --task-flow-backup /Users/heisenbergs-1/ai-worker/backups/aiworker-task-flow-skill/YYYYMMDD-HHMMSS.XXXXXX \
  --target-sha 0123456789abcdef0123456789abcdef01234567
```

两个备份路径都必须明确给出，且必须分别是固定备份根目录的直接子目录；脚本不会选择 `latest`。`--target-sha` 必须同时等于当前 `HEAD`、本地 `origin/main` 和实时远端 `main`。插件备份必须带有有效的 `.verified`、0.2 配置、0.2 payload、旧索引记录、已审计 0.3 payload 指纹、创建备份时写入的 0.2 `previous-plugin` 完整规范化指纹，以及与 `--target-sha` 一致的来源提交。升级器在任何生产安装前写入该 0.2 指纹，并在创建 `.verified` 前重新计算；回滚入口也必须重新计算一致，任何普通文件增删改都会拒绝。任务流备份必须通过完整 `STATE` 与 `MANIFEST.sha256` 自校验；清单按安装器相同的全局 `LC_ALL=C` 字节序重算，覆盖根目录、`STATE`、对象类型、八进制 mode 与内容 SHA，并排除清单文件自身。除插件中唯一的 `node_modules/openclaw` 官方 peer 链接外，插件备份不允许其他符号链接；该链接的文本和真实目标必须与当前官方安装完全一致，任务流备份则完全不允许符号链接。

应用阶段同时持有 qwen-current 插件锁和任务流工作区锁，并先建立权限为 0700 的临时 0.3 事务快照。插件通过官方 OpenClaw 安装命令从受控 `previous-plugin` 恢复，配置按备份逐字恢复。安装索引不会把已经是 0.3 内容的 canonical 路径伪装成 0.2，而是安全地指向已验证的 0.2 备份 payload，并写入 active rollback marker；旧索引记录用于语义校验，不做不安全的 SQLite 字节复制。active marker 验证成功后，该备份从 `.verified` 转换为 active source，避免后续重试的保留策略误删唯一兼容基线。

任务流、插件、运行时和实时 Gateway 任一后置阶段失败时，脚本会用事务快照尝试把插件、配置、任务流技能、`AGENTS.md`、`MEMORY.md` 和 qwen-current Gateway 全部恢复到 0.3。只有 0.3 payload、runtime、索引、实时 Gateway、任务流、配置及受保护 PID 全部验证成功后，才先创建并校验空的 0600 `.verified`；此时 active marker 仍保留，最后一步才删除 active marker。标记转换会先保存 active marker 的精确事务副本；若 active 删除命令失败或删除后检查异常，脚本会恢复并逐字核验原 active marker，同时只删除本轮创建的 `.verified`，最终必须保持 active 有效且 `.verified` 不存在。若补偿本身不能完成，则以 70 退出并保留事务证据。若任何 0.3 验证失败，则保留 active marker 且不创建 `.verified`。只有完整 0.2 状态通过验证时才报告回滚成功；若回滚的回滚也失败，脚本以故障状态退出并保留事务证据，禁止报告成功。

整个入口只允许通过官方命令重启 qwen-current Gateway。执行前后会核对 3017 与 5678/5679 监听进程，Mission Control 与 n8n 的 PID 必须保持不变；脚本不读写 Mission Control 或 n8n 数据库，也不会提交或重放生产任务。
