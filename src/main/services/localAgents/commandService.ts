/**
 * `/run:<name>` — execute one `docs/CLI_COMMANDS.yaml` entry as a subprocess
 * cwd'd to the agent's folder, and turn its outcome into a
 * {@link RunAgentTurnResult} the runner seam already knows how to persist and
 * stream (see `agents/drivers/driver.ts`).
 *
 * ## Interactive and scheduled adapters
 *
 * `runExecutionService` intercepts `/run:<name>` before the agent driver:
 * a desktop catalog command is a local script rather than a model prompt.
 * `streamToAgent`
 * downstream only knows how to persist and post one shape, so this module
 * preserves that shape through an adapter. Scheduled commands share the same
 * executor and expose separate bounded streams and lifecycle evidence.
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
 * proven generically for other owner pairs (`turnLock.test.ts`,
 * `localAgentService.test.ts:285-293`) and now proven for this exact pair
 * too: a second `/run:` for the same agent refuses immediately with the
 * existing "busy" message instead of racing (`commandService.test.ts`'s
 * "the turn lock" suite), an **editor write** is refused the same way while a
 * command is running (`turnLock.acquire(agentId, 'editor')` throws — same
 * suite, "blocks an editor write"; mutation-checked: removing the
 * `turnLock.withLock` wrapper fails that test), and the folder watcher defers
 * its rescan until the command's writes have settled (this is
 * `watcherService`'s own `turnLock.isLocked`/`whenFree` consumption,
 * unmodified by this file and covered by `watcherService.test.ts` — not
 * re-proven here for the 'command' owner specifically). Lock release is
 * proven after a clean exit, a spawn failure, an abort and a timeout, all in
 * the same suite.
 *
 * `turnLock.anyHeld()` — the engine-wide predicate — is deliberately NOT used
 * here: a command never touches the shared `opencode serve` process, so there
 * is nothing engine-level to serialize against, only this one agent's folder.
 */

import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import type { ScheduleCommandOutcome } from '../../../shared/localSchedules'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getLayoutView } from '../../kit/contractStore'
import { readCommandCatalog } from '../../kit/validator'
import { getShellEnv, shellEnvForChild } from '../../shell/env'
import { LocalAgentError } from '../../errors'
import { createLogger } from '../../logger/logger'
import { localAgentService } from './localAgentService'
import { turnLock } from './turnLock'
import type { RunAgentTurnResult, TurnRun } from '../a2aStreamingService'
import type { AgentCapabilities } from '../../../shared/agentDrivers'
import type { MessagePart } from '../../../shared/messageParts'
import { RUN_REFERENCE_PATTERN } from '../../../shared/kit/manifest'

const logger = createLogger('local-agent-command')
let prepareCredentials: (agentId: string) => Promise<{ path?: string }> = async () => ({})
export function installCommandCredentialPreparation(prepare: typeof prepareCredentials): void { prepareCredentials = prepare }

/**
 * Combined stdout+stderr cap. A runaway script must not grow the DB row — or
 * this process's heap — without bound: `execute()` stops *accumulating* the
 * moment the cap is crossed (while still draining the pipes so the child
 * never blocks on a full buffer), rather than buffering everything and
 * trimming at the end.
 */
export const MAX_OUTPUT_BYTES = 200_000

/**
 * Backstop on top of the turn lock: a hung script must not hold this agent's
 * folder locked for the life of the app. Shorter than `TURN_CEILING_MS`
 * (80 min, `ACP_TURN_CEILING_MS`) on purpose — a catalog command is a
 * script, not an LLM turn waiting on a model, so a much tighter ceiling is
 * the safe default and still generous for anything that belongs in a
 * one-click "Run" button.
 */
export const COMMAND_TIMEOUT_MS = 5 * 60 * 1000

function fail(message: string, raw?: string): RunAgentTurnResult {
  return { text: '', parts: [], notices: [], error: { message, raw: raw ?? message } }
}

const TRUNCATION_MARKER = '\n…output truncated…'

