/**
 * The `claude` driver: a folder agent on the user's own Claude Code, through
 * `ClaudeAgentTurnRunner`, unchanged.
 *
 * Readiness adds the runner's own two pre-turn rungs after the folder's: is
 * there a `claude` on this machine, and is it logged in. A list-time check
 * answers both from cached state — detection is memoized, and the login probe
 * holds its answer behind a short window — so a list can ask on every render.
 * A check the user asked for (`fresh`) goes past both caches, or *Check again*
 * would keep refusing an install or a login the user has just fixed.
 */
import type { ClaudeAuthStatus } from '../../../shared/engine'
import { describeEngineSkip } from '../../../shared/runtimeMessages'
import { createFolderDriver, type FolderDriver, type FolderDriverDeps } from './folderDriver'
import type { ReadinessOptions } from './driver'

export interface ClaudeDriverDeps extends FolderDriverDeps {
  /** Absolute path of the `claude` this machine has, or null. `fresh` detects again when there is none. */
  claudePath(options?: ReadinessOptions): Promise<string | null>
  /** Whether that install is logged in — `claudeAuthProbe.status()`, or `refresh()` when `fresh`. */
  claudeAuth(options?: ReadinessOptions): Promise<ClaudeAuthStatus>
}

export function createClaudeDriver(deps: ClaudeDriverDeps): FolderDriver {
  return createFolderDriver('claude', deps, {
    async readiness(_userId, _agent, options) {
      const claudePath = await deps.claudePath(options).catch(() => null)
      if (!claudePath) {
        return { state: 'not_installed', reason: describeEngineSkip('claude_not_installed') }
      }
      // Only a definite `logged_out` is not ready. A probe that could not
      // answer is `unknown`, which never blocks — the same rule the runner
      // applies before a turn, for the same reason: a readiness check that
      // refuses a working engine on its own uncertainty is worse than none.
      const auth = await deps.claudeAuth(options).catch(() => null)
      if (auth?.state === 'logged_out') {
        return { state: 'not_logged_in', reason: describeEngineSkip('claude_not_logged_in') }
      }
      return { state: 'ok', reason: null }
    }
  })
}
