#!/usr/bin/env node
import { readFile } from 'node:fs/promises'

import { evaluateDirectorBrainCandidates } from './lib/director-brain-evaluation.mjs'

const MAX_INPUT_BYTES = 4 * 1024 * 1024

async function readStdin() {
  const chunks = []
  let size = 0
  for await (const chunk of process.stdin) {
    size += chunk.length
    if (size > MAX_INPUT_BYTES) throw new Error('evaluation_input_too_large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) throw new Error('evaluation_input_required')
  return text
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length > 2 || (args.length === 2 && args[0] !== '--input')) {
    throw new Error('usage: director-brain-evaluation [--input <absolute-json-path>]')
  }
  let source
  if (args.length === 2) {
    if (!args[1].startsWith('/')) throw new Error('evaluation_input_path_must_be_absolute')
    source = await readFile(args[1], 'utf8')
    if (Buffer.byteLength(source, 'utf8') > MAX_INPUT_BYTES) {
      throw new Error('evaluation_input_too_large')
    }
  } else {
    source = await readStdin()
  }
  const input = JSON.parse(source)
  process.stdout.write(`${JSON.stringify(evaluateDirectorBrainCandidates(input), null, 2)}\n`)
}

main().catch(error => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'evaluation_failed' })}\n`)
  process.exitCode = 1
})
