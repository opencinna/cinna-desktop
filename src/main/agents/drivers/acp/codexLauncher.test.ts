import { describe, expect, it, vi } from 'vitest'
import { createCodexLauncher, type CodexLauncherDeps } from './codexLauncher'
import { isRefusal, type AcpLaunchContext } from './acpLaunchers'
import { buildCodexEnv } from './codexEnv'
import { CodexAuthProbe, parseCodexAuthStatus, probeCodexAuth } from './codexAuth'
import type { execFile } from 'node:child_process'
import { getLogEntries, clearLogEntries } from '../../../logger/logger'

const context: AcpLaunchContext = { userId: 'u', agentId: 'folder:a', folder: {
  name: 'Agent', slug: 'agent', description: '', path: '/tmp/agent', kind: 'bare'
} }
function deps(over: Partial<CodexLauncherDeps> = {}): CodexLauncherDeps {
  return {
    path: async () => '/usr/local/bin/codex', auth: async () => ({ state: 'logged_in' }),
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
      { path: async () => '/other/codex' },
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

  it('refuses missing installs and known logged-out installs before spawning', async () => {
    const adapterEntry = vi.fn(() => '/adapter')
    for (const over of [{ path: async () => null }, { auth: async () => ({ state: 'logged_out' as const }) }]) {
      const launcher = createCodexLauncher(deps({ ...over, adapterEntry }))
      expect((await launcher.readiness!()).state).not.toBe('ok')
      expect(isRefusal(await launcher.plan(context))).toBe(true)
    }
    expect(adapterEntry).not.toHaveBeenCalled()
  })

  it('allows unknown auth, refreshes readiness, and explains a packaging failure', async () => {
    const path = vi.fn(async () => '/bin/codex')
    const auth = vi.fn(async () => ({ state: 'unknown' as const }))
    const launcher = createCodexLauncher(deps({ path, auth }))
    expect(await launcher.readiness!({ fresh: true })).toEqual({ state: 'ok', reason: null })
    expect(path).toHaveBeenCalledWith({ fresh: true })
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

  it('preserves the selected CLI profile and strips shell billing and adapter overrides', () => {
    const env = buildCodexEnv({ shellEnv: { HOME: '/home/user', CODEX_HOME: '/profile', OPENAI_API_KEY: 'secret', CODEX_API_KEY: 'secret', CODEX_PATH: '/evil', CODEX_CONFIG: '{}', INITIAL_AGENT_MODE: 'agent-full-access', OPENAI_BASE_URL: 'https://other', CINNA_ENGINE_KEY_TEST: 'secret' }, processEnv: {} })
    expect(env.CODEX_HOME).toBe('/profile')
    expect(env.HOME).toBe('/home/user')
    for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_PATH', 'CODEX_CONFIG', 'INITIAL_AGENT_MODE', 'OPENAI_BASE_URL', 'CINNA_ENGINE_KEY_TEST']) expect(env).not.toHaveProperty(key)
  })
})
