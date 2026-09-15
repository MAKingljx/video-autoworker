import { execFileSync } from 'node:child_process'
import { assertCleanGitSource, gitSourceEnvironment } from './git-source-layout.mjs'

function fail(code) { throw new Error(`git_source_layout_${code}`) }
function git(root, args, options = {}) {
  try { return execFileSync('/usr/bin/git', ['-C', root, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: gitSourceEnvironment(),
  }) } catch { fail(options.errorCode || 'git_command_failed') }
}

/** Clean release source may be main or a pinned commit on canonical origin/main. */
export function assertCanonicalMainlineGitSource(productRoot, expectedCommit = null) {
  const layout = assertCleanGitSource(productRoot, expectedCommit)
  const remote = git(layout.gitRoot, ['remote', 'get-url', 'origin']).trim()
  if (!['https://github.com/MAKingljx/video-autoworker',
    'https://github.com/MAKingljx/video-autoworker.git',
    'git@github.com:MAKingljx/video-autoworker.git'].includes(remote)) fail('canonical_remote_mismatch')
  const branch = git(layout.gitRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
  if (branch === 'main') return layout
  if (branch !== 'HEAD') fail('mainline_source_required')
  git(layout.gitRoot, ['merge-base', '--is-ancestor', layout.headCommit, 'refs/remotes/origin/main'], {
    errorCode: 'detached_source_not_on_mainline',
  })
  return layout
}
