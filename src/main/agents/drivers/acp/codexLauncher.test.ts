import { describe, expect, it, vi } from 'vitest'
import { CODEX_NOT_INSTALLED, codexBinaryKnownFrom, createCodexLauncher, type CodexLauncherDeps } from './codexLauncher'
import { isRefusal, type AcpLaunchContext } from './acpLaunchers'
import type { AcpRuntimeMode } from './types'
import { buildCodexEnv } from './codexEnv'
import { CodexAuthProbe, parseCodexAuthStatus, probeCodexAuth } from './codexAuth'
import type { execFile } from 'node:child_process'
import { getLogEntries, clearLogEntries } from '../../../logger/logger'

const folder = {
  name: 'Agent', slug: 'agent', description: '', path: '/tmp/agent',
  kind: 'bare' as const, runtimeMode: 'native' as const
}
const context: AcpLaunchContext = { userId: 'u', agentId: 'folder:a', folder }
/** The same agent scaffolded from the kit, whose session the desktop seals. */
const kitContext: AcpLaunchContext = {
  ...context,
  folder: { ...folder, kind: 'kit', runtimeMode: 'isolated' }
}
function deps(over: Partial<CodexLauncherDeps> = {}): CodexLauncherDeps {
  return {
    binary: async () => ({ path: '/usr/local/bin/codex' }),
    binaryKnown: async () => ({ state: 'ready' }),
    auth: async () => ({ state: 'logged_in' }),
    adapterEntry: () => '/app/codex-acp/dist/index.js',
    nodeRuntime: () => ({ command: '/app/Electron', args: [], env: { ELECTRON_RUN_AS_NODE: '1' } }),
    env: async () => ({ HOME: '/home/test', PATH: '/usr/bin' }),
    systemPrompt: () => 'You are the folder agent.',
    settings: () => ({ model: null, effort: 'medium', approval: 'ask' }), ...over
  }
}

