#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import {
  assertTaskFlowStateMatches,
  fingerprintAuditedPreviousPlugin,
  fingerprintPath,
  fingerprintPluginContent,
  restoreTaskFlowState,
  snapshotTaskFlowState,
  validateApprovedSha,
  validatePluginRollbackBackup,
  validateSafeEquivalentIndex,
  validateTaskFlowRollbackBackup,
} from './lib/aiworker-video-release-rollback-policy.mjs'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function readJson(pathname, label) {
  let value
  try {
    value = JSON.parse(await readFile(pathname, 'utf8'))
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`)
  }
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} must be a JSON object.`)
  return value
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  switch (command) {
    case 'approved-sha': {
      const [approvedSha] = args
      validateApprovedSha(approvedSha)
      process.stdout.write(`${approvedSha}\n`)
      break
    }
    case 'plugin-backup': {
      const [
        backupRoot,
        backupDir,
        approvedSha,
        installedPluginPath,
        repositoryRoot,
        pluginSourcePath,
      ] = args
      assert(
        backupRoot && backupDir && approvedSha && installedPluginPath
          && repositoryRoot && pluginSourcePath,
        'plugin-backup arguments are incomplete.',
      )
      process.stdout.write(`${JSON.stringify(await validatePluginRollbackBackup({
        backupRoot,
        backupDir,
        approvedSha,
        installedPluginPath,
        repositoryRoot,
        pluginSourcePath,
      }), null, 2)}\n`)
      break
    }
    case 'task-backup': {
      const [backupRoot, backupDir] = args
      assert(backupRoot && backupDir, 'task-backup arguments are incomplete.')
      process.stdout.write(`${JSON.stringify(await validateTaskFlowRollbackBackup({ backupRoot, backupDir }), null, 2)}\n`)
      break
    }
    case 'task-snapshot': {
      const [workspaceRoot, destination] = args
      assert(workspaceRoot && destination, 'task-snapshot arguments are incomplete.')
      process.stdout.write(`${JSON.stringify(await snapshotTaskFlowState({ workspaceRoot, destination }), null, 2)}\n`)
      break
    }
    case 'task-restore': {
      const [workspaceRoot, stateDir, stagingRoot] = args
      assert(workspaceRoot && stateDir && stagingRoot, 'task-restore arguments are incomplete.')
      await restoreTaskFlowState({ workspaceRoot, stateDir, stagingRoot })
      process.stdout.write('task-flow state restored\n')
      break
    }
    case 'task-compare': {
      const [workspaceRoot, stateDir] = args
      assert(workspaceRoot && stateDir, 'task-compare arguments are incomplete.')
      await assertTaskFlowStateMatches({ workspaceRoot, stateDir })
      process.stdout.write('task-flow state matches\n')
      break
    }
    case 'fingerprint': {
      const [pathname] = args
      assert(pathname, 'fingerprint path is required.')
      process.stdout.write(`${await fingerprintPath(pathname)}\n`)
      break
    }
    case 'plugin-fingerprint': {
      const [pathname, referencePath] = args
      assert(pathname, 'plugin-fingerprint path is required.')
      process.stdout.write(`${await fingerprintPluginContent(pathname, referencePath || null)}\n`)
      break
    }
    case 'previous-plugin-fingerprint': {
      const [pathname, expectedPeerLinkText, expectedPeerRealPath] = args
      assert(
        pathname && expectedPeerLinkText && expectedPeerRealPath,
        'previous-plugin-fingerprint arguments are incomplete.',
      )
      const result = await fingerprintAuditedPreviousPlugin(pathname, {
        expectedPeerLinkText,
        expectedPeerRealPath,
      })
      process.stdout.write(`${result.fingerprint}\n`)
      break
    }
    case 'index-equivalent': {
      const [oldIndexPath, currentIndexPath, expectedSourcePath, installedPluginPath] = args
      assert(
        oldIndexPath && currentIndexPath && expectedSourcePath && installedPluginPath,
        'index-equivalent arguments are incomplete.',
      )
      process.stdout.write(`${JSON.stringify(validateSafeEquivalentIndex({
        oldIndex: await readJson(oldIndexPath, 'backed-up index'),
        currentIndex: await readJson(currentIndexPath, 'current index'),
        expectedSourcePath,
        installedPluginPath,
      }), null, 2)}\n`)
      break
    }
    default:
      throw new Error('Unknown release rollback validator command.')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
