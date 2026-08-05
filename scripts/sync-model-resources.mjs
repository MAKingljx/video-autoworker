#!/usr/bin/env node

import {
  chmodSync,
  copyFileSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

const [templatePath, targetPath] = process.argv.slice(2)

if (!templatePath || !targetPath) {
  console.error('用法：sync-model-resources.mjs <template> <target>')
  process.exit(2)
}

function loadRegistry(path, label) {
  const value = JSON.parse(readFileSync(path, 'utf8'))
  if (value?.version !== 1 || !Array.isArray(value.routes)) {
    throw new Error(`${label}不是有效的 v1 模型注册表`)
  }
  if (value.resources !== undefined && !Array.isArray(value.resources)) {
    throw new Error(`${label}的 resources 必须是数组`)
  }
  return value
}

const targetStat = lstatSync(targetPath)
if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
  throw new Error('目标模型注册表必须是普通文件')
}

const template = loadRegistry(templatePath, '模板')
const target = loadRegistry(targetPath, '目标文件')
const templateResources = template.resources || []
const templateIds = new Set(templateResources.map(resource => resource.id))
const retainedResources = (target.resources || []).filter(resource => !templateIds.has(resource.id))
const merged = { ...target, resources: [...retainedResources, ...templateResources] }

const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')
const backupPath = `${targetPath}.backup-${timestamp}`
const temporaryPath = join(dirname(targetPath), `.${basename(targetPath)}.tmp-${process.pid}`)

copyFileSync(targetPath, backupPath)
chmodSync(backupPath, 0o600)

try {
  writeFileSync(temporaryPath, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  renameSync(temporaryPath, targetPath)
  chmodSync(targetPath, 0o600)
} finally {
  rmSync(temporaryPath, { force: true })
}

console.log(`已同步 ${templateResources.length} 个生产辅助模型资源；备份：${backupPath}`)
