import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function validateRuntimeInspection(report, pluginId, expectedVersion = '0.5.13') {
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    throw new Error('Runtime inspection must be a JSON object.')
  }
  if (report.plugin?.id !== pluginId) {
    throw new Error('Runtime inspection plugin id mismatch.')
  }
  if (report.plugin?.status !== 'loaded') {
    throw new Error('Runtime inspection did not load the plugin.')
  }
  if (report.plugin?.version !== expectedVersion) {
    throw new Error(`Runtime inspection plugin version must be ${expectedVersion}.`)
  }
  if (!Array.isArray(report.typedHooks)) {
    throw new Error('Runtime inspection hooks must be an array.')
  }
  const hookNames = report.typedHooks.map(hook => hook?.name).filter(Boolean).toSorted()
  if (JSON.stringify(hookNames) !== JSON.stringify(['before_dispatch'])) {
    throw new Error('Runtime must expose exactly before_dispatch.')
  }
  if (!Array.isArray(report.tools) || report.tools.length !== 1) {
    throw new Error('Runtime must expose exactly one task-chain tool.')
  }
  const toolNames = report.tools[0]?.names
  if (!Array.isArray(toolNames) || !toolNames.includes('aiworker_analyze_video')) {
    throw new Error('Runtime task-chain tool name is missing.')
  }
  if (!Array.isArray(report.diagnostics)) {
    throw new Error('Runtime inspection diagnostics must be an array.')
  }
  const diagnostics = report.diagnostics
  if (diagnostics.some(item => item?.level === 'error' || item?.severity === 'error')) {
    throw new Error('Runtime inspection reported an error diagnostic.')
  }
}

async function main() {
  const [reportPath, pluginId, expectedVersion = '0.5.13'] = process.argv.slice(2)
  if (!reportPath || !pluginId) {
    throw new Error('Usage: validate-runtime-inspection.mjs <report.json> <plugin-id> [expected-version]')
  }
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  validateRuntimeInspection(report, pluginId, expectedVersion)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
