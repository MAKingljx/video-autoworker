// @vitest-environment node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('legacy bootstrap SDK successor entry', () => {
  it('verifies the consumed successor before historical recovery logic and preserves historical tools', () => {
    const source = readFileSync(resolve(process.cwd(), 'scripts/deploy-blue-green.sh'), 'utf8')
    const start = source.indexOf('bootstrap_baseline() {')
    const end = source.indexOf('\nbind_slot() {', start)
    const body = source.slice(start, end)
    const successor = body.indexOf('successor_values="$(verify_bootstrap_sdk_successor)"')
    const sourceCommit = body.indexOf('source_commit="$(resolve_baseline_source_commit')
    const consume = body.indexOf('consume_bootstrap_sdk_successor')
    const firstMappingWrite = body.indexOf('write_json_atomic "$(binding_file "$slot")"', consume)
    const serviceStart = body.indexOf('"$manager" start "$slot"')

    expect(successor).toBeGreaterThan(0)
    expect(sourceCommit).toBeGreaterThan(successor)
    expect(consume).toBeGreaterThan(sourceCommit)
    expect(firstMappingWrite).toBeGreaterThan(consume)
    expect(serviceStart).toBeGreaterThan(sourceCommit)
    expect(body).toContain(
      'evidence_generator="$BOOTSTRAP_HISTORICAL_PROJECT_ROOT/scripts/generate-legacy-freeze-evidence.mjs"',
    )
    expect(body).toContain(
      'manager="$BOOTSTRAP_HISTORICAL_PROJECT_ROOT/scripts/manage-blue-green-services.sh"',
    )
    expect(body).toContain('publish_bootstrap_sdk_successor_completion "$source_commit"')
    expect(body).toContain('video-autoworker-legacy-bootstrap-sdk-target-mapping/v1')
    expect(body).toContain('requested:historical')
    expect(body).toContain('historical:requested')
    expect(body).toContain('assert_bootstrap_target_mapping_snapshot')
    expect(body).toContain('BOOTSTRAP_HISTORICAL_PENDING')
    expect(body).toContain('BOOTSTRAP_HISTORICAL_RUN_DIRECTORY')
  })

  it('publishes an explicit recovered result only after a complete deploy result exists', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'ops/recovery/run-legacy-bootstrap-sdk-successor.mjs'),
      'utf8',
    )
    const deploy = source.indexOf("execFileSync('/bin/bash'")
    const completion = source.indexOf('publishRecoveredResult(plan, deploy, env, true)', deploy)

    expect(deploy).toBeGreaterThan(0)
    expect(completion).toBeGreaterThan(deploy)
    expect(source).toContain('writeExclusive(resultPath, result, 0o600)')
    expect(source).toContain("[deploy, 'attest-current']")
    expect(source).toContain("'ops/recovery/run-legacy-bootstrap-sdk-successor.mjs', 0o755")
    expect(source).toContain("key.startsWith('AIWORKER_TEST_')")
    expect(source).toContain('fstatSync(descriptor, { bigint: true })')
    expect(source).toContain("schema: 'video-autoworker-legacy-release-recovery-result/v1'")
    expect(source).toContain('recovered: true')
    expect(source).toContain('sourceCommit: completion.sourceCommit')
    expect(source).toContain('historicalSourceCommit: plan.historical.commit')
    expect(source).not.toContain("controller, 'consume'")
  })
})
