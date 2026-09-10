# 首次部署的连续执行与自动续期

首次 legacy 迁移使用 `scripts/legacy-release-runner.mjs` 连续调用现有控制器。整条发布不设固定
30 分钟截止时间；每个实际命令仍有有界超时，保护窗口按下一阶段的命令预算续期。
runner 不替代 preinstall/bootstrap 的状态机，已签发收据、reservation、CAS 和 journal 仍是权威。

## 启动前

- 从实际生产目录确认源码、最终制品和 n8n transition 已准备完成；工作树保持最终提交且干净。
- n8n 必须已通过现有官方发布流程并取得同目标提交的 COMMITTED attestation。
- 旧 3017 保持在线，外部任务入口已受控暂停；本步骤不自动恢复先前停用的视频 lane。
- 所有计划、日志、owner/progress 和数据库备份放在 Git 外的当前用户私有目录，不进交付包。
- 先准备完整计划和 Aqua LaunchAgent，再启动 runner；不要先建立有时效的保护，然后跨聊天轮次执行命令。

计划文件为 0600 普通单链接 JSON。`controlRoot` 必须是受管 `maint/` 的尚不存在的直接子目录；
计划本身放在另一个已有私有目录，避免占用它。示例中的占位符必须替换为本次实际值：

```json
{
  "schema": "video-autoworker-legacy-release-plan/v1",
  "sourceCommit": "<final-40-hex-commit>",
  "controlRoot": "/Users/<user>/ai-worker/state/video-autoworker/maint/<unique-operation>",
  "releasesRoot": "/Users/<user>/ai-worker/services/video-autoworker-app/releases",
  "releaseId": "<final-40-hex-commit>-runtime",
  "releaseRoot": "/Users/<user>/ai-worker/services/video-autoworker-app/releases/<final-40-hex-commit>-runtime/standalone",
  "runDir": "/Users/<user>/ai-worker/state/video-autoworker/blue-green",
  "missionDb": "/Users/<user>/.mission-control-openclaw-profiles/mission-control.db",
  "n8nDb": "/Users/<user>/ai-worker/state/n8n/.n8n/database.sqlite",
  "transitionRoot": "/Users/<user>/ai-worker/state/video-autoworker/maint/<transition>/transition",
  "legacyPid": 12345,
  "sessionKeySha256": "<existing-inbound-session-key-sha256>"
}
```

不要把 session key 明文、Gateway token 或 SecretRef 解析值写入计划。runner 只在内存中匹配
既有 session key，经子进程环境提供给受管工具；基线采集和安装结束后释放该值。

## 执行

在已登录用户的 Aqua LaunchAgent 中运行以下唯一入口，以使用既有 Keychain/SecretRef 环境。
job 使用 `RunAtLoad=false`、`KeepAlive=false`、独立 0600 输出文件，`ProgramArguments` 按数组
传入 Node、脚本绝对路径、`run`、`--plan` 和计划路径。设置 `AbandonProcessGroup=true`，使
失败时需要保留的独立 guard 不会随一次性 runner 的进程组被自动清除。准备完后再 enable、
bootstrap 和 kickstart，不通过短命 SSH shell 手动逐步衔接。

```bash
node scripts/legacy-release-runner.mjs run --plan /absolute/private/plan.json
```

固定调用顺序是：guard → qwen start → 工具基线 → 阶段续期 → 安装前 proof/evidence →
统一 preinstall → 阶段续期 → 安装后 proof/evidence → bootstrap prepare/confirm/apply →
现有蓝绿 bootstrap → 全局 intake resume。新任务准入只在原有完整验收成功后恢复。

## 续期与失效

guard 的 `renew` 仅接受原私有 token、准确的当前 issuedAt/expiresAt、受管 runner 的真实
PID/启动身份/argv/源码摘要，以及严格递增的已完成进度收据。定时 heartbeat、重复进度和
已退出的 owner 不能续期。token 不进入 argv 或日志；现有一次性 bootstrap/current-confirm
凭据不续期或复用。

续期会更新本阶段的 guard 时间，因此原 proof/evidence 不能继续用于下一阶段。preinstall
只在无活动 reservation、尚未 finalize 的边界按需生成新证明，调用现有 controller renew
产生新 revision；初始 dry-run 耗时较长时也会在首次 prepare 前刷新已失效的证据。
不会原地修改旧证明或已签发收据。

租约到期后保留真实数据库 reservation，普通前进操作失败关闭；持有者完成有效工作后可
取得新的阶段租约。过期期间不得 handoff。`revoke` 仍是显式受控释放入口。

单个命令失败、超时或取消时，runner 先终止其进程组并暂停 qwen。只有仍处于首次 shutdown
之前、无 pending，且确认入口已停时才释放普通 dual guard。出现 shutdown receipt、
bootstrap pending 或 recovery-hold 时保留保护，交由已有恢复控制器处理，不把异常当成成功。
进度、脱敏错误及清理结果分别留在 `progress/`、`diagnostics/` 和 `failure-recovery.json`。

失败后禁止再次对同一 controlRoot 直接运行。先读取现有 controller 的阶段与收据，选择
其已有恢复或回滚入口；不要删除 pending、重放已完成组件或手工创建成功收据。
