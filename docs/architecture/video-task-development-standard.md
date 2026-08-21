# 视频任务链开发标准

飞书项目规范：`VAW-SINGLE-CHAIN-001`（`PROJ-VIDEO-AUTOWORKER`，P0）。

## 单一当前链路

项目只维护一条当前视频任务链：

`入口适配器 -> aiworker-task-flow -> 持久串行队列 -> Mission Control -> n8n -> prepare -> audio / vision -> finalize -> 正式结果`

Telegram `before_dispatch`、`aiworker_analyze_video`、控制台 API 和页面不是独立链路。它们只能做鉴权、输入转换、只读查询或展示，并调用同一 runner 与状态契约。不得为某个入口复制提交、状态查询、重试或结果选择逻辑。

## 单版本维护

- 功能升级直接替换当前实现，并在同一变更中迁移调用方、测试和文档。
- 不建立长期并行的旧版目录、版本分支、兼容开关、双写或双读链路。
- 必须保留的数据迁移应是有退出条件的边界代码；迁移完成后删除，不演化为第二套业务实现。
- 生产 release、数据库备份和旧 bundle 只用于回滚，不接收新功能和修复。
- 插件发布只维护 `scripts/install-aiworker-video-command-plugin.sh` 一个当前入口；
  版本化升级、激活、授权和旧版回滚脚本不得重新进入活动源码。

## 共享模块边界

- `task-status-authority` 是任务状态权威与终态判断的唯一来源。
- 平台存在任务记录时，以平台状态为准；仅在平台无记录或暂时不可用时使用耐久本地登记。
- `n8n-task-runs` 负责租户隔离的平台查询和安全投影；`n8n-task-queue` 只组合共享查询结果，不重新解释状态。
- 共享行为必须保持纯函数或显式依赖注入，便于 OpenClaw、服务端 API 和测试共同复用。

## 页面组件边界

- 通用交互原语放在 `src/components/ui/`，业务组合放在对应 feature component 或 panel。
- 页面不直接读取数据库、解释任务状态或复制格式化规则；这些逻辑放入 `src/lib/` 的可测试模块。
- 新组件先检索项目现有组件和 Phoenix 组件库。没有适配当前 React/Next.js 技术栈的实现时，只保留一份最小本地组件，并记录可复用需求。

## 完成标准

每次任务链变更至少验证：平台优先、本地降级、终态队列抑制、workspace/tenant 隔离、无任务副作用、定向与全量测试、类型检查、lint、生产构建和真实运行环境只读验收。部署记录必须区分源码提交、实际运行提交与回滚点。
