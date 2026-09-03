/**
 * `/run:<name>` — execute one `docs/CLI_COMMANDS.yaml` entry as a subprocess
 * cwd'd to the agent's folder, and turn its outcome into a
 * {@link RunAgentTurnResult} the runner seam already knows how to persist and
 * stream (see `agentTurn/runner.ts`).
 *
 * ## Why this returns a turn result instead of a new shape
 *
 * `commandService` is never called through `AgentTurnRunner.runTurn` —
 * `/run:<name>` is intercepted *before* the runner is reached (see
 * `agent_a2a.ipc.ts`), specifically so `src/main/services/agentTurn/**`, which
 * Phase 6's mutation audit hardened, stays untouched. But `streamToAgent`
 * downstream only knows how to persist and post one shape, so this module
 * produces that shape directly rather than inventing a second one the caller
 * would have to branch on.
 *
 * ## The turn-lock decision
 *
 * A command runs under the same per-agent {@link turnLock} a model turn does.
 * Invariant 3 says the desktop never writes into a folder while a turn
 * streams, but the invariant's actual subject is *any* write racing the page
 * editors and the watcher — not specifically the engine. A `/run:<name>`
 * script is free to write anywhere under the folder (a status updater
 * touching `app-data/storage/STATUS.md` is the catalog's own worked example),
 * so it is exactly the kind of writer the lock exists to serialize against:
 * without it, an editor save or a concurrent model turn could land mid-script
 * and the folder would show a half-written file to whichever side lost the
 * race. Taking the lock also gets two more invariants for free, both already
 * proven by the runner: a second `/run:` for the same agent (or a model turn)
 * refuses immediately with the existing "busy" message instead of racing, and
 * the folder watcher defers its rescan until the command's writes have
 * settled rather than reading a half-written tree. See `commandService.test.ts`
 * for the mutation-checked proof (concurrent run refused; editor-write-alike
 * probe blocked while a command holds the lock; lock released after both a
 * clean exit and a spawn failure).
 *
 * `turnLock.anyHeld()` — the engine-wide predicate — is deliberately NOT used
 * here: a command never touches the shared `opencode serve` process, so there
 * is nothing engine-level to serialize against, only this one agent's folder.
 */

import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getLayoutView } from '../../kit/contractStore'
import { readCommandCatalog } from '../../kit/validator'
import { getShellEnv, shellEnvForChild } from '../../shell/env'
import { LocalAgentError } from '../../errors'
import { createLogger } from '../../logger/logger'
import { localAgentService } from './localAgentService'
import { turnLock } from './turnLock'
import type { RunAgentTurnResult } from '../a2aStreamingService'
import type { AgentTurnRunner } from '../agentTurn/runner'
import type { MessagePart } from '../../../shared/messageParts'
import { RUN_REFERENCE_PATTERN } from '../../../shared/kit/manifest'

const logger = createLogger('local-agent-command')

/** Combined stdout+stderr cap. A runaway script must not grow the DB row without bound. */
const MAX_OUTPUT_BYTES = 200_000

/**
 * Backstop on top of the turn lock: a hung script must not hold this agent's
 * folder locked for the life of the app. Shorter than `TURN_CEILING_MS`
 * (20 min, `localAgentTurnRunner.ts`) on purpose — a catalog command is a
 * script, not an LLM turn waiting on a model, so a much tighter ceiling is
 * the safe default and still generous for anything that belongs in a
 * one-click "Run" button.
 */
export const COMMAND_TIMEOUT_MS = 5 * 60 * 1000

function fail(message: string, raw?: string): RunAgentTurnResult {
  return { text: '', parts: [], notices: [], error: { message, raw: raw ?? message } }
}

function truncate(output: string): string {
  if (output.length <= MAX_OUTPUT_BYTES) return output
  return output.slice(0, MAX_OUTPUT_BYTES) + '\n…output truncated…'
}

interface SpawnOutcome {
  output: string
  /** Set when the process could not be started or ended abnormally (not a plain non-zero exit). */
  spawnError?: string
  exitCode: number | null
  timedOut: boolean
}

/**
 * Kill `child` and everything it forked, not just the shell `spawn(...,
 * {shell:true})` itself.
 *
 * **Why this exists, found by running it rather than reasoning about it**: a
 * plain `child.kill('SIGKILL')` only signals the shell process. The shell
 * dies, but a grandchild it already forked (the real command a pipeline or
 * `&&` sequence is running) is orphaned and keeps running — and, holding the
 * inherited stdout/stderr pipes open, keeps `execute()`'s `'close'` event
 * from firing until *it* finishes. A `sleep 2 && touch marker` killed this
 * way still never runs `touch` (the shell that would launch it is dead), but
 * the promise this module returns did not settle — and the turn lock this
 * exists to protect stayed held — until the full sleep finished anyway,
 * silently defeating both the abort and the timeout ceiling. `child.pid` is
 * spawned as the leader of its own process group (`detached` below on
 * POSIX), so signalling the *negative* pid reaches every process in it.
 * Windows has no process groups in this sense; `taskkill /T` is the
 * documented tree-kill there.
 */
