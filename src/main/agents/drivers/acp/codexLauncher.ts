import { createHash } from 'node:crypto'
import type { AgentReadiness } from '../../../../shared/agentDrivers'
import type { ClaudeApproval, CodexAuthStatus } from '../../../../shared/engine'
import type { ReadinessOptions } from '../driver'
import type { AcpLauncher } from './acpLaunchers'
import { ACP_PROTOCOL_VERSION, type AcpRuntimeMode } from './types'
import { airClientMeta } from './acpActivity'
import { createLogger } from '../../../logger/logger'

const logger = createLogger('codex-launcher')

/**
 * Only ever a **failed install** now. Cinna downloads and verifies its own
 * pinned Codex CLI, so "not installed" stopped being a thing the user does
 * something about in a terminal: the CLI is either here, on its way (the turn
 * waits for it), or could not be fetched — and only the last one refuses.
 */
export const CODEX_NOT_INSTALLED = 'Codex could not be installed. Try again in Settings → Agents → Runtime.'
export const CODEX_NOT_LOGGED_IN = 'Codex is not logged in. Run `codex login` in a terminal, then check again.'

/**
 * What is known about the Codex binary **without downloading anything**.
 *
 * - `ready` — the explicit Settings path or the managed pinned copy is on disk.
 * - `pending` — nobody has fetched it yet, or a fetch is running. Not a
 *   refusal: the turn that needs it resolves it, exactly as OpenCode's does.
 * - `failed` — the last attempt could not get one; `error` is its sentence.
 */
export type CodexBinaryKnown =
  | { state: 'ready' }
  | { state: 'pending' }
  | { state: 'failed'; error: string }

/**
 * {@link CodexLauncherDeps.binaryKnown} over the binary service, kept apart from
 * the wiring so its one promise is testable: **it never waits for a download.**
 *
 * *Check again* on a failed install is the user asking for another try, so
 * `fresh` starts one — and reports `pending` at once. Awaiting it put a ~90 MB
 * fetch with a ten-minute ceiling inside a readiness check that the agent card
 * and the build composer call while the user looks at them; its progress is
 * pushed to the UI by the service, which is where a wait that long belongs.
 */
export async function codexBinaryKnownFrom(deps: {
  state(): { state: 'unresolved' | 'resolving' | 'ready' } | { state: 'failed'; error: string }
  /** Starts a new resolution. Its promise is deliberately not awaited here. */
  refresh(): Promise<unknown>
  /** What would run without downloading — the binary service's memoised `peek`. */
  known(): Promise<string | null>
}, options?: ReadinessOptions): Promise<CodexBinaryKnown> {
  const state = deps.state()
  if (state.state === 'failed') {
    if (!options?.fresh) return { state: 'failed', error: state.error }
    void deps.refresh().catch(() => undefined)
    return { state: 'pending' }
  }
  if (state.state === 'ready') return { state: 'ready' }
  // Unresolved in this run is not "absent": a copy installed by an earlier
  // run is on disk, and saying so costs one stat.
  return (await deps.known()) ? { state: 'ready' } : { state: 'pending' }
}

export interface CodexLauncherDeps {
  /**
   * The binary this session runs on: the explicit path from Settings
   * (unpinned), else the managed pinned copy — **downloading and verifying it
   * if this machine has none**. Never the user's PATH copy. A failure is
   * returned as its user-facing sentence rather than thrown, because the
   * launcher's catch-all below deliberately discards thrown messages.
   */
  binary(): Promise<{ path: string } | { error: string }>
  /** Free, and never starts a download. `fresh` retries a failed install. */
  binaryKnown(options?: ReadinessOptions): Promise<CodexBinaryKnown>
  auth(options?: ReadinessOptions): Promise<CodexAuthStatus>
  adapterEntry(): string
  nodeRuntime(): { command: string; args: string[]; env: Record<string, string> }
  env(): Promise<Record<string, string>>
  /**
   * The system prompt for this turn, chosen by the folder's runtime mode: an
   * **isolated** folder's whole assembled document, or a **native** folder's
   * desktop context alone, because Codex reads that folder's `AGENTS.md`
   * itself. Read on every plan, so an edited folder takes effect on the next
   * turn.
   */
  systemPrompt(userId: string, agentId: string, mode: AcpRuntimeMode): string
  settings(userId: string, agentId: string): {
    model: string | null; effort: string; approval: ClaudeApproval
  }
}

