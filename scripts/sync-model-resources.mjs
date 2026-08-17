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

const [templatePath, targetPath, ...options] = process.argv.slice(2)
const enableVideoAnalysis = options.includes('--enable-video-analysis')
const syncRoutes = options.includes('--sync-routes')

if (!templatePath || !targetPath || options.some(option => !['--enable-video-analysis', '--sync-routes'].includes(option))) {
  console.error('用法：sync-model-resources.mjs <template> <target> [--enable-video-analysis] [--sync-routes]')
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
let mergedRoutes = target.routes
if (syncRoutes) {
  const existingRouteIds = new Set(target.routes.map(route => route.id))
  const missingRoutes = template.routes.filter(route => !existingRouteIds.has(route.id))
  mergedRoutes = [...target.routes, ...missingRoutes]
}
if (enableVideoAnalysis) {
  const routeId = 'local-qwen36-direct'
  const templateRoute = template.routes.find(route => route.id === routeId)
  const targetRoute = target.routes.find(route => route.id === routeId)
  if (!templateRoute || templateRoute.transport !== 'openai-compatible' || !templateRoute.capabilities?.includes('vision')) {
    throw new Error(`模板缺少可用于视频分析的 ${routeId} vision 直连路由`)
  }
  if (!targetRoute || targetRoute.transport !== 'openai-compatible') {
    throw new Error(`目标注册表缺少可安全升级的 ${routeId} 直连路由`)
  }
  mergedRoutes = target.routes.map(route => route.id === routeId
    ? { ...route, capabilities: [...new Set([...(route.capabilities || []), 'vision'])] }
    : route)
}
const merged = {
  ...target,
  routes: mergedRoutes,
  resources: [...retainedResources, ...templateResources],
}

const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')
const backupPath = `${targetPath}.backup-${timestamp}-${process.pid}`
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

console.log(`已同步 ${templateResources.length} 个辅助模型资源${syncRoutes ? `，补充 ${template.routes.filter(route => !target.routes.some(existing => existing.id === route.id)).length} 个缺失路由` : ''}${enableVideoAnalysis ? '，并启用视频分析视觉直连能力' : ''}；备份：${backupPath}`)
