# 导演脑 OpenClaw 安装与回滚

`scripts/install-aiworker-director-brain.sh` 只在明确指定的 OpenClaw profile 上安装三项内容：

- `aiworker-director-brain` tool-only 插件；
- 插件私有的飞书导演脑服务代码和无密钥 schema；
- 目标 agent workspace 中的 `aiworker-director-brain` Skill。

安装器同时只为目标 agent 授权 `aiworker_director_brain`，不提供全局授权。它不会复制 App Secret 或本地 catalog，不连接远端，不操作任务队列、n8n、素材或数据库，也不会重启 Gateway。剪辑、DaVinci、时间线、渲染和导出不在安装载荷或工具能力内。

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

## 安装

确认预检结果后，把 `--dry-run` 改为 `--apply`。有变化时，安装器先验证备份根必须为绝对、非宽泛、非 Git 工作树，且不得等于 state 或 workspace。允许使用 state 下专用的 `backups/aiworker-director-brain/` 子目录，但备份根不得位于受管目标内或包含受管源/目标，也不得与源码、Git 工作树或事务路径形成危险重叠；默认在该专用子目录创建 `0700` 回滚点。清单精确覆盖目录、普通文件、权限、文件摘要和成员集合。插件、Skill 与配置分别通过原子换名或硬链接激活，并由失败补偿恢复整体状态；三项并不是一个文件系统级原子事务。配置还绑定激活 inode，并在最终校验和提交完成前再次核对，防止同内容替换绕过检测。相同内容重复执行是无写入操作，不生成新备份。已有 `plugins.allow` 只保留原名单并追加导演脑插件，不会把原先排除的其他已启用插件重新放通。

安装完成不会自动重启 Gateway。后续应在独立受控步骤中重启目标 profile，并通过 `plugins inspect`、`tools.catalog` 和真实 `health` 调用验收；重启前还必须重新确认真实运行目录、目标 profile、监听端口和进程。生产安装与 Gateway 重启属于独立风险阶段，必须重新通过运行硬门。

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
