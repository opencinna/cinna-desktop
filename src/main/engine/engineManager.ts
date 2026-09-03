/**
 * The one desktop-managed `opencode serve` process.
 *
 * Owns the whole lifecycle: resolve a binary, generate the config, pick a
 * loopback port, spawn, health-check, restart when the config changes, stop on
 * quit — and expose a state the readiness strip can render. Every transition is
 * logged through the scoped logger, because the failures here are all
 * *invisible* ones: a port that got taken, a process that died between two
 * turns, a start that was still running when the app quit.
 *
 * ## Four situations this is written around
 *
 * **The port dying under us.** OpenCode's `--port 0` does *not* mean "any free
 * port" — verified against v1.18.27, it falls back to the default 4096, which
 * collides with any `opencode serve` the user is already running. Re-checked
 * against the real binary on 3 Sep 2026: the second instance does **not** fail
 * on the collision. It comes up on an unpredictable OS-assigned port instead —
 * so a collision is silent rather than loud, and an engine we did not intend to
 * talk to is reachable at an address we would never guess. (An earlier note
 * here said the second instance dies on a SQLite `CREATE TABLE`; that did not
 * reproduce, though the check shared one config and data directory and did not
 * capture the engine's own logs, so a logged error may still exist.)
 *
 * So the port is chosen here: bind a throwaway server to `127.0.0.1:0`, read
 * the port the OS gave it, close, and pass that. There is an unavoidable race
 * between closing and spawning, so a start that fails its health check is
 * retried on a fresh port.
 *
 * **The process exiting unexpectedly.** A crash, an OOM kill, a user killing it
 * from Activity Monitor. The `exit` handler moves the state to `failed` with
 * the exit code, so the next caller starts a new one rather than talking to a
 * closed socket — the state is not repaired by polling, because nothing polls.
 *
 * **`start` called twice concurrently.** Two chats opening at once, or a start
 * racing a config change. One in-flight promise serves every caller; the second
 * caller never spawns a second engine.
 *
 * **The app quitting mid-start.** A start carries the {@link stopEpoch} it
 * began under and checks it at each step, honouring a bump by killing whatever
 * it just created. A download in flight is not interrupted — it is up to 50 MB
 * and interrupting it saves nothing — but the process it would have spawned is
 * never spawned.
 *
 * ## Facts about the process, not beliefs about it
 *
 * The one structural rule here, and the one four separate bugs came from
 * breaking. Anything this module needs to know about *the engine that is
 * running* is recorded on {@link RunningEngine} and dies with the process:
 * {@link RunningEngine.loaded} is what that `opencode serve` actually read at
 * spawn — a digest of its config and prompt files, a digest of its credential
 * environment, and the key maps it was built from.
 *
 * So "does the engine need restarting" is a comparison against a fact, not a
 * flag somebody remembered to set. A stored "a restart is owed" boolean is
 * wrong twice over: nothing reconciles it against reality, so a restart from
 * Settings can pay the debt without clearing it and buy one more restart of a
 * healthy engine; and it is set from a comparison of config *bytes*, which
 * cannot see a rotated API key, because a key is never in those bytes
 * (Invariant 4). Equally, "the last config we generated" is not "the config the
 * engine is running" — a change deferred past a streaming turn is precisely a
 * generation the engine never loaded — so {@link engineManager.agentKey} and
 * {@link engineManager.lastSkips} answer from the loaded record and are silent
 * about anything else.
 *
 * The same rule settles the deferral. Because the comparison is in memory, a
 * change that is going to be deferred can be discovered *before* anything is
 * written — so a deferred change writes **nothing at all**: no config, no
 * prompt files, no prune of a departed agent's prompt. That matters beyond
 * tidiness. `writeEngineConfig` deletes the generated prompt file of an agent
 * that is no longer in the set, and whether OpenCode resolves
 * `{file:./prompts/<key>.md}` at config load or per request decides whether
 * deleting one underneath a live turn changes what that agent *is* mid-reply.
 * Not writing makes the question moot; the restart regenerates everything from
 * scratch, which it already did.
 *
 * ## The engine's environment, and why it is narrow
 *
 * The engine gets **the same narrowed environment a third-party stdio MCP
 * server gets** — `shellEnvForChild` over the login-shell environment — plus an
 * explicit, enumerated set of variables we add ourselves.
 *
 * The instinct is that this should be looser: the engine is our own binary, not
 * a third party, and `envMerge`'s reasoning is about not widening the blast
 * radius of the user's shell secrets to code we did not write. But the thing
 * that *runs inside* the engine is a language model with a bash tool, driven by
 * whatever text arrives in a conversation, and its output goes on screen and
 * into the database. A shell environment handed to it is one prompt injection
 * away from being read aloud. `ANTHROPIC_API_KEY`, `GITHUB_TOKEN` and `AWS_*`
 * live in exactly the `.zshrc` this app is deliberately sourcing, so the
 * narrowing applies with *more* force here than it does for an MCP server,
 * whose tools at least have fixed schemas.
 *
 * It also costs nothing. Every credential the engine legitimately needs is
 * injected here by name, decrypted from our own keystore; the agent's own
 * secrets stay in `credentials/.env` where its scripts read them. The login
 * shell is being consulted for `PATH` — so `uv`, `make` and `python` resolve —
 * and for nothing else.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { createServer } from 'node:net'
import { app } from 'electron'
import { createLogger } from '../logger/logger'
import { getShellEnv, shellEnvForChild } from '../shell/env'
import { turnLock } from '../services/localAgents/turnLock'
import { appSettingsRepo } from '../db/appSettings'
import {
  engineRootDir,
  realBinaryResolverDeps,
  resolveEngineBinaryWith,
  type ResolvedEngineBinary
} from './binaryResolver'
import {
  buildEngineConfig,
  digestEngineConfig,
  writeEngineConfig,
  type BuiltEngineConfig,
  type EngineConfigDigest,
  type EngineModelRef,
  type SkippedAgent
} from './configGenerator'
import { collectEngineConfigInput } from './engineConfigSource'
import type { EngineSkips, EngineState } from '../../shared/engine'

const logger = createLogger('engine')

/**
 * The clock this module runs on.
 *
 * A mutable object rather than four `const`s so a test can shorten the health
 * window: the "server answers but is never healthy" path costs
 * `attempts × healthMs` by definition, and at the shipping value that is a
 * ninety-second test — long enough that it would be deleted, which is how a
 * failure path ends up with no coverage at all. Production never writes to it.
 */