describe('Codex ACP launcher', () => {
  it('uses the detected CLI and assembled instructions with mandatory sandbox mode setup', async () => {
    const plan = await createCodexLauncher(deps()).plan(context)
    if (isRefusal(plan)) throw new Error(plan.error)
    expect(plan.spec.command).toBe('/app/Electron')
    expect(plan.spec.args).toEqual(['/app/codex-acp/dist/index.js'])
    expect(plan.spec.env).toMatchObject({ CODEX_PATH: '/usr/local/bin/codex', INITIAL_AGENT_MODE: 'read-only', ELECTRON_RUN_AS_NODE: '1' })
    expect(JSON.parse(plan.spec.env.CODEX_CONFIG)).toEqual({ developer_instructions: 'You are the folder agent.', model_reasoning_effort: 'medium' })
    expect(plan.setup).toEqual({ modeId: 'read-only' })
    expect(plan.init.clientCapabilities?.elicitation).toEqual({ form: {} })
  })

  it('sends a native folder the desktop context alone, and an isolated one the whole assembled prompt', async () => {
    // Codex loads the folder's own `AGENTS.md` and the user's
    // `~/.codex/config.toml` by itself, exactly as it does for a terminal
    // session there, so repeating the folder's instructions in
    // `developer_instructions` would state them twice. A kit folder has no
    // such loading of its own and still needs the whole document.
    // Mutation: drop the mode argument and a bare folder is handed the kit
    // document — every instruction the engine has already read, again.
    const systemPrompt = vi.fn((_userId: string, _agentId: string, mode: AcpRuntimeMode) =>
      mode === 'native' ? 'How you are running now: in this folder.' : 'You are the folder agent.')
    const bare = await createCodexLauncher(deps({ systemPrompt })).plan(context)
    if (isRefusal(bare)) throw new Error(bare.error)
    expect(JSON.parse(bare.spec.env.CODEX_CONFIG).developer_instructions)
      .toBe('How you are running now: in this folder.')
    expect(systemPrompt).toHaveBeenCalledWith('u', 'folder:a', 'native')

    const kit = await createCodexLauncher(deps({ systemPrompt })).plan(kitContext)
    if (isRefusal(kit)) throw new Error(kit.error)
    expect(JSON.parse(kit.spec.env.CODEX_CONFIG).developer_instructions).toBe('You are the folder agent.')
    expect(systemPrompt).toHaveBeenCalledWith('u', 'folder:a', 'isolated')
    // The instructions travel in the environment, so the two kinds cannot
    // share a pooled process.
    expect(kit.spec.key).not.toBe(bare.spec.key)
  })

  it('asks for background tasks only: native subagent sessions would hide the spawn call', async () => {
    const plan = await createCodexLauncher(deps()).plan(context)
    if (isRefusal(plan)) throw new Error(plan.error)
    expect(plan.init.clientCapabilities).toEqual({
      elicitation: { form: {} },
      _meta: { jetbrains: { air: { version: 1, capabilities: ['asyncTasks'] } } }
    })
  })

  it('replaces pooled processes when prompt, model, effort, approval or CLI changes', async () => {
    const baseline = await createCodexLauncher(deps()).plan(context)
    if (isRefusal(baseline)) throw new Error(baseline.error)
    for (const over of [
      { systemPrompt: () => 'New instructions' },
      { binary: async () => ({ path: '/other/codex' }) },
      { settings: () => ({ model: 'chosen-model', effort: 'medium', approval: 'ask' as const }) },
      { settings: () => ({ model: null, effort: 'high', approval: 'ask' as const }) },
      { settings: () => ({ model: null, effort: 'medium', approval: 'auto' as const }) }
    ]) {
      const plan = await createCodexLauncher(deps(over)).plan(context)
      if (isRefusal(plan)) throw new Error(plan.error)
      expect(plan.spec.key).not.toBe(baseline.spec.key)
    }
  })

  it('passes the chosen model and uses automatic review only when selected', async () => {
    const plan = await createCodexLauncher(deps({ settings: () => ({ model: 'my-model', effort: 'high', approval: 'auto' }) })).plan(context)
    if (isRefusal(plan)) throw new Error(plan.error)
    expect(JSON.parse(plan.spec.env.CODEX_CONFIG).model).toBe('my-model')
    expect(plan.setup.modeId).toBe('agent')
  })

  it('refuses a failed install and a known logged-out install before spawning', async () => {
    const adapterEntry = vi.fn(() => '/adapter')
    for (const over of [
      { binaryKnown: async () => ({ state: 'failed' as const, error: 'no network' }), binary: async () => ({ error: 'no network' }) },
      { auth: async () => ({ state: 'logged_out' as const }) }
    ]) {
      const launcher = createCodexLauncher(deps({ ...over, adapterEntry }))
      expect((await launcher.readiness!()).state).not.toBe('ok')
      expect(isRefusal(await launcher.plan(context))).toBe(true)
    }
    expect(adapterEntry).not.toHaveBeenCalled()
  })

  it('reports a failed install as not installed, with the remedy and the resolver’s sentence', async () => {
    const launcher = createCodexLauncher(deps({
      binaryKnown: async () => ({ state: 'failed', error: 'The downloaded Codex did not match its expected checksum.' })
    }))
    expect(await launcher.readiness!()).toEqual({
      state: 'not_installed',
      reason: CODEX_NOT_INSTALLED,
      detail: 'The downloaded Codex did not match its expected checksum.'
    })
    // The remedy is Cinna's own retry, never "install it in a terminal": a PATH
    // copy is not what spawned sessions run on.
    expect(CODEX_NOT_INSTALLED).toMatch(/Try again in Settings/)
    expect(CODEX_NOT_INSTALLED).not.toMatch(/terminal|npm|install it/i)
  })

  it('does not refuse while the managed CLI is merely not fetched yet, and never downloads to find out', async () => {
    // Mutation: refuse on `pending` and no agent on a fresh machine can ever
    // send the message that would fetch the CLI.
    const binary = vi.fn(async () => ({ path: '/managed/codex' }))
    const launcher = createCodexLauncher(deps({ binary, binaryKnown: async () => ({ state: 'pending' }) }))
    expect(await launcher.readiness!()).toEqual({ state: 'ok', reason: null })
    expect(binary).not.toHaveBeenCalled()
  })

  it('Check again on a failed install starts the retry and answers pending without waiting for the download', async () => {
    // Mutation: `await deps.refresh()` — the agent card's Check again and the
    // build composer then sit on a ~90 MB download with a ten-minute ceiling.
    const refresh = vi.fn(() => new Promise<never>(() => undefined))
    const failed = { state: () => ({ state: 'failed' as const, error: 'no network' }), refresh, known: async () => null }
    const answer = await Promise.race([
      codexBinaryKnownFrom(failed, { fresh: true }),
      new Promise((resolve) => setTimeout(() => resolve('waited for the download'), 50))
    ])
    expect(answer).toEqual({ state: 'pending' })
    expect(refresh).toHaveBeenCalledTimes(1)
    // Without `fresh` nothing is started and the failure is reported as it stands.
    expect(await codexBinaryKnownFrom(failed)).toEqual({ state: 'failed', error: 'no network' })
    expect(refresh).toHaveBeenCalledTimes(1)
    // A retry that rejects must not surface as an unhandled rejection.
    expect(await codexBinaryKnownFrom({ ...failed, refresh: async () => { throw new Error('boom') } }, { fresh: true })).toEqual({ state: 'pending' })
  })

  it('reports a copy from an earlier run as ready with one stat, and never refreshes to find out', async () => {
    const refresh = vi.fn(async () => undefined)
    expect(await codexBinaryKnownFrom({ state: () => ({ state: 'unresolved' }), refresh, known: async () => '/managed/codex' }, { fresh: true })).toEqual({ state: 'ready' })
    expect(await codexBinaryKnownFrom({ state: () => ({ state: 'resolving' }), refresh, known: async () => null })).toEqual({ state: 'pending' })
    expect(await codexBinaryKnownFrom({ state: () => ({ state: 'ready' }), refresh, known: async () => null })).toEqual({ state: 'ready' })
    expect(refresh).not.toHaveBeenCalled()
  })

  it('resolves the binary at the top of the turn and hands a download failure back in words', async () => {
    const sentence = 'The downloaded Codex did not match its expected checksum, so it was discarded. Check your connection and try again.'
    const auth = vi.fn(async () => ({ state: 'logged_in' as const }))
    // `binaryKnown` says pending, so only `binary()` can produce this refusal.
    const launcher = createCodexLauncher(deps({
      binaryKnown: async () => ({ state: 'pending' }), binary: async () => ({ error: sentence }), auth
    }))
    expect(await launcher.plan(context)).toEqual({ error: sentence })
    // The login is a question for the binary; with none, it is not asked.
    expect(auth).not.toHaveBeenCalled()
  })

  it('asks the login only after the binary is resolved', async () => {
    const order: string[] = []
    const launcher = createCodexLauncher(deps({
      binary: async () => { order.push('binary'); return { path: '/managed/codex' } },
      auth: async () => { order.push('auth'); return { state: 'logged_in' } }
    }))
    const plan = await launcher.plan(context)
    if (isRefusal(plan)) throw new Error(plan.error)
    expect(order).toEqual(['binary', 'auth'])
    expect(plan.spec.env.CODEX_PATH).toBe('/managed/codex')
  })

  it('allows unknown auth, refreshes readiness, and explains a packaging failure', async () => {
    const binaryKnown = vi.fn(async () => ({ state: 'ready' as const }))
    const auth = vi.fn(async () => ({ state: 'unknown' as const }))
    const launcher = createCodexLauncher(deps({ binaryKnown, auth }))
    expect(await launcher.readiness!({ fresh: true })).toEqual({ state: 'ok', reason: null })
    expect(binaryKnown).toHaveBeenCalledWith({ fresh: true })
    expect(auth).toHaveBeenCalledWith({ fresh: true })
    expect(isRefusal(await launcher.plan(context))).toBe(false)
    expect(await createCodexLauncher(deps({ adapterEntry: () => { throw Error() } })).plan(context)).toEqual({ error: expect.stringContaining('adapter is missing') })
  })

  it('fails closed when folder instructions or settings cannot be read', async () => {
    clearLogEntries()
    expect(isRefusal(await createCodexLauncher(deps({ systemPrompt: () => { throw Error('private instructions') } })).plan(context))).toBe(true)
    expect(getLogEntries()).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: 'codex-launcher', data: { agentId: context.agentId, phase: 'instructions' } })
    ]))
    expect(JSON.stringify(getLogEntries())).not.toContain('private instructions')
  })
})

