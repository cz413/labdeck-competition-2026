import { posix } from 'node:path'
import type { RepositoryCandidate } from '../shared/repository-guide'

/** Parse `find` output for `.git` markers or root READMEs into repository directories. */
export function parseRepositoryCandidates(output: string): RepositoryCandidate[] {
  const paths = new Set<string>()
  for (const line of output.split('\n')) {
    const value = line.trim()
    if (!value.startsWith('/')) continue
    const path = value.endsWith('/.git') ? value.slice(0, -5) : value.replace(/\/(README\.md|README\.rst)$/i, '')
    if (!path || path === '/' || path.length > 4096 || /[\0\r\n]/.test(path)) continue
    paths.add(path)
  }
  return [...paths]
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
    .slice(0, 40)
    .map(path => ({ path, name: posix.basename(path) }))
}
