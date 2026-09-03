import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { credentialEnvName, type EngineConfigInput } from './configGenerator'

/**
 * The engine as a **real subprocess**.
 *
 * Everything below spawns a process, binds a real loopback port and speaks real
 * HTTP to it. That is deliberate: every question worth asking here — does the
 * health check notice a dead process, does an external `kill` get seen, do two
 * concurrent starts produce one engine — is a question about processes, and a
 * mocked `spawn` answers all of them "yes" by construction.
 *
 * The stand-in engine is a small node script rather than the real `opencode`,
 * so these tests run anywhere. It speaks the two things `engineManager`
 * actually depends on: `--version` on stdout, and `GET /api/health` behind HTTP
 * Basic auth on `--port`. The real binary was driven separately during
 * development; what is pinned here is our side of the contract.
 *
 * ## What the child is asked to record, and why
 *
 * Each spawn dumps `{env, argv, pid}` next to the config it was pointed at.
 * `argv` is there because four of the decisions this module makes are only
 * visible in the command line — the port, the hostname, the subcommand — and a
 * test that cannot see them is a test that reads as coverage while the
 * behaviour it names is free to change. That is not hypothetical: before these
 * were added, replacing the whole port picker with a hard-coded 4096 and
 * changing `--hostname` to `0.0.0.0` both left this file entirely green.
 *
 * **Never assert absence by asking the child.** The child is SIGTERM'd within
 * a millisecond of a stop, well before a node process finishes booting, so
 * "no dump file appeared" is satisfied by a process that *was* spawned and
 * merely died early. Absence is asserted on artefacts the **parent** writes —
 * the generated `opencode.json` — which is synchronous and cannot race.
 *
 * Every assertion here was mutation-checked, including the ones that had to be
 * rewritten because their first version could not fail.
 */

const logs: { message: string; meta?: unknown }[] = vi.hoisted(() => [])
const settings = vi.hoisted(() => ({ enginePath: '' }))
const configInput = vi.hoisted(() => ({
  current: { providers: [], agents: [] } as EngineConfigInput,
  /**
   * An override that lets a test hold the start still inside config
   * generation. That window is the only place a stop can land *after* the
   * start's first checkpoint but *before* it spawns, which is the whole point
   * of the check inside the attempt loop.
   */
  generate: null as null | (() => Promise<EngineConfigInput>),
  /** How many times the collector was asked to refresh the model list. */
  modelRefreshes: 0
}))
const paths = vi.hoisted(() => ({ userData: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => paths.userData, on: () => undefined }
}))
/**
 * The scoped logger, captured rather than silenced.
 *
 * `engineManager` logs before it spawns, which makes "an engine was started"
 * observable **from the parent**. That matters because the child cannot be the
 * witness: it is SIGTERM'd within a millisecond of a stop, long before a node
 * process finishes booting, so "no spawn dump appeared" is satisfied by a
 * process that really was spawned. The log line is written synchronously in
 * this process and cannot race.
 */
vi.mock('../logger/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: (message: string, meta?: unknown) => logs.push({ message, meta }),
    warn: (message: string, meta?: unknown) => logs.push({ message, meta }),
    error: (message: string, meta?: unknown) => logs.push({ message, meta })
  })
}))
vi.mock('../db/appSettings', () => ({
  appSettingsRepo: { get: () => settings.enginePath }
}))
vi.mock('./engineConfigSource', () => ({
  collectEngineConfigInput: async (_userId: string, options?: { refreshModels?: boolean }) => {
    if (options?.refreshModels !== false) configInput.modelRefreshes += 1
    return configInput.generate ? configInput.generate() : configInput.current
  }
}))
/**
 * The narrowing is `envMerge`'s and is tested there; what matters here is that
 * `engineManager` passes a *narrow base* rather than the whole environment.
 * This fake keeps a marker variable out of the allowlist so a test can prove
 * the base was narrowed rather than inherited.
 */
vi.mock('../shell/env', () => ({
  // `which` is only reached when no path is configured; every test here
  // configures one, but the mock must still export it or the module's own
  // import fails and the start reports a mock error instead of starting.
  which: async () => null,
  getShellEnv: async () => ({
    ...process.env,
    PATH: process.env.PATH,
    A_SHELL_SECRET: 'sk-ant-should-never-reach-the-engine'
  }),
  shellEnvForChild: (base: NodeJS.ProcessEnv): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const key of ['HOME', 'PATH', 'SHELL', 'TERM', 'USER', 'LOGNAME', 'TMPDIR']) {
      const value = base[key]
      if (typeof value === 'string') out[key] = value
    }
    return out
  }
}))

