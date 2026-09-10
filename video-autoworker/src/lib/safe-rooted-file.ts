import { constants, type Stats } from 'node:fs'
import { lstat, open, realpath, stat, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'

export type SafeRootedFileErrorCode =
  | 'outside_root'
  | 'not_found'
  | 'not_file'
  | 'unsafe_path'
  | 'changed'

export class SafeRootedFileError extends Error {
  constructor(public readonly code: SafeRootedFileErrorCode) {
    super(code)
    this.name = 'SafeRootedFileError'
  }
}

export type SafeRootedFile = {
  path: string
  stat: Stats
  close: () => Promise<void>
  createWebStream: (range?: { start: number; end: number }) => ReadableStream<Uint8Array>
}

function isWithinRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function mapFilesystemError(error: unknown): SafeRootedFileError {
  if (error instanceof SafeRootedFileError) return error
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return new SafeRootedFileError('not_found')
    if (code === 'ELOOP') return new SafeRootedFileError('unsafe_path')
  }
  return new SafeRootedFileError('changed')
}

async function assertNoSymlinkComponents(root: string, target: string): Promise<void> {
  const rootInfo = await lstat(root)
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new SafeRootedFileError('unsafe_path')
  }

  const relative = path.relative(root, target)
  let current = root
  const components = relative ? relative.split(path.sep) : []
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index])
    const info = await lstat(current)
    if (info.isSymbolicLink()) throw new SafeRootedFileError('unsafe_path')
    if (index < components.length - 1 && !info.isDirectory()) {
      throw new SafeRootedFileError('not_found')
    }
  }
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

async function closeQuietly(handle: FileHandle): Promise<void> {
  try {
    await handle.close()
  } catch {
    // The stream may already have closed the descriptor.
  }
}

export async function openSafeRootedFile(rootPath: string, targetPath: string): Promise<SafeRootedFile> {
  const root = path.resolve(rootPath)
  const target = path.resolve(targetPath)
  if (!isWithinRoot(root, target)) throw new SafeRootedFileError('outside_root')

  let handle: FileHandle | undefined
  try {
    await assertNoSymlinkComponents(root, target)
    const physicalRoot = await realpath(root)
    const physicalTarget = await realpath(target)
    if (!isWithinRoot(physicalRoot, physicalTarget)) throw new SafeRootedFileError('outside_root')

    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
    const openedStat = await handle.stat()
    if (!openedStat.isFile()) throw new SafeRootedFileError('not_file')

    // Recheck the pathname after opening. The response is then bound to this
    // descriptor, so later renames cannot redirect the stream to another file.
    await assertNoSymlinkComponents(root, target)
    const checkedPhysicalTarget = await realpath(target)
    if (!isWithinRoot(physicalRoot, checkedPhysicalTarget)) {
      throw new SafeRootedFileError('outside_root')
    }
    const checkedStat = await stat(target)
    if (!sameFile(openedStat, checkedStat)) throw new SafeRootedFileError('changed')

    let owned = true
    return {
      path: target,
      stat: openedStat,
      close: async () => {
        if (!owned) return
        owned = false
        await closeQuietly(handle as FileHandle)
      },
      createWebStream: (range) => {
        if (!owned) throw new SafeRootedFileError('changed')
        owned = false
        const stream = (handle as FileHandle).createReadStream({
          autoClose: true,
          ...(range ? { start: range.start, end: range.end } : {}),
        })
        return Readable.toWeb(stream) as ReadableStream<Uint8Array>
      },
    }
  } catch (error) {
    if (handle) await closeQuietly(handle)
    throw mapFilesystemError(error)
  }
}
