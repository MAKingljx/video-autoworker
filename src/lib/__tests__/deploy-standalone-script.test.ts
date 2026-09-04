import { execFile, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

async function exists(pathname: string) {
  return access(pathname).then(() => true, () => false)
}

async function freeTcpPort() {
  const server = createServer()
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('free_port_unavailable')
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.close(error => error ? rejectPromise(error) : resolvePromise())
  })
  return address.port
}

describe('standalone deployment script', () => {
  const script = readFileSync(resolve(process.cwd(), 'scripts/deploy-standalone.sh'), 'utf8')

  it('stays compatible with the Bash 3.2 bundled with macOS', () => {
    expect(script).not.toContain('declare -A')
    expect(script).not.toContain('IGNORECASE=1')
    expect(script).toContain('case " $seen_pids " in')
    expect(script).toContain('CI="${CI:-true}" pnpm install --frozen-lockfile')
    expect(script).toContain('curl -fsSL "http://$VERIFY_HOST:$PORT/login"')
    expect(script).toContain('tolower($1) == "content-type:"')
    expect(script).toContain('trap cleanup_failed_new_server EXIT')
    expect(script).toContain('stop_pid "$new_pid" "failed standalone candidate"')
    expect(script).toContain('if [[ "$recorded_pid" == "$new_pid" ]]')
    expect(script).toContain('deployment_verified=1')
    expect(script).toContain('trap - EXIT')
  })

  it('keeps runtime state and the PID outside the rebuilt release by default', () => {
    expect(script).toContain('SOURCE_DATA_DIR="$PROJECT_ROOT/.data"')
    expect(script).toContain('SOURCE_RUN_DIR="$PROJECT_ROOT/.run"')
    expect(script).toContain('PID_FILE="${PID_FILE:-$AIWORKER_RUN_DIR/standalone.pid}"')
    expect(script).not.toContain('.next/standalone/server.pid')
  })

  it.each([
    'MISSION_CONTROL_DATA_DIR',
    'MISSION_CONTROL_DB_PATH',
    'MISSION_CONTROL_TOKENS_PATH',
    'PID_FILE',
  ])('validates the physical deployment boundary for %s', (variable) => {
    expect(script).toContain(
      `assert_runtime_path_outside_standalone "${variable}" "$${variable}"`
    )
  })

  it('revalidates paths after the release rebuild and writes the PID atomically', () => {
    const rebuildIndex = script.indexOf('pnpm build')
    const postBuildValidationIndex = script.indexOf('configure_runtime_paths', rebuildIndex)

    expect(rebuildIndex).toBeGreaterThan(0)
    expect(postBuildValidationIndex).toBeGreaterThan(rebuildIndex)
    expect(script).toContain('pid_tmp="$PID_FILE.tmp.$$"')
    expect(script).toContain('chmod 600 "$pid_tmp"')
    expect(script).toContain('mv "$pid_tmp" "$PID_FILE"')
  })

  it('migrates the fallback database to the configured DB path or fails closed on sidecars', () => {
    expect(script).toContain(
      '[[ -e "${source_db}-wal" || -e "${source_db}-shm" || -e "${source_db}-journal" ]]'
    )
    expect(script).toContain(
      'error: sqlite3 is required to migrate an active SQLite database with sidecar files'
    )
    expect(script).toContain('local target_db_tmp="$target_db.migration.$$"')
    expect(script).toContain('cp -p "$source_db" "$target_db_tmp"')
    expect(script).toContain('mv "$target_db_tmp" "$target_db"')
    expect(script).not.toContain('"$SOURCE_DATA_DIR"/ "$target_data_dir"/')
  })

  it('stops the old server before migration and builds only after migration succeeds', () => {
    const stopIndex = script.indexOf('\nstop_existing_server\n')
    const migrationIndex = script.indexOf('\nif migrate_runtime_data_dir; then\n')
    const migrationExitIndex = script.indexOf('\n  exit "$migration_status"\n')
    const installIndex = script.indexOf('\nCI="${CI:-true}" pnpm install --frozen-lockfile\n')
    const buildIndex = script.indexOf('\npnpm build\n')

    expect(stopIndex).toBeGreaterThan(0)
    expect(migrationIndex).toBeGreaterThan(stopIndex)
    expect(migrationExitIndex).toBeGreaterThan(migrationIndex)
    expect(installIndex).toBeGreaterThan(migrationExitIndex)
    expect(buildIndex).toBeGreaterThan(installIndex)
  })

  it('retains the independent recovery snapshot until the new service is fully verified', () => {
    const trapIndex = script.indexOf('\ntrap cleanup_failed_new_server EXIT\n')
    const stopIndex = script.indexOf('\nstop_existing_server\n')
    const verifiedIndex = script.indexOf('\ndeployment_verified=1\n')
    const cleanupIndex = script.indexOf('\ncleanup_recovery_bundle\n', verifiedIndex)
    const clearTrapIndex = script.indexOf('\ntrap - EXIT\n', verifiedIndex)

    expect(script).toContain('cp -pR "$standalone_root" "$RECOVERY_STANDALONE_ROOT"')
    expect(script).toContain('auditor_closure_is_safe "$RECOVERY_WORK_ROOT"')
    expect(script).toContain('install -m 600 "$current_sensitive_scanner"')
    expect(script).toContain('install -m 600 "$current_value_scanner"')
    expect(script).toContain('install -m 600 "$current_provenance"')
    expect(script).toContain('if ! restart_old_server_after_migration_failure; then')
    expect(script).toContain('if [[ "$old_server_was_running" != 1 ]]; then')
    expect(script).toContain('preserved recovery release at $RECOVERY_WORK_ROOT')
    expect(trapIndex).toBeGreaterThan(0)
    expect(trapIndex).toBeLessThan(stopIndex)
    expect(cleanupIndex).toBeGreaterThan(verifiedIndex)
    expect(clearTrapIndex).toBeGreaterThan(cleanupIndex)
  })

  it('rejects an incomplete recovery auditor closure before executing the auditor', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'deploy-standalone-recovery-closure-'))
    try {
      const scriptsDir = resolve(root, 'scripts')
      const recoveryRoot = resolve(root, 'recovery')
      const standaloneRoot = resolve(recoveryRoot, 'standalone')
      const marker = resolve(root, 'auditor-ran')
      const harness = resolve(scriptsDir, 'deploy-standalone.sh')
      await mkdir(resolve(standaloneRoot, '.next'), { recursive: true })
      await mkdir(resolve(recoveryRoot, 'lib'), { recursive: true })
      await mkdir(scriptsDir, { recursive: true })
      await writeFile(resolve(standaloneRoot, 'server.js'), 'process.exit(0)\n')
      await writeFile(resolve(standaloneRoot, '.next/BUILD_ID'), 'build\n')
      await writeFile(resolve(recoveryRoot, 'start-preserved-release.sh'), '#!/bin/bash\n', {
        mode: 0o700,
      })
      await writeFile(resolve(recoveryRoot, 'check-standalone-artifact.mjs'), `
import { writeFileSync } from 'node:fs'
writeFileSync(process.env.AUDITOR_MARKER, 'ran')
`)
      await writeFile(resolve(recoveryRoot, 'lib/sensitive-value-scanner.mjs'), 'export {}\n')
      await writeFile(
        resolve(recoveryRoot, 'lib/director-extraction-release-provenance.mjs'),
        'export {}\n',
      )

      const functionPrelude = script.slice(0, script.indexOf('\ncd "$PROJECT_ROOT"'))
      await writeFile(harness, `${functionPrelude}
RECOVERY_WORK_ROOT="${recoveryRoot}"
RECOVERY_LAUNCHER="$RECOVERY_WORK_ROOT/start-preserved-release.sh"
RECOVERY_AUDITOR="$RECOVERY_WORK_ROOT/check-standalone-artifact.mjs"
RECOVERY_STANDALONE_ROOT="$RECOVERY_WORK_ROOT/standalone"
RECOVERY_SERVER_SHA256="$(file_sha256 "$RECOVERY_STANDALONE_ROOT/server.js")"
RECOVERY_BUILD_ID_SHA256="$(file_sha256 "$RECOVERY_STANDALONE_ROOT/.next/BUILD_ID")"
RECOVERY_READY=1
verify_recovery_release_identity
`)

      const failure = await execFileAsync('bash', [harness], {
        env: { ...process.env, AUDITOR_MARKER: marker },
      }).then(() => null, error => error as Error & { code?: number })
      expect(failure?.code).not.toBe(0)
      expect(await exists(marker)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not signal a reused or malformed PID that is not the verified old release', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'deploy-standalone-pid-identity-'))
    const sleeper = spawn('/bin/sleep', ['30'])
    try {
      const scriptsDir = resolve(root, 'scripts')
      const runDir = resolve(root, '.run')
      const harness = resolve(scriptsDir, 'deploy-standalone.sh')
      const pidPath = resolve(runDir, 'standalone.pid')
      await mkdir(scriptsDir)
      await mkdir(runDir)
      await writeFile(pidPath, `${sleeper.pid}\n`)
      const functionPrelude = script.slice(0, script.indexOf('\ncd "$PROJECT_ROOT"'))
      await writeFile(harness, `${functionPrelude}
PID_FILE="${pidPath}"
list_listener_pids() { return 0; }
pgrep() { printf '%s\\n' "$UNRELATED_PID" '-9' '0' 'not-a-pid'; }
stop_existing_server
`)

      await execFileAsync('bash', [harness], {
        env: { ...process.env, BRANCH: 'test', UNRELATED_PID: String(sleeper.pid) },
      })

      expect(() => process.kill(sleeper.pid!, 0)).not.toThrow()
      expect(await exists(pidPath)).toBe(false)
      expect(script).toContain('[[ "$1" =~ ^[1-9][0-9]*$ ]]')
      expect(script).toContain('kill -- "$pid"')
      expect(script).toContain('kill -9 -- "$pid"')
      expect(script).toContain('process_cwd_is "$pid" "$PROJECT_ROOT/.next/standalone"')
      expect(script).toContain('original_release_matches_recovery')
    } finally {
      if (sleeper.pid) {
        try { process.kill(sleeper.pid, 'SIGTERM') } catch { /* already stopped */ }
      }
      await rm(root, { recursive: true, force: true })
    }
  })

  it('restores the preserved release with the old process actual external runtime bindings', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'deploy-standalone-restart-old-'))
    let restoredPid: number | null = null
    let originalPid: number | null = null
    try {
      const scriptsDir = resolve(root, 'scripts')
      const standaloneRoot = resolve(root, '.next/standalone')
      const sourceDataDir = resolve(root, '.data')
      const externalDataDir = resolve(root, 'external-data')
      const targetDataDir = resolve(root, 'target-data')
      const runDir = resolve(root, '.run')
      const harness = resolve(scriptsDir, 'deploy-standalone.sh')
      const auditor = resolve(scriptsDir, 'check-standalone-artifact.mjs')
      const capturePath = resolve(root, 'opened-runtime.json')
      const pidPath = resolve(runDir, 'standalone.pid')
      const sourceDb = resolve(sourceDataDir, 'mission-control.db')
      const externalDb = resolve(externalDataDir, 'production.sqlite')
      const externalTokens = resolve(externalDataDir, 'production-tokens.json')
      const port = await freeTcpPort()
      const runtimeEnv = {
        ...process.env,
        BRANCH: 'test',
        PORT: String(port),
        VERIFY_HOST: '127.0.0.1',
        MC_HOSTNAME: '127.0.0.1',
        CAPTURE_PATH: capturePath,
        AIWORKER_RUN_DIR: runDir,
        PID_FILE: pidPath,
        MISSION_CONTROL_DATA_DIR: targetDataDir,
        MISSION_CONTROL_DB_PATH: resolve(targetDataDir, 'wrong.sqlite'),
        MISSION_CONTROL_TOKENS_PATH: resolve(targetDataDir, 'wrong-tokens.json'),
      }
      await mkdir(resolve(standaloneRoot, '.next'), { recursive: true })
      await mkdir(sourceDataDir)
      await mkdir(externalDataDir)
      await mkdir(runDir)
      await mkdir(resolve(scriptsDir, 'lib'), { recursive: true })
      await writeFile(sourceDb, 'source database\n')
      await writeFile(resolve(sourceDataDir, 'mission-control-tokens.json'), '{"source":true}\n')
      await writeFile(externalDb, 'external production database\n')
      await writeFile(externalTokens, '{"external":true}\n')
      await writeFile(resolve(standaloneRoot, '.next/BUILD_ID'), 'preserved-build\n')
      await writeFile(auditor, `
import { accessSync } from 'node:fs'
import { resolve } from 'node:path'
accessSync(resolve(process.argv[2], 'server.js'))
accessSync(resolve(process.argv[2], '.next/BUILD_ID'))
`)
      await writeFile(resolve(scriptsDir, 'check-sensitive-content.mjs'), 'export {}\n')
      await writeFile(resolve(scriptsDir, 'lib/sensitive-value-scanner.mjs'), 'export {}\n')
      await writeFile(
        resolve(scriptsDir, 'lib/director-extraction-release-provenance.mjs'),
        'export {}\n',
      )
      await writeFile(resolve(standaloneRoot, 'server.js'), `
const fs = require('node:fs')
const http = require('node:http')
const databaseHandle = fs.openSync(process.env.MISSION_CONTROL_DB_PATH, 'r')
fs.writeFileSync(process.env.CAPTURE_PATH, JSON.stringify({
  dbPath: process.env.MISSION_CONTROL_DB_PATH,
  tokensPath: process.env.MISSION_CONTROL_TOKENS_PATH,
  cwd: process.cwd(),
}) + '\\n')
const server = http.createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' })
  response.end('<html>preserved release</html>')
})
server.listen(Number(process.env.PORT), process.env.HOSTNAME)
process.on('SIGTERM', () => server.close(() => {
  fs.closeSync(databaseHandle)
  process.exit(0)
}))
`)

      const originalServer = spawn(process.execPath, ['server.js'], {
        cwd: standaloneRoot,
        env: {
          ...runtimeEnv,
          MISSION_CONTROL_DATA_DIR: externalDataDir,
          MISSION_CONTROL_DB_PATH: externalDb,
          MISSION_CONTROL_TOKENS_PATH: externalTokens,
        },
        stdio: 'ignore',
      })
      originalPid = originalServer.pid ?? null
      expect(originalPid).toBeGreaterThan(0)
      await writeFile(pidPath, `${originalPid}\n`)
      let originalReady = false
      for (let attempt = 0; attempt < 200; attempt += 1) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/login`)
          if (response.ok) {
            originalReady = true
            break
          }
        } catch { /* not listening yet */ }
        await new Promise((resolveWait) => setTimeout(resolveWait, 10))
      }
      expect(originalReady).toBe(true)

      const functionPrelude = script.slice(0, script.indexOf('\ncd "$PROJECT_ROOT"'))
      await writeFile(harness, `${functionPrelude}
configure_runtime_paths
prepare_existing_server_recovery
stop_existing_server
printf '%s\\n' 'process.exit(99)' > "$PROJECT_ROOT/scripts/check-standalone-artifact.mjs"
rm -rf "$PROJECT_ROOT/.next"
trap cleanup_failed_new_server EXIT
exit 86
`)

      const deployFailure = await execFileAsync('bash', [harness], {
        env: runtimeEnv,
      }).then(() => null, error => error as Error & { code?: number, stderr?: string })
      expect(deployFailure?.stderr).toBe('')
      expect(deployFailure?.code).toBe(86)

      const physicalRoot = await realpath(root)
      const openedRuntime = JSON.parse(await readFile(capturePath, 'utf8'))
      expect(openedRuntime).toMatchObject({
        dbPath: externalDb,
        tokensPath: externalTokens,
      })
      originalPid = null
      expect(openedRuntime.cwd).toMatch(new RegExp(
        `^${resolve(physicalRoot, '.run/.deploy-recovery.').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}[^/]+/standalone$`,
        'u',
      ))
      expect(openedRuntime.cwd).not.toBe(resolve(physicalRoot, '.next/standalone'))
      expect(await exists(openedRuntime.cwd)).toBe(true)
      expect(await exists(resolve(root, '.next'))).toBe(false)
      restoredPid = Number((await readFile(pidPath, 'utf8')).trim())
      expect(restoredPid).toBeGreaterThan(0)

      const redeployHarness = resolve(scriptsDir, 'redeploy-harness.sh')
      await writeFile(redeployHarness, `${functionPrelude}
configure_runtime_paths
prepare_existing_server_recovery
process_is_expected_old_server "$EXPECTED_PID"
stop_existing_server
`)
      await execFileAsync('bash', [redeployHarness], {
        env: { ...runtimeEnv, EXPECTED_PID: String(restoredPid) },
      })
      expect(await exists(pidPath)).toBe(false)
      restoredPid = null
    } finally {
      if (originalPid) {
        try { process.kill(originalPid, 'SIGTERM') } catch { /* already stopped */ }
      }
      if (restoredPid) {
        try { process.kill(restoredPid, 'SIGTERM') } catch { /* already stopped */ }
      }
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it('rejects a new listener whose effective runtime data binding overrides the deployment target', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'deploy-standalone-new-runtime-identity-'))
    let candidatePid: number | null = null
    try {
      const scriptsDir = resolve(root, 'scripts')
      const standaloneRoot = resolve(root, '.next/standalone')
      const expectedDataDir = resolve(root, 'expected-data')
      const overriddenDataDir = resolve(root, 'platform-data')
      const expectedDb = resolve(expectedDataDir, 'expected.sqlite')
      const overriddenDb = resolve(overriddenDataDir, 'overridden.sqlite')
      const expectedTokens = resolve(expectedDataDir, 'expected-tokens.json')
      const overriddenTokens = resolve(overriddenDataDir, 'overridden-tokens.json')
      const harness = resolve(scriptsDir, 'deploy-standalone.sh')
      const auditor = resolve(scriptsDir, 'check-standalone-artifact.mjs')
      const port = await freeTcpPort()
      await mkdir(resolve(standaloneRoot, '.next'), { recursive: true })
      await mkdir(expectedDataDir)
      await mkdir(overriddenDataDir)
      await mkdir(scriptsDir, { recursive: true })
      await writeFile(expectedDb, 'expected database\n')
      await writeFile(overriddenDb, 'platform database\n')
      await writeFile(expectedTokens, '{"expected":true}\n')
      await writeFile(overriddenTokens, '{"overridden":true}\n')
      await writeFile(resolve(standaloneRoot, '.next/BUILD_ID'), 'candidate-build\n')
      await writeFile(auditor, `
import { accessSync } from 'node:fs'
import { resolve } from 'node:path'
accessSync(resolve(process.argv[2], 'server.js'))
accessSync(resolve(process.argv[2], '.next/BUILD_ID'))
`)
      await writeFile(resolve(standaloneRoot, 'server.js'), `
const fs = require('node:fs')
const http = require('node:http')
const databaseHandle = fs.openSync(process.env.MISSION_CONTROL_DB_PATH, 'r')
const server = http.createServer((_request, response) => response.end('ok'))
server.listen(Number(process.env.PORT), process.env.HOSTNAME)
process.on('SIGTERM', () => server.close(() => {
  fs.closeSync(databaseHandle)
  process.exit(0)
}))
`)

      const candidate = spawn(process.execPath, ['server.js'], {
        cwd: standaloneRoot,
        env: {
          ...process.env,
          PORT: String(port),
          HOSTNAME: '127.0.0.1',
          MISSION_CONTROL_DATA_DIR: overriddenDataDir,
          MISSION_CONTROL_DB_PATH: overriddenDb,
          MISSION_CONTROL_TOKENS_PATH: overriddenTokens,
        },
        stdio: 'ignore',
      })
      candidatePid = candidate.pid ?? null
      expect(candidatePid).toBeGreaterThan(0)
      let candidateReady = false
      for (let attempt = 0; attempt < 200; attempt += 1) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/login`)
          if (response.ok) {
            candidateReady = true
            break
          }
        } catch { /* not listening yet */ }
        await new Promise((resolveWait) => setTimeout(resolveWait, 10))
      }
      expect(candidateReady).toBe(true)

      const functionPrelude = script.slice(0, script.indexOf('\ncd "$PROJECT_ROOT"'))
      await writeFile(harness, `${functionPrelude}
configure_runtime_paths
verify_new_runtime_identity "$EXPECTED_PID"
`)
      await expect(execFileAsync('bash', [harness], {
        env: {
          ...process.env,
          BRANCH: 'test',
          PORT: String(port),
          MISSION_CONTROL_DATA_DIR: expectedDataDir,
          MISSION_CONTROL_DB_PATH: expectedDb,
          MISSION_CONTROL_TOKENS_PATH: expectedTokens,
          EXPECTED_PID: String(candidatePid),
        },
      })).rejects.toMatchObject({ code: expect.any(Number) })

      expect(script).toContain('process_cwd_is "$pid" "$PROJECT_ROOT/.next/standalone"')
      expect(script).toContain('process_executable_is_node "$pid"')
      expect(script).toContain('process_has_open_path "$pid" "$MISSION_CONTROL_DB_PATH"')
    } finally {
      if (candidatePid) {
        try { process.kill(candidatePid, 'SIGTERM') } catch { /* already stopped */ }
      }
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it.each([
    'sqlite',
    'database-copy',
    'token-copy',
    'backup-copy',
    'database-move-reported-failed',
  ])('propagates %s migration failure from an if condition without leaving a target DB', async (failure) => {
    const root = await mkdtemp(resolve(tmpdir(), 'deploy-standalone-migration-failure-'))
    try {
      const scriptsDir = resolve(root, 'scripts')
      const sourceDataDir = resolve(root, '.data')
      const targetDataDir = resolve(root, 'runtime-data')
      const targetDb = resolve(root, 'custom', 'runtime.sqlite')
      const targetTokens = resolve(targetDataDir, 'tokens.json')
      const harness = resolve(scriptsDir, 'deploy-standalone.sh')
      await mkdir(scriptsDir)
      await mkdir(resolve(sourceDataDir, 'backups'), { recursive: true })
      await writeFile(resolve(sourceDataDir, 'mission-control.db'), 'database snapshot\n')
      await writeFile(resolve(sourceDataDir, 'mission-control-tokens.json'), '{"token":true}\n')
      await writeFile(resolve(sourceDataDir, 'backups/known-good.db'), 'backup\n')

      const functionPrelude = script.slice(0, script.indexOf('\ncd "$PROJECT_ROOT"'))
        .replace(
          'if command -v sqlite3 >/dev/null 2>&1; then',
          'if [[ "$FAIL_STAGE" == "sqlite" ]]; then',
        )
      await writeFile(harness, `${functionPrelude}
sqlite3() { return 71; }
cp() {
  case "$FAIL_STAGE:$*" in
    database-copy:*mission-control.db*migration.*) return 72 ;;
    token-copy:*mission-control-tokens.json*) return 73 ;;
    backup-copy:*backups*) return 74 ;;
  esac
  command cp "$@"
}
mv() {
  if [[ "$FAIL_STAGE" == "database-move-reported-failed" && "$1" == *runtime.sqlite.migration.* ]]; then
    command mv "$@"
    return 75
  fi
  command mv "$@"
}
configure_runtime_paths
if migrate_runtime_data_dir; then
  exit 0
else
  exit $?
fi
`)

      await expect(execFileAsync('bash', [harness], {
        env: {
          ...process.env,
          BRANCH: 'test',
          FAIL_STAGE: failure,
          MISSION_CONTROL_DATA_DIR: targetDataDir,
          MISSION_CONTROL_DB_PATH: targetDb,
          MISSION_CONTROL_TOKENS_PATH: targetTokens,
        },
      })).rejects.toMatchObject({ code: expect.any(Number) })

      expect(await exists(targetDb)).toBe(false)
      const targetParentEntries = await exists(resolve(root, 'custom'))
        ? await readdir(resolve(root, 'custom'))
        : []
      expect(targetParentEntries.some(name => name.includes('.migration.'))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('copies the no-sqlite fallback database to MISSION_CONTROL_DB_PATH', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'deploy-standalone-fallback-'))
    try {
      const scriptsDir = resolve(root, 'scripts')
      const sourceDataDir = resolve(root, '.data')
      const targetDataDir = resolve(root, 'runtime-data')
      const targetDb = resolve(root, 'custom', 'runtime.sqlite')
      const harness = resolve(scriptsDir, 'deploy-standalone.sh')
      await mkdir(scriptsDir)
      await mkdir(sourceDataDir)
      await writeFile(resolve(sourceDataDir, 'mission-control.db'), 'database snapshot\n')

      const functionPrelude = script.slice(0, script.indexOf('\ncd "$PROJECT_ROOT"'))
        .replace('if command -v sqlite3 >/dev/null 2>&1; then', 'if false; then')
      await writeFile(harness, `${functionPrelude}\nconfigure_runtime_paths\nmigrate_runtime_data_dir\n`)

      await execFileAsync('bash', [harness], {
        env: {
          ...process.env,
          BRANCH: 'test',
          MISSION_CONTROL_DATA_DIR: targetDataDir,
          MISSION_CONTROL_DB_PATH: targetDb,
          MISSION_CONTROL_TOKENS_PATH: resolve(targetDataDir, 'tokens.json'),
        },
      })

      expect(await readFile(targetDb, 'utf8')).toBe('database snapshot\n')
      expect(await exists(resolve(targetDataDir, 'mission-control.db'))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails the no-sqlite fallback before copying a database with WAL state', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'deploy-standalone-wal-'))
    try {
      const scriptsDir = resolve(root, 'scripts')
      const sourceDataDir = resolve(root, '.data')
      const targetDataDir = resolve(root, 'runtime-data')
      const targetDb = resolve(root, 'custom', 'runtime.sqlite')
      const harness = resolve(scriptsDir, 'deploy-standalone.sh')
      await mkdir(scriptsDir)
      await mkdir(sourceDataDir)
      await writeFile(resolve(sourceDataDir, 'mission-control.db'), 'stale main database\n')
      await writeFile(resolve(sourceDataDir, 'mission-control.db-wal'), 'uncheckpointed transaction\n')

      const functionPrelude = script.slice(0, script.indexOf('\ncd "$PROJECT_ROOT"'))
        .replace('if command -v sqlite3 >/dev/null 2>&1; then', 'if false; then')
      await writeFile(harness, `${functionPrelude}\nconfigure_runtime_paths\nmigrate_runtime_data_dir\n`)

      await expect(execFileAsync('bash', [harness], {
        env: {
          ...process.env,
          BRANCH: 'test',
          MISSION_CONTROL_DATA_DIR: targetDataDir,
          MISSION_CONTROL_DB_PATH: targetDb,
          MISSION_CONTROL_TOKENS_PATH: resolve(targetDataDir, 'tokens.json'),
        },
      })).rejects.toThrow(/sqlite3 is required/u)
      expect(await exists(targetDb)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