export const ENGINE_TIMEOUTS = {
  /** How long a spawned engine has to answer its health check. */
  healthMs: 45_000,
  /** Gap between health probes while waiting for a fresh process to come up. */
  pollMs: 250,
  /** Ceiling on one health request, so a wedged socket cannot stall the poll. */
  requestMs: 3_000,
  /** How long a stopping process gets before SIGKILL. */
  stopGraceMs: 3_000
}

/** Starts to attempt before giving up. A second try covers a lost port race. */
const START_ATTEMPTS = 2

/** Stderr kept for the failure message. Enough to be useful, small enough to log. */
const STDERR_KEEP = 4_000

/**
 * The Basic-auth username OpenCode expects. Its own default, hard-coded rather
 * than left unset so the credential pair is visible in one place.
 */
const ENGINE_USERNAME = 'opencode'

/**
 * What one engine process read at spawn.
 *
 * Recorded on the process rather than in a module variable so it cannot outlive
 * the thing it describes: when the process dies this goes with it, and there is
 * no window in which a stale record claims to describe a running engine.
 */
interface LoadedConfig {
  digest: EngineConfigDigest
  /** Our agent id → the OpenCode agent key **this process** knows. */
  agentKeys: Map<string, string>
  /** Our agent id → the model **this process's** config gave that agent. */
  agentModels: Map<string, EngineModelRef>
  /** What **this process's** config left out, and why. */
  skippedAgents: SkippedAgent[]
}

interface RunningEngine {
  child: ChildProcess
  baseUrl: string
  authHeader: string
  port: number
  /** The config and credentials this process actually loaded. */
  loaded: LoadedConfig
}

let state: EngineState = {
  status: 'stopped',
  version: null,
  binarySource: null,
  binaryPath: null,
  pid: null,
  error: null,
  changedAt: Date.now()
}