function killTree(child: ReturnType<typeof spawn>): void {
  if (!child.pid) {
    try {
      child.kill('SIGKILL')
    } catch {
      // Never got a pid — nothing to signal at all.
    }
    return
  }
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {
      // Best-effort: the process may already be gone, which is success too.
    })
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    // The group is already gone, or this process was never its leader —
    // fall back to signalling the child directly.
    try {
      child.kill('SIGKILL')
    } catch {
      // Already gone either way.
    }
  }
}

/** Run `localCommand` under a shell, cwd'd to `agentDir`, and collect its output. */
function execute(
  localCommand: string,
  agentDir: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  timeoutMs: number = COMMAND_TIMEOUT_MS
): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    // `run()` awaits `getShellEnv()` before reaching here, so an abort fired
    // in that gap — a cancel issued the instant a turn starts — would
    // otherwise be lost: a listener added *after* `AbortSignal.abort()` has
    // already fired is never invoked for it, and the child would run to
    // completion unkilled. Checking here closes that gap without spawning
    // anything at all.
    if (signal?.aborted) {
      resolve({ output: '', exitCode: null, timedOut: false })
      return
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(localCommand, {
        cwd: agentDir,
        env,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        // New process group on POSIX so `killTree` can reach every process
        // the shell forks, not only the shell itself. Meaningless (and
        // harmless) on Windows, where `killTree` takes the `taskkill /T` path
        // instead.
        detached: process.platform !== 'win32'
      })
    } catch (err) {
      resolve({
        output: '',
        spawnError: err instanceof Error ? err.message : String(err),
        exitCode: null,
        timedOut: false
      })
      return
    }

    let output = ''
    let settled = false
    let timedOut = false

    const onAbort = (): void => killTree(child)
    signal?.addEventListener('abort', onAbort)

    const ceiling = setTimeout(() => {
      timedOut = true
      onAbort()
    }, timeoutMs)
    ceiling.unref?.()

    const append = (chunk: Buffer): void => {
      output += chunk.toString('utf8')
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)

    const finish = (outcome: Omit<SpawnOutcome, 'output' | 'timedOut'>): void => {
      if (settled) return
      settled = true
      clearTimeout(ceiling)
      signal?.removeEventListener('abort', onAbort)
      resolve({ output: truncate(output), timedOut, ...outcome })
    }

    child.once('error', (err) => finish({ spawnError: err.message, exitCode: null }))
    child.once('close', (code) => finish({ exitCode: code }))
  })
}

export interface CommandRunOutcome {
  ok: boolean
  /** Catalog entry name — what `/run:<name>` referenced. */
  name: string
  /** As localized and actually executed (`layout.localizeCommand`). */
  localCommand: string
  output: string
  exitCode: number | null
  /** Set when `ok` is false: a short, user-facing reason. */
  error?: string
}

