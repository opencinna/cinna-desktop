/**
 * Getting one Cinna profile from "signed in" to "can develop agents locally",
 * and keeping it there.
 *
 * ## One entry point
 *
 * {@link localDevService.reconcile} is the only way anything here happens, and
 * it is idempotent — the same rule the engine's `ensureRunning` follows, for
 * the same reason. It runs after a Cinna user is activated, after a re-auth,
 * when the machine wakes, and when the user presses Repair. Every step checks
 * whether it is already satisfied and skips itself if so, so the common case (a
 * profile that was ready yesterday) is a discovery request, a `--version` probe
 * and a token check.
 *
 * There is deliberately no `install()`, no `createWorkspace()`, no `repair()`
 * that does something different: a second door into a state machine is a second
 * place for it to be entered halfway.
 *
 * ## What it does, in order
 *
 * 1. **Discover.** No `local_dev` block in `/.well-known/cinna-desktop` → the
 *    instance is not offering this. That is `unsupported/server`, a supported
 *    answer, and the end of it.
 * 2. **Consent.** Nothing is downloaded and nothing is written outside
 *    `userData` before the user has agreed, per host. Declining is remembered
 *    too, so the prompt does not come back every launch.
 * 3. **Toolchain.** uv, Mutagen and cinna-cli into `<userData>/localdev`.
 * 4. **Workspace.** `<AgentsHome>/Cloud/<host>/`, created by cinna-cli from a
 *    setup token this app mints with its own OAuth bearer. The single-use token
 *    is the thing that removes the second browser login.
 * 5. **Token.** An existing workspace is checked, not recreated; an expired
 *    token is refreshed in place with a fresh mint.
 *
 * A workspace someone created from a terminal at the same path is simply
 * adopted at step 5 — it is the same thing cinna-cli would have made.
 *
 * ## What it does not do
 *
 * It does not clone an agent, start a Mutagen session, or run `cinna dev`.
 * First run prepares; syncing an agent is a later, explicit action. And it does
 * not reimplement anything cinna-cli owns: no workspace layout, no token
 * exchange, no sync. The desktop is installer and orchestrator.
 *
 * ## The setup command is a secret
 *
 * `setup_command` carries a single-use token valid for fifteen minutes. It goes
 * from `cinnaFetch` into an argv array and nowhere else — never into a log,
 * never into an error `detail`, never into a state the renderer can read. The
 * `logArgs` parameter on {@link runCinnaCli} exists to make that a decision
 * someone has to take rather than a default someone can forget.
 */

