import { NextRequest, NextResponse } from 'next/server'
import { readdir, stat } from 'node:fs/promises'
import { dirname, basename, join, resolve } from 'node:path'
import { requireRole } from '@/lib/auth'
import { readLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'
import { config } from '@/lib/config'

const MONTH_DIR_RE = /^(0[1-9]|1[0-2])$/

interface WorkspaceProjectEntry {
  name: string
  path: string
  modified: number
  hasReadme: boolean
  hasNeed: boolean
  hasReport: boolean
}

interface WorkspaceMonthEntry {
  name: string
  path: string
  modified: number
  projectCount: number
  projects: WorkspaceProjectEntry[]
}

async function directoryExists(targetPath: string): Promise<boolean> {
  try {
    const info = await stat(targetPath)
    return info.isDirectory()
  } catch {
    return false
  }
}

async function readDirectoryNames(dirPath: string): Promise<string[]> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

async function looksLikeWorkspaceRoot(dirPath: string): Promise<boolean> {
  const children = await readDirectoryNames(dirPath)
  const monthDirs = children.filter((name) => MONTH_DIR_RE.test(name))
  if (monthDirs.length >= 2) return true
  return /^\d{4}$/.test(basename(dirPath)) && monthDirs.length >= 1
}

async function detectWorkspaceRoot(startPath: string): Promise<string> {
  const candidates = [
    process.env.MISSION_CONTROL_WORKSPACE_DIR,
    process.env.OPENCLAW_WORKSPACE_DIR,
    config.openclawWorkspaceDir,
  ]
    .filter((value): value is string => Boolean(value && value.trim()))
    .map((value) => resolve(value))

  for (const candidate of candidates) {
    if (await looksLikeWorkspaceRoot(candidate)) {
      return candidate
    }
  }

  let current = resolve(startPath)
  let bestMatch: string | null = null

  while (true) {
    if (await looksLikeWorkspaceRoot(current)) {
      bestMatch = current
    }

    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }

  return bestMatch || resolve(startPath)
}

async function collectProjectEntry(monthPath: string, projectName: string): Promise<WorkspaceProjectEntry> {
  const projectPath = join(monthPath, projectName)
  const fileNames = new Set<string>()

  try {
    const entries = await readdir(projectPath, { withFileTypes: true })
    for (const entry of entries) {
      fileNames.add(entry.name)
    }
  } catch {
    // Ignore unreadable project folders and fall back to empty flags.
  }

  const details = await stat(projectPath)

  return {
    name: projectName,
    path: projectPath,
    modified: details.mtimeMs,
    hasReadme: fileNames.has('README.md') || fileNames.has('readme.md'),
    hasNeed: fileNames.has('need'),
    hasReport: fileNames.has('report'),
  }
}

async function collectWorkspaceMonths(workspaceRoot: string): Promise<WorkspaceMonthEntry[]> {
  const children = await readDirectoryNames(workspaceRoot)
  const monthNames = children.filter((name) => MONTH_DIR_RE.test(name)).sort((a, b) => a.localeCompare(b))

  const months = await Promise.all(monthNames.map(async (monthName) => {
    const monthPath = join(workspaceRoot, monthName)
    const monthStats = await stat(monthPath)
    const projectNames = (await readDirectoryNames(monthPath)).sort((a, b) => a.localeCompare(b))
    const projects = await Promise.all(projectNames.map((projectName) => collectProjectEntry(monthPath, projectName)))

    return {
      name: monthName,
      path: monthPath,
      modified: monthStats.mtimeMs,
      projectCount: projects.length,
      projects,
    }
  }))

  return months
}

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = readLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const workspaceRoot = await detectWorkspaceRoot(process.cwd())
    const exists = await directoryExists(workspaceRoot)

    if (!exists) {
      return NextResponse.json({
        workspaceRoot,
        workspaceName: basename(workspaceRoot),
        months: [],
      })
    }

    const months = await collectWorkspaceMonths(workspaceRoot)

    return NextResponse.json({
      workspaceRoot,
      workspaceName: basename(workspaceRoot),
      months,
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/local/workspace-projects error')
    return NextResponse.json({ error: 'Failed to load workspace projects' }, { status: 500 })
  }
}

export const dynamic = 'force-dynamic'
