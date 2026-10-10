import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CinnaAgentManifest } from '../../shared/kit/manifest'

export const PUBLICATIONS_FILE = 'publications.json'
/** The sibling ledger wins. Legacy embedded history remains readable; reads never migrate it. */
/**
 * `value` is `undefined` when the sibling file is an object without a
 * `publications` array (null or absent: it records nothing), and `null` when
 * the file is not an object at all.
 * `skills` is the sibling file's `skills[]` (contract 1.10.0, published skills),
 * as written; absent for the legacy embedded history, which never had one.
 */
export function readPublications(agentDir: string | undefined, manifest: CinnaAgentManifest): { source: string; value: unknown; skills?: unknown; invalidJson?: boolean } {
  if (agentDir && existsSync(join(agentDir, PUBLICATIONS_FILE))) {
    try {
      const document = JSON.parse(readFileSync(join(agentDir, PUBLICATIONS_FILE), 'utf8'))
      const isObject = document && typeof document === 'object' && !Array.isArray(document)
      return { source: PUBLICATIONS_FILE, value: isObject ? document.publications ?? undefined : null, skills: isObject ? document.skills : undefined }
    } catch { return { source: PUBLICATIONS_FILE, value: null, invalidJson: true } }
  }
  return { source: 'cinna-agent.json', value: manifest.publications }
}