import { homedir, hostname } from 'node:os'
import { lstat, mkdir, readlink, stat, symlink, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { BrowserWindow, shell } from 'electron'
import { userRepo } from '../db/users'
import { appSettingsRepo } from '../db/appSettings'
import { cinnaFetch } from '../services/cinna-http'
import { clearEndpointCache, discoverCinnaEndpoints } from '../auth/cinna-oauth'
import { agentsHomeService } from '../services/localAgents/agentsHomeService'
import { getLayout } from '../kit/contractStore'
import { CinnaApiError, ToolchainError } from '../errors'
import { createLogger } from '../logger/logger'
import { prefetchEngineBinary } from '../engine/binaryResolver'
import { runCinnaCli, type CliRunOutcome } from './cliRunner'
import {
  clearCliCapabilityCache,
  probeCliCapabilities,
  type CliCapabilities
} from './cliCapabilities'
import {
  toolchain,
  type ToolchainPins,
  type ToolchainProgressUpdate
} from './toolchain'
import {
  LOCAL_DEV_STATE_CHANNEL,
  type CinnaLocalDev,
  type LocalDevState,
  type LocalDevTask,
  type LocalDevTaskId
} from '../../shared/localDevState'

const logger = createLogger('local-dev')

/** cinna-cli's exit-code contract. Text is for people; these are for us. */
const EXIT_OK = 0
const EXIT_SETUP_TOKEN = 10
const EXIT_ACCOUNT_MISMATCH = 11
const EXIT_NETWORK = 12

/** The route that turns a desktop OAuth session into a cinna-cli setup token. */
const SETUP_TOKEN_PATH = '/api/v1/cli/account/setup-tokens'

interface SetupTokenCreated {
  setup_command: string
  expires_at?: string
}

/** `cinna account status --json`'s final line, as much of it as we read. */
interface AccountStatus {
  result: string
  workspace?: string
  token?: 'valid' | 'expired' | 'unreachable'
  context_package?: { state?: string }
}

/**
 * How the reconcile's two measurable halves share one bar.
 *
 * The toolchain reports 0..100 for itself and cinna-cli reports `step n of m`
 * for the workspace, and showing each on its own scale would send the bar back
 * to near-zero the moment the toolchain finished — which reads as a restart,
 * and is worse than no bar at all. So each is scaled into a slice of one
 * monotonic 0..100.
 *
 * The toolchain gets the larger share because on a cold profile it *is* the
 * wait: hundreds of megabytes against three short HTTP calls.
 */
const TOOLCHAIN_SHARE = 0.7
const WORKSPACE_FROM = 70
const WORKSPACE_TO = 97

/**
 * How much of the overall bar the engine pre-fetch is worth.
 *
 * It runs alongside everything else rather than in sequence, so it cannot have
 * a *range* the way the toolchain and the workspace do — it is a share, added
 * to whatever the sequential part has reached. Without it the bar would sit at
 * 97% for the length of a 46 MB download, which is the one shape a progress bar
 * exists to avoid.
 *
 * 0.15 because it is one download against a toolchain that is several, and
 * because it is very often already satisfied: a developer with their own
 * `opencode` reports 100 immediately and simply starts the bar at 15.
 */
const ENGINE_SHARE = 0.15

/** This run's engine progress, 0..100. Reset with the checklist. */
let enginePercent = 0

/**
 * The engine was not cached this run, and its row must survive the closing
 * tick. See {@link prefetchEngine} for why that is `pending` rather than a
 * failure.
 */
let engineSkipped = false

/**
 * The last figure the *sequential* part reported, kept so the engine can move
 * the bar on its own.
 *
 * Without it the blended percentage only changes when something sequential
 * calls `setState`, and the one moment that matters is the one where nothing
 * does: a warm toolchain and a warm workspace reach the token check in seconds
 * and then wait on a cold 46 MB download, with the bar frozen at the token
 * check's number. That is exactly the stuck bar {@link ENGINE_SHARE} exists to
 * prevent. It has to be the *raw* figure, too — re-blending an already-blended
 * `state.percent` would fold the engine's share in twice and move the bar
 * backwards.
 */
let sequentialPercent: number | undefined

/** The highest figure published this run. Nothing may be published below it. */
let publishedPercent = 0

/**
 * The sequential part's figure, plus the engine's share of its own, and never
 * less than the last number the user saw.
 *
 * The two inputs each only move forward, but the *sequence* of sequential
 * figures does not: the token check publishes 97, and a token that turns out to
 * be expired sends the refresh back to 70. A bar that jumps back reads as a
 * restart — worse than no bar — so the clamp is here rather than at the one
 * call site that needs it today, in the same shape as the toolchain's own
 * aggregation.
 */
function overall(sequential: number | undefined): number | undefined {
  if (sequential === undefined) return undefined
  sequentialPercent = sequential
  const blended = Math.round(sequential * (1 - ENGINE_SHARE) + enginePercent * ENGINE_SHARE)
  publishedPercent = Math.max(publishedPercent, blended)
  return publishedPercent
}

/** The toolchain's own 0..100, as a fraction of the whole reconcile. */
function toolchainPercent(percent: number | undefined): number | undefined {
  return percent === undefined ? undefined : Math.round(percent * TOOLCHAIN_SHARE)
}

/** cinna-cli's `step n of m`, as a fraction of what is left after the toolchain. */
function workspacePercent(step: number | undefined, total: number | undefined): number {
  if (!step || !total || total <= 0) return WORKSPACE_FROM
  const fraction = Math.max(0, Math.min(1, step / total))
  return Math.round(WORKSPACE_FROM + (WORKSPACE_TO - WORKSPACE_FROM) * fraction)
}

/**
 * The checklist, in the order the reconciler actually does the work.
 *
 * Held beside the phase rather than derived from it: a phase says what is
 * happening *now*, and the question the checklist answers — what is already
 * done, and which step is the one that broke — needs the history the phase
 * throws away on every transition.
 */
const TASK_LABELS: { id: LocalDevTaskId; label: string; measurable: boolean }[] = [
  { id: 'uv', label: 'uv', measurable: true },
  { id: 'mutagen', label: 'Mutagen', measurable: true },
  { id: 'cinna-cli', label: 'cinna-cli', measurable: true },
  { id: 'engine', label: 'opencode engine', measurable: true },
  { id: 'workspace', label: 'Account workspace', measurable: true },
  // One round trip. A bar for it would be decoration, and a bar that never
  // moves is exactly the thing the checklist exists to remove.
  { id: 'token', label: 'Account token', measurable: false }
]

/** The ids in order, exported so the ordering rule can be asserted. */
export const TASK_ORDER: LocalDevTaskId[] = TASK_LABELS.map((t) => t.id)

let tasks: LocalDevTask[] = []

/**
 * The checklist as it looks before anything has happened.
 *
 * A measurable row starts at `percent: 0` rather than undefined so its (empty)
 * bar is on screen from the first frame. The alternative — bars appearing as
 * each row starts — makes the list reflow under the user precisely while they
 * are trying to read how much is left.
 */
function resetTasks(): void {
  enginePercent = 0
  engineSkipped = false
  sequentialPercent = undefined
  publishedPercent = 0
  tasks = TASK_LABELS.map(({ id, label, measurable }) => ({
    id,
    label,
    status: 'pending',
    ...(measurable ? { percent: 0 } : {})
  }))
}

function patchTask(id: LocalDevTaskId, patch: Partial<LocalDevTask>): void {
  tasks = tasks.map((task) => (task.id === id ? { ...task, ...patch } : task))
}

/**
 * Mark `id` as the thing being worked on right now.
 *
 * Several rows can be active at once: uv, Mutagen and cinna-cli no longer run
 * in single file. So this says nothing about the rows around it — completion is
 * always reported explicitly by whoever finished the work, because with
 * concurrent installs "a later step started" is no longer evidence that an
 * earlier one ended.
 */
function markActive(id: LocalDevTaskId, detail?: string, percent?: number): void {
  patchTask(id, { status: 'active', detail, ...(percent === undefined ? {} : { percent }) })
}

/** This component is finished. A full bar, and no leftover progress detail. */
function markDone(id: LocalDevTaskId, detail?: string): void {
  const task = tasks.find((t) => t.id === id)
  if (!task) return
  patchTask(id, {
    status: 'done',
    detail,
    // Only rows that had a bar keep one; the token row's tick is the whole
    // report.
    ...(task.percent === undefined ? {} : { percent: 100 })
  })
}

/**
 * Everything done, with an optional closing detail on the last one.
 *
 * A `failed` row is left alone, and so is the engine row when its pre-fetch did
 * not happen. Local development can be ready while the engine was not cached —
 * it is an optimisation, and the engine is fetched at first use exactly as it
 * always was — and painting either row green on the way past would be claiming
 * something this run knows to be untrue.
 */
function markAllDone(detail?: string): void {
  tasks = tasks.map((task, i) => {
    if (task.status === 'failed') return task
    if (task.id === 'engine' && engineSkipped) return task
    return {
      ...task,
      status: 'done',
      ...(task.percent === undefined ? {} : { percent: 100 }),
      detail: i === tasks.length - 1 ? (detail ?? task.detail) : task.detail
    }
  })
}

/**
 * A component became the reason the run stopped.
 *
 * `id` when the caller knows which one — a toolchain error names the tool it
 * was installing — and otherwise the first row still in flight. Whichever it
 * is, the *other* in-flight rows drop back to pending: their work may well
 * still be running in the background, but a spinner beside a failure reads as
 * "and this part is fine", which is not something this run can claim.
 */
function markFailed(detail: string, id?: LocalDevTaskId): void {
  const named = id ? tasks.findIndex((task) => task.id === id) : -1
  const active = tasks.findIndex((task) => task.status === 'active')
  const fallback = active === -1 ? tasks.findIndex((task) => task.status === 'pending') : active
  const index = named === -1 ? fallback : named
  if (index === -1) return
  tasks = tasks.map((task, i) => {
    if (i === index) return { ...task, status: 'failed', detail }
    return task.status === 'active' ? { ...task, status: 'pending' } : task
  })
}

/** `Could not reach X.` → `could not reach X.`, so it reads mid-sentence. */
function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1)
}