/** Pinned app-server adapter, always driving Cinna's managed (or explicitly configured) Codex executable. */
export function createCodexLauncher(deps: CodexLauncherDeps): AcpLauncher {
  const loggedOut = async (options?: ReadinessOptions): Promise<boolean> => {
    const auth = await deps.auth(options).catch(() => {
      logger.warn('Codex authentication readiness check failed')
      return null
    })
    return auth?.state === 'logged_out'
  }
  const readiness = async (options?: ReadinessOptions): Promise<AgentReadiness> => {
    const known = await deps.binaryKnown(options).catch((): CodexBinaryKnown => {
      logger.warn('Codex executable state could not be read')
      return { state: 'pending' }
    })
    // Only a *failed* install refuses. `pending` stays `ok` on purpose: a send
    // joins the install at the top of its turn, and a readiness that refused
    // while the CLI was merely on its way would block the one action that
    // fetches it. The resolver's own sentence rides along as the detail.
    if (known.state === 'failed') {
      return { state: 'not_installed', reason: CODEX_NOT_INSTALLED, detail: known.error }
    }
    return (await loggedOut(options))
      ? { state: 'not_logged_in', reason: CODEX_NOT_LOGGED_IN }
      : { state: 'ok', reason: null }
  }
  return {
    id: 'codex', readiness,
    async plan(ctx) {
      if (!ctx.folder) return { error: 'This launcher requires a local agent folder.' }
      let phase = 'executable'
      try {
        // The binary first — this is the step that may download — and the login
        // after it, because the login is asked *of that binary*. A failure here
        // is not remembered: the next turn simply tries again.
        const binary = await deps.binary()
        if ('error' in binary) return { error: binary.error }
        const path = binary.path
        phase = 'readiness'
        if (await loggedOut()) return { error: CODEX_NOT_LOGGED_IN }
        let adapter: string
        try { adapter = deps.adapterEntry() } catch {
          logger.error('The Codex ACP adapter is missing from this installation', { agentId: ctx.agentId })
          return { error: 'The Codex adapter is missing from this installation. Reinstall Cinna Desktop.' }
        }
        phase = 'settings'
        const settings = deps.settings(ctx.userId, ctx.agentId)
        const modeId = settings.approval === 'auto' ? 'agent' : 'read-only'
        phase = 'instructions'
        const config = {
          // An isolated folder's whole assembled prompt; on the native branch
          // the desktop's context only, since Codex loads that folder's
          // `AGENTS.md` and the user's `~/.codex/config.toml` by itself,
          // exactly as it does for a terminal session there.
          developer_instructions: deps.systemPrompt(ctx.userId, ctx.agentId, ctx.folder.runtimeMode),
          ...(settings.model ? { model: settings.model } : {}),
          model_reasoning_effort: settings.effort
        }
        phase = 'runtime'
        const runtime = deps.nodeRuntime()
        phase = 'environment'
        const env = {
          ...await deps.env(), ...runtime.env,
          CODEX_PATH: path, CODEX_CONFIG: JSON.stringify(config), INITIAL_AGENT_MODE: modeId
        }
        // A changed prompt/model/effort must replace the pooled process, including on resume.
        const key = createHash('sha256').update(JSON.stringify([
          runtime.command, runtime.args, adapter, ctx.folder.path,
          Object.entries(env).sort(([a], [b]) => a.localeCompare(b))
        ])).digest('hex').slice(0, 32)
        return {
          spec: { command: runtime.command, args: [...runtime.args, adapter], env, cwd: ctx.folder.path, key },
          init: { protocolVersion: ACP_PROTOCOL_VERSION,
            // Background terminals only. Native subagent sessions would make
            // codex-acp swallow the spawn call, and nothing would link the
            // child to the chat; its subagents are read off the root session.
            clientCapabilities: { elicitation: { form: {} }, _meta: airClientMeta(['asyncTasks']) },
            clientInfo: { name: 'cinna-desktop', version: '1' } },
          session: { mcpServers: [] },
          sessionToolsFixed: true,
          // Enforce on both new and loaded sessions, before any prompt.
          setup: { modeId }
        }
      } catch {
        // Errors from CLI/config readers can contain credentials or instructions.
        logger.warn('Codex could not be prepared', { agentId: ctx.agentId, phase })
        return { error: 'Codex could not be prepared. Check the agent folder and Codex CLI installation.' }
      }
    }
  }
}
