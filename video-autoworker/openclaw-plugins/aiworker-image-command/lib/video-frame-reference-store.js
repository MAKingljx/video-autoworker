import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const FRAME_REF = /^[a-f0-9]{32}$/u
const SHA256 = /^[a-f0-9]{64}$/u
const MAX_FRAME_BYTES = 3 * 1024 * 1024
const MAX_REFERENCES = 64
const TTL_MS = 60 * 60 * 1_000

function fail(code) { throw new Error(`video_frame_reference_${code}`) }
function sha256(value) { return createHash('sha256').update(value).digest('hex') }

function safeDirectory(directory, mode = 0o700) {
  const stat = fs.lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()
    || (stat.mode & 0o7777) !== mode || fs.realpathSync(directory) !== directory) fail('unsafe_directory')
  return stat
}

function ensureReferenceDirectory(stateDir) {
  if (!path.isAbsolute(stateDir) || path.resolve(stateDir) !== stateDir) fail('state_root_invalid')
  const physicalStateDir = fs.realpathSync(stateDir)
  safeDirectory(physicalStateDir)
  const mediaRoot = path.join(physicalStateDir, 'media')
  if (!fs.existsSync(mediaRoot)) fs.mkdirSync(mediaRoot, { mode: 0o700 })
  safeDirectory(mediaRoot)
  const root = path.join(mediaRoot, 'video-frame-references')
  if (!fs.existsSync(root)) fs.mkdirSync(root, { mode: 0o700 })
  safeDirectory(root)
  return root
}

function writePrivateFile(target, data) {
  const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT
    | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}

function readReceipt(pathname) {
  const stat = fs.lstatSync(pathname)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()
    || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600 || stat.size < 2 || stat.size > 8_192
    || fs.realpathSync(pathname) !== pathname) fail('receipt_invalid')
  return JSON.parse(fs.readFileSync(pathname, 'utf8'))
}

function validateReceipt(value, frameRef) {
  const keys = ['bytes', 'createdAt', 'expiresAt', 'frameRef', 'frameSha256', 'imageScope', 'segmentIndex',
    'sessionKeySha256', 'timeRange', 'videoName', 'width', 'height']
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys.sort())
    || value.frameRef !== frameRef || !FRAME_REF.test(value.frameRef)
    || !SHA256.test(value.frameSha256) || !SHA256.test(value.imageScope) || !SHA256.test(value.sessionKeySha256)
    || !Number.isSafeInteger(value.segmentIndex) || value.segmentIndex < 1
    || !Number.isFinite(value.createdAt) || !Number.isFinite(value.expiresAt) || value.expiresAt <= value.createdAt
    || typeof value.timeRange !== 'string' || value.timeRange.length > 128
    || typeof value.videoName !== 'string' || value.videoName.length > 180
    || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > MAX_FRAME_BYTES
    || !Number.isSafeInteger(value.width) || value.width < 64 || value.width > 8192
    || !Number.isSafeInteger(value.height) || value.height < 64 || value.height > 8192
    || value.width * value.height > 24 * 1024 * 1024) fail('receipt_invalid')
  return value
}

function unlinkOwnedFile(pathname) {
  try {
    const stat = fs.lstatSync(pathname)
    if (stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid()
      && stat.nlink === 1 && (stat.mode & 0o7777) === 0o600 && fs.realpathSync(pathname) === pathname) {
      fs.unlinkSync(pathname)
    }
  } catch { /* Preserve any object whose identity is not proven. */ }
}

