#!/usr/bin/env node

import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  buildMediaRetentionPlan,
  writeMediaRetentionPlan,
} from './lib/aiworker-media-retention.mjs'

function fail(code) {
  process.stderr.write(`${JSON.stringify({ ok: false, mode: 'dry-run', code })}\n`)
  process.exitCode = 1
}

export function parseMediaRetentionArguments(argv) {
  if (argv.includes('--apply') || argv.includes('--delete')) throw new Error('destructive_mode_unsupported')
  const values = new Map()
  let dryRun = false
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]
    if (name === '--dry-run') {
      if (dryRun) throw new Error('duplicate_argument')
      dryRun = true
      continue
    }
    const value = argv[index + 1]
    if (!name?.startsWith('--') || value === undefined || value.startsWith('--') || values.has(name)) {
      throw new Error('invalid_arguments')
    }
    values.set(name, value)
    index += 1
  }
  const allowed = new Set([
    '--inbox-root', '--work-root', '--db-path', '--older-than-hours', '--plan-out',
  ])
  if (!dryRun || values.size !== allowed.size || [...values.keys()].some(key => !allowed.has(key))) {
    throw new Error('invalid_arguments')
  }
  for (const pathOption of ['--inbox-root', '--work-root', '--db-path', '--plan-out']) {
    const value = values.get(pathOption)
    if (!value || !value.startsWith('/')) throw new Error(`${pathOption.slice(2).replaceAll('-', '_')}_must_be_absolute`)
  }
  const olderThanHours = Number(values.get('--older-than-hours'))
  if (!Number.isInteger(olderThanHours)) throw new Error('older_than_hours_out_of_range')
  return {
    inboxRoot: resolve(values.get('--inbox-root')),
    workRoot: resolve(values.get('--work-root')),
    databasePath: resolve(values.get('--db-path')),
    olderThanHours,
    planOut: resolve(values.get('--plan-out')),
  }
}

export async function runMediaRetentionAudit(argv) {
  const options = parseMediaRetentionArguments(argv)
  const plan = await buildMediaRetentionPlan(options)
  await writeMediaRetentionPlan(options.planOut, plan)
  return {
    ok: true,
    mode: 'dry-run',
    deletionSupported: false,
    planHashSha256: plan.planHashSha256,
    ...plan.summary,
  }
}

async function main() {
  const result = await runMediaRetentionAudit(process.argv.slice(2))
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    const code = /^[a-z][a-z0-9_]{2,63}$/u.test(error?.message) ? error.message : 'audit_failed'
    fail(code)
  })
}
