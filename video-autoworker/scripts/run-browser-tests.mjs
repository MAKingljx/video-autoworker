#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { lstatSync, realpathSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export function createBrowserTestInvocations(plan, productRoot = process.cwd()) {
  if (plan?.runBrowserTests !== true || !Array.isArray(plan.browserTestFiles) || !plan.browserTestFiles.length) {
    throw new Error('ci_browser_selection_empty')
  }
  const root = realpathSync(productRoot)
  const files = [...new Set(plan.browserTestFiles)]
  if (files.length !== plan.browserTestFiles.length) throw new Error('ci_browser_selection_duplicate')
  for (const member of files) {
    if (typeof member !== 'string' || !/^tests\/[a-zA-Z0-9_./-]+\.spec\.[cm]?[jt]sx?$/u.test(member)
      || member.split('/').includes('..')) throw new Error('ci_browser_member_invalid')
    const path = resolve(root, member)
    const stat = lstatSync(path)
    const actual = relative(root, realpathSync(path))
    if (!stat.isFile() || stat.isSymbolicLink() || actual.startsWith(`..${sep}`) || actual === '..') {
      throw new Error('ci_browser_member_unsafe')
    }
  }
  const escape = file => `${file.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`
  const harness = 'tests/openclaw-harness.spec.ts'
  const ordinary = files.filter(file => file !== harness)
  return [
    ...(ordinary.length ? [{ args: ['exec', 'playwright', 'test', ...ordinary.map(escape)], env: {} }] : []),
    ...(files.includes(harness) ? [{
      args: ['exec', 'playwright', 'test', '--config=playwright.openclaw.local.config.ts', escape(harness)],
      env: { E2E_GATEWAY_EXPECTED: '0' },
    }] : []),
  ]
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const plan = JSON.parse(process.env.CI_IMPACT_PLAN || 'null')
    const invocations = createBrowserTestInvocations(plan)
    process.stdout.write(`${JSON.stringify({ browserTestFiles: plan.browserTestFiles, invocations: invocations.length })}\n`)
    for (const { args, env } of invocations) {
      execFileSync('pnpm', args, { stdio: 'inherit', env: { ...process.env, ...env } })
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'ci_browser_tests_failed'}\n`)
    process.exitCode = 1
  }
}
