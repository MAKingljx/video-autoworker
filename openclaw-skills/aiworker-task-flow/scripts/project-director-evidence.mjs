#!/usr/bin/env node

import { buildDirectorBrainEvidenceProjection } from '../lib/director-brain-evidence.mjs'

const MAX_STDIN_BYTES = 2 * 1024 * 1024

async function readStdin() {
  const chunks = []
  let size = 0
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_STDIN_BYTES) throw new Error('director_evidence_stdin_too_large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) throw new Error('director_evidence_stdin_required')
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('director_evidence_stdin_invalid_json')
  }
}

async function main() {
  if (process.argv.length !== 2) throw new Error('director_evidence_arguments_forbidden')
  const projection = buildDirectorBrainEvidenceProjection(await readStdin())
  process.stdout.write(`${JSON.stringify(projection)}\n`)
}

main().catch(error => {
  const message = error instanceof Error ? error.message : 'director_evidence_failed'
  process.stderr.write(`${JSON.stringify({ ok: false, error: message })}\n`)
  process.exitCode = 1
})
