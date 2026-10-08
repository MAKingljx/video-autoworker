# 发布绑定、当前运行收据与制品保留

发布仍使用 canonical Git 提交、已验证的同一份 standalone 制品和既有 release operation。自动发现不修改平台配置、数据库或安装收据，也不猜测缺失的绑定。

## 自动发现

在产品目录使用 Node 22 执行 `node scripts/release-impact-deploy.mjs discover`。入口读取实际安装收据、权限为0600的 `platform.env`、调度 Worker 的 LaunchAgent 参数和当前 Worker 状态。未显式指定的运行目录、制品目录、端口、数据库、作用域和 Worker manifest 自动补齐；命令行参数及已有环境变量优先，空值或错误值不会被静默修复。

Worker manifest以真实 LaunchAgent 的 `--artifact` 和进程状态为依据，避免复用平台文件中已过期的指针。缺失或不一致的绑定一次返回 `currentState`、`errorCode`、`nextAction` 和 `missing` 列表；发布不得越过该报告。配置解析仅允许发布字段，不执行Shell表达式、不输出凭据。

`plan`、`apply` 和 `resume` 复用自动发现，继续执行原有锁、CAS、幂等、制品完整性、数据库身份及真实验收合同。显式覆盖仍须通过运行身份校验。

## 当前运行收据

唯一当前文件为安装收据所声明运行目录中的 `current-runtime.json`，权限0600。发布完成真实验收、恢复Worker并结算本operation拥有的接单状态后，才在同一发布操作中原子更新该文件。成功输出晚于收据写入；收据失败时原制品及接单状态保持实际事实，可诊断并续作。

收据分别记录真实运行应用提交及制品摘要、安装控制组件提交与本次发布协调器提交、插件与技能内容指纹、Worker manifest与当前租约健康、路由generation、数据库device/inode、实际migration和可选编辑表，以及短验收证据摘要。当前Git checkout不替代线上应用提交，应用源码版本也不代表所有组件同时升级。

`node scripts/release-impact-deploy.mjs current` 与鉴权后的 `GET /api/runtime/current` 读取同一共享模块。读取会核对路由、slot binding、制品清单及文件身份、真实PID/cwd/数据库开放身份、SQLite schema、Worker和已登记组件引用；缺文件显示 `uninitialized`，不一致显示 `drift`。读取不生成、修补或覆盖收据。网页响应只公开版本和证据摘要，不包含配置内容、凭据或私有运行路径。

## 有界制品保留工具

本轮工具仅处理应用 release 制品，不覆盖数据库、素材、索引、模型、备份、源码、工作树、普通下载和其他资源类型。默认保留当前制品及最近两个已验证、可恢复的历史对象。current、previous、进程文件引用、未完成发布计划引用、未知目录、源码工作树、链接、跨文件系统对象及未验证对象均受保护，不为凑数量删除。

先执行 `node scripts/release-impact-deploy.mjs retention-plan --output /absolute/task/retention-plan.json`。计划只读取，给出具体路径、预计字节数、保护原因和 `planSha256`。受控 operations namespace来自当前验收收据；缺失、过深或超出读取上限时阻断清理。默认单次最多64个release对象，最多256个；每个制品清单最多20000文件、2GiB。

历史候选必须具有该release目录下的 `recovery-receipt.json`，满足同一运行收据结构、匹配制品摘要，并明确 `evidence.recoveryVerified=true`。该标记只应在实际恢复条件和兼容性验证后生成，不能把“过去启动过”当作当前可恢复证明。历史未知对象继续保留并报告，不自动补造证明。

用户核对对象和摘要并明确确认后，才可执行 `node scripts/release-impact-deploy.mjs retention-apply --plan /absolute/task/retention-plan.json --confirmed-plan-sha256 <confirmed-sha256>`。工具获取共享部署锁，再次核对路由、当前收据、根目录身份、进程及待续发布引用，并完整审计全部待删制品；任一变化在首个删除前阻断。删除按历史时间从旧到新，只处理本次确认的可再生成制品。预计字节数与实际文件系统可用空间增量分开报告。本轮开发和部署不自动执行该删除命令。
