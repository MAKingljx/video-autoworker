import { homedir } from 'node:os'
import { join } from 'node:path'
import { config } from '@/lib/config'
import { publicRuntimeReceiptStatus, readCurrentRuntimeReceipt } from '../../scripts/lib/runtime-receipt.mjs'

/** UI, API and CLI share the same read-only receipt and drift contract. */
export async function getCurrentRuntimeStatus() {
  const runDir = process.env.AIWORKER_BG_RUN_DIR
    || join(homedir(), 'ai-worker/state/video-autoworker/blue-green')
  return publicRuntimeReceiptStatus(await readCurrentRuntimeReceipt({ runDir, databasePath: config.dbPath }))
}
