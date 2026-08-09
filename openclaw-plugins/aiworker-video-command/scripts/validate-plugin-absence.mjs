import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function validatePluginAbsenceReport(report, pluginId) {
  if (!Array.isArray(report) || typeof pluginId !== 'string' || !pluginId) {
    throw new Error('Plugin absence report input is invalid.')
  }
  for (const entry of report) {
    const id = entry?.plugin?.id
    if (typeof id !== 'string' || !id) {
      throw new Error('Plugin absence report contains a malformed entry.')
    }
    if (id === pluginId) {
      throw new Error('Target plugin is already discoverable; first install refused.')
    }
  }
}

async function main() {
  const [reportPath, pluginId] = process.argv.slice(2)
  if (!reportPath || !pluginId) {
    throw new Error('Usage: validate-plugin-absence.mjs <report.json> <plugin-id>')
  }
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  validatePluginAbsenceReport(report, pluginId)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