let running: RunningEngine | null = null
let startInFlight: Promise<EngineState> | null = null
/**
 * How many times a stop has been *asked for*, ever.
 *
 * A counter rather than a boolean because a restart is a stop followed by a
 * start issued by this module itself, and a boolean cannot tell that stop from
 * the user's. It could not: `ensureRunning` cleared the flag unconditionally on
 * its way into a start, so a Stop pressed — or a `will-quit` fired — while a
 * reconcile was restarting got erased by the restart it was meant to cancel,
 * and the engine came back up under a user who had just turned it off. During a
 * quit that is an `opencode serve` left running with no window to stop it from.
 *
 * A start captures this value when it begins and treats any later value as
 * "somebody asked for a stop after I started"; an internal restart uses
 * {@link halt}, which stops without asking, so it cannot cancel itself.
 */
let stopEpoch = 0
/** Cached across starts: resolving the binary can mean a 50 MB download. */
let binary: ResolvedEngineBinary | null = null
/**
 * The Settings value {@link binary} was resolved against.
 *
 * Without this the cache is wrong the moment the user edits the engine path:
 * they would keep running the old binary until the app restarted, and the
 * Settings field would silently describe something that is not what is running.
 */
let binaryResolvedFor: string | null = null
/**
 * The reconcile {@link engineManager.ensureRunning} runs when the engine is
 * already up, shared between concurrent callers.
 *
 * Two chats opening at once would otherwise each restart, and the second would
 * hand back a state that says stopped for an engine that is coming back up.
 */
let reconcileInFlight: Promise<EngineState> | null = null

/** True once somebody asked for a stop after the given epoch was captured. */
function cancelled(epoch: number): boolean {
  return stopEpoch !== epoch
}

const listeners = new Set<(next: EngineState) => void>()

function setState(patch: Partial<EngineState>): void {
  const next = { ...state, ...patch, changedAt: Date.now() }
  const changed = (Object.keys(patch) as (keyof EngineState)[]).some(
    (key) => state[key] !== next[key]
  )
  state = next
  if (!changed) return
  logger.info('engine state', {
    status: next.status,
    source: next.binarySource,
    version: next.version,
    pid: next.pid,
    error: next.error
  })
  for (const listener of listeners) {
    try {
      listener(next)
    } catch (err) {
      logger.warn('an engine state listener threw', { error: String(err) })
    }
  }
}

/**
 * A free loopback port, from the OS.
 *
 * Closing the probe server before spawning leaves a window in which something
 * else can take the port. That is unavoidable without handing the child a
 * listening socket, which `opencode serve` has no way to accept — so the window
 * is made harmless instead: a start that loses the race fails its health check
 * and {@link ensureRunning} retries on a fresh port.
 */
function pickLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => (port > 0 ? resolve(port) : reject(new Error('no port available'))))
    })
  })
}

/** The engine path in Settings, or null for "resolve one for me". */
function configuredBinaryPath(): string | null {
  const value = appSettingsRepo.get('localAgentsEnginePath')
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * The child's environment: the narrowed shell environment, plus exactly what
 * the engine needs and nothing else. See the module comment for why it is
 * narrow rather than inherited.
 */
async function engineEnv(
  configPath: string,
  password: string,
  credentials: Record<string, string>
): Promise<Record<string, string>> {
  const base = shellEnvForChild(await getShellEnv())
  return {
    ...base,
    // Our generated config, in the app data dir — never the agents home.
    OPENCODE_CONFIG: configPath,
    // Without a password the server is unsecured, and it is a loopback server
    // that can run bash: any process on this machine could drive it. Fresh per
    // start, never written to disk, never logged, never sent to the renderer.
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_SERVER_USERNAME: ENGINE_USERNAME,
    // We pin and verify the binary; an engine that replaces itself underneath
    // that pin is exactly what the checksum exists to prevent.
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    ...credentials
  }
}

async function healthy(engine: RunningEngine): Promise<boolean> {
  try {
    const response = await fetch(`${engine.baseUrl}/api/health`, {
      headers: { Authorization: engine.authHeader },
      signal: AbortSignal.timeout(ENGINE_TIMEOUTS.requestMs)
    })
    if (!response.ok) return false
    const body = (await response.json()) as { healthy?: unknown }
    return body?.healthy === true
  } catch {
    return false
  }
}

/**
 * Wait for the engine to answer, or for its process to die.
 *
 * The dead-process check is the point. Without it a crashed engine is
 * indistinguishable from a slow one and the caller waits the full timeout for a
 * process that exited in the first 200 ms — which is exactly what a bad config
 * or a taken port looks like.
 */
async function waitForHealth(engine: RunningEngine, epoch: number): Promise<boolean> {
  const deadline = Date.now() + ENGINE_TIMEOUTS.healthMs
  while (Date.now() < deadline) {
    if (engine.child.exitCode !== null || engine.child.signalCode !== null) return false
    if (cancelled(epoch)) return false
    if (await healthy(engine)) return true
    await new Promise((resolve) => setTimeout(resolve, ENGINE_TIMEOUTS.pollMs))
  }
  return false
}

function killEngine(engine: RunningEngine): void {
  try {
    engine.child.kill('SIGTERM')
  } catch {
    /* already gone */
  }
  const child = engine.child
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }
  }, ENGINE_TIMEOUTS.stopGraceMs).unref?.()
}