describe('Codex CLI authentication', () => {
  it('recognizes only explicit login verdicts without exposing account details', () => {
    expect(parseCodexAuthStatus('Logged in using ChatGPT')).toEqual({ state: 'logged_in' })
    expect(parseCodexAuthStatus('Logged in using an API key - sk-secret')).toEqual({ state: 'logged_in' })
    expect(parseCodexAuthStatus('Not logged in\n')).toEqual({ state: 'logged_out' })
    expect(parseCodexAuthStatus('error: failed to check')).toEqual({ state: 'unknown' })
  })

  it('parses stderr on exit 1 and uses the same child environment as turns', async () => {
    const run = vi.fn((_path, _args, _options, callback) => callback({ code: 1 }, '', 'Not logged in'))
    const env = { HOME: '/test' }
    expect(await probeCodexAuth({ path: '/codex', env, exec: run as unknown as typeof execFile })).toEqual({ state: 'logged_out' })
    expect(run).toHaveBeenCalledWith('/codex', ['login', 'status'], expect.objectContaining({ env }), expect.any(Function))
  })

  it('logs probe states without CLI output or thrown errors, and bounds a hung probe', async () => {
    clearLogEntries()
    const run = vi.fn((_path, _args, _options, callback) => callback(null, '', 'Logged in using an API key - sk-secret'))
    await probeCodexAuth({ path: '/codex', env: {}, exec: run as unknown as typeof execFile })
    await probeCodexAuth({ path: '/codex', env: {}, exec: (() => { throw Error('sk-private') }) as unknown as typeof execFile })
    expect(JSON.stringify(getLogEntries())).not.toMatch(/sk-secret|sk-private/)
    expect(getLogEntries()).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: 'codex-auth', data: expect.objectContaining({ state: 'logged_in' }) }),
      expect.objectContaining({ scope: 'codex-auth', data: expect.objectContaining({ reason: 'spawn-failed' }) })
    ]))
    vi.useFakeTimers()
    try {
      const pending = probeCodexAuth({ path: '/codex', env: {}, timeoutMs: 10, exec: vi.fn() as unknown as typeof execFile })
      await vi.advanceTimersByTimeAsync(510)
      expect(await pending).toEqual({ state: 'unknown' })
      expect(getLogEntries().at(-1)?.data).toMatchObject({ reason: 'timeout' })
    } finally { vi.useRealTimers() }
  })

  it('caches and shares probes, refreshes after login, and tolerates detection failures', async () => {
    const probe = vi.fn(async () => ({ state: 'logged_in' as const }))
    const auth = new CodexAuthProbe({ path: async () => '/codex', env: async () => ({}), probe })
    await Promise.all([auth.status(), auth.status()])
    await auth.status()
    expect(probe).toHaveBeenCalledTimes(1)
    await auth.refresh()
    expect(probe).toHaveBeenCalledTimes(2)
    expect(await new CodexAuthProbe({ path: async () => { throw Error() }, env: async () => ({}) }).status()).toEqual({ state: 'unknown' })
  })

  it('does not cache "there was no binary to ask", so the turn that installs it still checks the login', async () => {
    // The managed CLI arrives with the first turn. Mutation: cache the pathless
    // `unknown` and a logged-out install sails past the launcher for 30 seconds.
    let path: string | null = null
    const probe = vi.fn(async () => ({ state: 'logged_out' as const }))
    const auth = new CodexAuthProbe({ path: async () => path, env: async () => ({}), probe })
    expect(await auth.status()).toEqual({ state: 'unknown' })
    expect(probe).not.toHaveBeenCalled()
    path = '/managed/codex'
    expect(await auth.status()).toEqual({ state: 'logged_out' })
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ path: '/managed/codex' }))
  })

  it('forgets the answer when the binary changes, without asking, and drops a probe still in flight', async () => {
    // Mutation: make `invalidate` a no-op — a new Codex Path keeps reporting
    // the old CLI's login for thirty seconds.
    let path = '/old/codex'
    let release: (value: { state: 'logged_in' }) => void = () => undefined
    const probe = vi.fn(async (input: { path: string }) => input.path === '/old/codex'
      ? new Promise<{ state: 'logged_in' }>((resolve) => { release = resolve })
      : { state: 'logged_out' as const })
    const auth = new CodexAuthProbe({ path: async () => path, env: async () => ({}), probe })
    const stale = auth.status()
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1))
    path = '/new/codex'
    auth.invalidate()
    expect(probe).toHaveBeenCalledTimes(1)
    // Not the stale in-flight promise: a new question, of the new binary.
    expect(await auth.status()).toEqual({ state: 'logged_out' })
    release({ state: 'logged_in' })
    expect(await stale).toEqual({ state: 'logged_in' })
    // The old binary's late answer was not kept over the new one's.
    expect(await auth.status()).toEqual({ state: 'logged_out' })
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('preserves the selected CLI profile and strips shell billing and adapter overrides', () => {
    const env = buildCodexEnv({ shellEnv: { HOME: '/home/user', CODEX_HOME: '/profile', OPENAI_API_KEY: 'secret', CODEX_API_KEY: 'secret', CODEX_PATH: '/evil', CODEX_CONFIG: '{}', INITIAL_AGENT_MODE: 'agent-full-access', OPENAI_BASE_URL: 'https://other', CINNA_ENGINE_KEY_TEST: 'secret' }, processEnv: {} })
    expect(env.CODEX_HOME).toBe('/profile')
    expect(env.HOME).toBe('/home/user')
    for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_PATH', 'CODEX_CONFIG', 'INITIAL_AGENT_MODE', 'OPENAI_BASE_URL', 'CINNA_ENGINE_KEY_TEST']) expect(env).not.toHaveProperty(key)
  })
})
