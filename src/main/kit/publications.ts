import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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

/** One `skills[]` entry of `publications.json` (contract 1.10.0): a skill of this agent published to a catalog. */
export interface SkillPublication {
  platform_url: string
  name: string
  package_id: string
  package_uuid: string
  revision_number: number
  content_hash: string
}

function isSkillPublication(value: unknown): value is SkillPublication & Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return (
    typeof row.platform_url === 'string' && row.platform_url !== '' &&
    typeof row.name === 'string' && row.name !== '' &&
    typeof row.package_id === 'string' &&
    typeof row.package_uuid === 'string' && row.package_uuid !== '' &&
    typeof row.revision_number === 'number' && Number.isInteger(row.revision_number) && row.revision_number >= 1 &&
    typeof row.content_hash === 'string'
  )
}

/** Origins compare without a trailing slash, as `platform_url` may be written either way. */
function sameOrigin(a: string, b: string): boolean {
  return a.replace(/\/+$/, '') === b.replace(/\/+$/, '')
}

/**
 * The well-formed `skills[]` entries of an agent's `publications.json`; none
 * when the file is absent or cannot be read. Never throws.
 */
export function readSkillPublications(agentDir: string): SkillPublication[] {
  try {
    const document = JSON.parse(readFileSync(join(agentDir, PUBLICATIONS_FILE), 'utf8'))
    const skills = document && typeof document === 'object' && !Array.isArray(document) ? document.skills : null
    return Array.isArray(skills) ? skills.filter(isSkillPublication) : []
  } catch {
    return []
  }
}

/** The entry recording the skill `name` on the instance `platformUrl`, or null. */
export function findSkillPublication(agentDir: string, platformUrl: string, name: string): SkillPublication | null {
  return readSkillPublications(agentDir).find((entry) => entry.name === name && sameOrigin(entry.platform_url, platformUrl)) ?? null
}

/**
 * Record a published skill: replace the `skills[]` entry with the same
 * `platform_url` and `name` (keeping any unknown keys it had), or add one.
 * A missing file is created as `{"publications": [], "skills": [entry]}` —
 * the schema still requires `publications`. Every other key of an existing
 * file survives; written to a temporary file and renamed into place.
 *
 * @throws Error when the file exists but is not a JSON object (it is the
 *   user's ledger, and is never overwritten blind), or cannot be written.
 */
export function upsertSkillPublication(agentDir: string, entry: SkillPublication): void {
  const path = join(agentDir, PUBLICATIONS_FILE)
  let document: Record<string, unknown> = { publications: [] }
  if (existsSync(path)) {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${PUBLICATIONS_FILE} is not a JSON object`)
    document = { ...(parsed as Record<string, unknown>) }
    if (!Array.isArray(document.publications)) document.publications = []
  }
  const skills: unknown[] = Array.isArray(document.skills) ? [...document.skills] : []
  const index = skills.findIndex(
    (row) => isSkillPublication(row) && row.name === entry.name && sameOrigin(row.platform_url, entry.platform_url)
  )
  if (index === -1) skills.push({ ...entry })
  else skills[index] = { ...(skills[index] as Record<string, unknown>), ...entry }
  document.skills = skills
  const tmp = join(agentDir, `.${PUBLICATIONS_FILE}.tmp`)
  try {
    writeFileSync(tmp, `${JSON.stringify(document, null, 2)}\n`)
    renameSync(tmp, path)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}