/**
 * One spawn attempt. Resolves to a healthy engine, or null.
 *
 * Takes the whole built config rather than just its environment, because the
 * process that comes back has to carry a record of what it loaded — and the
 * only honest moment to take that record is the moment the bytes are handed
 * over.
 */
async function spawnAttempt(
  binaryPath: string,
  configPath: string,
  built: BuiltEngineConfig,
  epoch: number
): Promise<RunningEngine | null> {
  const port = await pickLoopbackPort()
  const password = randomBytes(32).toString('hex')
  const env = await engineEnv(configPath, password, built.env)
  const root = engineRootDir()
  mkdirSync(root, { recursive: true })

  // Logged **before** the spawn, not after a successful one. The transition
  // this module most needs a record of is an engine starting when nothing
  // should have started one — during a quit, or behind a stop — and a line
  // written only on success is exactly the line that would be missing then.
  logger.info('spawning the engine', { port })

  let child: ChildProcess
  try {
    child = spawn(binaryPath, ['serve', '--port', String(port), '--hostname', '127.0.0.1'], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (err) {
    logger.error('could not spawn the engine', { error: String(err) })
    return null
  }

  const engine: RunningEngine = {
    child,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    authHeader: `Basic ${Buffer.from(`${ENGINE_USERNAME}:${password}`).toString('base64')}`,
    loaded: {
      digest: digestEngineConfig(built),
      agentKeys: built.agentKeys,
      agentModels: built.agentModels,
      skippedAgents: built.skippedAgents
    }
  }

  let stderr = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-STDERR_KEEP)
  })
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    logger.debug('engine stdout', { line: chunk.trim().slice(0, 500) })
  })
  child.on('error', (err) => logger.error('engine process error', { error: err.message }))
  child.on('exit', (code, signal) => {
    if (running?.child !== child) return
    running = null
    // An engine that dies while we thought it was up is the case the readiness
    // strip exists for: nothing else will notice, because nothing polls.
    setState({
      status: 'failed',
      pid: null,
      error: `The local engine stopped unexpectedly (${signal ?? `exit ${code}`}).`
    })
    logger.error('engine exited unexpectedly', {
      code,
      signal,
      stderr: stderr.trim().slice(-1000)
    })
  })

  if (await waitForHealth(engine, epoch)) return engine

  logger.warn('engine did not become healthy', {
    port,
    exitCode: child.exitCode,
    stderr: stderr.trim().slice(-1000)
  })
  killEngine(engine)
  return null
}

async function startEngine(userId: string, epoch: number): Promise<EngineState> {
  const configured = configuredBinaryPath()
  if (!binary || binaryResolvedFor !== configured) {
    setState({ status: 'installing', error: null })
    try {
      binary = await resolveEngineBinaryWith(realBinaryResolverDeps(() => configured))
      binaryResolvedFor = configured
    } catch (err) {
      binary = null
      binaryResolvedFor = null
      const message = err instanceof Error ? err.message : String(err)
      setState({ status: 'failed', error: message, binarySource: null, binaryPath: null })
      return state
    }
  }
  setState({
    binarySource: binary.source,
    binaryPath: binary.path,
    version: binary.version
  })
  if (cancelled(epoch)) {
    setState({ status: 'stopped', pid: null, error: null })
    return state
  }

  setState({ status: 'starting', error: null })
  // A start is the one place that always generates fresh — models refreshed,
  // config and prompt files written, stale prompts pruned. That is what makes
  // the deferral above able to write nothing: whatever a deferred change would
  // have put on disk, the restart that loads it puts there anyway.
  const built = buildEngineConfig(await collectEngineConfigInput(userId, { refreshModels: true }))
  const root = engineRootDir()
  mkdirSync(root, { recursive: true })
  const written = writeEngineConfig(root, built)

  for (let attempt = 0; attempt < START_ATTEMPTS; attempt += 1) {
    if (cancelled(epoch)) break
    const engine = await spawnAttempt(binary.path, written.configPath, built, epoch)
    if (engine) {
      if (cancelled(epoch)) {
        killEngine(engine)
        break
      }
      running = engine
      setState({ status: 'running', pid: engine.child.pid ?? null, error: null })
      return state
    }
  }

  if (cancelled(epoch)) {
    setState({ status: 'stopped', pid: null, error: null })
    return state
  }
  setState({
    status: 'failed',
    pid: null,
    error: 'The local engine did not start. See the log for details.'
  })
  return state
}