interface SpawnOutcome extends ScheduleCommandOutcome {
  /** Original interleaved stream presentation for interactive commands. */
  output: string
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
  const startedAt = Date.now()
  const empty = (): SpawnOutcome => ({ output: '', stdout: '', stderr: '', exitCode: null,
    startedAt, finishedAt: Date.now(), timedOut: false, aborted: false,
    stdoutTruncated: false, stderrTruncated: false })
  return new Promise((resolve) => {
    // `run()` awaits `getShellEnv()` before reaching here, so an abort fired
    // in that gap — a cancel issued the instant a turn starts — would
    // otherwise be lost: a listener added *after* `AbortSignal.abort()` has
    // already fired is never invoked for it, and the child would run to
    // completion unkilled. Checking here closes that gap without spawning
    // anything at all.
    if (signal?.aborted) {
      resolve({ ...empty(), aborted: true })
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
        ...empty(),
        spawnError: err instanceof Error ? err.message : String(err)
      })
      return
    }

    // Each collection is byte-bounded while pipes continue to drain. Keep the
    // interleaved presentation independently so existing chat output is stable.
    const collected = {
      output: { chunks: [] as Buffer[], bytes: 0, truncated: false },
      stdout: { chunks: [] as Buffer[], bytes: 0, truncated: false },
      stderr: { chunks: [] as Buffer[], bytes: 0, truncated: false }
    }
    let settled = false
    let timedOut = false

    const onAbort = (): void => killTree(child)
    signal?.addEventListener('abort', onAbort)
    const ceiling = setTimeout(() => { timedOut = true; onAbort() }, timeoutMs)
    ceiling.unref?.()

    const append = (key: keyof typeof collected, chunk: Buffer): void => {
      const target = collected[key]
      const remaining = MAX_OUTPUT_BYTES - target.bytes
      if (chunk.length > remaining) target.truncated = true
      if (remaining <= 0) return
      const kept = chunk.subarray(0, remaining)
      target.chunks.push(kept)
      target.bytes += kept.length
    }
    child.stdout?.on('data', (chunk: Buffer) => { append('stdout', chunk); append('output', chunk) })
    child.stderr?.on('data', (chunk: Buffer) => { append('stderr', chunk); append('output', chunk) })

    const finish = (outcome: { spawnError?: string; exitCode: number | null }): void => {
      if (settled) return
      settled = true
      clearTimeout(ceiling)
      signal?.removeEventListener('abort', onAbort)
      const output = Buffer.concat(collected.output.chunks).toString('utf8')
      resolve({
        ...empty(),
        output: collected.output.truncated ? output + TRUNCATION_MARKER : output,
        stdout: Buffer.concat(collected.stdout.chunks).toString('utf8'),
        stderr: Buffer.concat(collected.stderr.chunks).toString('utf8'),
        stdoutTruncated: collected.stdout.truncated,
        stderrTruncated: collected.stderr.truncated,
        timedOut,
        aborted: signal?.aborted === true,
        ...outcome
      })
    }

    child.once('error', (err) => finish({ spawnError: err.message, exitCode: null }))
    child.once('close', (code) => finish({ exitCode: code }))
  })
}

/**
 * Shared environment/lock lifetime; resolves only after the command lock is released.
 * Interactive callers are refused at once while the agent is busy (`busy`); a
 * scheduled run passes `queueSignal` and waits its turn instead, until aborted.
 */
async function executeForAgent(agentId: string, agentDir: string, localCommand: string, signal?: AbortSignal,
  timeoutMs = COMMAND_TIMEOUT_MS, queueSignal?: AbortSignal, onStart?: () => void): Promise<SpawnOutcome> {
  const body = async (): Promise<SpawnOutcome> => {
    // First statement under the lock: from here on the command may have had effects.
    onStart?.()
    const env = shellEnvForChild(await getShellEnv())
    const prepared = await prepareCredentials(agentId)
    delete env.CINNA_CREDENTIALS_PATH
    if (prepared.path) env.CINNA_CREDENTIALS_PATH = prepared.path
    const outcome = await execute(localCommand, agentDir, env, signal, timeoutMs)
    const { redactCredentialText } = await import('../../security/serviceCredentialRedaction')
    outcome.stdoutIsExactOk = !outcome.stdoutTruncated && outcome.stdout.trim() === 'OK'
    outcome.output = redactCredentialText(outcome.output)
    outcome.stdout = redactCredentialText(outcome.stdout)
    outcome.stderr = redactCredentialText(outcome.stderr)
    if (outcome.spawnError) outcome.spawnError = redactCredentialText(outcome.spawnError)
    return outcome
  }
  return queueSignal ? turnLock.withQueuedLock(agentId, 'command', queueSignal, body) : turnLock.withLock(agentId, 'command', body)
}

