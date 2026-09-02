import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'

const repositoryRoot = resolve(__dirname, '../..')
const script = join(repositoryRoot, 'scripts/reconcile-legacy-media-orphan.mjs')
const roots: string[] = []

function embeddedExclusiveRenameHelper(): string {
  const source = readFileSync(script, 'utf8')
  const match = source.match(/const EXCLUSIVE_RENAME_HELPER = (`[\s\S]*?`\.trim\(\))/u)
  expect(match).not.toBeNull()
  return String(runInNewContext(match?.[1] || "''"))
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('exclusive directory rename helper', () => {
  it('publishes atomically only when the destination is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'exclusive-directory-rename-'))
    roots.push(root)
    const helper = embeddedExclusiveRenameHelper()

    const source = 'pending-source'
    const destination = 'published-destination'
    mkdirSync(join(root, source))
    const sourceIdentity = statSync(join(root, source), { bigint: true })
    const published = spawnSync('/usr/bin/python3', [
      '-I', '-S', '-c', helper, root, source, destination,
    ], { encoding: 'utf8' })

    expect(published.status, published.stderr).toBe(0)
    expect(published.stderr).toBe('')
    expect(existsSync(join(root, source))).toBe(false)
    const destinationIdentity = statSync(join(root, destination), { bigint: true })
    expect(destinationIdentity.dev).toBe(sourceIdentity.dev)
    expect(destinationIdentity.ino).toBe(sourceIdentity.ino)

    const blockedSource = 'pending-blocked'
    const occupiedDestination = 'published-occupied'
    mkdirSync(join(root, blockedSource))
    mkdirSync(join(root, occupiedDestination))
    writeFileSync(join(root, occupiedDestination, 'sentinel'), 'keep\n')
    const blocked = spawnSync('/usr/bin/python3', [
      '-I', '-S', '-c', helper, root, blockedSource, occupiedDestination,
    ], { encoding: 'utf8' })

    expect(blocked.status).toBe(82)
    expect(blocked.stderr.trim()).toMatch(/^errno=\d{1,5} strerror=[\p{L}\p{N} .,:'()_-]{1,120}$/u)
    expect(blocked.stderr).not.toContain(root)
    expect(blocked.stderr).not.toContain(blockedSource)
    expect(blocked.stderr).not.toContain(occupiedDestination)
    expect(existsSync(join(root, blockedSource))).toBe(true)
    expect(readFileSync(join(root, occupiedDestination, 'sentinel'), 'utf8')).toBe('keep\n')
  })
})
