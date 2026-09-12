/**
 * Installing a **runtime** — the `claude` or `codex` CLI an agent runs on — by
 * running the vendor's own published installer.
 *
 * ## Why this exists
 *
 * A user who has just installed this desktop very often has neither an API key
 * nor a CLI, and the two states have completely different remedies: the key is
 * a form in Settings, the CLI is a command in a terminal the app cannot help
 * with. Settings → Runtime reports which runtimes this machine has; a row that
 * reports "Not found" and offers nothing is a diagnosis without a fix
 * (ux_rules rule 12), and that is what this closes.
 *
 * ## The rules it keeps
 *
 * - **The command is a constant, never a parameter.** `install` takes an id and
 *   looks the command up in {@link INSTALLERS}. Nothing a renderer sends is
 *   interpolated into a shell string — the id is checked against the table and
 *   an unknown one is refused.
 * - **The user is shown the exact command first.** The renderer reads the same
 *   table through `plans()` and puts it, verbatim, in the confirm dialog. This
 *   app is about to run a third-party script that writes to the user's machine,
 *   under their account, and doing that behind a button labelled *Install* and
 *   nothing else would be a side effect they did not agree to.
 * - **One install at a time, per tool.** Two concurrent runs of the same
 *   installer is a corrupted install; the guard is the in-flight map, keyed by
 *   tool. It is deliberately not an overall lock: nothing here serialises a
 *   `claude` install against a `codex` one, and the reason it is safe today is
 *   that the UI offers one button at a time, not that this file enforces it.
 * - **Nothing is installed for the user without a click.** There is no
 *   auto-install path, at first run or anywhere else.
 * - **A child is killed as a group, and never outlives the app.** The installer
 *   is a pipeline — `curl` into a shell — so signalling the `sh` alone leaves
 *   the download and the script it feeds running; and a `will-quit` that did
 *   not reach them would leave a script writing the user's home directory with
 *   no window left to report it.
 *
 * ## What it does not do
 *
 * It does not manage, update, pin or verify what it installed. The installers
 * here are the vendors' own and they own their own update story — Claude Code
 * updates itself, `codex` is a package the user's package manager owns. This is
 * a convenience over the terminal the user would otherwise open, and the moment
 * it becomes more than that it should be a managed download like the engine's,
 * with a pinned version and a recorded hash.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { homedir } from 'node:os'
import { createLogger } from '../../logger/logger'
import { getShellEnv, resetShellEnv, shellEnvForChild } from '../../shell/env'
import { toolDetectionService } from './toolDetectionService'
import { LocalToolsError } from '../../errors'
import {
  isRuntimeToolId,
  type DetectedTool,
  type RuntimeToolId,
  type ToolInstallPlan,
  type ToolInstallProgress
} from '../../../shared/localTools'

const logger = createLogger('tool-install')

/**
 * How long one installer may run before it is abandoned.
 *
 * Generous: Claude Code's installer downloads a ~190 MB binary and `codex`'s
 * fetches a release archive, both over whatever connection the user has. The
 * ceiling exists so a wedged installer cannot hold the button in `Installing…`
 * for the rest of the session, not to bound a normal run.
 */
const INSTALL_TIMEOUT_MS = 15 * 60_000

/** Longest output line kept for the UI. The full output goes to the log. */
const MAX_LINE = 160

interface InstallerSpec {
  label: string
  /**
   * The vendor's published command for this platform, as they publish it.
   *
   * Written out per platform rather than assembled, because a command line is
   * exactly the kind of string that must be readable next to the vendor's own
   * documentation when someone comes to check it.
   */
  command: Partial<Record<NodeJS.Platform, string>>
  docsUrl: string
}

/**
 * The installers, verbatim from each vendor's install page.
 *
 * Windows is deliberately absent from both `command` maps. Its published
 * installers are PowerShell one-liners (`irm … | iex`), and running one through
 * a shell this app picked, in a process with no console attached, is a
 * different set of failure modes than the POSIX case — so that platform is sent
 * to the documentation instead of to a button that would have to guess.
 */
