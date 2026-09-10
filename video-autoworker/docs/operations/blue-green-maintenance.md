# 常规蓝绿维护入口

常规发布使用 `scripts/release-impact-deploy.mjs` 的plan/apply入口，按组件变化协调现有安装器和蓝绿控制器。需要查询或执行单一蓝绿操作时，使用 `pnpm deploy:blue-green <命令及参数>`（例如 `pnpm deploy:blue-green status`），或固定Node运行 `scripts/run-blue-green-deployment.mjs`。入口只负责调用原有 `deploy-blue-green.sh`、传递参数与退出状态；Git 来源检查、锁、制品审计、安装来源校验、路由切换及自动回滚仍由同一控制器执行。

macOS 远端维护应从已验证的固定 Node 运行环境启动该入口，需要 Aqua 上下文时使用受控 LaunchAgent。不要改用 Python 作为发布命令父进程：历史来源位于 Documents 时，两种运行上下文的系统访问权限可能不同。使用受控 Node 入口不放宽目录权限，也不修改历史源码。

每次运行的主机路径、环境、日志和证据存放在权限受控的私有目录，不能放进源码树。沿用已安装环境的 `AIWORKER_BG_RUN_DIR`、`AIWORKER_BG_RELEASES_DIR`、`AIWORKER_BG_LIVE_DB_PATH` 与 `AIWORKER_PLATFORM_ENV_FILE`；切换时必须提供仍有效的 `AIWORKER_OPENCLAW_RUNTIME_CONVERGENCE_PROOF`，不得改写旧证据时间。

应用更新按已存在的 stage、bind、switch、rollback、retire 合同执行。绑定或切换前先读取实际路由、槽位和安装状态；已暂存但从未激活的候选不能当作生产退役槽位覆盖，须在精确证明其进程退出后保留原绑定证据，再重新准备候选。应用成功切换后，核验实际 HTTP、浏览器、数据库身份和业务数据，再按当前 revision 恢复入口。

普通 `switch` 比较稳定的导演证据投影协议；源码闭包与制品摘要继续独立验证完整性。已知历史摘要通过 `src/lib/director-projection-contract-compatibility.json` 的明确映射兼容，历史outbox保留原摘要、ID和幂等键；未知协议或损坏数据拒绝切换。普通实现改动无需更新业务协议，也不要求重装未变化的薄插件。历史数据回执修复通过指定对象的幂等应用维护接口执行，不作为所有发布的前置任务。

安装器或路由器升级属于独立维护步骤。目标 release 新增 auditor 依赖时，旧 slot launcher 会继续调用其安装绑定的旧 auditor，因此须先用官方 execve-adapter installer 以 CAS 更新 slot runtime 闭包；不能绕过 auditor，也不重做 legacy bootstrap。保留旧安装文件和原历史源码；所有被停止的服务须核实精确 label、PID 和监听缺席，再处理旧运行证明。维护 HTTP 复查使用短连接，避免跨进程重启复用连接；读取允许在明确期限内重试，写入不盲重试，响应不确定时先 GET 对账实际 revision。

本入口不重放历史 bootstrap、恢复收据或其他一次性授权，不开启视频 lane、自动清理或新的外部投递。

开发与发布按 `VAW-FOCUSED-VALIDATION-001` 验证本次功能及直接影响，复用未受影响的既有证据；完整测试仅在明确需要全范围验收时运行，不是每次发布的前置条件。控制层变更不要求重打包未变化的应用；测试和文档修正可从已验证的完整Git来源交付小型增量bundle，并建立新的不可变控制目录。内容摘要相同的接口与制品审计可以复用，commit、安装绑定、进程、数据库打开句柄、调度租约及入口状态必须在新环境重新核验。不要把另一提交成功的CI或旧的运行身份当成本次通过证据。
