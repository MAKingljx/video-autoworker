import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function validatePluginDoctorReport(raw, pluginId) {
  if (typeof raw !== 'string' || typeof pluginId !== 'string' || !pluginId) {
    throw new Error('Plugin doctor report input is invalid.')
  }
  const lines = raw.split(/\r?\n/u).map(line => line.trim()).filter(Boolean)
  if (lines.length === 1 && lines[0] === 'No plugin issues detected.') return

  const expectedCompatibility = `- ${pluginId} is hook-only. This remains a supported compatibility path, but it has not migrated to explicit capability registration yet. [info]`
  const expected = [
    'Compatibility:',
    expectedCompatibility,
    'Docs: https://docs.openclaw.ai/plugin',
  ]
  if (lines.length !== expected.length || lines.some((line, index) => line !== expected[index])) {
    throw new Error('Plugin doctor reported an unexpected issue.')
  }
}

async function main() {
  const [reportPath, pluginId] = process.argv.slice(2)
  if (!reportPath || !pluginId) {
    throw new Error('Usage: validate-plugin-doctor.mjs <report.txt> <plugin-id>')
  }
  validatePluginDoctorReport(await readFile(reportPath, 'utf8'), pluginId)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