const { ENGINE_TIMEOUTS, engineManager } = await import('./engineManager')
// The real lock, not a fake: what is being tested is that the engine consults
// the same lock a turn actually takes, and a stubbed one would let the engine
// consult nothing at all and still pass.
const { turnLock } = await import('../services/localAgents/turnLock')

// A real health window would make the "answers but never healthy" case a
// ninety-second test. Everything else here comes up in well under a second, so
// shortening this changes nothing except how long a failure takes to admit.
ENGINE_TIMEOUTS.healthMs = 2_000

let userData: string
let scripts: string

/** What the fake engine records about one spawn. */
interface SpawnDump {
  env: Record<string, string>
  argv: string[]
  pid: number
}

/** The generated config, which the **parent** writes before it spawns anything. */
function configPath(): string {
  return join(userData, 'engine', 'opencode.json')
}

/** Where the fake engine writes one file per spawn. */
function dumps(): SpawnDump[] {
  const dir = join(userData, 'engine')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.startsWith('spawn-') && name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as SpawnDump)
}

function envDumps(): Record<string, string>[] {
  return dumps().map((dump) => dump.env)
}

/** The `--port` the engine was actually told to bind. */
function spawnPort(dump: SpawnDump): number {
  return Number(dump.argv[dump.argv.indexOf('--port') + 1])
}

/**
 * A stand-in `opencode`: answers `--version`, and on `serve --port N` binds
 * loopback and serves `/api/health` behind Basic auth, exactly as the real one
 * does. `mode` picks a failure to simulate.
 */
function writeFakeEngine(name: string, mode: 'healthy' | 'dies' | 'unhealthy'): string {
  const path = join(scripts, name)
  writeFileSync(
    path,
    `#!/usr/bin/env node
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
if (args.includes('--version')) { console.log('9.9.9-fake'); process.exit(0) }

// One file per spawn, next to the config we were pointed at, so the test can
// count spawns and inspect exactly what environment we were handed.
const dir = path.dirname(process.env.OPENCODE_CONFIG || '.')
fs.writeFileSync(path.join(dir, 'spawn-' + Date.now() + '-' + process.pid + '.json'),
  JSON.stringify({ env: { ...process.env }, argv: args, pid: process.pid }))

if (${JSON.stringify(mode)} === 'dies') process.exit(3)

const port = Number(args[args.indexOf('--port') + 1])
const expected = 'Basic ' + Buffer.from('opencode:' + process.env.OPENCODE_SERVER_PASSWORD).toString('base64')
http.createServer((req, res) => {
  if (req.headers.authorization !== expected) {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ message: 'Authentication required' }))
    return
  }
  if (req.url === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ healthy: ${mode === 'unhealthy' ? 'false' : 'true'} }))
    return
  }
  res.writeHead(404)
  res.end()
}).listen(port, '127.0.0.1', () => {
  console.log('opencode server listening on http://127.0.0.1:' + port)
})
process.on('SIGTERM', () => process.exit(0))
`
  )
  chmodSync(path, 0o755)
  return path
}

async function until(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('timed out waiting for a condition')
}

function agentConfig(prompt: string): EngineConfigInput {
  return {
    providers: [
      {
        id: 'p1',
        type: 'anthropic',
        name: 'Anthropic',
        apiKey: 'sk-ant-THE-SECRET',
        baseUrl: null,
        models: []
      }
    ],
    agents: [
      {
        agentId: 'folder:aaa',
        slug: 'demo',
        description: 'demo',
        prompt,
        providerId: 'p1',
        modelId: 'claude-sonnet-4-5',
        permissions: null
      }
    ]
  }
}

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'cinna-engine-mgr-'))
  scripts = mkdtempSync(join(tmpdir(), 'cinna-engine-bin-'))
  paths.userData = userData
  settings.enginePath = writeFakeEngine('opencode', 'healthy')
  configInput.current = { providers: [], agents: [] }
  configInput.generate = null
  configInput.modelRefreshes = 0
  logs.length = 0
})

