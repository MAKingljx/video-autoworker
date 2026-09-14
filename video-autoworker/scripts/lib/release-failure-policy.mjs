import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function releaseFailurePolicy(value = 'assess-first') {
  if (!['assess-first', 'restore-previous'].includes(value)) throw new Error('release_failure_policy_invalid')
  return value
}

export function releaseFailureAssessment({ policy = 'assess-first', routeState = 'unknown', errorCode = 'release_acceptance_failed' } = {}) {
  const failurePolicy = releaseFailurePolicy(policy)
  if (!['original', 'committed', 'unknown'].includes(routeState)
    || !/^[a-z0-9][a-z0-9._:-]{0,100}$/u.test(errorCode)) throw new Error('release_failure_assessment_invalid')
  return { failurePolicy,
    currentState: routeState === 'committed' ? 'route_committed_unverified'
      : routeState === 'original' ? 'original_route_preserved' : 'state_unknown',
    errorCode, nextAction: failurePolicy === 'restore-previous' && routeState !== 'unknown'
      ? 'verify_previous_compatibility_then_restore' : 'resume_after_assessment',
    restorePrevious: failurePolicy === 'restore-previous' && routeState !== 'unknown',
    keepIntakeHold: true }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [policy, routeState, errorCode] = process.argv.slice(2)
    process.stdout.write(`${JSON.stringify(releaseFailureAssessment({ policy, routeState, errorCode }))}\n`)
  } catch {
    process.stderr.write('{"currentState":"state_unknown","errorCode":"release_failure_policy_invalid","nextAction":"inspect_failure_policy"}\n')
    process.exitCode = 1
  }
}