/**
 * The checklist row a toolchain failure belongs to, from the component the
 * error names.
 *
 * `ToolchainError.tool` and {@link LocalDevTaskId} share these three spellings
 * on purpose, but the check is a membership test rather than a cast: `tool` is
 * a plain string on the error, and a row is not something to guess at when
 * getting it wrong marks a healthy download as the failure.
 */
function taskForTool(tool: string | undefined): LocalDevTaskId | undefined {
  return tool === 'uv' || tool === 'mutagen' || tool === 'cinna-cli' ? tool : undefined
}

/**
 * One toolchain report → a checklist tick and an `installing` state, for the
 * run identified by `generation`.
 *
 * The tool id comes from the toolchain rather than being parsed out of the
 * step text, so renaming a user-facing label cannot silently stop the checklist
 * advancing.
 *
 * The generation check is not defensive tidiness. The toolchain installs
 * concurrently, so a failure in one component returns while another is still
 * downloading, and that survivor keeps reporting progress afterwards — without
 * this, its next line would overwrite the `attention` state the user is being
 * shown with a cheerful `installing`, and the failure would vanish from the
 * screen while remaining true.
 */
function progressFor(generation: number): (update: ToolchainProgressUpdate) => void {
  return ({ step, percent, tool, toolPercent, toolStatus }) => {
    if (generation !== activeRun) return
    if (tool) {
      if (toolStatus === 'done') markDone(tool)
      else markActive(tool, step, toolPercent)
    }
    setState({ phase: 'installing', step, percent: overall(toolchainPercent(percent)) })
  }
}

/**
 * Fetch the opencode engine alongside everything else, and tick its row.
 *
 * The engine is not part of the cinna-cli toolchain and this module does not
 * install it — {@link prefetchEngineBinary} resolves it through the engine's
 * own three sources, so a configured path or a developer's own `opencode`
 * answers the row in milliseconds and downloads nothing. What is decided here
 * is only *when*: a user who has just asked for local development is about to
 * sync an agent and run it, and the alternative is meeting a 46 MB download at
 * the moment they press send.
 *
 * Best effort by design. A failure marks the row and nothing else: local
 * development is genuinely ready without it, and the engine is fetched at first
 * use exactly as it was before this existed. Returning a promise rather than
 * awaiting inline is the point — it runs while the toolchain installs and the
 * workspace is created, and is only waited on at the end.
 */
function prefetchEngine(generation: number): Promise<void> {
  markActive('engine', 'Checking…', 0)
  const mb = (bytes: number): string => (bytes / 1_000_000).toFixed(1)
  return prefetchEngineBinary((received, total) => {
    if (generation !== activeRun) return
    enginePercent = total === null ? enginePercent : Math.round((received / total) * 100)
    const step =
      total === null
        ? `Downloading opencode — ${mb(received)} MB`
        : `Downloading opencode — ${mb(received)} of ${mb(total)} MB`
    markActive('engine', step, total === null ? undefined : enginePercent)
    // Progress *within* whatever the reconcile is already doing rather than a
    // transition of its own — but the bar and the headline still have to move,
    // because for the last stretch of a run this is the only thing happening.
    // Every other component narrates the same way while it works.
    setState(
      state.phase === 'installing'
        ? { phase: 'installing', step, percent: overall(sequentialPercent) }
        : state
    )
  }).then((result) => {
    if (generation !== activeRun) return
    enginePercent = 100
    if (result.ok) {
      // Where it came from matters on this row: "we did not download 46 MB
      // because you already have one" is the good outcome, and a tick with no
      // explanation reads like the download simply flashed past.
      markDone('engine', result.source === 'managed' ? undefined : 'Already on this machine')
    } else {
      // `pending`, not `failed`. Nothing is broken: the engine is fetched at
      // first use exactly as it was before this pre-fetch existed, so a red row
      // would sit under a green "ready" for the rest of the session,
      // contradicted by an app that works. Not-yet-done is the truth, and the
      // detail says who will do it.
      engineSkipped = true
      patchTask('engine', {
        status: 'pending',
        percent: 0,
        detail: `Not cached — ${lowerFirst(result.error)} It will be fetched the first time you run an agent.`
      })
    }
    setState(state)
  })
}

