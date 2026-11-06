import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const FRAME_REF = /^[a-f0-9]{32}$/u
const WORKFLOW_ID = /^[a-f0-9]{32}$/u
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
    'sessionKeySha256', 'timeRange', 'videoName', 'width', 'height', 'workflowId']
  const legacyKeys = keys.filter(key => key !== 'workflowId')
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (![keys, legacyKeys].some(expected => JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expected.sort())))
    || value.frameRef !== frameRef || !FRAME_REF.test(value.frameRef)
    || !SHA256.test(value.frameSha256) || !SHA256.test(value.imageScope) || !SHA256.test(value.sessionKeySha256)
    || !Number.isSafeInteger(value.segmentIndex) || value.segmentIndex < 1
    || !Number.isFinite(value.createdAt) || !Number.isFinite(value.expiresAt) || value.expiresAt <= value.createdAt
    || typeof value.timeRange !== 'string' || value.timeRange.length > 128
    || typeof value.videoName !== 'string' || value.videoName.length > 180
    || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > MAX_FRAME_BYTES
    || !Number.isSafeInteger(value.width) || value.width < 64 || value.width > 8192
    || !Number.isSafeInteger(value.height) || value.height < 64 || value.height > 8192
    || value.width * value.height > 24 * 1024 * 1024
    || (Object.hasOwn(value, 'workflowId') && value.workflowId !== null && !WORKFLOW_ID.test(value.workflowId))) fail('receipt_invalid')
  return { ...value, workflowId: value.workflowId ?? null }
}

