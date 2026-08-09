import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function validateRuntimeInspection(report, pluginId) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    throw new Error('Runtime inspection must be a JSON object.')
  }
  if (report.plugin?.id !== pluginId) {
    throw new Error('Runtime inspection plugin id mismatch.')
  }
  if (report.plugin?.status !== 'loaded') {
    throw new Error('Runtime inspection did not load the plugin.')
  }
  if (
    !Array.isArray(report.typedHooks)
    || !report.typedHooks.some(hook => hook?.name === 'before_dispatch')
  ) {
    throw new Error('Runtime inspection is missing before_dispatch.')
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
  const [reportPath, pluginId] = process.argv.slice(2)
  if (!reportPath || !pluginId) {
    throw new Error('Usage: validate-runtime-inspection.mjs <report.json> <plugin-id>')
  }
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  validateRuntimeInspection(report, pluginId)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
