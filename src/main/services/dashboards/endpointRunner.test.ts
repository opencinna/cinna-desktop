import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ScheduleCommandOutcome } from '../../../shared/localSchedules'

/**
 * The endpoint runner over `commandService`'s real `execute`: real `sh -c`
 * children for stdin, the caps, EPIPE, the quoted fallback and the timeout
 * kill — a mock could not prove any of them — and a scripted `execute` for
 * the queue (cap of 3) and supersede, which are about ordering, not processes.
 */

vi.mock('../../host/runtimeHost', () => ({
  runtimeHost: { isPackaged: false, getAppPath: () => process.cwd(), resourcesPath: '', getPath: () => '/nonexistent', nodeRuntime: () => ({ command: process.execPath, args: [], env: {} }) }
}))
vi.mock('../../logger/logger', () => ({ createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }) }))
vi.mock('../../shell/env', () => ({ getShellEnv: async () => process.env, shellEnvForChild: (env: NodeJS.ProcessEnv) => env }))
vi.mock('../localAgents/localAgentService', () => ({ localAgentService: { locate: () => { throw new Error('not used') } } }))

const { executeLocalCommand } = await import('../localAgents/commandService')
const { createEndpointRunner, NATIVE_ADDON_MESSAGE, MAX_ENDPOINT_STDOUT_BYTES, shellQuote } = await import('./endpointRunner')
type Deps = Parameters<typeof createEndpointRunner>[0]

let base = ''
let agentDir = ''

function script(name: string, body: string): string {
  const rel = `dashboards/demo/api/${name}`
  const file = join(agentDir, rel)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, body)
  return rel
}

function deps(overrides: Partial<Deps> = {}): Deps {
  return {
    execute: executeLocalCommand,
    childEnv: async () => ({ ...process.env }),
    localizePython: (command) => command,
    resolveNode: async () => process.execPath,
    nodeRuntime: () => ({ command: process.execPath, args: [], env: {} }),
    tryLock: () => ({ release: () => {} }),
    uvReason: async () => null,
    ...overrides
  }
}

