import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CinnaAgentManifest } from '../../shared/kit/manifest'

export const PUBLICATIONS_FILE = 'publications.json'
/** The sibling ledger wins. Legacy embedded history remains readable; reads never migrate it. */
export function readPublications(agentDir: string | undefined, manifest: CinnaAgentManifest): { source: string; value: unknown; invalidJson?: boolean } {
  if (agentDir && existsSync(join(agentDir, PUBLICATIONS_FILE))) {
    try {
      const document = JSON.parse(readFileSync(join(agentDir, PUBLICATIONS_FILE), 'utf8'))
      return { source: PUBLICATIONS_FILE, value: document && typeof document === 'object' && !Array.isArray(document) ? document.publications ?? null : null }
    } catch { return { source: PUBLICATIONS_FILE, value: null, invalidJson: true } }
  }
  return { source: 'cinna-agent.json', value: manifest.publications }
}
