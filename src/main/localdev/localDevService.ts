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
import { runCinnaCli, type CliRunOutcome } from './cliRunner'
import { toolchain, type ToolchainPins } from './toolchain'
import {
  LOCAL_DEV_STATE_CHANNEL,
  type CinnaLocalDev,
  type LocalDevState
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

let state: LocalDevState = { phase: 'idle' }
/** One reconcile at a time; a second caller joins the run in flight. */
let inFlight: Promise<LocalDevState> | null = null

function setState(next: LocalDevState): void {
  state = next
  logger.info('local dev state', next)
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(LOCAL_DEV_STATE_CHANNEL, next)
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

async function createWorkspace(
  userId: string,
  localDev: CinnaLocalDev,
  workspacePath: string,
  env: NodeJS.ProcessEnv,
  cinnaBin: string
): Promise<LocalDevState | null> {
  const minted = await mintSetupCommand(userId, localDev)
  if (!minted.ok) return minted.state

  setState({ phase: 'installing', step: 'Creating your account workspace…' })
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
      '--no-input',
      '--json'
    ],
    logArgs: ['account', 'setup', '<setup-command>', '--dir', workspacePath, '--json'],
    env,
    // `--dir` is absolute, so cinna-cli does not consult the working directory
    // — but a spawn that inherits whatever the OS launched Electron from is a
    // loose end worth not having.
    cwd: dirname(workspacePath),
    onProgress: (line) => {
      if (line.status === 'start') setState({ phase: 'installing', step: line.message })
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
  cinnaBin: string
): Promise<LocalDevState | null> {
  const minted = await mintSetupCommand(userId, localDev)
  if (!minted.ok) return minted.state

  setState({ phase: 'installing', step: 'Refreshing your account token…' })
  const outcome = await runCinnaCli({
    bin: cinnaBin,
    args: ['account', 'set-token', minted.command, '--no-input', '--json'],
    logArgs: ['account', 'set-token', '<setup-command>', '--json'],
    env,
    cwd: workspacePath
  })
  if (outcome.exitCode !== EXIT_OK) return fromCliOutcome(outcome, 'Refreshing the account token')
  return null
}

async function readAccountStatus(
  workspacePath: string,
  env: NodeJS.ProcessEnv,
  cinnaBin: string
): Promise<CliRunOutcome> {
  return runCinnaCli({
    bin: cinnaBin,
    args: ['account', 'status', '--no-input', '--json'],
    logArgs: ['account', 'status', '--json'],
    env,
    cwd: workspacePath,
    timeoutMs: 60_000
  })
}

async function runReconcile(userId: string, force: boolean): Promise<LocalDevState> {
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
  if (force) clearEndpointCache()

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

  let cliVersion: string
  let env: NodeJS.ProcessEnv
  try {
    setState({ phase: 'installing', step: 'Checking the local development toolchain…' })
    const result = force
      ? await toolchain.repair(pins, (step, percent) =>
          setState({ phase: 'installing', step, percent })
        )
      : await toolchain.ensure(pins, (step, percent) =>
          setState({ phase: 'installing', step, percent })
        )
    cliVersion = result.cliVersion
    env = await toolchain.toolchainEnv(pins)
  } catch (err) {
    setState(
      err instanceof ToolchainError
        ? fromToolchainError(err)
        : {
            phase: 'attention',
            reason: 'toolchain',
            detail: err instanceof Error ? err.message : String(err)
          }
    )
    return state
  }

  const cinnaBin = toolchain.paths(pins).cinnaBin
  const workspacePath = workspacePathFor(userId, host)

  // The `Cloud/` parent, not the workspace: cinna-cli creates and populates the
  // workspace directory, and creating it here first would only teach `account
  // setup` that something is already there.
  try {
    await mkdir(join(workspacePath, '..'), { recursive: true })
  } catch (err) {
    setState({
      phase: 'attention',
      reason: 'workspace',
      detail: `Could not create the agents folder: ${err instanceof Error ? err.message : String(err)}`
    })
    return state
  }

  if (!(await isFile(accountConfigPath(workspacePath)))) {
    const failure = await createWorkspace(userId, localDev, workspacePath, env, cinnaBin)
    if (failure) {
      setState(failure)
      return state
    }
  }

  setState({ phase: 'installing', step: 'Checking your account token…' })
  let status = await readAccountStatus(workspacePath, env, cinnaBin)
  if (status.exitCode !== EXIT_OK) {
    setState(fromCliOutcome(status, 'Reading the workspace'))
    return state
  }

  const parsed = status.result as unknown as AccountStatus | null
  if (parsed?.token === 'expired') {
    const failure = await refreshAccountToken(userId, localDev, workspacePath, env, cinnaBin)
    if (failure) {
      setState(failure)
      return state
    }
    status = await readAccountStatus(workspacePath, env, cinnaBin)
    if (status.exitCode !== EXIT_OK) {
      setState(fromCliOutcome(status, 'Reading the workspace'))
      return state
    }
  } else if (parsed?.token === 'unreachable') {
    // The workspace is fine; the server is not answering. Nothing to repair —
    // and calling this a workspace problem would send the user looking in the
    // wrong place.
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

  setState({ phase: 'ready', workspacePath, cliVersion, cinnaBinPath: cinnaBin })
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

  /** Record the consent answer for a host, then act on it. */
  async setConsent(userId: string, host: string, accepted: boolean): Promise<LocalDevState> {
    writeConsent({ ...readConsent(), [host]: accepted })
    logger.info('local dev consent recorded', { host, accepted })
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
