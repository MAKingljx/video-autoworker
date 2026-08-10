#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const SECTION_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const SAME_OR_HIGHER_HEADING = /^#{1,2}(?:[ \t]+|$)/u

function scanLines(value) {
  const lines = []
  let offset = 0

  while (offset < value.length) {
    const newline = value.indexOf('\n', offset)
    const end = newline === -1 ? value.length : newline + 1
    let contentEnd = newline === -1 ? value.length : newline
    if (contentEnd > offset && value[contentEnd - 1] === '\r') contentEnd -= 1
    lines.push({
      content: value.slice(offset, contentEnd),
      start: offset,
      end,
      hasEol: newline !== -1,
    })
    offset = end
  }

  return lines
}

export function managedSectionMarkers(sectionId) {
  if (typeof sectionId !== 'string' || !SECTION_ID_PATTERN.test(sectionId)) {
    throw new Error('managed section id must contain only lowercase letters, digits, and hyphens')
  }
  return {
    start: `<!-- aiworker-task-flow:${sectionId}:start -->`,
    end: `<!-- aiworker-task-flow:${sectionId}:end -->`,
  }
}

export function renderManagedMarkdownSection({
  current,
  template,
  sectionId,
  legacyHeadings,
}) {
  if (typeof current !== 'string' || typeof template !== 'string') {
    throw new Error('current content and template must be strings')
  }
  if (!Array.isArray(legacyHeadings) || legacyHeadings.length === 0
    || legacyHeadings.some(heading => typeof heading !== 'string' || !heading.startsWith('## '))) {
    throw new Error('at least one exact H2 legacy heading is required')
  }

  const markers = managedSectionMarkers(sectionId)
  const normalizedTemplate = template.replace(/\r\n?/gu, '\n').replace(/\n+$/u, '')
  const templateFirstLine = normalizedTemplate.split('\n', 1)[0]
  if (!normalizedTemplate || !legacyHeadings.includes(templateFirstLine)) {
    throw new Error('managed template must start with one configured legacy heading')
  }
  if (normalizedTemplate.includes(markers.start) || normalizedTemplate.includes(markers.end)) {
    throw new Error('managed template must not contain section markers')
  }

  const eol = current.match(/\r\n|\n/u)?.[0] || '\n'
  const renderedTemplate = normalizedTemplate.replace(/\n/gu, eol)
  const managedBlock = [markers.start, renderedTemplate, markers.end].join(eol)
  const lines = scanLines(current)
  const startLines = lines.filter(line => line.content === markers.start)
  const endLines = lines.filter(line => line.content === markers.end)

  if (startLines.length > 0 || endLines.length > 0) {
    if (startLines.length !== 1 || endLines.length !== 1) {
      throw new Error('managed section markers must appear exactly once')
    }

    const startLine = startLines[0]
    const endLine = endLines[0]
    const startIndex = lines.indexOf(startLine)
    const endIndex = lines.indexOf(endLine)
    if (startIndex >= endIndex) throw new Error('managed section markers are out of order')

    const legacyOutsideManagedBlock = lines.some((line, index) => (
      legacyHeadings.includes(line.content) && (index <= startIndex || index >= endIndex)
    ))
    if (legacyOutsideManagedBlock) {
      throw new Error('legacy managed heading exists outside the managed section')
    }

    const trailingEol = endLine.hasEol ? eol : ''
    return current.slice(0, startLine.start)
      + managedBlock
      + trailingEol
      + current.slice(endLine.end)
  }

  const legacyLines = lines.filter(line => legacyHeadings.includes(line.content))
  if (legacyLines.length > 1) {
    throw new Error('legacy managed heading must appear at most once')
  }

  if (legacyLines.length === 1) {
    const legacyLine = legacyLines[0]
    const legacyIndex = lines.indexOf(legacyLine)
    const nextBoundary = lines.slice(legacyIndex + 1)
      .find(line => SAME_OR_HIGHER_HEADING.test(line.content))
    const endOffset = nextBoundary?.start ?? current.length
    const trailingEol = endOffset < current.length || current.endsWith('\n') ? eol : ''
    return current.slice(0, legacyLine.start)
      + managedBlock
      + trailingEol
      + current.slice(endOffset)
  }

  if (current.length === 0) return `${managedBlock}${eol}`
  const separator = current.endsWith(`${eol}${eol}`)
    ? ''
    : current.endsWith(eol) ? eol : `${eol}${eol}`
  return `${current}${separator}${managedBlock}${eol}`
}

function parseCliArguments(argv) {
  const values = {
    input: '',
    template: '',
    sectionId: '',
    legacyHeadings: [],
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const value = argv[index + 1]
    if (!value) throw new Error(`missing value for ${argument}`)
    if (argument === '--input') values.input = value
    else if (argument === '--template') values.template = value
    else if (argument === '--section-id') values.sectionId = value
    else if (argument === '--legacy-heading') values.legacyHeadings.push(value)
    else throw new Error(`unknown argument: ${argument}`)
    index += 1
  }

  if (!values.input || !values.template || !values.sectionId) {
    throw new Error('--input, --template, and --section-id are required')
  }
  return values
}

function main() {
  const options = parseCliArguments(process.argv.slice(2))
  const rendered = renderManagedMarkdownSection({
    current: readFileSync(options.input, 'utf8'),
    template: readFileSync(options.template, 'utf8'),
    sectionId: options.sectionId,
    legacyHeadings: options.legacyHeadings,
  })
  process.stdout.write(rendered)
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  try {
    main()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`Managed section render failed: ${message}\n`)
    process.exitCode = 1
  }
}