const INSTALLERS: Record<RuntimeToolId, InstallerSpec> = {
  claude: {
    label: 'Claude Code',
    command: {
      darwin: 'curl -fsSL https://claude.ai/install.sh | bash',
      linux: 'curl -fsSL https://claude.ai/install.sh | bash'
    },
    docsUrl: 'https://code.claude.com/docs/en/setup'
  },
  codex: {
    label: 'Codex',
    command: {
      darwin: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
      linux: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh'
    },
    docsUrl: 'https://github.com/openai/codex'
  }
}

/** In-flight installs, keyed by tool. The concurrency guard and nothing more. */
const running = new Map<RuntimeToolId, Promise<ToolInstallProgress>>()

/**
 * The child processes, so quitting can reach them.
 *
 * Separate from {@link running}, which holds promises: what `will-quit` needs is
 * the handle to signal, and a promise cannot be killed.
 */
const active = new Set<ChildProcess>()

/**
 * Kill a child and everything it forked.
 *
 * The negative pid signals the whole group `detached: true` made this child the
 * leader of. Modelled on `acpConnection.killTree` — the same problem, the same
 * answer — and a failure here is the outcome we wanted: the only reason a group
 * refuses a signal is that it is already gone.
 */
function killTree(child: ChildProcess): void {
  if (!child.pid) return
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      // Already reaped.
    }
  }
}

/** Subscribers — the IPC layer, forwarding to the window. */
const listeners = new Set<(progress: ToolInstallProgress) => void>()