const call = (rel: string, extra: Record<string, unknown> = {}) => ({
  agentId: 'folder:a', agentDir, script: rel, runtime: 'node' as const, params: { month: '2026-09' }, key: 'tile:src', ...extra
})

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'dash-run-'))
  agentDir = join(base, 'agent')
  mkdirSync(agentDir)
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('an endpoint over the real execute', () => {
  it('gets the params on stdin and returns the JSON it prints', async () => {
    const rel = script('echo.mjs', `const t = await new Response(process.stdin).text(); console.log(JSON.stringify({ got: JSON.parse(t), cwd: process.cwd() }))`)
    const outcome = await createEndpointRunner(deps()).run(call(rel))
    expect(outcome).toMatchObject({ ok: true, value: { got: { month: '2026-09' } } })
    expect((outcome as { value: { cwd: string } }).value.cwd.endsWith('agent')).toBe(true)
  })

  it('survives a script that never reads 1 MB of stdin (EPIPE)', async () => {
    const rel = script('ignores.mjs', `console.log('{"ok":1}')`)
    const outcome = await createEndpointRunner(deps()).run(call(rel, { params: { blob: 'x'.repeat(1024 * 1024) } }))
    expect(outcome).toMatchObject({ ok: true, value: { ok: 1 } })
  })

  it('caps stdout at 5 MB and says the output is too large', async () => {
    const rel = script('big.mjs', `process.stdout.write('"' + 'x'.repeat(${MAX_ENDPOINT_STDOUT_BYTES + 1000}) + '"')`)
    const outcome = await createEndpointRunner(deps()).run(call(rel))
    expect(outcome).toMatchObject({ ok: false, code: 'too_large', message: expect.stringMatching(/too large/) })
  })

  it('fails a non-zero exit with the last 2,000 characters of stderr', async () => {
    const rel = script('fails.mjs', `process.stderr.write('a'.repeat(20000) + 'THE-END'); process.exit(3)`)
    const outcome = await createEndpointRunner(deps()).run(call(rel))
    expect(outcome.ok).toBe(false)
    const message = (outcome as { message: string }).message
    expect(message).toMatch(/^The endpoint exited with code 3: a+THE-END$/)
    expect(message.length).toBeLessThan(2100)
  })

  it('says a script printed no JSON', async () => {
    const rel = script('text.mjs', `console.log('hello')`)
    expect(await createEndpointRunner(deps()).run(call(rel))).toMatchObject({ ok: false, code: 'not_json' })
  })

  it('runs the fallback Node single-quoted, so a path with spaces and quotes works, with ELECTRON_RUN_AS_NODE', async () => {
    const odd = join(base, "Cinna Desktop's.app", 'MacOS')
    mkdirSync(odd, { recursive: true })
    const binary = join(odd, 'Cinna Desktop')
    symlinkSync(process.execPath, binary)
    // The leading args are the extra-CA preload, under the same odd path.
    const preloadDir = join(base, "Cinna Desktop's.app", 'Resources', 'node-extra-ca')
    cpSync(join(__dirname, '..', '..', '..', '..', 'resources', 'node-extra-ca'), preloadDir, { recursive: true })
    const preload = join(preloadDir, 'preload.cjs')
    const rel = script('env.mjs', `console.log(JSON.stringify({ flag: process.env.ELECTRON_RUN_AS_NODE ?? null, execArgv: process.execArgv }))`)
    const execute = vi.fn(executeLocalCommand)
    const runner = createEndpointRunner(deps({ execute, resolveNode: async () => null, nodeRuntime: () => ({ command: binary, args: ['--require', preload], env: {} }) }))
    expect(await runner.run(call(rel))).toMatchObject({ ok: true, value: { flag: '1', execArgv: ['--require', preload] } })
    expect(execute.mock.calls[0][0]).toBe(`${shellQuote(binary)} ${shellQuote('--require')} ${shellQuote(preload)} ${shellQuote(rel)}`)
  })

  it('names a native addon on the fallback, and only there', async () => {
    const rel = script('native.mjs', `process.stderr.write('Error: was compiled against a different Node.js version using NODE_MODULE_VERSION 145'); process.exit(1)`)
    const fallback = await createEndpointRunner(deps({ resolveNode: async () => null })).run(call(rel))
    expect(fallback).toMatchObject({ ok: false, message: NATIVE_ADDON_MESSAGE })
    const own = await createEndpointRunner(deps()).run(call(rel))
    expect((own as { message: string }).message).toMatch(/exited with code 1: .*NODE_MODULE_VERSION/)
  })

  it('kills the whole process group at the timeout', async () => {
    const pidFile = join(base, 'grandchild.pid')
    const rel = script(
      'slow.mjs',
      `import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs'
       const c = spawn('sleep', ['30'], { stdio: 'ignore' }); writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setInterval(() => {}, 1000)`
    )
    const outcome = await createEndpointRunner(deps()).run(call(rel, { timeoutS: 1 }))
    expect(outcome).toMatchObject({ ok: false, code: 'timeout', message: 'The endpoint did not finish within 1s and was stopped.' })
    expect(existsSync(pidFile)).toBe(true)
    const pid = Number(readFileSync(pidFile, 'utf8'))
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(() => process.kill(pid, 0)).toThrow()
  }, 10_000)

  it('an editor save mid-run takes the agent at once: the run is killed and comes back interrupted', async () => {
    const { turnLock } = await import('../localAgents/turnLock')
    turnLock.releaseAll()
    const pidFile = join(base, 'endpoint.pid')
    const rel = script('long.mjs', `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`)
    const runner = createEndpointRunner(deps({ tryLock: (agentId, onPreempt) => turnLock.tryAcquireSharedYielding(agentId, 'dashboard', onPreempt) }))
    const run = runner.run(call(rel, { timeoutS: 20 }))
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((resolve) => setTimeout(resolve, 50))
    const pid = Number(readFileSync(pidFile, 'utf8'))
    const editor = turnLock.acquire('folder:a', 'editor')
    expect(await run).toMatchObject({ ok: false, code: 'interrupted' })
    expect(() => process.kill(pid, 0)).toThrow()
    expect(turnLock.isExclusivelyLocked('folder:a')).toBe(true)
    editor.release()
    expect(turnLock.isLocked('folder:a')).toBe(false)
  }, 10_000)

  it('runs .py through the localized python command', async () => {
    const rel = script('data.py', 'print("{}")')
    const execute = vi.fn(async (..._args: Parameters<Deps['execute']>): Promise<ScheduleCommandOutcome> => ({ stdout: '{"py":true}', stderr: '', exitCode: 0, startedAt: 0, finishedAt: 0, timedOut: false, aborted: false, stdoutTruncated: false, stderrTruncated: false }))
    const runner = createEndpointRunner(deps({ execute, localizePython: (command) => command.replace(/^python /, 'uv run ') }))
    expect(await runner.run(call(rel, { runtime: 'python' }))).toMatchObject({ ok: true, value: { py: true } })
    expect(execute.mock.calls[0][0]).toBe(`uv run ${shellQuote(rel)}`)
  })

  it('redacts string values after parsing, keeping the JSON whole', async () => {
    const { rememberCredentialSecrets, clearCredentialRedaction } = await import('../../security/serviceCredentialRedaction')
    rememberCredentialSecrets({ api_key: 'sk-secret-"quoted"-value' })
    try {
      const rel = script('leak.mjs', `console.log(JSON.stringify({ note: 'key is sk-secret-"quoted"-value', n: 1 }))`)
      expect(await createEndpointRunner(deps()).run(call(rel))).toMatchObject({ ok: true, value: { note: 'key is ***REDACTED***', n: 1 } })
    } finally {
      clearCredentialRedaction()
    }
  })
})

