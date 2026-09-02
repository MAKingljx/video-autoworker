import { spawnSync } from 'node:child_process'
import {
  chmodSync,
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
    chmodSync(join(root, source), 0o500)
    const sourceIdentity = statSync(join(root, source), { bigint: true })
    const published = spawnSync('/usr/bin/python3', [
      '-I', '-S', '-c', helper, root, source, destination,
      String(sourceIdentity.dev), String(sourceIdentity.ino), String(sourceIdentity.uid),
      String(sourceIdentity.nlink),
    ], { encoding: 'utf8' })

    expect(published.status, published.stderr).toBe(0)
    expect(published.stderr).toBe('')
    expect(existsSync(join(root, source))).toBe(false)
    const destinationIdentity = statSync(join(root, destination), { bigint: true })
    expect(destinationIdentity.dev).toBe(sourceIdentity.dev)
    expect(destinationIdentity.ino).toBe(sourceIdentity.ino)
    expect(destinationIdentity.mode & BigInt(0o777)).toBe(BigInt(0o500))

    const blockedSource = 'pending-blocked'
    const occupiedDestination = 'published-occupied'
    mkdirSync(join(root, blockedSource))
    chmodSync(join(root, blockedSource), 0o500)
    mkdirSync(join(root, occupiedDestination))
    writeFileSync(join(root, occupiedDestination, 'sentinel'), 'keep\n')
    const blockedIdentity = statSync(join(root, blockedSource), { bigint: true })
    const blocked = spawnSync('/usr/bin/python3', [
      '-I', '-S', '-c', helper, root, blockedSource, occupiedDestination,
      String(blockedIdentity.dev), String(blockedIdentity.ino), String(blockedIdentity.uid),
      String(blockedIdentity.nlink),
    ], { encoding: 'utf8' })

    expect(blocked.status).toBe(82)
    expect(blocked.stderr.trim()).toMatch(/^errno=\d{1,5} strerror=[\p{L}\p{N} .,:'()_-]{1,120}$/u)
    expect(blocked.stderr).not.toContain(root)
    expect(blocked.stderr).not.toContain(blockedSource)
    expect(blocked.stderr).not.toContain(occupiedDestination)
    expect(existsSync(join(root, blockedSource))).toBe(true)
    expect(statSync(join(root, blockedSource)).mode & 0o777).toBe(0o500)
    expect(readFileSync(join(root, occupiedDestination, 'sentinel'), 'utf8')).toBe('keep\n')
  })

  it('rejects a stale source identity before opening the publish permission window', () => {
    const root = mkdtempSync(join(tmpdir(), 'exclusive-directory-rename-'))
    roots.push(root)
    const helper = embeddedExclusiveRenameHelper()
    const source = 'pending-source'
    const destination = 'published-destination'
    mkdirSync(join(root, source))
    chmodSync(join(root, source), 0o500)
    const identity = statSync(join(root, source), { bigint: true })

    const result = spawnSync('/usr/bin/python3', [
      '-I', '-S', '-c', helper, root, source, destination,
      String(identity.dev), String(identity.ino + BigInt(1)), String(identity.uid), String(identity.nlink),
    ], { encoding: 'utf8' })

    expect(result.status).toBe(82)
    expect(result.stderr.trim()).toMatch(/^errno=\d{1,5} strerror=[\p{L}\p{N} .,:'()_-]{1,120}$/u)
    expect(existsSync(join(root, source))).toBe(true)
    expect(existsSync(join(root, destination))).toBe(false)
    expect(statSync(join(root, source)).mode & 0o777).toBe(0o500)
  })
})
