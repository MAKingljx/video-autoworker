import { execFile } from 'node:child_process'
import { cp, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const PLUGIN_PATH = 'openclaw-plugins/aiworker-video-command'

export const V03_SOURCE_SHA = '3c385f19308b4d36cf624d3c95a20cc65acaf903'
export const V04_SOURCE_SHA = 'db3632713b54be5e8797ff2d85ab91ebccd134f5'
export const V041_SOURCE_SHA = 'e615d8dc68d089f11afe1581c1f56c614e01b796'

export async function materializeHistoricalPlugin(destination, commit = V03_SOURCE_SHA) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'video-command-history-')))
  const archive = join(root, 'plugin.tar')
  try {
    await execFileAsync('git', [
      '-C', process.cwd(), 'archive', '--format=tar', '--output', archive, commit, PLUGIN_PATH,
    ])
    await execFileAsync('tar', ['-xf', archive, '-C', root])
    await cp(join(root, PLUGIN_PATH), destination, { recursive: true })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