/** A scripted `execute`: each call waits until the test settles it or its signal aborts. */
function scriptedExecute() {
  const calls: Array<{ command: string; settle: (stdout: string) => void; signal: AbortSignal }> = []
  const execute = (command: string, _cwd: string, _env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<ScheduleCommandOutcome> =>
    new Promise((resolve) => {
      const outcome = (stdout: string, aborted = false): ScheduleCommandOutcome => ({ stdout, stderr: '', exitCode: aborted ? null : 0, startedAt: 0, finishedAt: 0, timedOut: false, aborted, stdoutTruncated: false, stderrTruncated: false })
      signal.addEventListener('abort', () => resolve(outcome('', true)), { once: true })
      calls.push({ command, signal, settle: (stdout) => resolve(outcome(stdout)) })
    })
  return { calls, execute }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('the queue, supersede and the lock', () => {
  it('runs at most three endpoint processes at once and queues the rest', async () => {
    const { calls, execute } = scriptedExecute()
    const runner = createEndpointRunner(deps({ execute }))
    const runs = [0, 1, 2, 3, 4].map((i) => runner.run(call(`dashboards/demo/api/e${i}.mjs`, { key: `tile${i}:src` })))
    await tick()
    expect(calls).toHaveLength(3)
    expect(runner.stats()).toEqual({ running: 3, queued: 2 })
    calls[0].settle('1')
    await tick(); await tick()
    expect(calls).toHaveLength(4)
    for (const c of calls.slice(1)) c.settle('2')
    await tick(); await tick()
    calls[4].settle('3')
    const outcomes = await Promise.all(runs)
    expect(outcomes.every((o) => o.ok)).toBe(true)
    expect(runner.stats()).toEqual({ running: 0, queued: 0 })
  })

  it('lets the newest call per key win: the older one is aborted', async () => {
    const { calls, execute } = scriptedExecute()
    const runner = createEndpointRunner(deps({ execute }))
    const first = runner.run(call('dashboards/demo/api/a.mjs', { params: { v: 1 } }))
    await tick()
    const second = runner.run(call('dashboards/demo/api/a.mjs', { params: { v: 2 } }))
    await tick()
    expect(calls[0].signal.aborted).toBe(true)
    expect(await first).toMatchObject({ ok: false, code: 'superseded' })
    calls[1].settle('{"v":2}')
    expect(await second).toMatchObject({ ok: true, value: { v: 2 } })
  })

  it('aborts a queued call superseded before it got a slot, without spawning it', async () => {
    const { calls, execute } = scriptedExecute()
    const runner = createEndpointRunner(deps({ execute, maxConcurrent: 1 }))
    const blocker = runner.run(call('dashboards/demo/api/x.mjs', { key: 'other' }))
    const queued = runner.run(call('dashboards/demo/api/a.mjs'))
    const newer = runner.run(call('dashboards/demo/api/a.mjs'))
    expect(await queued).toMatchObject({ ok: false, code: 'superseded' })
    await tick()
    calls[0].settle('0')
    await blocker
    await tick()
    calls[1].settle('1')
    expect(await newer).toMatchObject({ ok: true })
    expect(calls).toHaveLength(2)
  })

  it('reports busy without spawning while the yielding lock refuses, and releases its slot', async () => {
    const { calls, execute } = scriptedExecute()
    const runner = createEndpointRunner(deps({ execute, tryLock: () => null }))
    expect(await runner.run(call('dashboards/demo/api/a.mjs'))).toMatchObject({ ok: false, code: 'busy' })
    expect(calls).toHaveLength(0)
    expect(runner.stats()).toEqual({ running: 0, queued: 0 })
  })

  it('holds the lock only while the process runs, and releases it however the run ends', async () => {
    const { calls, execute } = scriptedExecute()
    const release = vi.fn()
    const runner = createEndpointRunner(deps({ execute, tryLock: () => ({ release }) }))
    const run = runner.run(call('dashboards/demo/api/a.mjs'))
    await tick()
    expect(release).not.toHaveBeenCalled()
    calls[0].settle('not json')
    expect(await run).toMatchObject({ ok: false, code: 'not_json' })
    expect(release).toHaveBeenCalledOnce()
  })

  it('reports a caller’s abort as cancelled', async () => {
    const { execute } = scriptedExecute()
    const runner = createEndpointRunner(deps({ execute }))
    const controller = new AbortController()
    const run = runner.run(call('dashboards/demo/api/a.mjs', { signal: controller.signal }))
    await tick()
    controller.abort()
    expect(await run).toMatchObject({ ok: false, code: 'cancelled' })
  })
})