let state: LocalDevState = { phase: 'idle' }
/**
 * The reconcile whose progress reports are worth listening to, or `null`
 * between runs.
 *
 * Cleared when a run ends rather than only when the next one starts, because
 * the window that matters is *after* a failure: the toolchain installs
 * concurrently, so a run can return `attention` while a sibling download is
 * still going, and that survivor keeps reporting for as long as it takes to
 * finish. Left un-cleared, its next line would replace the failure the user is
 * looking at with a progress bar that nothing will ever complete.
 */
let activeRun: number | null = null
let runGeneration = 0
/** One reconcile at a time; a second caller joins the run in flight. */
let inFlight: Promise<LocalDevState> | null = null

/** Last logged phase and percent decade, so progress ticks do not flood the log. */
let lastLogged = { phase: '', decade: -1 }

/**
 * What is worth a log line, out of the hundreds of progress reports a download
 * produces.
 *
 * Every transition used to be logged, which for one install meant two hundred
 * identical `{ phase: 'installing' }` lines — a log that says nothing, at the
 * one moment somebody reading it wants to know what happened. A phase change is
 * always worth a line; a progress tick is worth one every ten percent.
 */
function shouldLog(next: LocalDevState): boolean {
  const decade =
    next.phase === 'installing' && next.percent !== undefined
      ? Math.floor(next.percent / 10)
      : -1
  if (next.phase === lastLogged.phase && decade === lastLogged.decade) return false
  lastLogged = { phase: next.phase, decade }
  return true
}

function setState(next: LocalDevState): void {
  // Attached here rather than at every call site: the checklist is a property
  // of the run, not of any one transition, and threading it through forty
  // `setState` calls is forty chances to drop it.
  state = { ...next, tasks: tasks.length ? tasks : undefined }
  if (shouldLog(next)) {
    logger.info('local dev state', {
      phase: next.phase,
      ...(next.phase === 'installing' ? { step: next.step, percent: next.percent } : {}),
      ...(next.phase === 'attention' ? { reason: next.reason, detail: next.detail } : {}),
      ...(next.phase === 'unsupported' ? { reason: next.reason } : {}),
      ...(next.phase === 'ready' ? { workspacePath: next.workspacePath, cliVersion: next.cliVersion, protocol: next.protocol } : {})
    })
  }
  // `state`, not `next`: the checklist is attached two lines above and the
  // renderer replaces its whole copy on every push. Sending `next` published a
  // task-less state on every transition, so the per-component list existed in
  // main and never survived a single broadcast — which is what left the UI
  // showing one "Installing…" line for a five-part install.
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(LOCAL_DEV_STATE_CHANNEL, state)
  }
}

// ── Consent, per host ───────────────────────────────────────────────────────

function readConsent(): Record<string, boolean> {
  const raw = appSettingsRepo.get('localDevConsent')
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: Record<string, boolean> = {}
    for (const [host, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'boolean') out[host] = value
    }
    return out
  } catch {
    // A corrupt value means "nobody has been asked", which is the safe reading:
    // the worst case is asking once more, never acting without an answer.
    return {}
  }
}

function writeConsent(next: Record<string, boolean>): void {
  appSettingsRepo.set('localDevConsent', JSON.stringify(next))
}

// ── Paths ───────────────────────────────────────────────────────────────────

/**
 * A host as a directory name. Only the port separator needs replacing — a
 * hostname cannot contain a path separator, and cinna-core's own default for
 * this folder normalizes the domain the same way.
 */
export function hostDirName(host: string): string {
  return host.replace(/:/g, '_')
}

/**
 * `<AgentsHome>/<Cloud>/<host>` — where cinna-cli's account workspace goes.
 *
 * The `Cloud` segment comes from the kit contract's layout rather than a
 * literal, because the workshop layout is the contract's to define: `Local/` and
 * `Cloud/` are declared there, and a second spelling of one of them in this file
 * is a second thing to keep in step.
 */
