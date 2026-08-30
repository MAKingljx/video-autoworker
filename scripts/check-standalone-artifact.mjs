#!/usr/bin/env node

import { readdir } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const FORBIDDEN_STANDALONE_NAMES = new Set([
  '.phoenixbrain',
  '.git',
  '.env',
  'test-catalog.json',
])

const FORBIDDEN_CREDENTIAL_NAMES = new Set([
  '.npmrc',
  '.netrc',
  '.pypirc',
  '.git-credentials',
  '.ssh',
  'id_rsa',
  'id_ed25519',
])

const FORBIDDEN_CREDENTIAL_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx']

export function isForbiddenStandaloneName(name) {
  const normalized = name.toLowerCase()
  return FORBIDDEN_STANDALONE_NAMES.has(normalized)
    || FORBIDDEN_CREDENTIAL_NAMES.has(normalized)
    || normalized.startsWith('.env')
    || FORBIDDEN_CREDENTIAL_EXTENSIONS.some(extension => normalized.endsWith(extension))
}

export async function findForbiddenStandaloneMembers(rootPath) {
  const root = resolve(rootPath)
  const forbidden = []

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const pathname = resolve(directory, entry.name)
      if (isForbiddenStandaloneName(entry.name)) {
        forbidden.push(relative(root, pathname) || entry.name)
        continue
      }
      if (entry.isDirectory()) await visit(pathname)
    }
  }

  await visit(root)
  return forbidden.sort()
}

export async function auditStandaloneArtifact(rootPath = resolve('.next/standalone')) {
  const forbidden = await findForbiddenStandaloneMembers(rootPath)
  if (forbidden.length > 0) {
    throw new Error(`standalone_forbidden_members:${forbidden.join(',')}`)
  }
  return { ok: true, root: resolve(rootPath), forbiddenMembers: 0 }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null
if (invokedPath === import.meta.url) {
  try {
    const result = await auditStandaloneArtifact(process.argv[2])
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${JSON.stringify({ ok: false, error: message })}\n`)
    process.exitCode = 1
  }
}