export function createVideoFrameReferenceStore({ stateDir, now = Date.now } = {}) {
  if (typeof now !== 'function') fail('clock_invalid')
  let root = ''
  let timer
  async function prune() {
    if (!root) root = ensureReferenceDirectory(stateDir)
    safeDirectory(root)
    const names = fs.readdirSync(root).filter(name => /^frame-[a-f0-9]{32}\.json$/u.test(name))
    if (names.length > 1_000) fail('store_unbounded')
    for (const name of names) {
      const frameRef = name.slice('frame-'.length, -'.json'.length)
      const receiptPath = path.join(root, name)
      let receipt
      try { receipt = validateReceipt(readReceipt(receiptPath), frameRef) } catch { continue }
      if (receipt.expiresAt <= now()) {
        const framePath = path.join(root, `frame-${frameRef}.jpg`)
        unlinkOwnedFile(framePath)
        unlinkOwnedFile(receiptPath)
      }
    }
  }
  return Object.freeze({
    async start() {
      if (timer) return
      root = ensureReferenceDirectory(stateDir)
      await prune()
      timer = setInterval(() => { void prune().catch(() => {}) }, 60_000)
      timer.unref?.()
    },
    async stop() {
      if (timer) clearInterval(timer)
      timer = undefined
      await prune().catch(() => {})
    },
    async captureBatch({ imageScope, sessionKey, candidates }) {
      if (!SHA256.test(imageScope) || typeof sessionKey !== 'string' || !sessionKey || sessionKey.length > 4096
        || !Array.isArray(candidates) || candidates.length < 1 || candidates.length > 3) fail('capture_invalid')
      await prune()
      const active = fs.readdirSync(root).filter(name => /^frame-[a-f0-9]{32}\.json$/u.test(name)).length
      if (active + candidates.length > MAX_REFERENCES) fail('store_full')
      const created = []
      try {
        for (const candidate of candidates) {
          if (!candidate || !FRAME_REF.test(candidate.frameRef) || candidate.mimeType !== 'image/jpeg'
            || !Buffer.isBuffer(candidate.bytesBuffer) || candidate.bytesBuffer.length !== candidate.bytes
            || candidate.bytesBuffer.length > MAX_FRAME_BYTES || sha256(candidate.bytesBuffer) !== candidate.sha256
            || candidate.bytesBuffer[0] !== 0xff || candidate.bytesBuffer[1] !== 0xd8 || candidate.bytesBuffer[2] !== 0xff) {
            fail('candidate_invalid')
          }
          const imagePath = path.join(root, `frame-${candidate.frameRef}.jpg`)
          const receiptPath = path.join(root, `frame-${candidate.frameRef}.json`)
          const createdAt = now()
          const receipt = {
            bytes: candidate.bytes,
            createdAt,
            expiresAt: createdAt + TTL_MS,
            frameRef: candidate.frameRef,
            frameSha256: candidate.sha256,
            imageScope,
            segmentIndex: candidate.segmentIndex,
            sessionKeySha256: sha256(Buffer.from(sessionKey, 'utf8')),
            timeRange: candidate.timeRange,
            videoName: candidate.videoName,
            width: candidate.width,
            height: candidate.height,
          }
          writePrivateFile(imagePath, candidate.bytesBuffer)
          created.push({ imagePath, receiptPath })
          writePrivateFile(receiptPath, `${JSON.stringify(receipt)}\n`)
        }
      } catch (error) {
        for (const item of created) {
          unlinkOwnedFile(item.imagePath)
          unlinkOwnedFile(item.receiptPath)
        }
        throw error
      }
      return candidates.map(candidate => ({ frameRef: candidate.frameRef, segmentIndex: candidate.segmentIndex,
        timeRange: candidate.timeRange, frameTimeSeconds: candidate.frameTimeSeconds,
        videoName: candidate.videoName, width: candidate.width, height: candidate.height,
        sha256: candidate.sha256, summary: candidate.summary, data: candidate.bytesBuffer.toString('base64') }))
    },
    async resolve({ frameRef, imageScope, sessionKey }) {
      if (!FRAME_REF.test(frameRef || '') || !SHA256.test(imageScope) || typeof sessionKey !== 'string'
        || !sessionKey || sessionKey.length > 4096) fail('reference_invalid')
      await prune()
      const imagePath = path.join(root, `frame-${frameRef}.jpg`)
      const receiptPath = path.join(root, `frame-${frameRef}.json`)
      const receipt = validateReceipt(readReceipt(receiptPath), frameRef)
      if (receipt.expiresAt <= now()) fail('expired')
      if (receipt.imageScope !== imageScope || receipt.sessionKeySha256 !== sha256(Buffer.from(sessionKey, 'utf8'))) {
        fail('scope_mismatch')
      }
      safeDirectory(root)
      const stat = fs.lstatSync(imagePath)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()
        || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600 || stat.size !== receipt.bytes
        || fs.realpathSync(imagePath) !== imagePath) fail('image_invalid')
      const bytes = fs.readFileSync(imagePath)
      if (sha256(bytes) !== receipt.frameSha256 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
        fail('image_changed')
      }
      return { path: imagePath, receipt }
    },
  })
}