/**
 * Which half of what the engine loaded has moved, in a form safe to log.
 *
 * Null when neither has. Never the digests themselves: the credential digest is
 * taken over live API keys, and this module's rule is that key material has no
 * safe representation in a log, digested or not.
 */
function whatMoved(loaded: EngineConfigDigest, desired: EngineConfigDigest): string | null {
  const config = loaded.config !== desired.config
  const credentials = loaded.env !== desired.env
  if (config && credentials) return 'config and credentials'
  if (config) return 'config'
  if (credentials) return 'credentials'
  return null
}

/**
 * Take the engine down, **without** asking for a stop.
 *
 * The body of {@link engineManager.stop} minus the epoch bump, so a restart
 * this module issues itself cannot look like a user's Stop to the start that
 * follows it — and, symmetrically, cannot hide a user's Stop that lands while
 * it runs.
 */
async function halt(): Promise<void> {
  const pending = startInFlight
  if (pending) {
    // A start in flight will see the epoch move and clean up after itself, but
    // only once it reaches its next checkpoint — so wait for it rather than
    // returning while a process is still being spawned behind us.
    await pending.catch(() => undefined)
  }
  const engine = running
  running = null
  if (engine) {
    logger.info('stopping the engine', { pid: engine.child.pid })
    killEngine(engine)
  }
  setState({ status: 'stopped', pid: null, error: null })
}

