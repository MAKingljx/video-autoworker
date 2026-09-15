import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const run = promisify(execFile)
const runnerUrl = pathToFileURL(resolve('openclaw-plugins/aiworker-video-command/lib/scheduler-runner.js')).href
const reportsUrl = pathToFileURL(resolve('openclaw-skills/aiworker-task-flow/lib/video-segment-report.mjs')).href

describe('controlled export validation with real artifacts', () => {
  it.each(['docx', 'markdown'])('verifies a real %s file and rejects changed or redirected content', async format => {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'aiworker-export-reader-'))
    try {
      const script = `
        import { createSchedulerRunner } from ${JSON.stringify(runnerUrl)};
        import { selectVideoSegmentReport, exportVideoSegmentReport } from ${JSON.stringify(reportsUrl)};
        import { writeFile, rename, symlink } from 'node:fs/promises';
        const taskId = 'video-natural-' + 'a'.repeat(64);
        const report = selectVideoSegmentReport({ segmentSummaries: [{ index: 1, startTime: '00:00:00', endTime: '00:01:00', summary: '项目片段摘要' }] });
        const artifact = await exportVideoSegmentReport(report, { taskId, name: 'S03E03.mp4', format: ${JSON.stringify(format)} });
        const response = { kind: 'artifact', taskId, name: 'S03E03.mp4', status: 'succeeded', artifact };
        const runner = createSchedulerRunner({ scriptPath: '/installed/task.mjs', execute: async () => ({ stdout: JSON.stringify(response) }) });
        const request = { query: taskId, view: 'export', exportFormat: ${JSON.stringify(format)} };
        const accepted = await runner.taskResult(request);
        const output = { accepted: accepted.artifact.sha256 === artifact.sha256, metadataOnly: !('text' in accepted.artifact) };
        await writeFile(artifact.path, Buffer.alloc(artifact.bytes, 0));
        try { await runner.taskResult(request); output.corruptRejected = false; } catch { output.corruptRejected = true; }
        await rename(artifact.path, artifact.path + '.old');
        await symlink(artifact.path + '.old', artifact.path);
        try { await runner.taskResult(request); output.symlinkRejected = false; } catch { output.symlinkRejected = true; }
        console.log(JSON.stringify(output));
      `
      const result = await run(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, HOME: root }, timeout: 15000 })
      expect(JSON.parse(result.stdout)).toEqual({ accepted: true, metadataOnly: true, corruptRejected: true, symlinkRejected: true })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
