import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { openSafeRootedFile } from '@/lib/safe-rooted-file'

const temporaryDirectories: string[] = []

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'safe-rooted-file-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('openSafeRootedFile', () => {
  it('streams the descriptor that was validated even when the pathname is replaced later', async () => {
    const root = await makeTemporaryDirectory()
    const target = path.join(root, 'clip.txt')
    await writeFile(target, 'original')

    const file = await openSafeRootedFile(root, target)
    await rename(target, path.join(root, 'old.txt'))
    await writeFile(target, 'replacement')

    await expect(new Response(file.createWebStream()).text()).resolves.toBe('original')
  })

  it('rejects a final symlink that points outside the root', async () => {
    const root = await makeTemporaryDirectory()
    const outside = await makeTemporaryDirectory()
    const outsideFile = path.join(outside, 'secret.txt')
    const link = path.join(root, 'linked.txt')
    await writeFile(outsideFile, 'secret')
    await symlink(outsideFile, link)

    await expect(openSafeRootedFile(root, link)).rejects.toMatchObject({
      code: 'unsafe_path',
    })
  })

  it('rejects a symlinked directory inside the root', async () => {
    const root = await makeTemporaryDirectory()
    const outside = await makeTemporaryDirectory()
    await mkdir(path.join(outside, 'nested'))
    await writeFile(path.join(outside, 'nested', 'secret.txt'), 'secret')
    await symlink(path.join(outside, 'nested'), path.join(root, 'linked-directory'))

    await expect(openSafeRootedFile(root, path.join(root, 'linked-directory', 'secret.txt'))).rejects.toMatchObject({
      code: 'unsafe_path',
    })
  })
})