export const engineManager = {
  /** The current state, for the readiness strip and Settings. */
  getState(): EngineState {
    return state
  },

  /** Subscribe to state transitions. Returns an unsubscribe function. */
  onStateChange(listener: (next: EngineState) => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },

  /**
   * Start the engine if it is not running, and hand back the resulting state.
   *
   * Never throws: a failed start is a *state*, not an exception, because every
   * caller — the readiness strip, a turn about to run — has to render it either
   * way, and `ipcMain.handle` would drop the code off a thrown error anyway.
   */
  async ensureRunning(userId: string): Promise<EngineState> {
    if (running && state.status === 'running') {
      // **Reconcile, rather than return early.** This is the choke point: at
      // least five things invalidate a generated config — a credential added
      // or deleted, an account-config sync materialising managed providers on
      // a background timer with no IPC call to hook, a managed chat mode's
      // model, the default chat mode the Default runtime falls back to, and a
      // per-agent runtime write — and hooking each is a list that a sixth
      // input silently defeats. Deriving from current state at the moment the
      // engine is about to be used is correct for inputs nobody has thought of
      // yet, including the ones with nowhere to put a hook.
      //
      // A change deferred past an earlier streaming turn needs no separate
      // branch here, and used to have one. It is the same question — does what
      // this process loaded still match what we would generate — asked of the
      // running process rather than of a flag, so it answers itself for as long
      // as the answer stays true, and stops answering the moment a restart
      // makes it false, whoever caused that restart.
      if (reconcileInFlight) return reconcileInFlight
      const reconcile = this.applyConfigChange(userId).finally(() => {
        if (reconcileInFlight === reconcile) reconcileInFlight = null
      })
      reconcileInFlight = reconcile
      return reconcile
    }
    if (startInFlight) return startInFlight

    // Captured **here**, synchronously, not inside `startEngine`. `startEngine`
    // runs a microtask later, so reading the epoch there would let a `stop()`
    // issued in between look like it had happened before this start — the app
    // quitting mid-start, which is precisely the case the epoch exists for.
    const epoch = stopEpoch
    // Deferred through a resolved promise for the reason `getShellEnv` does it:
    // a synchronous throw in the body would run `finally` before `startInFlight`
    // was ever assigned, leaving a stale in-flight promise behind.
    const run = Promise.resolve()
      .then(() => startEngine(userId, epoch))
      .catch((err) => {
        logger.error('engine start failed', { error: String(err) })
        setState({
          status: 'failed',
          pid: null,
          error: err instanceof Error ? err.message : String(err)
        })
        return state
      })
      .finally(() => {
        if (startInFlight === run) startInFlight = null
      })

    startInFlight = run
    return run
  },

  /**
   * Rebuild the config and restart the engine **only if the running one is out
   * of date**.
   *
   * Called whenever something the config is derived from moves: a credential
   * added, removed or rotated, a runtime chosen, a folder rescanned. The
   * no-change case has to be cheap, because a rescan fires on every file the
   * user's assistant saves — restarting the engine on each one would kill a live
   * conversation to apply a config identical to the one already loaded.
   *
   * **Out of date is decided against the running process, not against the
   * disk.** Two things follow, and both were bugs before they were properties.
   * A rotated API key never touches the config file — it is an `{env:…}`
   * reference there and a value in the process environment (Invariant 4) — so a
   * comparison of bytes on disk reports "unchanged" for the one change that
   * makes every turn fail to authenticate; the credential digest is what sees
   * it. And because the comparison needs no write to happen first, a change
   * that is going to be deferred is discovered before anything is written.
   *
   * **A changed config does not restart a busy engine.** One `opencode serve`
   * serves every folder agent, so a restart ends every conversation in flight,
   * not only the one whose folder changed — Invariant 3, at the coarsest
   * granularity it has. When any turn holds a lock, this returns having done
   * nothing at all: nothing written, nothing pruned, no state moved. There is no
   * debt to record, because the next {@link ensureRunning} asks the same
   * question of the same running process and gets the same answer for as long
   * as it stays true.
   *
   * **It never starts an engine.** Starting is an explicit act — Settings, or a
   * turn (see `engine.ipc.ts`). A manifest save fires this on every field edit,
   * and a failed start clears the binary cache, so restarting from here would
   * re-run binary resolution — up to a 46 MB download — once per edit.
   *
   * This is also why there is no enumerated list of "things that call me". The
   * account-config sync can materialise a managed provider on a timer with no
   * IPC call to hook at all, so a list would be incomplete by construction. The
   * two honest choke points are a start (which always generates fresh) and a
   * turn (which is `ensureRunning`).
   */
  async applyConfigChange(userId: string): Promise<EngineState> {
    // Captured before the first await, so a Stop — or a `will-quit` — arriving
    // anywhere in what follows is still visible at the moment this decides to
    // restart.
    const epoch = stopEpoch
    if (!running || state.status !== 'running') return state
    let built: BuiltEngineConfig
    try {
      built = buildEngineConfig(await collectEngineConfigInput(userId, { refreshModels: false }))
    } catch (err) {
      logger.error('could not rebuild the engine config', { error: String(err) })
      return state
    }
    // Re-read after the await: the engine may have been stopped, or have died,
    // while the config was being collected.
    const engine = running
    if (!engine || state.status !== 'running') return state

    const moved = whatMoved(engine.loaded.digest, digestEngineConfig(built))
    if (!moved) return state
    if (turnLock.anyHeld()) {
      logger.info('the engine config changed while a turn is streaming; deferring', { moved })
      return state
    }
    logger.info('the engine config changed, restarting', { moved })
    // `halt`, not `stop`: this is our own restart, and asking for a stop here
    // would leave the start that follows unable to tell it from the user's.
    await halt()
    if (cancelled(epoch)) return state
    return this.ensureRunning(userId)
  },

  /**
   * Stop the engine, on somebody's explicit say-so. Safe to call when it is not
   * running, or mid-start.
   *
   * The epoch bump is the "somebody asked" part, and it is what an internal
   * restart deliberately does not do — see {@link halt}.
   */
  async stop(): Promise<void> {
    stopEpoch += 1
    await halt()
  },

  /**
   * Which OpenCode agent key a folder agent became **in the config the running
   * engine loaded**.
   *
   * Phase 6 opens a session against this key, so it has to name an entry the
   * engine actually has. Null means "this agent cannot be addressed right now",
   * which covers all three ways that happens: the engine is not running, the
   * generation that produced it skipped the agent, or the agent was added or
   * fixed after this process started and the restart that would load it is
   * still waiting on a streaming turn. Answering from the last config
   * *generated* instead would hand back a real-looking key for an entry the
   * engine has never heard of.
   */
  agentKey(agentId: string): string | null {
    return running?.loaded.agentKeys.get(agentId) ?? null
  },

  /**
   * Which model a folder agent's entry names, **in the config the running
   * engine loaded**, as `POST /api/session` spells it.
   *
   * Answered from the loaded record for exactly the reason {@link agentKey} is:
   * the last config we *generated* may be one the engine never read, and a
   * model the running process has never heard of resolves to
   * `SessionRunnerModel.ModelUnavailableError` — which the engine reports on no
   * event at all, so the turn hangs rather than fails.
   *
   * It has to be sent per session because the engine's v2 runner resolves a
   * model from `session.model` alone; `agent.<key>.model` in the config is not
   * read on that path. A session opened without one runs on whatever the engine
   * picks — verified 3 Sep 2026 to be a free `opencode/muse-spark-*` gateway.
   */
  agentModel(agentId: string): EngineModelRef | null {
    return running?.loaded.agentModels.get(agentId) ?? null
  },

  /**
   * What the **running** engine's config left out, for the Runtime card's
   * reason line.
   *
   * The running engine's, not the last generation's — an agent whose credential
   * was deleted a moment ago is still being served perfectly well until the
   * restart lands, and a reason line saying it cannot run would be describing a
   * config nothing has loaded. It follows that this only ever moves when
   * `running` moves, and every one of those transitions pushes a state change,
   * which is exactly the signal `useEngine` re-reads this on.
   */
  lastSkips(): EngineSkips {
    return { agents: running?.loaded.skippedAgents ?? [] }
  },

  /**
   * An authenticated request to the running engine.
   *
   * The base URL and the Basic-auth header never leave this module, which is
   * what keeps "everything talks to the engine through the runner" true by
   * construction rather than by convention.
   */
  async request(path: string, init?: RequestInit): Promise<Response> {
    const engine = running
    if (!engine || state.status !== 'running') {
      throw new Error('The local engine is not running.')
    }
    const headers = new Headers(init?.headers)
    headers.set('Authorization', engine.authHeader)
    return fetch(`${engine.baseUrl}${path}`, { ...init, headers })
  }
}

