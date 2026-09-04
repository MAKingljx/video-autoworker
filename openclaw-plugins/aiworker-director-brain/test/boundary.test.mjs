import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(process.cwd(), 'openclaw-plugins/aiworker-director-brain')

describe('director brain static boundaries', () => {
  it('has no process, shell, scheduler, database, or task-chain adapter', async () => {
    const runtime = [
      await readFile(resolve(ROOT, 'index.js'), 'utf8'),
      await readFile(resolve(ROOT, 'lib/director-brain-tool.js'), 'utf8'),
      await readFile(resolve(ROOT, 'lib/director-system-question-router.js'), 'utf8'),
    ].join('\n')
    const contextSummary = await readFile(
      resolve(ROOT, 'lib/director-context-summary.js'),
      'utf8',
    )

    expect(runtime).not.toMatch(/node:child_process|execFile|spawn\(|launchctl/iu)
    expect(runtime).not.toMatch(/better-sqlite3|sqlite3|\.db\b/iu)
    expect(runtime).not.toMatch(/dispatchVideo|dispatchDirectory|submit-task|run-video-batch/iu)
    expect(runtime).not.toMatch(/registerHook/u)
    expect(runtime.match(/api\.on\(/gu)).toHaveLength(3)
    expect(runtime.match(/https?:\/\/[^'"\s]+/gu)).toEqual([
      'http://127.0.0.1:3017/api/n8n/director-extraction',
    ])
    expect(runtime).not.toMatch(/Authorization|Bearer|api.?key|password/iu)
    expect(runtime).not.toMatch(/appId|appToken|catalogPath|schemaPath/iu)
    expect(contextSummary).not.toMatch(
      /node:child_process|node:fs|node:http|node:https|fetch\(|execFile|spawn\(|\.db\b|launchctl/iu,
    )
    expect(contextSummary).not.toMatch(/registerHook|api\.on\(/u)
  })

  it('keeps the skill explicit about candidate and non-editing behavior', async () => {
    const skill = await readFile(resolve(
      process.cwd(),
      'openclaw-skills/aiworker-director-brain/SKILL.md',
    ), 'utf8')

    expect(skill).toContain('先用 `search`')
    expect(skill).toContain('先调用 `resolve_work`')
    expect(skill).toContain('这七类作品业务必须绑定唯一 `workId`')
    expect(skill).toContain('`skills_techniques` 是项目级跨作品全局知识')
    expect(skill).toContain('项目全局治理表 `system_blueprint` 和作品目录 `works` 的单表读操作不传 `workId`')
    expect(skill).toContain('`skills_techniques` 的 `get`/`search` 可不传 `workId`')
    expect(skill).toContain('需要只看某个来源作品时才传入该作品 `workId` 作为读取过滤')
    expect(skill).toContain('使用 `assemble`')
    expect(skill).toContain('`assemble` 是只读动作')
    expect(skill).toContain('`references.intentVersionId` 必须引用同一作品的一个已生效导演意图')
    expect(skill).toContain('只有用户明确要求')
    expect(skill).toContain('六层阶段：素材感知、人物理解、故事发现、导演判断、叙事结构、导演意图')
    expect(skill).toContain('`workflow` 不创建任务、不派发队列、不改状态、不自动重试')
    expect(skill).toContain('`start_extraction`、`extraction_status`、`backfill_extraction`')
    expect(skill).toContain('3017 loopback 共享应用服务的薄入口')
    expect(skill).toContain('不要要求用户提供任务号、提炼号或其他内部 ID')
    expect(skill).toContain('`awaiting_case_review`：导演案例待确认；确认后才能继续沉淀技法')
    expect(skill).toContain('不自行重试或改走其他数据源')
    expect(skill).toContain('依据不足')
    expect(skill).toContain('新记录只是草稿或候选')
    expect(skill).toContain('稳定业务 ID、项目 ID、作品 ID、版本、候选状态、来源、更新时间及表内引用字段由服务生成')
    expect(skill).toContain('允许提交候选的表及最小内容如下')
    expect(skill).toContain('`system_blueprint` 与 `material_evidence` 始终只读')
    expect(skill).toContain('这里的“时间线”是故事发生顺序，不是剪辑软件时间线')
    expect(skill).toContain('不得批准、拒绝、合并、删除')
    expect(skill).toContain('除 `skills_techniques` 按已确认案例聚合全局技法外，不得跨作品')
    expect(skill).toContain('必须在 `references.caseIds` 引用至少一个已确认导演案例')
    expect(skill).toContain('提交时不传 `workId`，由服务根据案例链自动推导')
    expect(skill).toContain('不得调用或设计剪辑、DaVinci、时间线、渲染、导出能力')
    expect(skill).toContain('不得使用 `exec`、SQLite、n8n、聊天记录、媒体目录或旧素材库')
  })
})
