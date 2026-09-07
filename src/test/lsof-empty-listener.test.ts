import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('one-recovery empty-listener adapter', () => {
  const query = ['-tiTCP:3017', '-sTCP:LISTEN']
  it.each([
    { name: 'quiet no-match', args: query, status: 1, stdout: '', stderr: '', expected: 0 },
    { name: 'real listener', args: query, status: 0, stdout: '123\n456\n\n', stderr: '', expected: 0 },
    { name: 'partial PID result', args: query, status: 1, stdout: '123\n', stderr: '', expected: 1 },
    { name: 'native diagnostic', args: query, status: 1, stdout: '', stderr: 'permission denied\n\n', expected: 1 },
    { name: 'native error', args: query, status: 2, stdout: '', stderr: 'bad query\n', expected: 2 },
    { name: 'another port', args: ['-tiTCP:5678', '-sTCP:LISTEN'], status: 1, stdout: '', stderr: '', expected: 1 },
    { name: 'another argument order', args: [...query].reverse(), status: 1, stdout: '', stderr: '', expected: 1 },
    { name: 'additional arguments', args: [...query, '-nP'], status: 1, stdout: '', stderr: '', expected: 1 },
  ])('preserves the native contract for $name', ({ args, status, stdout, stderr, expected }) => {
    const root = mkdtempSync(join(tmpdir(), 'lsof-listener-adapter-'))
    try {
      const native = join(root, 'native-lsof')
      writeFileSync(native, '#!/bin/sh\nprintf "%s" "$NATIVE_STDOUT"\nprintf "%s" "$NATIVE_STDERR" >&2\nexit "$NATIVE_STATUS"\n')
      chmodSync(native, 0o700)
      const adapter = join(root, 'lsof')
      // Substitute only the test-owned native executable, retaining the full adapter.
      writeFileSync(adapter, readFileSync(resolve('ops/recovery/lsof-empty-listener.sh'), 'utf8')
        .replaceAll('/usr/sbin/lsof', native))
      chmodSync(adapter, 0o700)
      const result = spawnSync(adapter, args, {
        env: { ...process.env, NATIVE_STDOUT: stdout, NATIVE_STDERR: stderr, NATIVE_STATUS: String(status) },
        encoding: 'utf8', timeout: 5000,
      })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(expected)
      expect(result.stdout).toBe(stdout)
      expect(result.stderr).toBe(stderr)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