/** How many engines were spawned, as recorded by the parent before each spawn. */
function spawnLogCount(): number {
  return logs.filter((line) => line.message === 'spawning the engine').length
}

afterEach(async () => {
  turnLock.releaseAll()
  await engineManager.stop()
  rmSync(userData, { recursive: true, force: true })
  rmSync(scripts, { recursive: true, force: true })
})

describe('engineManager', () => {
  it('starts a real process, health-checks it and reports running', async () => {
    const state = await engineManager.ensureRunning('user-1')
    expect(state.status).toBe('running')
    expect(state.pid).toBeGreaterThan(0)
    expect(state.version).toBe('9.9.9-fake')
    expect(state.binarySource).toBe('configured')
    // Proof it is a live process rather than a state machine that said so.
    expect(() => process.kill(state.pid as number, 0)).not.toThrow()
  })

  it('binds a port it chose itself, never opencode’s default 4096', async () => {
    // `opencode serve --port 0` binds **4096**, not an OS-assigned port —
    // re-confirmed against the real v1.18.27 on 3 Sep 2026, which printed
    // `listening on http://127.0.0.1:4096`. So a second engine lands on the
    // port any `opencode serve` the user already has is holding, and the
    // collision is silent: the loser quietly comes up on some other port
    // instead of failing, which is harder to notice than a crash. The port has
    // to come from us.
    await engineManager.ensureRunning('user-1')
    await engineManager.stop()
    configInput.current = agentConfig('a')
    await engineManager.ensureRunning('user-1')

    const ports = dumps().map(spawnPort)
    expect(ports).toHaveLength(2)
    for (const port of ports) {
      // The three assertions together are what a hard-coded port fails: 4096 is
      // the specific collision, and the range and the inequality below catch a
      // constant that merely is not 4096.
      expect(port).not.toBe(4096)
      expect(port).toBeGreaterThan(1024)
      expect(port).toBeLessThan(65_536)
    }
    // Chosen afresh per start. An ephemeral port repeating across two starts is
    // possible in principle but has never been observed here; if it ever
    // flakes, the fix is to pick again, not to drop the assertion.
    expect(ports[0]).not.toBe(ports[1])
  })

  it('binds the engine to loopback only', async () => {
    // The engine runs a model with a bash tool. `--hostname 0.0.0.0` would put
    // it on every interface of the machine, reachable by anything on the
    // network that can guess a 32-byte password — and nothing else in this file
    // looks at the command line, so the change would otherwise be invisible.
    //
    // This is not a hypothetical typo. The real `opencode` ships `--mdns`,
    // which **defaults the hostname to `0.0.0.0`** and advertises the server on
    // the local network. We never pass it, and it is off by default, so the
    // exposure is one word away rather than present — which is exactly what
    // makes an assertion here worth having instead of a comment.
    await engineManager.ensureRunning('user-1')
    const [dump] = dumps()
    expect(dump.argv[dump.argv.indexOf('--hostname') + 1]).toBe('127.0.0.1')
    expect(dump.argv[0]).toBe('serve')
  })

  it('secures the loopback server with a per-start password', async () => {
    await engineManager.ensureRunning('user-1')
    const first = envDumps()[0]
    expect(first.OPENCODE_SERVER_PASSWORD).toMatch(/^[0-9a-f]{64}$/)
    expect(first.OPENCODE_SERVER_USERNAME).toBe('opencode')

    // Regenerated per start: a password that survived a restart would outlive
    // the process it was minted for.
    await engineManager.stop()
    configInput.current = agentConfig('a')
    await engineManager.ensureRunning('user-1')
    const dumps = envDumps()
    expect(dumps).toHaveLength(2)
    expect(dumps[1].OPENCODE_SERVER_PASSWORD).not.toBe(first.OPENCODE_SERVER_PASSWORD)
  })

  it('hands the engine a narrowed environment plus exactly what it needs', async () => {
    configInput.current = agentConfig('a')
    await engineManager.ensureRunning('user-1')
    const [env] = envDumps()

    // The shell secret is the whole point: `getShellEnv` sources `.zshrc`,
    // which is where the user's own API keys live, and the engine runs a model
    // with a bash tool.
    expect(env.A_SHELL_SECRET).toBeUndefined()
    expect(env.PATH).toBeTruthy()
    expect(env.OPENCODE_DISABLE_AUTOUPDATE).toBe('1')
    // The credential the engine legitimately needs, by name, from our keystore.
    expect(env[credentialEnvName('p1')]).toBe('sk-ant-THE-SECRET')

    // **The exact key set**, not merely "the secret is absent". "Exactly what
    // it needs" is the claim in the name of this test, and a spot-check on one
    // known-bad variable cannot make it: adding any new variable to `engineEnv`
    // passes a spot-check silently, which is how an enumerated allowlist decays
    // back into an inherited environment one well-meant line at a time.
    const passedThrough = ['HOME', 'PATH', 'SHELL', 'TERM', 'USER', 'LOGNAME', 'TMPDIR'].filter(
      (key) => typeof process.env[key] === 'string'
    )
    // macOS's CoreFoundation adds `__CF_USER_TEXT_ENCODING` to a child on its
    // own, whatever environment we pass. Dropping it here rather than adding it
    // to the expected set keeps this assertion about *our* enumeration.
    // Invariant 4 at the last boundary that matters: the state object is the
    // only thing about the engine that crosses to the renderer, and it is
    // built in the same function that handles the key and the password.
    const published = JSON.stringify(engineManager.getState())
    expect(published).not.toContain('sk-ant-THE-SECRET')
    expect(published).not.toContain(env.OPENCODE_SERVER_PASSWORD)
    // The **encoded** pair too, not only the raw password. The form the engine
    // is actually addressed with is the Basic header, and a state field that
    // carried it would pass a check for the hex string while handing the
    // renderer everything it needs to drive a shell-capable server directly.
    expect(published).not.toContain(
      Buffer.from(`opencode:${env.OPENCODE_SERVER_PASSWORD}`).toString('base64')
    )

    const ours = Object.keys(env).filter((key) => !key.startsWith('__CF_'))
    expect(new Set(ours)).toEqual(
      new Set([
        ...passedThrough,
        'OPENCODE_CONFIG',
        'OPENCODE_SERVER_PASSWORD',
        'OPENCODE_SERVER_USERNAME',
        'OPENCODE_DISABLE_AUTOUPDATE',
        credentialEnvName('p1')
      ])
    )
  })

  it('writes the config into the app data dir and never into an agents folder', async () => {
    configInput.current = agentConfig('a')
    await engineManager.ensureRunning('user-1')
    const [env] = envDumps()
    expect(env.OPENCODE_CONFIG).toBe(join(userData, 'engine', 'opencode.json'))
    // And the key is not in it — the config carries an `{env:…}` reference.
    expect(readFileSync(env.OPENCODE_CONFIG, 'utf8')).not.toContain('sk-ant-THE-SECRET')
  })

  it('notices when the process is killed from outside', async () => {
    const state = await engineManager.ensureRunning('user-1')
    process.kill(state.pid as number, 'SIGKILL')
    // Nothing polls, so this only works because the `exit` handler moves the
    // state. Without it the app would keep believing the engine is up and every
    // turn would fail against a closed socket.
    await until(() => engineManager.getState().status === 'failed')
    expect(engineManager.getState().error).toMatch(/stopped unexpectedly/i)
    expect(engineManager.getState().pid).toBeNull()
  })

  it('starts a fresh engine after the old one died', async () => {
    const first = await engineManager.ensureRunning('user-1')
    process.kill(first.pid as number, 'SIGKILL')
    await until(() => engineManager.getState().status === 'failed')

    const second = await engineManager.ensureRunning('user-1')
    expect(second.status).toBe('running')
    expect(second.pid).not.toBe(first.pid)
  })

  it('fails fast when the binary exits immediately instead of waiting out the health timeout', async () => {
    settings.enginePath = writeFakeEngine('dies', 'dies')
    const started = Date.now()
    const state = await engineManager.ensureRunning('user-1')
    expect(state.status).toBe('failed')
    // The bound is stated relative to the health window, not as a round number:
    // without the dead-process check both attempts run their full window, so
    // the floor for a broken version is `2 × healthMs`. A generous absolute
    // bound would sit *above* that and pass either way — which is exactly how a
    // fail-fast test ends up asserting nothing.
    expect(Date.now() - started).toBeLessThan(ENGINE_TIMEOUTS.healthMs)
  }, 30_000)

  it('reports failed when the server answers but is not healthy', async () => {
    settings.enginePath = writeFakeEngine('sick', 'unhealthy')
    const state = await engineManager.ensureRunning('user-1')
    expect(state.status).toBe('failed')
    expect(engineManager.getState().pid).toBeNull()
    // Both attempts ran and both processes were killed — a `failed` state that
    // left an `opencode serve` behind would be the worst outcome here.
    await until(() =>
      dumps().every((dump) => {
        try {
          process.kill(dump.pid, 0)
          return false
        } catch {
          return true
        }
      })
    )
  }, 30_000)

  it('spawns one engine for two concurrent starts', async () => {
    const [a, b] = await Promise.all([
      engineManager.ensureRunning('user-1'),
      engineManager.ensureRunning('user-1')
    ])
    expect(a.pid).toBe(b.pid)
    // The count is the assertion that matters — equal pids would also hold if
    // the second start had killed and replaced the first.
    expect(envDumps()).toHaveLength(1)
  })

  it('does not restart when a regenerated config is identical', async () => {
    configInput.current = agentConfig('the prompt')
    const first = await engineManager.ensureRunning('user-1')
    const after = await engineManager.applyConfigChange('user-1')
    expect(after.pid).toBe(first.pid)
    // A rescan fires on every file an assistant saves; restarting on each one
    // would kill a live conversation to load an identical config.
    expect(envDumps()).toHaveLength(1)
  })

  it('restarts when the generated config actually changed', async () => {
    configInput.current = agentConfig('the prompt')
    const first = await engineManager.ensureRunning('user-1')
    configInput.current = agentConfig('a completely different prompt')
    const after = await engineManager.applyConfigChange('user-1')
    expect(after.status).toBe('running')
    expect(after.pid).not.toBe(first.pid)
    expect(envDumps()).toHaveLength(2)
    // The old process is really gone, not merely forgotten.
    await until(() => {
      try {
        process.kill(first.pid as number, 0)
        return false
      } catch {
        return true
      }
    })
  })

  it('picks up a config change nobody reported, at the next point of use', async () => {
    // The choke point. Nothing calls `applyConfigChange` here — this is a
    // change arriving the way most of them actually do: a default chat mode
    // edited in Settings, a managed provider materialised by the background
    // account-config sync that has no IPC call to hook at all. `ensureRunning`
    // is what a turn calls, and deriving from current state there is what makes
    // those cases work without a hook apiece.
    configInput.current = agentConfig('the prompt')
    const first = await engineManager.ensureRunning('user-1')

    configInput.current = agentConfig('a completely different prompt')
    const after = await engineManager.ensureRunning('user-1')

    expect(after.status).toBe('running')
    expect(after.pid).not.toBe(first.pid)
    expect(spawnLogCount()).toBe(2)
  })

  it('leaves an unchanged engine alone at the point of use', async () => {
    // The other half, and the one that makes the reconcile affordable: a turn
    // happens far more often than a config changes, and an engine that
    // restarted on every `ensureRunning` would end the previous conversation
    // every time the user sent a message.
    configInput.current = agentConfig('the prompt')
    const first = await engineManager.ensureRunning('user-1')
    const second = await engineManager.ensureRunning('user-1')
    const third = await engineManager.ensureRunning('user-1')

    expect(second.pid).toBe(first.pid)
    expect(third.pid).toBe(first.pid)
    expect(spawnLogCount()).toBe(1)
  })

  it('reconciles once for two turns starting at the same moment', async () => {
    configInput.current = agentConfig('the prompt')
    await engineManager.ensureRunning('user-1')
    configInput.current = agentConfig('a completely different prompt')

    const [a, b] = await Promise.all([
      engineManager.ensureRunning('user-1'),
      engineManager.ensureRunning('user-1')
    ])
    // Without a shared in-flight reconcile the second caller regenerates while
    // the first is still stopping, sees bytes the first already wrote, reports
    // no change, and hands back a `stopped` state for an engine that is coming
    // back up.
    expect(a.status).toBe('running')
    expect(b.status).toBe('running')
    expect(a.pid).toBe(b.pid)
    expect(spawnLogCount()).toBe(2)
  })

  it('does not reach the network for a model list on every turn', async () => {
    // Every adapter's `listModels()` is a real request — Anthropic's SDK,
    // OpenAI's SDK, a `fetch` for Gemini — so one per credential, per turn,
    // in front of the user's message. The running engine's cache came from the
    // start that launched it; a reconcile compares against that.
    configInput.current = agentConfig('the prompt')
    await engineManager.ensureRunning('user-1')
    const afterStart = configInput.modelRefreshes
    expect(afterStart).toBeGreaterThan(0)

    await engineManager.ensureRunning('user-1')
    await engineManager.ensureRunning('user-1')
    expect(configInput.modelRefreshes).toBe(afterStart)
  })

  it('does not restart a busy engine, and writes the new config anyway', async () => {
    // One `opencode serve` serves every folder agent, so a restart ends every
    // conversation in flight — not only the one whose folder changed. A
    // credential saved in Settings must not end somebody's streaming reply.
    configInput.current = agentConfig('the prompt')
    const first = await engineManager.ensureRunning('user-1')

    // A turn on a *different* agent than the one being edited: the case a
    // per-agent lock check would get wrong.
    turnLock.acquire('folder:someone-else', 'turn')
    configInput.current = agentConfig('a completely different prompt')
    const after = await engineManager.applyConfigChange('user-1')

    expect(after.pid).toBe(first.pid)
    expect(envDumps()).toHaveLength(1)
    // Deferred, not dropped. The bytes are on disk; only the restart waits.
    expect(readFileSync(join(userData, 'engine', 'opencode.json'), 'utf8')).toBeTruthy()
    const prompts = dumps()
    expect(prompts).toHaveLength(1)
    expect(() => process.kill(first.pid as number, 0)).not.toThrow()
  })

  it('applies the deferred config change at the next turn boundary', async () => {
    configInput.current = agentConfig('the prompt')
    const first = await engineManager.ensureRunning('user-1')
    const handle = turnLock.acquire('folder:someone-else', 'turn')
    configInput.current = agentConfig('a completely different prompt')
    await engineManager.applyConfigChange('user-1')
    expect(engineManager.getState().pid).toBe(first.pid)

    // The turn ends, and the next caller — a turn about to start, or the
    // readiness strip — is what pays the debt off. Nothing polls, and nothing
    // had to be hooked into `release()`.
    handle.release()
    const after = await engineManager.ensureRunning('user-1')

    expect(after.status).toBe('running')
    expect(after.pid).not.toBe(first.pid)
    expect(envDumps()).toHaveLength(2)
    await until(() => {
      try {
        process.kill(first.pid as number, 0)
        return false
      } catch {
        return true
      }
    })
  })

  it('holds a deferred change back while another agent is still streaming', async () => {
    // The second turn is the dangerous moment: agent A is mid-reply, the config
    // changed, and now a turn starts on agent B. `ensureRunning` is exactly
    // what B's turn calls — so a deferred restart that fires on *any*
    // `ensureRunning` rather than on a free lock would end A's reply to start
    // B's, which is the bug the deferral existed to prevent.
    configInput.current = agentConfig('the prompt')
    const first = await engineManager.ensureRunning('user-1')
    const streaming = turnLock.acquire('folder:agent-a', 'turn')
    configInput.current = agentConfig('a completely different prompt')
    await engineManager.applyConfigChange('user-1')

    const duringSecondTurn = await engineManager.ensureRunning('user-1')
    expect(duringSecondTurn.pid).toBe(first.pid)
    expect(envDumps()).toHaveLength(1)

    // And it is still owed once the stream ends, not forgotten by the attempt.
    streaming.release()
    const after = await engineManager.ensureRunning('user-1')
    expect(after.pid).not.toBe(first.pid)
  })

  it('does not restart again once a deferred change has been applied', async () => {
    configInput.current = agentConfig('the prompt')
    await engineManager.ensureRunning('user-1')
    const handle = turnLock.acquire('folder:a', 'turn')
    configInput.current = agentConfig('changed once')
    await engineManager.applyConfigChange('user-1')
    handle.release()

    const applied = await engineManager.ensureRunning('user-1')
    // A deferred flag that is never cleared restarts the engine on **every**
    // subsequent turn, which is worse than the bug it was added to fix.
    const again = await engineManager.ensureRunning('user-1')
    expect(again.pid).toBe(applied.pid)
    expect(envDumps()).toHaveLength(2)
  })

  it('does not start an engine just because the config changed while stopped', async () => {
    configInput.current = agentConfig('a')
    const state = await engineManager.applyConfigChange('user-1')
    expect(state.status).toBe('stopped')
    expect(envDumps()).toEqual([])
  })

  it('stops the process and reports stopped', async () => {
    const state = await engineManager.ensureRunning('user-1')
    await engineManager.stop()
    expect(engineManager.getState().status).toBe('stopped')
    expect(engineManager.getState().pid).toBeNull()
    await until(() => {
      try {
        process.kill(state.pid as number, 0)
        return false
      } catch {
        return true
      }
    })
  })

  it('leaves nothing running when stop lands mid-start', async () => {
    // The app quitting while a start is in flight. `stop()` has to wait for the
    // start to reach a checkpoint rather than returning while a process is
    // still being spawned behind it.
    const starting = engineManager.ensureRunning('user-1')
    await engineManager.stop()
    await starting
    expect(engineManager.getState().status).toBe('stopped')
    expect(engineManager.getState().pid).toBeNull()
    // **No engine was ever spawned**, and the proof is a parent-side artefact.
    //
    // The obvious assertion — "no spawn dump appeared" — cannot fail: the
    // child is SIGTERM'd within a millisecond, long before a node process
    // finishes booting and writes anything, so a start that ignores the stop
    // flag entirely still leaves the directory empty. Verified by neutralising
    // `stopRequested` inside `startEngine`: this test stayed green while two
    // real `opencode` processes were spawned during app shutdown.
    //
    // `opencode.json` is written by the **parent**, synchronously, after the
    // stop checkpoint and before any spawn. Its absence is therefore
    // unraceable evidence that the start bailed out before doing any work.
    expect(existsSync(configPath())).toBe(false)
    expect(spawnLogCount()).toBe(0)
    expect(dumps()).toEqual([])
  })

  it('spawns nothing when the stop lands after the start passed its first checkpoint', async () => {
    // The checkpoint above runs before the config is generated, so it alone
    // would leave the rest of the start path unguarded. Here the stop arrives
    // *while* the config is being built — the app quitting a beat later — and
    // the only thing standing between that and a spawned engine is the check
    // inside the attempt loop.
    let released: () => void = () => {}
    let entered: () => void = () => {}
    const inConfig = new Promise<void>((resolve) => (entered = resolve))
    configInput.generate = async () => {
      entered()
      await new Promise<void>((resolve) => (released = resolve))
      return agentConfig('a')
    }

    const starting = engineManager.ensureRunning('user-1')
    await inConfig
    const stopping = engineManager.stop()
    released()
    await Promise.all([starting, stopping])

    expect(engineManager.getState().status).toBe('stopped')
    expect(engineManager.getState().pid).toBeNull()
    // The config *was* written this time — the start got that far, which is
    // what makes this a different scenario from the test above rather than a
    // second copy of it.
    expect(existsSync(configPath())).toBe(true)
    // **The parent's own record**, which is what makes this assertion able to
    // fail: removing `if (stopRequested) break` from the attempt loop spawns an
    // engine here, and the spawned process dies too fast to leave a dump.
    expect(spawnLogCount()).toBe(0)
    expect(dumps()).toEqual([])
  })

  /*
   * **One known gap left here, stated rather than implied.**
   *
   * Removing `await pending` from `stop()` changes nothing above, so "stop does
   * not return while a process is still being spawned behind it" is asserted by
   * no test. It needs a spawn that is *in flight* at the moment `stop()`
   * returns, and every checkpoint that remains in the start path prevents one
   * from existing — so the only way to observe it is to break something else
   * first, which is not a test.
   *
   * Both of the gaps that used to be here are closed. The one that mattered —
   * the attempt loop's checkpoint — is covered by `spawnLogCount()` above,
   * which reads the parent's own log rather than asking the child, and both
   * mutations that used to survive now fail.
   */

  it('refuses a request when the engine is not running', async () => {
    await expect(engineManager.request('/api/health')).rejects.toThrow(/not running/i)
  })

  it('reaches the engine over authenticated loopback once it is up', async () => {
    await engineManager.ensureRunning('user-1')
    const response = await engineManager.request('/api/health')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ healthy: true })
  })
})