export const commandService = {
  /**
   * `/run:<name>`, and only that — reuses the exact grammar
   * `validateAgentFolder` already checks `status_refresh_command` against
   * (`RUN_REFERENCE_PATTERN`), so a chat message has to look exactly like a
   * reference the validator would also accept. Anchored to the *whole*
   * trimmed message on purpose: `/run:check please` is chat text that happens
   * to start with a command reference, not an invocation, and falls through
   * to the engine unchanged.
   */
  matchRunCommand(wireContent: string): string | null {
    const match = RUN_REFERENCE_PATTERN.exec(wireContent.trim())
    return match ? match[1] : null
  },

  /**
   * Run catalog command `name` for `agentId`, cwd'd to its folder, under the
   * turn lock. Never throws — every failure path (not in the catalog, the
   * agent folder gone, the localized binary not on PATH, a non-zero exit, a
   * spawn that throws) comes back as `ok: false` with a user-facing `error`
   * and whatever output the process did produce before failing.
   */
  async run(
    userId: string,
    agentId: string,
    name: string,
    signal?: AbortSignal,
    timeoutMs: number = COMMAND_TIMEOUT_MS
  ): Promise<CommandRunOutcome> {
    let located: ReturnType<typeof localAgentService.locate>
    try {
      located = localAgentService.locate(userId, agentId)
    } catch (err) {
      const message =
        err instanceof LocalAgentError ? err.message : 'That agent is no longer in your agents folder.'
      logger.warn('command run: agent could not be located', { agentId, error: String(err) })
      return { ok: false, name, localCommand: '', output: '', exitCode: null, error: message }
    }
    const { root, agentDir } = located

    const layout = getLayoutView(root.path)
    const catalogPath = layout.layout.agent.command_catalog
    const catalog = readCommandCatalog(agentDir, catalogPath)
    const entry = catalog.commands.find((c) => c.name === name)
    if (!entry) {
      return {
        ok: false,
        name,
        localCommand: '',
        output: '',
        exitCode: null,
        error: `No command named "${name}" in ${catalogPath}.`
      }
    }

    const context = { hasPyproject: existsSync(join(agentDir, 'pyproject.toml')) }
    const localCommand = layout.localizeCommand(entry.command, context)

    try {
      return await turnLock.withLock(agentId, 'command', async () => {
        const env = shellEnvForChild(await getShellEnv())
        const outcome = await execute(localCommand, agentDir, env, signal, timeoutMs)

        if (outcome.spawnError) {
          return {
            ok: false,
            name,
            localCommand,
            output: outcome.output,
            exitCode: null,
            error: `"${localCommand}" could not run: ${outcome.spawnError}`
          }
        }
        if (outcome.timedOut) {
          return {
            ok: false,
            name,
            localCommand,
            output: outcome.output,
            exitCode: outcome.exitCode,
            error: `"${localCommand}" did not finish within ${Math.round(COMMAND_TIMEOUT_MS / 1000)}s and was stopped.`
          }
        }
        if (outcome.exitCode !== 0) {
          return {
            ok: false,
            name,
            localCommand,
            output: outcome.output,
            exitCode: outcome.exitCode,
            error: `"${localCommand}" exited with code ${outcome.exitCode}.`
          }
        }
        return { ok: true, name, localCommand, output: outcome.output, exitCode: 0 }
      })
    } catch (err) {
      // `turnLock.acquire` throws `LocalAgentError('turn_in_progress', …)` and
      // never queues — see the module header. `runForTurn`'s contract (like
      // `AgentTurnRunner.runTurn`) is that it never throws, so this is caught
      // here rather than left for the IPC handler to rediscover.
      const message = err instanceof Error ? err.message : String(err)
      logger.warn('command could not start', { agentId, name, error: message })
      return { ok: false, name, localCommand, output: '', exitCode: null, error: message }
    }
  },

  /**
   * {@link run}, shaped into the `RunAgentTurnResult` the runner seam
   * persists and streams. A successful run becomes one `command_result` part
   * (`cinna.command_invocation` always set, per `messageParts.ts`); every
   * failure becomes a turn error, so it renders through the same
   * already-built, already-tested error banner every other turn failure
   * does — expandable to the captured output via its `raw`/`detail` field,
   * rather than a second rendering path this phase would have to invent.
   */
  async runForTurn(
    userId: string,
    agentId: string,
    name: string,
    signal?: AbortSignal
  ): Promise<RunAgentTurnResult> {
    const outcome = await this.run(userId, agentId, name, signal)
    const invocation = `/run:${name}`
    if (!outcome.ok) {
      return fail(outcome.error ?? `"${invocation}" failed.`, outcome.output || outcome.error)
    }
    const body = outcome.output.trim().length > 0 ? outcome.output.trim() : '_(no output)_'
    const text = `\`\`\`\n${body}\n\`\`\``
    const part: MessagePart = { kind: 'command_result', text, commandInvocation: invocation }
    return { text, parts: [part], notices: [] }
  }
}

/**
 * The `/run:<name>` interception point, called from `agent_a2a.ipc.ts` before
 * `streamToAgent`. Extracted as a pure, directly testable function rather than
 * left inline in the IPC handler: which runner a message actually goes
 * through is exactly the kind of decision a mutation could silently break
 * (e.g. `runCommandName` computed but never wired in) with no failing test to
 * catch it, and the IPC handler itself is not unit-testable without spinning
 * up `ipcMain`.
 *
 * Never touches `resolveTurnRunner` or anything under `agentTurn/**` — a
 * non-folder agent, or a folder-agent message that is not a bare
 * `/run:<name>`, returns `fallback` unchanged.
 */
export function resolveCommandRunner(
  isFolder: boolean,
  wireContent: string,
  agentOwnerId: string,
  agentId: string,
  fallback: AgentTurnRunner
): AgentTurnRunner {
  if (!isFolder) return fallback
  const name = commandService.matchRunCommand(wireContent)
  if (!name) return fallback
  return {
    runTurn: (input) => commandService.runForTurn(agentOwnerId, agentId, name, input.signal)
  }
}