function validateWorkflowReceipt(value, operationId) {
  const keys = ['createdAt', 'expiresAt', 'imageScope', 'operationId', 'segmentIndexes', 'sessionKeySha256', 'videoName']
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys.sort())
    || value.operationId !== operationId || !WORKFLOW_ID.test(value.operationId)
    || !SHA256.test(value.imageScope) || !SHA256.test(value.sessionKeySha256)
    || !Number.isFinite(value.createdAt) || !Number.isFinite(value.expiresAt) || value.expiresAt <= value.createdAt
    || typeof value.videoName !== 'string' || value.videoName.length < 1 || value.videoName.length > 180
    || !Array.isArray(value.segmentIndexes) || value.segmentIndexes.length < 1 || value.segmentIndexes.length > 10_000
    || value.segmentIndexes.some(index => !Number.isSafeInteger(index) || index < 1)
    || new Set(value.segmentIndexes).size !== value.segmentIndexes.length) fail('workflow_receipt_invalid')
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
    const names = fs.readdirSync(root).filter(name => /^(?:frame|workflow)-[a-f0-9]{32}\.json$/u.test(name))
    if (names.length > 1_000) fail('store_unbounded')
    for (const name of names) {
      const frameRef = name.slice(name.indexOf('-') + 1, -'.json'.length)
      const receiptPath = path.join(root, name)
      let receipt
      try {
        receipt = name.startsWith('frame-')
          ? validateReceipt(readReceipt(receiptPath), frameRef)
          : validateWorkflowReceipt(readReceipt(receiptPath), frameRef)
      } catch { continue }
      if (receipt.expiresAt <= now()) {
        if (name.startsWith('frame-')) {
          const framePath = path.join(root, `frame-${frameRef}.jpg`)
          unlinkOwnedFile(framePath)
        }
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
    async beginWorkflow({ imageScope, sessionKey, videoName, segmentIndexes }) {
      if (!SHA256.test(imageScope) || typeof sessionKey !== 'string' || !sessionKey || sessionKey.length > 4096
        || typeof videoName !== 'string' || !videoName || videoName.length > 180
        || !Array.isArray(segmentIndexes) || segmentIndexes.length < 1 || segmentIndexes.length > 10_000
        || segmentIndexes.some(index => !Number.isSafeInteger(index) || index < 1)
        || new Set(segmentIndexes).size !== segmentIndexes.length) fail('workflow_begin_invalid')
      await prune()
      const operationId = randomUUID().replaceAll('-', '')
      const createdAt = now()
      const receipt = {
        createdAt,
        expiresAt: createdAt + TTL_MS,
        imageScope,
        operationId,
        segmentIndexes: [...segmentIndexes].sort((left, right) => left - right),
        sessionKeySha256: sha256(Buffer.from(sessionKey, 'utf8')),
        videoName,
      }
      writePrivateFile(path.join(root, `workflow-${operationId}.json`), `${JSON.stringify(receipt)}\n`)
      return { operationId, videoName, segmentIndexes: receipt.segmentIndexes }
    },
    async resolveWorkflow({ operationId, imageScope, sessionKey }) {
      if (!WORKFLOW_ID.test(operationId || '') || !SHA256.test(imageScope) || typeof sessionKey !== 'string'
        || !sessionKey || sessionKey.length > 4096) fail('workflow_reference_invalid')
      await prune()
      const receipt = validateWorkflowReceipt(
        readReceipt(path.join(root, `workflow-${operationId}.json`)), operationId,
      )
      if (receipt.expiresAt <= now()) fail('workflow_expired')
      if (receipt.imageScope !== imageScope || receipt.sessionKeySha256 !== sha256(Buffer.from(sessionKey, 'utf8'))) {
        fail('workflow_scope_mismatch')
      }
      return { operationId: receipt.operationId, videoName: receipt.videoName, segmentIndexes: receipt.segmentIndexes }
    },
    async findWorkflow({ imageScope, sessionKey, videoName }) {
      if (!SHA256.test(imageScope) || typeof sessionKey !== 'string' || !sessionKey || sessionKey.length > 4096
        || typeof videoName !== 'string' || !videoName || videoName.length > 180) fail('workflow_lookup_invalid')
      await prune()
      const sessionKeySha256 = sha256(Buffer.from(sessionKey, 'utf8'))
      const matches = []
      for (const name of fs.readdirSync(root).filter(item => /^workflow-[a-f0-9]{32}\.json$/u.test(item))) {
        const operationId = name.slice('workflow-'.length, -'.json'.length)
        try {
          const receipt = validateWorkflowReceipt(readReceipt(path.join(root, name)), operationId)
          if (receipt.expiresAt > now() && receipt.imageScope === imageScope
            && receipt.sessionKeySha256 === sessionKeySha256 && receipt.videoName === videoName) matches.push(receipt)
        } catch { /* Leave unknown evidence untouched and keep searching. */ }
      }
      if (matches.length === 0) return null
      matches.sort((left, right) => right.createdAt - left.createdAt || left.operationId.localeCompare(right.operationId))
      const receipt = matches[0]
      return { operationId: receipt.operationId, videoName: receipt.videoName, segmentIndexes: receipt.segmentIndexes }
    },
    async captureBatch({ imageScope, sessionKey, videoName, candidates, workflowId } = {}) {
      if (!SHA256.test(imageScope) || typeof sessionKey !== 'string' || !sessionKey || sessionKey.length > 4096
        || typeof videoName !== 'string' || !videoName || videoName.length > 180
        || !Array.isArray(candidates) || candidates.length < 1 || candidates.length > 3
        || (workflowId !== undefined && !WORKFLOW_ID.test(workflowId))) fail('capture_invalid')
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
            videoName,
            workflowId: workflowId ?? null,
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
    async resolve({ frameRef, imageScope, sessionKey, workflowId } = {}) {
      if (!FRAME_REF.test(frameRef || '') || !SHA256.test(imageScope) || typeof sessionKey !== 'string'
        || !sessionKey || sessionKey.length > 4096 || (workflowId !== undefined && !WORKFLOW_ID.test(workflowId))) fail('reference_invalid')
      await prune()
      const imagePath = path.join(root, `frame-${frameRef}.jpg`)
      const receiptPath = path.join(root, `frame-${frameRef}.json`)
      const receipt = validateReceipt(readReceipt(receiptPath), frameRef)
      if (receipt.expiresAt <= now()) fail('expired')
      if (receipt.imageScope !== imageScope || receipt.sessionKeySha256 !== sha256(Buffer.from(sessionKey, 'utf8'))) {
        fail('scope_mismatch')
      }
      if (workflowId !== undefined && receipt.workflowId !== workflowId) fail('workflow_mismatch')
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
    async listWorkflowFrames({ operationId, segmentIndex, imageScope, sessionKey }) {
      if (!WORKFLOW_ID.test(operationId || '') || !Number.isSafeInteger(segmentIndex) || segmentIndex < 1
        || !SHA256.test(imageScope) || typeof sessionKey !== 'string' || !sessionKey || sessionKey.length > 4096) {
        fail('workflow_frame_lookup_invalid')
      }
      await this.resolveWorkflow({ operationId, imageScope, sessionKey })
      const matches = []
      for (const name of fs.readdirSync(root).filter(item => /^frame-[a-f0-9]{32}\.json$/u.test(item))) {
        const frameRef = name.slice('frame-'.length, -'.json'.length)
        try {
          const resolved = await this.resolve({ frameRef, imageScope, sessionKey, workflowId: operationId })
          if (resolved.receipt.segmentIndex !== segmentIndex) continue
          const data = fs.readFileSync(resolved.path).toString('base64')
          matches.push({ frameRef, segmentIndex: resolved.receipt.segmentIndex, timeRange: resolved.receipt.timeRange,
            width: resolved.receipt.width, height: resolved.receipt.height, sha256: resolved.receipt.frameSha256, data })
        } catch { /* Keep invalid/unrelated frame evidence untouched. */ }
      }
      if (matches.length > 3) fail('workflow_frame_count_invalid')
      return matches.toSorted((left, right) => left.frameRef.localeCompare(right.frameRef))
    },
  })
}