export interface CommandRunOutcome {
  ok: boolean
  /** Catalog entry name — what `/run:<name>` referenced. */
  name: string
  /** As localized and actually executed (`layout.localizeCommand`). */
  localCommand: string
  output: string
  exitCode: number | null
  /**
   * The caller cancelled it (`signal` fired). Always `ok: false`, but a
   * cancel is not a failure of the command — a caller that consumes {@link run}
   * directly (rather than through `streamToAgent`, which already suppresses
   * the error surface on abort) must not log or display it as one.
   */
  aborted: boolean
  /**
   * The per-agent turn lock refused this run — a model turn, an editor save or
   * another command holds it. Always `ok: false`, but like {@link aborted} it
   * is not a failure *of the command*: nothing ran, and the same call a moment
   * later may well succeed. Without this flag the refusal is structurally
   * indistinguishable from a script that exited non-zero, because
   * `turnLock.acquire`'s `LocalAgentError('turn_in_progress')` reaches the
   * outer catch as a plain message. `statusRefresh` treats it as a soft no-op
   * — the same shape as the remote `get` swallowing a 429.
   */
  busy: boolean
  /** Set when `ok` is false: a short, user-facing reason. */
  error?: string
}

export const commandService = {
  /** Resolve once for review and compare again before scheduled admission. */
  resolve(userId: string, agentId: string, command: string): { localCommand: string; revision: string } {
    if (typeof command !== 'string' || !command.trim() || command.length > 64000 || command.includes('\0')) {
      throw new Error('The schedule command must contain 1–64000 characters and no null bytes.')
    }
    const { root, agentDir } = localAgentService.locate(userId, agentId)
    const match = RUN_REFERENCE_PATTERN.exec(command.trim())
    let localCommand = command
    let source: unknown = command
    if (command.trim().startsWith('/run:') && !match) throw new Error('Use an exact /run:<name> catalog reference.')
    if (match) {
      const layout = getLayoutView(root.path)
      const catalog = readCommandCatalog(agentDir, layout.layout.agent.command_catalog)
      const entries = catalog.commands.filter((entry) => entry.name === match[1])
      if (entries.length !== 1) throw new Error(`No unique command named "${match[1]}" in ${layout.layout.agent.command_catalog}.`)
      source = entries[0]
      localCommand = layout.localizeCommand(entries[0].command, { hasPyproject: existsSync(join(agentDir, 'pyproject.toml')) })
    }
    return { localCommand, revision: createHash('sha256').update(JSON.stringify([source, localCommand])).digest('hex') }
  },

  /** Run the captured reviewed command; never re-resolve an edited catalog here. */
  async runScheduled(userId: string, agentId: string, resolvedCommand: string, signal?: AbortSignal,
    timeoutMs = COMMAND_TIMEOUT_MS): Promise<ScheduleCommandOutcome> {
    const startedAt = Date.now()
    // Set by the lock body itself, never inferred from an error message: a run
    // aborted while still queued for the turn lock never started.
    let started = false
    try {
      const { agentDir } = localAgentService.locate(userId, agentId)
      // A schedule waits behind a chat turn, editor save or another command on
      // this agent rather than failing its occurrence; the signal ends the wait.
      const { output: _output, ...outcome } = await executeForAgent(agentId, agentDir, resolvedCommand, signal, timeoutMs,
        signal ?? new AbortController().signal, () => { started = true })
      return { ...outcome, started }
    } catch (error) {
      const { redactCredentialText } = await import('../../security/serviceCredentialRedaction')
      const aborted = signal?.aborted === true
      return { stdout: '', stderr: '', exitCode: null, startedAt, finishedAt: Date.now(),
        timedOut: false, aborted, started,
        spawnError: aborted ? undefined : redactCredentialText(error instanceof Error ? error.message : String(error)),
        stdoutTruncated: false, stderrTruncated: false }
    }
  },

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
   * agent folder gone, the kit contract unreadable, the localized binary not
   * on PATH, a non-zero exit, a spawn that throws, a cancel, the ceiling)
   * comes back as `ok: false` with a user-facing `error` and whatever output
   * the process did produce before failing.
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
      return {
        ok: false, name, localCommand: '', output: '', exitCode: null,
        aborted: false, busy: false, error: message
      }
    }
    const { root, agentDir } = located

    // `readCommandCatalog` never throws, but `getLayoutView` does when the
    // kit contract itself cannot be loaded (`KitError`), and this function's
    // contract is that it never does — so the whole lookup is guarded, not
    // just the one call known to throw today.
    let localCommand: string
    let catalogPath: string
    try {
      const layout = getLayoutView(root.path)
      catalogPath = layout.layout.agent.command_catalog
      const catalog = readCommandCatalog(agentDir, catalogPath)
      const entry = catalog.commands.find((c) => c.name === name)
      if (!entry) {
        return {
          ok: false,
          name,
          localCommand: '',
          output: '',
          exitCode: null,
          aborted: false,
          busy: false,
          error: `No command named "${name}" in ${catalogPath}.`
        }
      }
      const context = { hasPyproject: existsSync(join(agentDir, 'pyproject.toml')) }
      localCommand = layout.localizeCommand(entry.command, context)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn('command run: catalog could not be resolved', { agentId, name, error: message })
      return {
        ok: false,
        name,
        localCommand: '',
        output: '',
        exitCode: null,
        aborted: false,
        busy: false,
        error: `The command catalog could not be read: ${message}`
      }
    }

    try {
      const outcome = await executeForAgent(agentId, agentDir, localCommand, signal, timeoutMs)

      if (outcome.spawnError) {
        return {
          ok: false,
          name,
          localCommand,
          output: outcome.output,
          exitCode: null,
          aborted: false,
          busy: false,
          error: `"${localCommand}" could not run: ${outcome.spawnError}`
        }
      }
      // Timeout before abort: the ceiling kills through the same path a
      // cancel does, but the caller's signal never fires for it, so the two
      // are distinguishable — and a run that hit the ceiling *and* was then
      // cancelled is still a timeout, which is the fact worth reporting.
      if (outcome.timedOut) {
        return {
          ok: false,
          name,
          localCommand,
          output: outcome.output,
          exitCode: outcome.exitCode,
          aborted: false,
          busy: false,
          error: `"${localCommand}" did not finish within ${Math.ceil(timeoutMs / 1000)}s and was stopped.`
        }
      }
      if (outcome.aborted) {
        return {
          ok: false,
          name,
          localCommand,
          output: outcome.output,
          exitCode: outcome.exitCode,
          aborted: true,
          busy: false,
          error: `"${localCommand}" was cancelled.`
        }
      }
      if (outcome.exitCode !== 0) {
        return {
          ok: false,
          name,
          localCommand,
          output: outcome.output,
          exitCode: outcome.exitCode,
          aborted: false,
          busy: false,
          error: `"${localCommand}" exited with code ${outcome.exitCode}.`
        }
      }
      return {
        ok: true, name, localCommand, output: outcome.output, exitCode: 0,
        aborted: false, busy: false
      }
    } catch (err) {
      // `turnLock.acquire` throws `LocalAgentError('turn_in_progress', …)` and
      // never queues — see the module header. `runForTurn`'s contract (like
      // the driver result contract) is that it never throws, so this is caught
      // here rather than left for the execution service to rediscover.
      const message = err instanceof Error ? err.message : String(err)
      // The lock refusing is the *expected* outcome of an unlucky moment, not
      // a fault: `warn` is reserved for a start that genuinely failed.
      const busy = err instanceof LocalAgentError && err.code === 'turn_in_progress'
      if (busy) logger.debug('command deferred: agent busy', { agentId, name })
      else logger.warn('command could not start', { agentId, name, error: message })
      return {
        ok: false, name, localCommand, output: '', exitCode: null,
        aborted: false, busy, error: message
      }
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
 * Never touches the agent's driver or anything under `agents/drivers/**` — an
 * agent whose commands do not come from a folder catalog, or a catalog
 * agent's message that is not a bare `/run:<name>`, returns `fallback`
 * unchanged. Decided on the driver's `capabilities.commands`, not on what kind
 * of agent it is.
 */
export function resolveCommandRunner(
  commands: AgentCapabilities['commands'],
  wireContent: string,
  agentOwnerId: string,
  agentId: string,
  fallback: TurnRun
): TurnRun {
  if (commands !== 'catalog') return fallback
  const name = commandService.matchRunCommand(wireContent)
  if (!name) return fallback
  return (io) => commandService.runForTurn(agentOwnerId, agentId, name, io.signal)
}
