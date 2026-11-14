/**
 * The reserved `SecureAgents/` folder of a workshop root (README
 * "SecureAgents/ is a reserved name"). No service imports: the root adoption
 * path and the vault service both ask it.
 */
import { existsSync, readdirSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { SECURE_AGENTS_DIR, SECURE_AGENTS_MARKER, isSecureAgentsName } from '../../shared/vault/types'

/**
 * `rootPath`'s `SecureAgents` folder (any case) when it is there **without**
 * Cinna's marker, i.e. someone else's folder under the reserved name; else null.
 */
export function foreignSecureAgentsDir(rootPath: string): string | null {
  let entries: Dirent[]
  try {
    entries = readdirSync(rootPath, { withFileTypes: true })
  } catch {
    return null
  }
  const found = entries.find((entry) => isSecureAgentsName(entry.name))
  if (!found) return null
  const path = join(rootPath, found.name)
  return existsSync(join(path, SECURE_AGENTS_MARKER)) ? null : path
}

/** The refusal text for a root holding a foreign `SecureAgents/`. */
export function foreignSecureAgentsReason(): string {
  return `This folder already has a "${SECURE_AGENTS_DIR}" folder. That name is reserved for Agent Vault; rename it, then add the folder again.`
}
