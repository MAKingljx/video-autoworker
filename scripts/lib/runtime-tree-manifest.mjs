#!/usr/bin/env node

import { createHash } from 'node:crypto'
import fs from 'node:fs'

const [profile, rootPath, excludedPath = ''] = process.argv.slice(2)
if (!['task-flow', 'director-brain'].includes(profile) || typeof rootPath !== 'string'
  || process.argv.length > 5) {
  throw new Error('Expected a supported manifest profile, root, and optional excluded path')
}
// Director trees admit only regular files and directories. Task-flow retains
// its existing absent, symlink, and special-object manifest records.
const strictTree = profile === 'director-brain'
const root = Buffer.from(rootPath)
const excluded = excludedPath === '' ? null : Buffer.from(excludedPath)
const slash = Buffer.from('/')
const dotSlash = Buffer.from('./')

const mode = stat => Number(stat.mode & 0o7777n).toString(8)
const sameSnapshot = (left, right) => left.dev === right.dev && left.ino === right.ino
  && left.mode === right.mode && left.nlink === right.nlink && left.size === right.size
  && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
const verifyPath = (pathname, expected) => {
  const actual = fs.lstatSync(pathname, { bigint: true })
  if (!sameSnapshot(actual, expected)) throw new Error('Manifest path changed while reading')
  return actual
}
const write = value => {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value)
  let offset = 0
  while (offset < buffer.length) {
    const written = fs.writeSync(1, buffer, offset, buffer.length - offset)
    if (written === 0) throw new Error('Could not complete manifest output')
    offset += written
  }
}
const sha256 = value => createHash('sha256').update(value).digest('hex')

const hashFile = (pathname, expected) => {
  const noFollow = fs.constants.O_NOFOLLOW
  if (noFollow === undefined) throw new Error('O_NOFOLLOW is required for manifest hashing')
  const fd = fs.openSync(pathname, fs.constants.O_RDONLY | noFollow)
  try {
    const before = fs.fstatSync(fd, { bigint: true })
    if (!before.isFile() || !sameSnapshot(before, expected)) {
      throw new Error('Manifest file changed before hashing')
    }
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(64 * 1024)
    for (;;) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
    }
    const after = fs.fstatSync(fd, { bigint: true })
    if (!sameSnapshot(after, expected)) {
      throw new Error('Manifest file changed while hashing')
    }
    verifyPath(pathname, expected)
    return hash.digest('hex')
  } finally {
    fs.closeSync(fd)
  }
}

let rootStat
try {
  rootStat = fs.lstatSync(root, { bigint: true })
} catch (error) {
  if (strictTree) throw error
  write('absent\n')
  process.exit(0)
}
if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
  if (strictTree) throw new Error('Manifest root must be a regular directory')
  write('absent\n')
  process.exit(0)
}

const entries = []
const pending = [{ pathname: root, relative: Buffer.alloc(0), stat: rootStat }]
while (pending.length > 0) {
  const directory = pending.pop()
  verifyPath(directory.pathname, directory.stat)
  for (const name of fs.readdirSync(directory.pathname, { encoding: 'buffer' })) {
    if (name.includes(0x0a)) throw new Error('Manifest paths must not contain newlines')
    const pathname = Buffer.concat([directory.pathname, slash, name])
    const bareRelative = directory.relative.length === 0
      ? name
      : Buffer.concat([directory.relative, slash, name])
    const relative = Buffer.concat([dotSlash, bareRelative])
    const stat = fs.lstatSync(pathname, { bigint: true })
    entries.push({ pathname, relative, stat })
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      pending.push({ pathname, relative: bareRelative, stat })
    }
  }
}
entries.sort((left, right) => Buffer.compare(left.relative, right.relative))

verifyPath(root, rootStat)
write(`.\tdirectory\t${mode(rootStat)}\t-\n`)
for (const entry of entries) {
  const isExcluded = excluded !== null && entry.relative.equals(excluded)
  if (isExcluded && !strictTree) continue
  verifyPath(entry.pathname, entry.stat)
  if (strictTree && !entry.stat.isDirectory() && !entry.stat.isFile()) {
    throw new Error('Unsupported object in strict manifest tree')
  }
  if (isExcluded) continue
  write(entry.relative)
  if (entry.stat.isSymbolicLink()) {
    let target = fs.readlinkSync(entry.pathname, { encoding: 'buffer' })
    while (target.length > 0 && target[target.length - 1] === 0x0a) {
      target = target.subarray(0, target.length - 1)
    }
    const verified = fs.lstatSync(entry.pathname, { bigint: true })
    if (!verified.isSymbolicLink() || !sameSnapshot(entry.stat, verified)) {
      throw new Error('Manifest symlink changed while reading')
    }
    write(`\tsymlink\t${mode(entry.stat)}\t${sha256(target)}\n`)
  } else if (entry.stat.isDirectory()) {
    write(`\tdirectory\t${mode(entry.stat)}\t-\n`)
  } else if (entry.stat.isFile()) {
    const escapedDigest = entry.relative.includes(0x5c) ? '\\' : ''
    write(`\tfile\t${mode(entry.stat)}\t${escapedDigest}${hashFile(entry.pathname, entry.stat)}\n`)
  } else {
    write(`\tother\t${mode(entry.stat)}\t-\n`)
  }
}
verifyPath(root, rootStat)
for (const entry of entries) {
  if (entry.stat.isDirectory()) verifyPath(entry.pathname, entry.stat)
}
