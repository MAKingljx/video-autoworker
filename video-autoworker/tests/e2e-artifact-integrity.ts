import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

function sha256(pathname: string): string {
  return createHash('sha256').update(readFileSync(pathname)).digest('hex')
}

export default function preserveStandaloneArtifact() {
  const root = resolve(process.cwd(), '.next/standalone')
  const manifest = resolve(root, 'release-manifest.json')
  if (!existsSync(resolve(root, 'server.js')) || !existsSync(manifest)) return undefined

  const originalManifestSha256 = sha256(manifest)

  return () => {
    const forbiddenEnvironmentFiles = readdirSync(root)
      .filter((name) => name === '.env' || name.startsWith('.env.'))
    if (forbiddenEnvironmentFiles.length > 0) {
      throw new Error('E2E polluted the immutable standalone artifact with an environment file')
    }
    if (sha256(manifest) !== originalManifestSha256) {
      throw new Error('E2E changed the immutable standalone release manifest digest')
    }

    const audit = spawnSync(
      process.execPath,
      [resolve(process.cwd(), 'scripts/check-standalone-artifact.mjs'), root],
      { cwd: process.cwd(), encoding: 'utf8' },
    )
    if (audit.status !== 0) {
      throw new Error(`E2E changed immutable standalone content: ${audit.stderr.trim()}`)
    }
  }
}
