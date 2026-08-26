# 2026-08-26 视频重跑确认状态修复

## 需求与现象

- 生产 OpenClaw 通过 `aiworker_analyze_video.submit_video` 正确命中同名同路径门禁。
- 用户在后续消息中回复“确认重新分析”时，`confirm_duplicate` 返回“当前没有等待确认的重复视频任务”，未执行重跑。
- 根因是插件确认状态只保存在单次插件进程的内存 Map；OpenClaw CLI 的跨回合运行无法可靠复用该 Map。

## 决策与改动

- 保留同名同路径门禁和精确确认短语，不放宽自动重跑条件。
- `duplicate-confirmation-store.js` 增加可选的受控 JSON checkpoint：按会话 scope 保存任务/批次编号、规范路径和 15 分钟过期时间；写入使用临时文件原子替换，目录 `0700`、文件 `0600`，读取时校验版本、scope 和操作结构。
- `index.js` 将 checkpoint 放到当前 OpenClaw profile 的 `aiworker-video-command/duplicate-confirmations.json`，不写入源码仓库、任务数据库或 n8n。
- 插件版本由 `0.5.10` 升为 `0.5.11`，唯一安装器增加 `0.5.10` 迁移入口；其余视频处理链、队列、模型和状态契约不变。

## 本地验证

- `pnpm test:openclaw-video-command`：11 个测试文件、85 项通过。
- 新增跨 store 实例恢复、过期清理和 `0600` 权限测试；`pnpm test:openclaw-task-flow`：17 项通过。
- `node --check`、`git diff --check` 通过。

## 生产边界与回滚

- 目标节点为 `heisenbergs-1`，OpenClaw profile 为 `qwen-current`，版本 `2026.7.1-2`。
- 使用唯一安装器的 `--dry-run/--apply`，安装器会先建立带清单的回滚点，安装后只重启 `qwen-current` Gateway 并校验唯一 hook/tool、载荷哈希和监听端口。
- 回滚使用安装器输出的已验证 `current-release-*` 目录；不触碰视频队列、n8n、媒体、数据库或模型服务。

## 触发验收

- 修复前的真实 OpenClaw 会话已记录：首次提交返回同名同路径门禁，随后确认因内存状态丢失而失败；期间没有新增任务或 n8n execution。
- 修复部署后需重新提交该成片以生成新的确认 checkpoint，再由下一条精确“确认重新分析”验证 queued 回执；若门禁状态仍不可恢复，应停止并回滚，不得直接调用底层提交器绕过 OpenClaw。

## 已知问题与下一步

- 当前待确认状态只保留 15 分钟，超过期限需重新提交并再次确认；不提供跨 profile 或跨会话的模糊恢复。

## 生产部署与触发证据

- canonical 提交 `c887c6eada099b181f58c089e0998a1e15958a70` 已推送 GitHub 并快进到实际生产仓库；运行插件由 `0.5.10` 升为 `0.5.11`。唯一安装器先完成 dry-run，再创建已验证回滚点并仅重启 `qwen-current` Gateway。
- 运行时检查确认插件处于 `loaded`，仅有 1 个 `before_dispatch` 和 1 个可选 `aiworker_analyze_video` 工具；Gateway 连通正常。新的确认 checkpoint 在 profile 私有状态目录中以 `0600` 权限创建，确认成功后已清空待确认条目。
- 用户对约 47.4 GiB 成片给出精确“确认重新分析”后，生产 OpenClaw 原生工具成功提交任务 `video-command-a70bb25e044f27672042f866bd04f8a45bb5bcc07904ac53d4c7a7fb77559e38`；未直接调用底层提交脚本绕过 OpenClaw。
- 平台任务当前为 `accepted`、无错误，持久化视频 lane 为 `running`；n8n 真实 `aiworker-video-analysis-v1` execution `65` 已处于 `running`。控制台管理 execution API 因未配置管理 API Key 不列出执行项，因此以 n8n SQLite 只读查询核验实际执行态；不修改 n8n 数据库。
- 视频分析为长时异步任务，本记录时点仅证明已正确派发且执行已启动，不将其表述为已完成。后续只读查询应使用上述任务编号和正式 `status` / `result` 链路。