function emit(progress: ToolInstallProgress): void {
  for (const listener of listeners) {
    try {
      listener(progress)
    } catch (err) {
      logger.warn('an install progress listener threw', {
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }
}

function planFor(id: RuntimeToolId): ToolInstallPlan {
  const spec = INSTALLERS[id]
  return {
    id,
    label: spec.label,
    command: spec.command[process.platform] ?? null,
    docsUrl: spec.docsUrl
  }
}

/**
 * The last line worth showing, out of a chunk of installer output.
 *
 * Carriage returns are split on as well as newlines: a progress bar rewrites
 * one line with `\r`, and treating the chunk as a single line would show the
 * whole bar's history as one very long string.
 */
function lastLine(chunk: string): string | null {
  const lines = chunk
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
  const line = lines.at(-1)
  return line ? line.slice(0, MAX_LINE) : null
}

async function run(id: RuntimeToolId, command: string): Promise<ToolInstallProgress> {
  const env = shellEnvForChild(await getShellEnv())
  return await new Promise<ToolInstallProgress>((resolve) => {
    /**
     * `sh -c`, with the command as a **single argument and no user input in
     * it**. The shell is needed because the vendors publish pipelines
     * (`curl … | bash`); what makes that acceptable is that the string is a
     * constant in this file, shown to the user before it ran.
     *
     * `cwd` is the home directory: an installer that writes a stray file should
     * not do it inside whatever directory Electron was launched from.
     */
    const child = spawn('/bin/sh', ['-c', command], {
      cwd: homedir(),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      /*
        **Its own process group**, which is what makes the kill below mean
        anything. The command is a pipeline — `curl` writing into a shell — so
        the `sh` this spawns is one of at least three processes, and signalling
        it alone leaves the download and the installer script running with
        nothing left that knows about them. Same reason, and the same shape, as
        the ACP process pool's children.
      */
      detached: true
    })
    active.add(child)

    let line: string | null = null
    /** The tail of the output, for the failure sentence and the log. */
    let tail = ''
    let settled = false

    const timer = setTimeout(() => {
      logger.warn('an installer exceeded its ceiling and was killed', { id })
      killTree(child)
    }, INSTALL_TIMEOUT_MS)

    const absorb = (chunk: Buffer): void => {
      const text = chunk.toString()
      tail = (tail + text).slice(-4000)
      const next = lastLine(text)
      if (next && next !== line) {
        line = next
        emit({ id, state: 'running', line, error: null })
      }
    }
    child.stdout.on('data', absorb)
    child.stderr.on('data', absorb)

    const finish = (progress: ToolInstallProgress): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      active.delete(child)
      emit(progress)
      resolve(progress)
    }

    child.on('error', (err) => {
      logger.warn('an installer could not be started', { id, error: err.message })
      finish({
        id,
        state: 'failed',
        line: null,
        error: 'That installer could not be started on this machine.'
      })
    })

    child.on('close', (code) => {
      if (code === 0) {
        logger.info('installer finished', { id })
        finish({ id, state: 'done', line, error: null })
        return
      }
      logger.warn('installer failed', { id, code, output: tail.slice(-1000) })
      finish({
        id,
        state: 'failed',
        line,
        // The installer's own last words, when it had any. They are what names
        // the actual problem — no network, a read-only prefix, a missing
        // `curl` — and a generic sentence in their place sends the user to
        // support with nothing.
        error: line
          ? `The installer stopped: ${line}`
          : `The installer exited with code ${code ?? 'unknown'}.`
      })
    })
  })
}

export const toolInstallService = {
  /** What this platform would run for each installable runtime. */
  plans(): ToolInstallPlan[] {
    return (Object.keys(INSTALLERS) as RuntimeToolId[]).map(planFor)
  },

  /**
   * Kill every running installer. Fired from `will-quit`.
   *
   * Synchronous to the last signal, like the ACP pool's shutdown, because
   * Electron does not await a `will-quit` handler: anything after the first
   * `await` may never run, so the kill happens before there is one.
   */
  shutdown(): void {
    for (const child of active) killTree(child)
    active.clear()
  },

  /** Subscribe to progress. Returns an unsubscribe. */
  onProgress(listener: (progress: ToolInstallProgress) => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },

  /**
   * Run the vendor's installer for one runtime, then look for it again.
   *
   * Resolves with the outcome — including a failure — rather than rejecting:
   * a failed install is a state the dialog renders beside the button that was
   * pressed (ux_rules rule 6), and a rejection would lose its sentence crossing
   * the bridge. The one thing that *throws* is being asked for a tool this
   * build has no installer for, which is a programming error rather than a
   * state a user can reach.
   */
  async install(id: unknown): Promise<ToolInstallProgress> {
    if (!isRuntimeToolId(id)) {
      throw new LocalToolsError('tool_unavailable', 'That is not a runtime Cinna can install.')
    }
    const plan = planFor(id)
    if (!plan.command) {
      // Emitted as well as returned, like every other outcome: the dialog reads
      // the pushed progress, and a failure that only came back through the
      // invoke would leave a subscriber sitting on `running` for ever.
      const refused: ToolInstallProgress = {
        id,
        state: 'failed',
        line: null,
        error: `Cinna cannot install ${plan.label} on this platform. Follow the vendor's instructions instead.`
      }
      emit(refused)
      return refused
    }
    const inFlight = running.get(id)
    if (inFlight) return await inFlight

    const started = (async (): Promise<ToolInstallProgress> => {
      emit({ id, state: 'running', line: null, error: null })
      logger.info('running an installer', { id, command: plan.command })
      const outcome = await run(id, plan.command as string)
      if (outcome.state !== 'done') return outcome

      /**
       * **Forget the login-shell environment before looking again.**
       *
       * Every one of these installers puts its binary somewhere the user's
       * shell profile is then edited to include — `~/.local/bin` for both of
       * today's two. The app resolved its PATH once, at startup, from a login
       * shell that ran before that edit; `clearToolCache` alone drops the
       * per-binary lookups but keeps that PATH, so detection would look in the
       * old set of directories and report the tool it had just installed as
       * missing. Re-probing the shell is what makes the row change without a
       * restart.
       */
      resetShellEnv()
      const tools = await toolDetectionService.refresh()
      const found = tools.find((tool: DetectedTool) => tool.id === id && tool.available)
      if (found) return outcome
      const invisible: ToolInstallProgress = {
        id,
        state: 'failed',
        line: outcome.line,
        // Not "the install failed" — it reported success, and saying otherwise
        // would send the user to install it a second time. What is true is that
        // this app still cannot see it, and where it looks.
        error: `${plan.label} installed, but Cinna could not find it on your PATH. Open a new terminal, check that ${plan.label} runs there, then press Refresh.`
      }
      // `run` already emitted `done` — the process really did succeed — so this
      // second push is what corrects it. The dialog stays open on it.
      emit(invisible)
      return invisible
    })().finally(() => running.delete(id))

    running.set(id, started)
    return await started
  }
}
