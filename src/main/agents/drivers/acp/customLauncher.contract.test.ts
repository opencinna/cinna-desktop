import { afterEach, describe, expect, it } from 'vitest'
import { realpathSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { StdioAcpConfig } from '../../../../shared/customAgents'
import type { LocalPermissionRequest } from '../../../../shared/localAgentRequests'
import type { RunEvent } from '../../../../shared/runEvents'
import { describeDriverContract, type DriverContractSubject, type TurnIO } from '../__golden__/driverContract'
import { goldenRow } from '../__golden__/driverWorld'
import { pendingRequests, type RequestResolution } from '../pendingRequests'
import { createAcpDriver, type AcpDriverDeps } from './acpDriver'
import { createAcpProcessPool } from './acpProcessPool'
import { startAcpConnection } from './acpConnection'
import { createCustomLauncher } from './customLauncher'
import { isRefusal } from './acpLaunchers'
import { createFakeAcp, waitFor, type FakeAcpScript } from './testSupport/fakeAcp'

const USER = 'custom-user'
const CHAT = 'custom-chat'
const ID = 'custom-checklist'
const REMOTE_CWD = '/remote-only/workspaces/checklist'
const SENTINELS = ['one literal argument with spaces', 'literal;dollar$quote\'and"double']
const HELLO: FakeAcpScript = { prompt: { emit: [{ kind: 'update', update: {
  sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Custom ACP answer.' }
} }] } }
const ASK: FakeAcpScript = { prompt: { emit: [{ kind: 'permission', toolCall: {
  toolCallId: 'custom-edit', title: 'Edit remote checklist', kind: 'edit', status: 'pending',
  rawInput: { filepath: `${REMOTE_CWD}/checklist.txt` }
} }] } }
interface Options {
  script?: FakeAcpScript
  config?: Partial<StdioAcpConfig>
  enabled?: boolean
  missing?: boolean
  invalid?: boolean
  readThrows?: boolean
  readinessRejects?: boolean
  childEnvRejects?: boolean
  grantFails?: boolean
  remembered?: string
  turnCeilingMs?: number
}
const worlds: { cleanup(): Promise<void> }[] = []
function world(options: Options = {}) {
  const fake = createFakeAcp(options.script ?? HELLO)
  // An explicitly selected shell stands in for SSH. The launcher must preserve
  // argv, not wrap or join it in another shell; the ACP peer is a real process.
  const config: StdioAcpConfig = { launcher: 'custom',
    command: ['/bin/sh', '-c', 'exec "$@"', 'custom-ssh-fixture', fake.spec.command, ...fake.spec.args, ...SENTINELS],
    cwd: REMOTE_CWD, localCwd: realpathSync(fake.dir), ...options.config }
  const env = { ...fake.spec.env, FAKE_ACP_WIRE_LOG: join(fake.dir, 'stdout.ndjson'), SSH_AUTH_SOCK: '/fixture-only/ssh-agent.sock' }
  const launcher = createCustomLauncher({ childEnv: async () => {
    if (options.childEnvRejects) throw new Error('Fixture child environment unavailable')
    return env
  }, defaultLocalCwd: () => realpathSync(fake.dir) })
  const row = goldenRow({ id: ID, name: 'Custom checklist', source: 'local', localPath: null,
    driver: 'acp', driverConfig: { ...config } })
  const sessions = new Map<string, string>()
  if (options.remembered) sessions.set(CHAT, options.remembered)
  const saved: string[] = []
  const grants: LocalPermissionRequest[] = []
  const events: RunEvent[] = []
  let valid = !options.invalid
  const validate = (): void => { if (!valid) throw new Error('The captured custom binding changed.') }
  const pool = createAcpProcessPool({ start: startAcpConnection })
  const deps: AcpDriverDeps = {
    pool, launcher: id => id === 'custom' ? launcher : undefined,
    readRuntime() {
      if (options.readThrows) throw new Error('Fixture runtime unavailable')
      if (options.missing) return null
      return { type: 'external', name: row.name, enabled: options.enabled ?? true, config, binding: 'fixture-revision-1',
        validate,
        readiness: async () => {
          if (options.readinessRejects) throw new TypeError('Fixture probe rejected')
          return { state: 'ok', reason: null }
        },
        readSession: chat => sessions.get(chat) ?? null,
        saveSession: (chat, value) => { validate(); sessions.set(chat, value); saved.push(value) },
        isGranted: () => false,
        rememberGrant: request => { validate(); if (options.grantFails) return false; grants.push(request); return true }
      }
    },
    registerRequest: input => pendingRequests.register(input),
    resolveRequest: (id, resolution) => pendingRequests.resolve(id, resolution) !== null,
    withLock: (_agent, _owner, fn) => fn(), cancelGraceMs: 100, turnCeilingMs: options.turnCeilingMs
  }
  const driver = createAcpDriver(deps)
  const cleanup = new AbortController()
  const running: ReturnType<typeof driver.run>[] = []
  const run = (io: Partial<TurnIO> = {}) => {
    const result = driver.run(USER, row, { chatId: CHAT, wireContent: 'Hello remote checklist.',
      signal: AbortSignal.any([cleanup.signal, io.signal ?? new AbortController().signal]),
      onEvent: io.onEvent ?? (event => events.push(event)) })
    running.push(result); return result
  }
  const answerRequest = async (requestId: string, resolution: RequestResolution) => {
    const owner = pendingRequests.owner(requestId)
    return owner ? driver.respond({ requestId, ...owner }, resolution) : { delivered: false }
  }
  const result = { fake, config, row, env, launcher, pool, driver, events, sessions, saved, grants, run, answerRequest,
    invalidate() { valid = false },
    async started() { await waitFor(() => fake.received('session/prompt').length > 0, 'custom prompt') },
    async asked() { return waitFor(() => events.find((event): event is Extract<RunEvent, { type: 'needs_input' }> => event.type === 'needs_input'), 'custom permission') },
    async cleanup() { cleanup.abort(); pendingRequests.clear(); await Promise.allSettled(running); await pool.shutdown(); fake.cleanup() }
  }
  worlds.push(result); return result
}
afterEach(async () => { pendingRequests.clear(); await Promise.all(worlds.splice(0).map(w => w.cleanup())) })

/** All fourteen clauses use the real custom launcher, shared ACP driver and child peer. No skipped clauses. */
describeDriverContract('acp custom command', (): DriverContractSubject => ({
  completes: () => world(),
  failures: () => ({
    missing_runtime: world({ missing: true }), disabled: world({ enabled: false }), stale_binding: world({ invalid: true }),
    environment_rejected: world({ childEnvRejects: true }),
    invalid_command: world({ config: { command: [] } }), invalid_local_cwd: world({ config: { localCwd: '/fixture-does-not-exist' } }),
    process_died: world({ script: { exitOnStart: { code: 3 } } }),
    prompt_failed: world({ script: { prompt: { error: { code: -32603, message: 'Custom prompt refused' } } } })
  }),
  hangs: () => world({ script: { prompt: { hang: true } } }),
  parks: () => ({ ...world({ script: ASK }), answer: { kind: 'permission', reply: 'once' } }),
  session: () => {
    const w = world(); let readBySecond: string | null = null
    return { first: w, second: { run(io) { readBySecond = w.sessions.get(CHAT) ?? null; return w.run(io) } },
      saved: () => w.saved, readBySecond: () => readBySecond }
  },
  underTest: () => { const w = world(); return { driver: w.driver, row: w.row, grantsWritten: () => w.grants.length } },
  readinessWorlds: () => Object.fromEntries([
    ['runtime_throws', { readThrows: true }], ['probe_rejects', { readinessRejects: true }], ['binding_changed', { invalid: true }]
  ].map(([name, options]) => { const w = world(options as Options); return [name, { driver: w.driver, row: w.row, grantsWritten: () => w.grants.length }] }))
}))

describe('custom launcher through a real shell and ACP peer', () => {
  it('keeps local spawn cwd, remote session cwd, argv and child environment distinct with no folder metadata', async () => {
    const w = world()
    const result = await w.run()
    expect(result.error).toBeUndefined(); expect(result.text).toBe('Custom ACP answer.')
    const start = w.fake.log().find(entry => entry.dir === 'start')!
    expect(start.cwd).toBe(w.config.localCwd)
    expect(start.argv?.slice(-SENTINELS.length)).toEqual(SENTINELS)
    expect(start.env).toMatchObject(w.env)
    expect(start.env?.ANTHROPIC_API_KEY).toBeUndefined()
    expect(start.env?.OPENAI_API_KEY).toBeUndefined()
    expect(start.env?.HOME).toBeUndefined()
    const initial = w.fake.received('initialize')[0].params!
    // Background tasks only: a custom agent with native subagent sessions
    // would move its spawn calls where the driver does not route them.
    expect(initial.clientCapabilities).toEqual({ elicitation: { form: {} },
      _meta: { jetbrains: { air: { version: 1, capabilities: ['asyncTasks'] } } },
      fs: { readTextFile: false, writeTextFile: false }, terminal: false, auth: { terminal: false } })
    expect(w.fake.received('session/new')[0].params).toEqual({ cwd: REMOTE_CWD, mcpServers: [] })
    expect(w.fake.received('session/set_mode')).toEqual([])
    expect(w.fake.received('session/set_config_option')).toEqual([])
    expect(w.fake.received('session/prompt')[0].params?.prompt).toEqual([{ type: 'text', text: 'Hello remote checklist.' }])
    expect(w.driver.capabilities(w.row).cwd).toBe(false)
    await w.run()
    expect(w.fake.received('session/load')[0].params).toEqual({ sessionId: 'ses_fake', cwd: REMOTE_CWD, mcpServers: [] })
    expect(w.fake.log().filter(entry => entry.dir === 'start')).toHaveLength(1)
    expect(w.fake.received('authenticate')).toEqual([])
    for (const line of readFileSync(w.env.FAKE_ACP_WIRE_LOG, 'utf8').split('\n').filter(Boolean)) {
      expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' })
    }
  })

  it('uses the local default without substituting the remote working directory', async () => {
    const w = world({ config: { localCwd: undefined } })
    expect((await w.run()).error).toBeUndefined()
    expect(w.fake.log().find(entry => entry.dir === 'start')?.cwd).toBe(realpathSync(w.fake.dir))
    expect(w.fake.received('session/new')[0].params?.cwd).toBe(REMOTE_CWD)
  })

  it('changes the pool identity when argv, remote/local cwd, user, binding or child environment changes', async () => {
    const w = world()
    const ctx = { userId: USER, agentId: ID, custom: w.config, binding: 'revision-1' }
    const baseline = await w.launcher.plan(ctx)
    if (isRefusal(baseline)) throw new Error(baseline.error)
    const changed = [
      { ...ctx, custom: { ...w.config, command: [...w.config.command, 'different argv'] } },
      { ...ctx, custom: { ...w.config, cwd: '/other/remote' } },
      { ...ctx, custom: { ...w.config, localCwd: '/tmp' } },
      { ...ctx, userId: 'another-profile' }, { ...ctx, binding: 'revision-2' }
    ]
    for (const input of changed) {
      const next = await w.launcher.plan(input)
      if (isRefusal(next)) throw new Error(next.error)
      expect(next.spec.key).not.toBe(baseline.spec.key)
    }
    w.env.SSH_AUTH_SOCK = '/fixture-only/new-agent.sock'
    const next = await w.launcher.plan(ctx)
    if (isRefusal(next)) throw new Error(next.error)
    expect(next.spec.key).not.toBe(baseline.spec.key)
    expect(w.fake.log()).toEqual([])
  })

  it('sends ACP once for Always, writes only the captured external grant authority and refuses a stale binding', async () => {
    const w = world({ script: ASK })
    const running = w.run(); const ask = await w.asked()
    expect(await w.answerRequest(ask.requestId, { kind: 'permission', reply: 'always' })).toEqual({ delivered: true, remembered: true })
    await running
    expect(w.grants).toHaveLength(1)
    expect(w.fake.answers('session/request_permission')[0].result).toEqual({ outcome: { outcome: 'selected', optionId: 'once' } })
    expect(await w.answerRequest(ask.requestId, { kind: 'permission', reply: 'always' })).toEqual({ delivered: false })

    const stale = world({ script: ASK })
    const controller = new AbortController(); const stopped = stale.run({ signal: controller.signal })
    const oldAsk = await stale.asked(); stale.invalidate()
    expect(await stale.answerRequest(oldAsk.requestId, { kind: 'permission', reply: 'always' })).toEqual({ delivered: false })
    expect(stale.grants).toEqual([]); expect(stale.fake.answers('session/request_permission')).toEqual([])
    controller.abort(); await stopped
  })

  it.each([
    ['initialize', 'initialize', 'stop'], ['newSession', 'session/new', 'stop'], ['loadSession', 'session/load', 'stop'],
    ['initialize', 'initialize', 'ceiling'], ['newSession', 'session/new', 'ceiling'], ['loadSession', 'session/load', 'ceiling']
  ] as const)('settles a silent %s on %s via %s, retires the process, and allows a fresh explicit turn', async (stage, method, ending) => {
    const w = world({ script: { ...HELLO, [stage]: { hang: true } },
      remembered: stage === 'loadSession' ? 'ses_remembered' : undefined,
      turnCeilingMs: ending === 'ceiling' ? 650 : undefined })
    const controller = new AbortController()
    const running = w.run({ signal: controller.signal })
    await waitFor(() => w.fake.received(method).length === 1, `silent ${method} entered`)
    const pid = w.fake.log().find(entry => entry.dir === 'start')!.pid!
    if (ending === 'stop') controller.abort()
    const result = await running
    if (ending === 'stop') { expect(result.taskState).toBe('canceled'); expect(result.error).toBeUndefined() }
    else expect(result.error?.message).toEqual(expect.any(String))
    expect(w.fake.received('session/prompt')).toEqual([])
    expect(w.saved).toEqual([])
    expect(w.pool.status(ID).state).not.toBe('running')
    await waitFor(() => { try { process.kill(pid, 0); return false } catch { return true } }, 'canceled startup process exit')

    // This is a new user action after the canceled process is gone, not an
    // automatic retry of the abandoned session operation.
    writeFileSync(w.fake.spec.env.FAKE_ACP_SCRIPT, JSON.stringify(HELLO))
    const next = await w.run()
    expect(next.error).toBeUndefined(); expect(next.text).toBe('Custom ACP answer.')
    expect(w.fake.received('session/prompt')).toHaveLength(1)
    expect(w.fake.log().filter(entry => entry.dir === 'start')).toHaveLength(2)
  })

  it('confirms cancellation over ACP and warns honestly when a remote peer ignores cancellation', async () => {
    for (const ignores of [false, true]) {
      const w = world({ script: { prompt: ignores ? { hang: true } : { emit: [{ kind: 'awaitCancel' }] } } })
      const controller = new AbortController(); const running = w.run({ signal: controller.signal })
      await w.started(); controller.abort()
      const result = await running
      expect(result.taskState).toBe('canceled'); expect(result.error).toBeUndefined()
      expect(w.fake.received('session/cancel')).toHaveLength(1)
      const notices = result.notices.map(notice => notice.text).join('\n')
      if (ignores) {
        expect(notices).toContain('without confirmation that the remote agent stopped')
        expect(w.pool.status(ID).state).not.toBe('running')
      } else expect(notices).not.toContain('without confirmation')
    }
  })
})
