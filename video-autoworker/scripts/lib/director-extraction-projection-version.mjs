import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Both release-report production and its consumer read the same application contract. */
export function extractionProjectionVersion(repositoryRoot) {
  const source = readFileSync(join(repositoryRoot, 'src/lib/director-extraction-state.ts'), 'utf8')
  const version = source.match(/DIRECTOR_EXTRACTION_PROJECTION_VERSION\s*=\s*'([^']+)'/u)?.[1]
  if (!['feishu-candidate-projection-v2', 'feishu-candidate-projection-v3'].includes(version)) {
    throw new Error('director_video_release_not_ready:extraction_projection_boundary_source_invalid')
  }
  return version
}