/**
 * Kill the engine synchronously.
 *
 * `will-quit` handlers are not awaited — Electron tears the process down around
 * an async one — and a spawned child is not reaped just because its parent
 * exits, so a quit that only scheduled an async stop would leave an
 * `opencode serve` running on the user's machine with no window to stop it
 * from. Signalling inside the handler body is what actually gets it killed.
 */
function stopEngineNow(): void {
  // The epoch, not a flag, and for the reason the epoch exists: a reconcile
  // that is mid-restart when the quit lands would otherwise resume, start an
  // engine, and leave an `opencode serve` behind a window that no longer
  // exists.
  stopEpoch += 1
  const engine = running
  running = null
  if (!engine) return
  logger.info('killing the engine on quit', { pid: engine.child.pid })
  try {
    engine.child.kill('SIGTERM')
  } catch {
    /* already gone */
  }
}

/** Stop the engine when the app quits. Registered from the IPC composition root. */
export function registerEngineShutdown(): void {
  app.on('will-quit', stopEngineNow)
}

/**
 * Drop the module state a stop does not clear. **Tests only.**
 *
 * Everything about a *running* engine now lives on {@link RunningEngine} and
 * dies with the process, so a stop leaves nothing behind that could describe
 * one. The binary cache is the deliberate exception — it exists precisely to
 * outlive a stop, so a restart does not re-download 46 MB — which makes it the
 * one thing that leaks from one test into the next, silently: a test that
 * changes the configured engine path would otherwise keep running the previous
 * test's binary. Reset it explicitly rather than trusting that no test ever
 * does.
 */
export function resetEngineStateForTests(): void {
  binary = null
  binaryResolvedFor = null
}
