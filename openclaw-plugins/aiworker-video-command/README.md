# AI-worker Video Command

当前版本为 `0.5.10`。本目录只维护一份可发布的 OpenClaw 视频入口实现，不保留
旧版运行模块、版本化升级脚本、影子链路或长期兼容分支。

## 单链路边界

`index.js` 是唯一插件入口，注册两个薄适配器：

- Telegram 私聊的 `before_dispatch`：调用 Qwen 做一次无工具结构化意图分类，
  再由宿主校验身份、原消息证据、路径或查询值。
- `aiworker_analyze_video`：为普通 Agent 会话提供结构化
  `submit_video | submit_directory | confirm_duplicate | status | result` 动作。

两个入口都调用 `scheduler-runner.js`，后者只执行已安装
`aiworker-task-flow/scripts/submit-task.mjs`。任务创建、同名同路径确认、串行队列、
平台状态权威、结果查询和分页均属于同一任务流实现；插件不得复制第二套任务状态机。

```text
before_dispatch ─┐
                 ├─ scheduler-runner ─ aiworker-task-flow ─ Video AutoWorker / n8n
aiworker_analyze_video ┘
```

控制台 API 和页面是同一平台记录的只读投影，不是额外派发链。平台存在任务记录时，
平台状态覆盖本地耐久登记；只有平台无记录或暂时不可用时才允许本地降级。

## 当前模块

- `qwen-video-classifier.js`：无工具意图分类。
- `qwen-before-dispatch.js`：Telegram 薄适配器及统一中文回执。
- `task-chain-tool.js`：结构化 Agent tool 薄适配器。
- `scheduler-runner.js`：唯一受控任务流子进程边界。
- `duplicate-confirmation-store.js`：有时限的重复任务确认状态。
- `dispatch-identity.js`、`stable-message-key.js`：可信会话身份和稳定消息键。
- `video-path-policy.js`：视频路径与扩展名校验。
- `json-command.js`：有界单行 JSON 子进程协议。

新增模块必须能从 `index.js` 静态可达；仅被旧测试或旧升级脚本引用的运行模块不得
留在当前包中。布局回归测试会检查全部 `lib/*.js` 都属于唯一入口的依赖闭包。

## 用户行为

- 新提交先检查受控登记中的规范真实路径和文件名。命中同名同路径时不创建任务，
  只提示用户；仅在用户下一条消息精确回复“确认重新分析”后继续。
- 提交只返回一次受理信息，不在同一轮轮询、重试、恢复、重新提交或完成回投。
- `status` 和 `result` 只读受控任务登记与正式输出，不搜索聊天、任意文件、
  SQLite、n8n execution、媒体目录或旧工作区。
- 名称查询命中多条结果时返回带任务编号、批次信息和完成时间的有界候选；
  默认选择最新完成记录，再按其精确任务编号读取。
- 默认结果回复使用中文三行：视频标题、当前状态、一句分析摘要。用户明确要求正文时
  才按偏移分页读取。

## 发布

源码和生产仓库必须处于 `main`，且 `HEAD`、`origin/main`、GitHub
`main` 与显式目标提交一致：

```bash
target_sha="$(git rev-parse HEAD)"
bash scripts/install-aiworker-video-command-plugin.sh --dry-run --target-sha "$target_sha"
bash scripts/install-aiworker-video-command-plugin.sh --apply --target-sha "$target_sha"
```

安装器只允许当前声明的上一个版本迁移到 `0.5.10`；已是当前版本时验证后无操作。
它使用 OpenClaw 官方命令移除已退役且运行时不再使用的 sender hash 配置，再安装
当前插件并只重启 `qwen-current` Gateway。除该字段外配置语义必须完全不变；安装后
还会核对运行载荷与当前源码字节一致，并验证工具目录和受保护监听端口。它不启动或
操作视频队列、调度器、n8n、媒体或数据库。

应用前会在仓库外创建带确定性清单的权限受控回滚点。回滚必须显式指定已验证目录：

```bash
bash scripts/install-aiworker-video-command-plugin.sh \
  --rollback \
  --target-sha "$target_sha" \
  --backup "/absolute/verified/current-release-backup"
```

旧 Git 提交、生产 release 和已验证备份只作为不可变回滚证据保留，不在当前源码中
继续修复或暴露日常入口。历史过程保留在日期化运维记录中。

## 验证

```bash
pnpm test:openclaw-video-command
pnpm test:openclaw-task-flow
pnpm typecheck
pnpm lint
pnpm build
git diff --check
```

本地测试只证明候选实现；生产完成还必须验证运行插件版本、唯一
`before_dispatch`、唯一 `aiworker_analyze_video`、任务流 Skill 字节一致、
调度器预期状态，以及部署前后没有新增任务执行。