function workspacePathFor(userId: string, host: string): string {
  const home = agentsHomeService.ensureHome(userId)
  const cloudDir = getLayout(home.path).workshop.cloud_dir
  return join(home.path, cloudDir, hostDirName(host))
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/** The file whose presence means "cinna-cli has set this workspace up". */
function accountConfigPath(workspacePath: string): string {
  return join(workspacePath, '.cinna', 'account.json')
}

// ── Failure mapping ─────────────────────────────────────────────────────────

/**
 * Turn a toolchain failure into what the user is told.
 *
 * `download_failed` is the only one that is really about the network; the rest
 * are about *this app* — a platform with no pinned build, a Mutagen version
 * shipped after this release, bytes that did not match. Lumping them together
 * would offer "try again" for a condition no amount of trying fixes.
 */
export function fromToolchainError(err: ToolchainError): LocalDevState {
  if (err.code === 'download_failed') {
    return { phase: 'attention', reason: 'network', detail: err.message }
  }
  return { phase: 'attention', reason: 'toolchain', detail: err.message }
}

/**
 * Turn a cinna-cli run into a state, by **exit code**.
 *
 * `10` means the setup token was rejected. From here that is almost always a
 * token that expired between minting and use, and re-running mints a new one —
 * so it is `token_expired`, whose Repair does exactly that, rather than a dead
 * end. `11` is an account mismatch: the workspace at that path belongs to a
 * different Cinna account, which no retry fixes and which the user has to
 * resolve by moving the folder.
 */
export function fromCliOutcome(outcome: CliRunOutcome, what: string): LocalDevState {
  const detail = outcome.result?.detail ?? outcome.stderr ?? ''
  if (outcome.timedOut) {
    return { phase: 'attention', reason: 'network', detail: `${what} timed out.` }
  }
  switch (outcome.exitCode) {
    case EXIT_NETWORK:
      return {
        phase: 'attention',
        reason: 'network',
        detail: detail || 'Could not reach your Cinna server.'
      }
    case EXIT_SETUP_TOKEN:
      return {
        phase: 'attention',
        reason: 'token_expired',
        detail: detail || 'The setup token was rejected. Try Repair.'
      }
    case EXIT_ACCOUNT_MISMATCH:
      return {
        phase: 'attention',
        reason: 'workspace',
        detail:
          detail ||
          'The folder for this server already belongs to a different Cinna account. Move it aside and try again.'
      }
    default:
      return {
        phase: 'attention',
        reason: 'workspace',
        detail: detail || `${what} failed.`
      }
  }
}

// ── The reconciler ──────────────────────────────────────────────────────────

async function mintSetupCommand(
  userId: string,
  localDev: CinnaLocalDev
): Promise<{ ok: true; command: string } | { ok: false; state: LocalDevState }> {
  // The instance names its own endpoint, which matters on a split-host
  // deployment where the API is not on the origin the user typed. Falling back
  // to the well-known path keeps a server that publishes an empty string
  // working rather than failing on a technicality.
  const endpoint = localDev.setup_token_endpoint || SETUP_TOKEN_PATH
  try {
    const created = await cinnaFetch<SetupTokenCreated>(userId, endpoint, { method: 'POST' })
    if (!created.setup_command) {
      return {
        ok: false,
        state: {
          phase: 'attention',
          reason: 'workspace',
          detail: 'The server returned no setup command.'
        }
      }
    }
    return { ok: true, command: created.setup_command }
  } catch (err) {
    if (err instanceof CinnaApiError) {
      // 403 is the role gate, not a dead session: cinna-core restricts account
      // setup tokens to `agent-developer` / `admin`. An `agent-user` gets
      // everything else the desktop offers and this one thing they cannot have,
      // which the UI explains rather than treating as a failure.
      if (err.code === 'reauth_required' && err.detail === '403') {
        return { ok: false, state: { phase: 'unsupported', reason: 'role' } }
      }
      if (err.code === 'reauth_required') {
        return {
          ok: false,
          state: {
            phase: 'attention',
            reason: 'token_expired',
            detail: 'Your Cinna session expired. Sign in again, then Repair.'
          }
        }
      }
    }
    return {
      ok: false,
      state: {
        phase: 'attention',
        reason: 'network',
        detail: err instanceof Error ? err.message : String(err)
      }
    }
  }
}

/**
 * The flags that only a cinna-cli new enough to have them may be given.
 *
 * Passing `--json` to one that does not is not a no-op — it is a usage error
 * that fails before the command does any work, which is precisely how a
 * server pinning an older cinna-cli would break every one of these calls.
 */
function protocolFlags(caps: CliCapabilities): string[] {
  return caps.json ? ['--no-input', '--json'] : []
}

async function createWorkspace(
  userId: string,
  localDev: CinnaLocalDev,
  workspacePath: string,
  env: NodeJS.ProcessEnv,
  cinnaBin: string,
  caps: CliCapabilities
): Promise<LocalDevState | null> {
  const minted = await mintSetupCommand(userId, localDev)
  if (!minted.ok) return minted.state

  setState({
    phase: 'installing',
    step: 'Creating your account workspace…',
    percent: overall(WORKSPACE_FROM)
  })
  const outcome = await runCinnaCli({
    bin: cinnaBin,
    // The setup command is argv element 2 and appears nowhere else.
    args: [
      'account',
      'setup',
      minted.command,
      '--dir',
      workspacePath,
      '--name',
      hostname(),
      ...protocolFlags(caps)
    ],
    logArgs: ['account', 'setup', '<setup-command>', '--dir', workspacePath, ...protocolFlags(caps)],
    env,
    // `--dir` is absolute, so cinna-cli does not consult the working directory
    // — but a spawn that inherits whatever the OS launched Electron from is a
    // loose end worth not having.
    cwd: dirname(workspacePath),
    onProgress: (line) => {
      if (line.status !== 'start') return
      // cinna-cli's own `step n of m` — the only progress the desktop has for
      // this half, and it is real: each line is a step actually beginning.
      const within =
        line.step && line.total ? Math.round((line.step / line.total) * 100) : undefined
      markActive('workspace', line.message, within)
      setState({
        phase: 'installing',
        step: line.message,
        percent: overall(workspacePercent(line.step, line.total))
      })
    }
  })
  if (outcome.exitCode !== EXIT_OK) return fromCliOutcome(outcome, 'Creating the workspace')
  return null
}

async function refreshAccountToken(
  userId: string,
  localDev: CinnaLocalDev,
  workspacePath: string,
  env: NodeJS.ProcessEnv,
  cinnaBin: string,
  caps: CliCapabilities
): Promise<LocalDevState | null> {
  if (!caps.accountSetToken) {
    // Nothing to fall back on: the top-level `cinna set-token` refreshes an
    // *agent* workspace and would refuse this one. Say so rather than running
    // it and reporting whatever it made of the attempt.
    return {
      phase: 'attention',
      reason: 'token_expired',
      detail:
        'The account token has expired, and the cinna-cli version your server pins cannot refresh one in place. Repair sets the workspace up again.'
    }
  }
  const minted = await mintSetupCommand(userId, localDev)
  if (!minted.ok) return minted.state

  setState({
    phase: 'installing',
    step: 'Refreshing your account token…',
    percent: overall(WORKSPACE_FROM)
  })
  const outcome = await runCinnaCli({
    bin: cinnaBin,
    args: ['account', 'set-token', minted.command, ...protocolFlags(caps)],
    logArgs: ['account', 'set-token', '<setup-command>', ...protocolFlags(caps)],
    env,
    cwd: workspacePath
  })
  if (outcome.exitCode !== EXIT_OK) return fromCliOutcome(outcome, 'Refreshing the account token')
  return null
}

async function readAccountStatus(
  workspacePath: string,
  env: NodeJS.ProcessEnv,
  cinnaBin: string,
  caps: CliCapabilities
): Promise<CliRunOutcome> {
  return runCinnaCli({
    bin: cinnaBin,
    args: ['account', 'status', ...protocolFlags(caps)],
    logArgs: ['account', 'status', ...protocolFlags(caps)],
    env,
    cwd: workspacePath,
    timeoutMs: 60_000
  })
}

async function runReconcile(userId: string, force: boolean): Promise<LocalDevState> {
  const generation = ++runGeneration
  activeRun = generation
  try {
    return await reconcileOnce(userId, force, generation)
  } finally {
    // Only if nothing newer has claimed it: `reconcile` serializes runs, but a
    // future caller that does not must not have its generation retired here.
    if (activeRun === generation) activeRun = null
  }
}

async function reconcileOnce(
  userId: string,
  force: boolean,
  generation: number
): Promise<LocalDevState> {
  // Whether Repair should reinstall the toolchain, decided *before* the first
  // `setState` overwrites the reason we are here.
  //
  // Repair is one button for every failure, and reinstalling uv, a Python and
  // the cinna-cli dependency tree takes minutes. Doing that because an account
  // token expired overnight would turn a two-second fix into a coffee break, so
  // the heavy path is reserved for the failure that is actually about the
  // tools. Everything else Repair does — look the server up again, re-check the
  // token, re-read the workspace — happens either way.
  const reinstallToolchain = force && state.phase === 'attention' && state.reason === 'toolchain'

  const user = userRepo.get(userId)
  if (!user || user.type !== 'cinna_user' || !user.cinnaServerUrl) {
    // Not an error: a local profile simply has no Cinna server to develop
    // against, and saying "unsupported" would imply this one could not.
    setState({ phase: 'idle' })
    return state
  }

  // Discovery is cached for the session, which is right for a check that runs on
  // every activation — but wrong for Repair, whose whole point is "look again".
  // A server that has just started offering local development, or bumped a
  // pinned version, is exactly what the user is pressing the button about.
  if (force) {
    clearEndpointCache()
    // Repair may install a different cinna-cli, and a cached answer for the
    // previous one is wrong in exactly the case that matters.
    clearCliCapabilityCache()
  }

  let localDev: CinnaLocalDev | undefined
  try {
    localDev = (await discoverCinnaEndpoints(user.cinnaServerUrl)).local_dev
  } catch (err) {
    setState({
      phase: 'attention',
      reason: 'network',
      detail: err instanceof Error ? err.message : String(err)
    })
    return state
  }

  if (!localDev?.cinna_cli_version || !localDev.mutagen_version) {
    setState({ phase: 'unsupported', reason: 'server' })
    return state
  }

  const host = new URL(user.cinnaServerUrl).host
  const consent = readConsent()[host]
  // From here on there is real work to describe, so the checklist starts.
  // Before this point — no Cinna user, no `local_dev` block — there is nothing
  // to tick off and an empty list is the honest answer.
  resetTasks()
  if (!force) {
    // Never asked, or asked and declined. Both stop here; they are different
    // states because Settings offers different things for them.
    if (consent === undefined) {
      setState({ phase: 'consent', host })
      return state
    }
    if (consent === false) {
      setState({ phase: 'declined', host })
      return state
    }
  } else if (consent !== true) {
    // `force` reaches here only from Repair or Settings' "Set up" — the user
    // pressing a button that says what it will do. That *is* the consent, so
    // record it; otherwise pressing it would loop straight back to the prompt.
    writeConsent({ ...readConsent(), [host]: true })
  }

  const pins: ToolchainPins = {
    cinnaCliVersion: localDev.cinna_cli_version,
    mutagenVersion: localDev.mutagen_version
  }

  // Started here, awaited at the end: it shares the wait with the toolchain
  // install and the workspace creation rather than adding to it.
  const engine = prefetchEngine(generation)

  let cliVersion: string
  let env: NodeJS.ProcessEnv
  try {
    setState({
      phase: 'installing',
      step: 'Checking the local development toolchain…',
      percent: overall(0)
    })
    const onToolchainProgress = progressFor(generation)
    const result = reinstallToolchain
      ? await toolchain.repair(pins, onToolchainProgress)
      : await toolchain.ensure(pins, onToolchainProgress)
    cliVersion = result.cliVersion
    // Whatever the individual reports said, the three tools are installed once
    // this returns — belt and braces for a toolchain path that skipped work
    // without narrating it.
    for (const id of ['uv', 'mutagen', 'cinna-cli'] as const) markDone(id)
    // The version is the useful detail on that row once it is installed —
    // "which cinna-cli am I actually running" is the first thing anyone asks
    // when the behaviour surprises them.
    tasks = tasks.map((task) => (task.id === 'cinna-cli' ? { ...task, detail: cliVersion } : task))
    env = await toolchain.toolchainEnv(pins)
  } catch (err) {
    const failure =
      err instanceof ToolchainError
        ? fromToolchainError(err)
        : {
            phase: 'attention' as const,
            reason: 'toolchain' as const,
            detail: err instanceof Error ? err.message : String(err)
          }
    markFailed(
      failure.phase === 'attention' ? failure.detail : 'Failed.',
      err instanceof ToolchainError ? taskForTool(err.tool) : undefined
    )
    setState(failure)
    return state
  }

  const cinnaBin = toolchain.paths(pins).cinnaBin
  // Asked once per (binary, version), before the first real invocation: a
  // server may pin a cinna-cli older than the protocol this app prefers, and
  // handing that one `--json` fails it before it does anything.
  const caps = await probeCliCapabilities(cinnaBin, cliVersion, env)
  const workspacePath = workspacePathFor(userId, host)

  // Only the `Cloud/` parent. cinna-cli creates the workspace directory itself
  // and refuses one that already holds a `.cinna/account.json`, so the split is
  // "the app owns the shape of the agents home, cinna-cli owns the workspace".
  // `ensureHome` does not make `Cloud/` — it is created on demand, here, the
  // first time a server needs one.
  try {
    await mkdir(dirname(workspacePath), { recursive: true })
  } catch (err) {
    const detail = `Could not create the agents folder: ${err instanceof Error ? err.message : String(err)}`
    // Through `markFailed` rather than straight to `setState`, like every other
    // stopping failure: it puts the reason on the workspace row and takes the
    // spinners off whatever was still running, which beside a red error would
    // read as "and those parts are fine".
    markFailed(detail, 'workspace')
    setState({ phase: 'attention', reason: 'workspace', detail })
    return state
  }

  if (!(await isFile(accountConfigPath(workspacePath)))) {
    markActive('workspace', 'Creating…', 0)
    const failure = await createWorkspace(userId, localDev, workspacePath, env, cinnaBin, caps)
    if (failure) {
      markFailed(failure.phase === 'attention' ? failure.detail : 'Failed.')
      setState(failure)
      return state
    }
  }

  markDone('workspace')
  markActive('token', 'Checking…')
  setState({
    phase: 'installing',
    step: 'Checking your account token…',
    percent: overall(WORKSPACE_TO)
  })
  let status = await readAccountStatus(workspacePath, env, cinnaBin, caps)
  if (status.exitCode !== EXIT_OK) {
    const failure = fromCliOutcome(status, 'Reading the workspace')
    markFailed(failure.phase === 'attention' ? failure.detail : 'Failed.')
    setState(failure)
    return state
  }

  const parsed = status.result as unknown as AccountStatus | null
  if (parsed?.token === 'expired') {
    const failure = await refreshAccountToken(
      userId,
      localDev,
      workspacePath,
      env,
      cinnaBin,
      caps
    )
    if (failure) {
      markFailed(failure.phase === 'attention' ? failure.detail : 'Failed.')
      setState(failure)
      return state
    }
    status = await readAccountStatus(workspacePath, env, cinnaBin, caps)
    if (status.exitCode !== EXIT_OK) {
      const readFailure = fromCliOutcome(status, 'Reading the workspace')
      markFailed(readFailure.phase === 'attention' ? readFailure.detail : 'Failed.')
      setState(readFailure)
      return state
    }
  } else if (parsed?.token === 'unreachable') {
    // The workspace is fine; the server is not answering. Nothing to repair —
    // and calling this a workspace problem would send the user looking in the
    // wrong place.
    markFailed('Could not reach your Cinna server to check the account token.')
    setState({
      phase: 'attention',
      reason: 'network',
      detail: 'Could not reach your Cinna server to check the account token.'
    })
    return state
  }

  // Best effort by design: a stale context package is a worse copy of the
  // platform docs, not a broken workspace, and failing readiness over it would
  // make an offline moment look like a setup failure.
  if ((status.result as unknown as AccountStatus | null)?.context_package?.state === 'behind') {
    const refreshed = await runCinnaCli({
      bin: cinnaBin,
      args: ['account', 'refresh-context', '--no-input', '--json'],
      logArgs: ['account', 'refresh-context', '--json'],
      env,
      cwd: workspacePath,
      timeoutMs: 5 * 60_000
    })
    if (refreshed.exitCode !== EXIT_OK) {
      logger.warn('context package refresh failed', { exitCode: refreshed.exitCode })
    }
  }

  // The last thing between a synced agent and a first turn, so `ready` waits
  // for it. It has usually finished long before this line; when it has not, the
  // engine row is the only one still moving and the bar says so.
  await engine

  markAllDone('Valid')
  setState({
    phase: 'ready',
    workspacePath,
    cliVersion,
    cinnaBinPath: cinnaBin,
    protocol: caps.json ? 'json' : 'legacy'
  })
  return state
}

export const localDevService = {
  getState(): LocalDevState {
    return state
  },

  /**
   * Bring local development to its target state for `userId`.
   *
   * Concurrent calls collapse onto the run already in flight — activation,
   * an OS resume and a Repair click can easily land together, and two
   * simultaneous `uv tool install`s into the same directory is not a race worth
   * having. `force` re-runs the installs and overrides a remembered decline;
   * it is what Repair and "Set up" pass.
   *
   * A `force` call that lands while an ordinary run is already going joins that
   * run rather than starting a second one. That is deliberate: the case is a
   * user pressing Repair during a long download, and finishing the download is
   * what they want — restarting it would throw away the bytes already on disk
   * and look identical from the outside.
   */
  async reconcile(userId: string, force = false): Promise<LocalDevState> {
    if (inFlight) return inFlight
    const run = runReconcile(userId, force)
      .catch((err) => {
        // A throw here is a bug, not a condition — but the user still needs a
        // state they can act on rather than a spinner that never resolves.
        logger.error('local dev reconcile threw', err)
        setState({
          phase: 'attention',
          reason: 'workspace',
          detail: err instanceof Error ? err.message : String(err)
        })
        return state
      })
      .finally(() => {
        if (inFlight === run) inFlight = null
      })
    inFlight = run
    return run
  },

  /**
   * Record the consent answer for a host, then act on it.
   *
   * The wait matters. The answer now arrives from the connect screen, which
   * gives it moments after the account is activated — while the reconcile that
   * activation kicked off is very likely still running. That run read the
   * consent before this one wrote it, so joining it (which is what `reconcile`
   * does with a call already in flight) would return "still waiting for an
   * answer" and quietly drop the one just given. Letting it finish first costs
   * a discovery round trip and makes the accept always take effect.
   */
  async setConsent(userId: string, host: string, accepted: boolean): Promise<LocalDevState> {
    writeConsent({ ...readConsent(), [host]: accepted })
    logger.info('local dev consent recorded', { host, accepted })
    if (inFlight) await inFlight.catch(() => undefined)
    return this.reconcile(userId)
  },

  /** Forget the answer for a host, so the next reconcile asks again. */
  async resetConsent(userId: string, host: string): Promise<LocalDevState> {
    const next = readConsent()
    delete next[host]
    writeConsent(next)
    return this.reconcile(userId)
  },

  /** The consent answers, for the Settings screen. */
  consent(): Record<string, boolean> {
    return readConsent()
  },

  /** Reveal the account workspace in Finder / Explorer. */
  async openWorkspace(): Promise<{ ok: boolean }> {
    if (state.phase !== 'ready') return { ok: false }
    const error = await shell.openPath(state.workspacePath)
    if (error) logger.warn('could not open the workspace folder', { error })
    return { ok: !error }
  },

  /**
   * Put the managed `cinna` on the user's own shell PATH, by symlinking it into
   * `~/.local/bin`.
   *
   * **Opt-in, never automatic.** The app's copy of cinna-cli exists so the
   * desktop can drive it; a developer's terminal is theirs, and silently
   * shadowing (or being shadowed by) a `cinna` they installed themselves is the
   * kind of surprise that costs an afternoon. Everything the desktop spawns
   * uses `toolchainEnv()` and is unaffected by this either way.
   *
   * An existing link that already points into the managed toolchain is
   * refreshed — that is a version bump, and repointing it is the whole job. Any
   * other file at that path is left strictly alone and reported: it is
   * someone's real install.
   */
  async addToPath(): Promise<{ ok: boolean; path?: string; reason?: string }> {
    if (state.phase !== 'ready') return { ok: false, reason: 'Local development is not ready yet.' }
    const source = state.cinnaBinPath
    const targetDir = join(homedir(), '.local', 'bin')
    const target = join(targetDir, 'cinna')
    try {
      await mkdir(targetDir, { recursive: true })
      const existing = await lstat(target).catch(() => null)
      if (existing) {
        const managed =
          existing.isSymbolicLink() &&
          (await readlink(target).catch(() => '')).startsWith(toolchain.root())
        if (!managed) {
          return {
            ok: false,
            reason: `Something else is already at ${target}. Remove it first if you want Cinna's copy there.`
          }
        }
        await unlink(target)
      }
      await symlink(source, target)
      logger.info('linked the managed cinna onto the user PATH')
      return { ok: true, path: target }
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }
  },

  /** Reset to `idle` on sign-out / profile switch, so no stale host is shown. */
  clear(): void {
    setState({ phase: 'idle' })
  }
}
