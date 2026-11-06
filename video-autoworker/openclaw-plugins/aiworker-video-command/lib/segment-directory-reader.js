// The task-flow CLI deliberately returns no more than this many summaries per
// invocation.  Keep that low-level boundary, but never expose it as a product
// limit: callers can ask for any available directory range and this adapter
// reads the required pages through the same authoritative result endpoint.
export const SEGMENT_DIRECTORY_PAGE_SIZE = 20
export const MAX_SEGMENT_DIRECTORY_ITEMS = 10_000
export const SEGMENT_DIRECTORY_READ_CONCURRENCY = 4
export const SEGMENT_DIRECTORY_PREVIEW_BYTES = 24 * 1024

function aborted(signal) {
  if (signal?.aborted) throw new Error('segment_directory_read_cancelled')
}

function validInteger(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum
}

function truncateUtf8(value, maximum) {
  if (typeof value !== 'string' || maximum <= 0) return ''
  let used = 0
  let result = ''
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8')
    if (used + size > maximum) break
    result += character
    used += size
  }
  return result
}

function compactPreviews(items) {
  if (!items.length) return { items, compacted: false }
  const each = Math.floor(SEGMENT_DIRECTORY_PREVIEW_BYTES / items.length)
  let compacted = false
  const result = items.map(item => {
    const preview = typeof item.preview === 'string' ? item.preview : ''
    const shortened = truncateUtf8(preview, each)
    if (shortened !== preview) compacted = true
    return shortened === preview ? item : { ...item, preview: shortened }
  })
  return { items: result, compacted }
}

function directoryIdentity(page) {
  return {
    taskId: page.taskId,
    name: page.name,
    status: page.status,
    source: page.source,
    totalSegments: page.totalSegments,
    displayState: page.displayState ?? null,
    savedPartialSnapshot: page.savedPartialSnapshot === true,
    learningSummary: page.learningSummary ?? null,
  }
}

function sameDirectory(first, page) {
  if (!page || page.kind !== 'segments') return false
  const expected = directoryIdentity(first)
  const actual = directoryIdentity(page)
  return Object.keys(expected).every(key => expected[key] === actual[key])
}

async function boundedMap(values, maximum, callback) {
  const results = new Array(values.length)
  let cursor = 0
  async function worker() {
    while (cursor < values.length) {
      const index = cursor
      cursor += 1
      results[index] = await callback(values[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(maximum, values.length) }, worker))
  return results
}

/**
 * Read an arbitrary range from a persisted video segment directory without
 * making the model reason about the CLI's 20-item transport pages.  The first
 * page resolves a title query to an authoritative task id; every later page
 * uses that id and must retain the same immutable directory identity.
 */
export async function readSegmentDirectory({ runner, query, offset = 0, limit, signal } = {}) {
  if (!runner || typeof runner.taskResult !== 'function') throw new Error('segment_directory_runner_unavailable')
  if (!validInteger(offset, 0, MAX_SEGMENT_DIRECTORY_ITEMS)) throw new Error('segment_directory_offset_invalid')
  if (limit !== undefined && !validInteger(limit, 1, MAX_SEGMENT_DIRECTORY_ITEMS)) {
    throw new Error('segment_directory_limit_invalid')
  }

  aborted(signal)
  const first = await runner.taskResult({
    query,
    view: 'segments',
    segmentOffset: offset,
    segmentLimit: Math.min(SEGMENT_DIRECTORY_PAGE_SIZE, limit ?? SEGMENT_DIRECTORY_PAGE_SIZE),
  })
  if (first?.kind === 'matches') return first
  if (!sameDirectory(first, first) || !validInteger(first.totalSegments, 0, MAX_SEGMENT_DIRECTORY_ITEMS)
    || !validInteger(first.segmentOffset, 0, MAX_SEGMENT_DIRECTORY_ITEMS)
    || first.segmentOffset !== offset || !Array.isArray(first.items)) {
    throw new Error('segment_directory_first_page_invalid')
  }
  if (offset > first.totalSegments) throw new Error('segment_directory_offset_out_of_range')

  const available = first.totalSegments - offset
  const requested = limit === undefined ? available : Math.min(limit, available)
  const endOffset = offset + requested
  const pageRequests = []
  for (let pageOffset = offset; pageOffset < endOffset; pageOffset += SEGMENT_DIRECTORY_PAGE_SIZE) {
    pageRequests.push({
      offset: pageOffset,
      limit: Math.min(SEGMENT_DIRECTORY_PAGE_SIZE, endOffset - pageOffset),
    })
  }

  const pages = [first]
  const remaining = pageRequests.slice(1)
  if (remaining.length) {
    const later = await boundedMap(remaining, SEGMENT_DIRECTORY_READ_CONCURRENCY, async request => {
      aborted(signal)
      return runner.taskResult({
        query: first.taskId,
        view: 'segments',
        segmentOffset: request.offset,
        segmentLimit: request.limit,
      })
    })
    pages.push(...later)
  }

  const items = []
  let expectedOffset = offset
  for (const page of pages) {
    if (!sameDirectory(first, page) || page.segmentOffset !== expectedOffset || !Array.isArray(page.items)) {
      throw new Error('segment_directory_changed')
    }
    const remainingItems = endOffset - expectedOffset
    const accepted = page.items.slice(0, remainingItems)
    items.push(...accepted)
    expectedOffset += accepted.length
    const fullyConsumed = accepted.length === page.items.length
    if (fullyConsumed) {
      const expectedNext = expectedOffset < first.totalSegments ? expectedOffset : null
      if (page.nextSegmentOffset !== expectedNext) throw new Error('segment_directory_pagination_inconsistent')
    }
    if (expectedOffset < endOffset && !fullyConsumed) {
      throw new Error('segment_directory_pagination_inconsistent')
    }
  }
  if (expectedOffset !== endOffset) throw new Error('segment_directory_pagination_incomplete')

  const preview = compactPreviews(items)
  return {
    ...first,
    segmentOffset: offset,
    segmentLimit: requested,
    items: preview.items,
    nextSegmentOffset: endOffset < first.totalSegments ? endOffset : null,
    directoryComplete: endOffset === first.totalSegments,
    internallyPaginated: pages.length > 1,
    pagesRead: pages.length,
    directoryPreviewCompacted: preview.compacted,
  }
}
