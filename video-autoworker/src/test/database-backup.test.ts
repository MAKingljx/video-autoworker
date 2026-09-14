// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { it, expect } from 'vitest'

it('verifies consistent WAL backups, isolated restore, retention and corruption protection', () => {
  const script = fileURLToPath(new URL('../../scripts/test-database-backup.py', import.meta.url))
  expect(() => execFileSync('python3', ['-B', script], { encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })).not.toThrow()
})
