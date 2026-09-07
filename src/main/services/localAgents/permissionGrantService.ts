/**
 * The permissions a user has granted one folder agent — the desktop's own
 * store, and the reason *Always allow* means what it says.
 *
 * ## Why this store exists at all
 *
 * OpenCode has a saved-permission store and it cannot be used. Replying
 * `always` writes `{projectID: "global", action, resource: "*"}` into
 * `~/.local/share/opencode/opencode.db`: no directory, no session, no agent,
 * shared with the user's own OpenCode installation, surviving engine restarts.
 * A grant made in one agent folder was watched authorising a *different* folder
 * agent with no prompt at all. The full observation is
 * `docs/agents/local_agents/opencode_contract.md` §4.
 *
 * Replying `once`, by contrast, persists nothing — also verified. So the
 * desktop opts out of the engine's store entirely: the grant is written here,
 * beside the agent it was made for, and a later matching ask is answered `once`
 * on the user's behalf. The engine's store stays empty forever.
 *
 * ## What it is *not*
 *
 * It is not the profile. What an agent may do without ever asking — read its
 * folder, run commands in it, write outside `credentials/` — is the static
 * `permission` block in the generated engine config (`configGenerator.ts`), and
 * it is the same for every agent unless its manifest overrides it. This module
 * only holds the answers to questions that *were* asked.
 *
 * Reads go to disk on every call rather than through a cache. An ask is a
 * human-paced event and the file is a few hundred bytes; a cache here would
 * exist only to go stale against the user's own editor, the agent's own
 * `desktop.json` writes, and the revoke button on the agent page.
 */

import {
  isPermissionGranted,
  permissionGrantKey,
  permissionGrantPatterns,
  type LocalPermissionGrant,
  type LocalPermissionRequest,
  type StoredPermissionGrant
} from '../../../shared/localAgentRequests'
import { createLogger } from '../../logger/logger'
import { desktopStateService } from './desktopStateService'

const logger = createLogger('local-agent-grants')

export type { StoredPermissionGrant }

export const permissionGrantService = {
  /**
   * Every grant this folder holds, newest first.
   *
   * Newest first because the list is read as a history of decisions — the one a
   * user wants to revoke is almost always the one they just made.
   */
  list(agentDir: string): StoredPermissionGrant[] {
    const grants = desktopStateService.read(agentDir).permissionGrants
    return Object.entries(grants)
      .map(([key, grant]) => ({ key, ...grant }))
      .sort((a, b) => b.decidedAt - a.decidedAt)
  },

  /**
   * True when a standing grant already covers this ask.
   *
   * Called on the ask path, so it must never throw: `desktopStateService.read`
   * returns the empty state for a missing or unreadable file, and an unreadable
   * store means "ask the user", which is the safe direction.
   */
  covers(agentDir: string, request: LocalPermissionRequest): boolean {
    return isPermissionGranted(
      request,
      Object.values(desktopStateService.read(agentDir).permissionGrants)
    )
  },

  /**
   * Record *Always allow* for an ask, one grant per resource it named.
   *
   * One grant per resource rather than one per ask, because that is the unit
   * matching works in — an ask naming two paths is only covered when both are
   * — and it is the unit the user can revoke: forgetting the path they regret
   * does not forget the one they meant.
   *
   * Throws `LocalAgentError('write_failed')` from the atomic write. The runner
   * catches it: a grant that could not be saved is a decision that will be
   * asked again, which is worse than nothing but far better than a turn that
   * fails after the user said yes.
   */
  remember(agentDir: string, request: LocalPermissionRequest): StoredPermissionGrant[] {
    const existing = desktopStateService.read(agentDir).permissionGrants
    const next = { ...existing }
    const added: StoredPermissionGrant[] = []
    const decidedAt = Date.now()
    for (const { pattern, scope } of permissionGrantPatterns(request)) {
      const key = permissionGrantKey(request.action, pattern)
      const grant: LocalPermissionGrant = { action: request.action, pattern, scope, decidedAt }
      next[key] = grant
      added.push({ key, ...grant })
    }
    desktopStateService.patch(agentDir, { permissionGrants: next })
    logger.info('remembered a permission grant', {
      action: request.action,
      patterns: added.length
    })
    return added
  },

  /** Revoke one grant. Silent when the key is already gone — so is the outcome. */
  forget(agentDir: string, key: string): void {
    const existing = desktopStateService.read(agentDir).permissionGrants
    if (!(key in existing)) return
    const next = { ...existing }
    delete next[key]
    desktopStateService.patch(agentDir, { permissionGrants: next })
    logger.info('forgot a permission grant')
  },

  /** Revoke every grant this folder holds. */
  forgetAll(agentDir: string): void {
    if (Object.keys(desktopStateService.read(agentDir).permissionGrants).length === 0) return
    desktopStateService.patch(agentDir, { permissionGrants: {} })
    logger.info('forgot every permission grant for an agent')
  }
}
