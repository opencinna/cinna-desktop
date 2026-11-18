import { describe, expect, it, vi } from 'vitest'
import type { VaultEngine, VaultState } from '../../../../shared/vault/protocol'

vi.mock('../../../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
  setLogValueRedactor: () => {}
}))

const { createVaultAntigravityLauncher, createVaultCodexLauncher, createVaultOpencodeLauncher } = await import('./vaultEngineLaunchers')
const { createVaultClaudeLauncher, vaultReadiness, VAULT_ANTIGRAVITY_SIGNED_OUT, VAULT_OPENCODE_NO_PROVIDER } = await import('./vaultLauncher')
type Deps = import('./vaultLauncher').VaultLauncherDeps

/**
 * The vault launchers of Codex and OpenCode, and every engine's readiness,
 * against a stub vaultd: what a plan asks of the guest, what it hands the
 * driver, and that how the agent runs comes from the vault's kv (D34), never
 * from the host row's display copies.
 */

interface Vault {
  state: VaultState
  runtimes: { engine: VaultEngine; version: string; kind: 'executable' | 'archive' | 'adapter'; sha256: string }[]
  auth: Partial<Record<VaultEngine, { loggedIn: boolean; method?: 'api_key'; keyName?: string }>>
  kv: Record<string, unknown>
  /** What this app pins; default: exactly what is installed. */
  pins?: { engine: VaultEngine; version: string; kind: 'executable' | 'archive' | 'adapter'; sha256: string | null }[]
}

function depsFor(engine: VaultEngine, vault: Vault, row: { model?: string | null; approval?: 'auto' | 'ask'; kind?: 'kit' | 'bare' } = {}): Deps & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    vaultOf: () => ({ vaultId: 'v1', engine, kind: row.kind ?? 'kit', model: row.model ?? null, approval: row.approval ?? 'ask' }),
    stateOf: () => vault.state,
    pins: (e) => vault.pins?.filter((pin) => pin.engine === e) ?? defaultPins(e, vault.runtimes),
    client: async () => ({
      request: (async (method: string, params: Record<string, unknown>) => {
        calls.push(method)
        if (method === 'runtime.status') return { runtimes: vault.runtimes }
        if (method === 'auth.status') return vault.auth[params['engine'] as VaultEngine] ?? { loggedIn: false }
        if (method === 'kv.get') return { value: vault.kv[params['key'] as string] ?? null }
        throw new Error(`unexpected ${method}`)
      }) as never
    })
  }
}

/** By default the app pins exactly what is installed (the last row of each kind), and an adapter for Claude and Codex. */
function defaultPins(engine: VaultEngine, runtimes: Vault['runtimes']): NonNullable<Vault['pins']> {
  const last = (adapter: boolean) => runtimes.filter((r) => r.engine === engine && (r.kind === 'adapter') === adapter).at(-1)
  const executable = last(false)
  const adapter = last(true)
  return [
    { engine, kind: executable?.kind ?? 'archive', version: executable?.version ?? '1', sha256: executable?.sha256 ?? null },
    ...(engine === 'claude' || engine === 'codex' ? [{ engine, kind: 'adapter' as const, version: adapter?.version ?? '1', sha256: adapter?.sha256 ?? null }] : [])
  ]
}

const ctx = { userId: 'u', agentId: 'folder:a' } as never
const codexRuntimes: Vault['runtimes'] = [
  { engine: 'codex', version: '0.167.0', kind: 'archive', sha256: 'c0de' },
  { engine: 'codex', version: '2.5.0-f1dc49e2', kind: 'adapter', sha256: 'ada9' }
]

describe('Codex in a vault', () => {
  it('plans the vault engine, opening in the mode the vault holds (not the row\'s)', async () => {
    const vault: Vault = {
      state: 'unlocked', runtimes: codexRuntimes,
      auth: { codex: { loggedIn: true, method: 'api_key', keyName: 'OPENAI_API_KEY' } },
      kv: { 'cinna.launch': { kind: 'kit', model: 'gpt-5.6-luna', approval: 'auto' }, 'cinna.instructions': 'You are Payroll.' }
    }
    // The row says ask; the vault says auto.
    const plan = await createVaultCodexLauncher(depsFor('codex', vault, { approval: 'ask', model: 'o-row' })).plan(ctx)
    if (!('spec' in plan)) throw new Error(JSON.stringify(plan))
    expect(plan.spec.vault).toEqual({ agentId: 'folder:a', vaultId: 'v1', engine: 'codex', extraEnv: {} })
    expect(plan.spec.command).toBe('')
    expect(plan.sessionCwd).toBe('/vault/agent')
    expect(plan.setup).toEqual({ modeId: 'agent' })
    expect(plan.session).toEqual({ mcpServers: [] })
    expect(plan.spec.authFingerprint).toBe('vault:v1:api_key')

    // A changed prompt or model in the vault is a new process.
    const again = await createVaultCodexLauncher(depsFor('codex', { ...vault, kv: { ...vault.kv, 'cinna.instructions': 'Changed.' } })).plan(ctx)
    expect('spec' in again && again.spec.key).not.toBe(plan.spec.key)
  })

  it('refuses a vault with no codex adapter, and one with no key, in words that name the remedy', async () => {
    const missing = await createVaultCodexLauncher(depsFor('codex', { state: 'unlocked', runtimes: codexRuntimes.slice(0, 1), auth: {}, kv: {} })).plan(ctx)
    expect(missing).toEqual({ error: 'Codex is not installed in this vault. Use Update dependencies on the agent’s Security tab.' })
    const signedOut = await createVaultCodexLauncher(depsFor('codex', { state: 'unlocked', runtimes: codexRuntimes, auth: { codex: { loggedIn: false, keyName: 'OPENAI_API_KEY' } }, kv: {} })).plan(ctx)
    expect(signedOut).toEqual({ error: 'Codex is not signed in inside this vault. Add an OpenAI API key on the agent’s Security tab.' })
  })

  it('a launcher for one engine never starts an agent on another', async () => {
    const plan = await createVaultClaudeLauncher(depsFor('codex', { state: 'unlocked', runtimes: codexRuntimes, auth: {}, kv: {} })).plan(ctx)
    expect(plan).toEqual({ error: 'This agent runs on Codex, not Claude.' })
  })
})

describe('OpenCode in a vault', () => {
  const runtimes: Vault['runtimes'] = [{ engine: 'opencode', version: '2.2.5', kind: 'archive', sha256: '0c0d' }]

  it('selects the vault\'s agent entry and model on the session', async () => {
    const vault: Vault = {
      state: 'unlocked', runtimes,
      auth: { opencode: { loggedIn: true, method: 'api_key', keyName: 'ANTHROPIC_API_KEY' } },
      kv: { 'cinna.launch': { kind: 'kit', model: 'claude-haiku-4-5', approval: 'ask', provider: 'anthropic' } }
    }
    const plan = await createVaultOpencodeLauncher(depsFor('opencode', vault, { model: 'gpt-host-row' })).plan(ctx)
    if (!('spec' in plan)) throw new Error(JSON.stringify(plan))
    expect(plan.spec.vault).toMatchObject({ engine: 'opencode', vaultId: 'v1' })
    expect(plan.setup).toEqual({ configOptions: [{ configId: 'mode', value: 'cinna' }, { configId: 'model', value: 'anthropic/claude-haiku-4-5', optional: true }] })
  })

  it('refuses when the vault names no provider it can reach', async () => {
    const vault: Vault = { state: 'unlocked', runtimes, auth: { opencode: { loggedIn: false } }, kv: { 'cinna.launch': { kind: 'kit', model: 'gemini-3', approval: 'ask', provider: 'gemini' } } }
    expect(await createVaultOpencodeLauncher(depsFor('opencode', vault)).plan(ctx)).toEqual({ error: VAULT_OPENCODE_NO_PROVIDER })
    expect(await vaultReadiness(depsFor('opencode', vault), { vaultId: 'v1', engine: 'opencode', kind: 'kit', model: null, approval: 'ask' })).toEqual({ state: 'invalid', reason: VAULT_OPENCODE_NO_PROVIDER })
  })
})

describe('Antigravity in a vault', () => {
  it('signs in with the vault\'s Gemini key after initialize, on the mode, model and prompt the vault holds', async () => {
    const vault: Vault = {
      state: 'unlocked', runtimes: [{ engine: 'antigravity', version: '1.4.5', kind: 'archive', sha256: 'a9a9' }],
      auth: { antigravity: { loggedIn: true, method: 'api_key', keyName: 'GEMINI_API_KEY' } },
      kv: { 'cinna.launch': { kind: 'kit', model: 'gemini-3-flash', approval: 'auto' }, 'cinna.instructions': 'You are Payroll.' }
    }
    const plan = await createVaultAntigravityLauncher(depsFor('antigravity', vault, { approval: 'ask' })).plan(ctx)
    if (!('spec' in plan)) throw new Error(JSON.stringify(plan))
    expect(plan.spec.vault).toEqual({ agentId: 'folder:a', vaultId: 'v1', engine: 'antigravity', extraEnv: {}, authMethod: 'gemini-api-key' })
    expect(plan.setup).toEqual({ modeId: 'yolo', configOptions: [{ configId: 'model', value: 'gemini-3-flash', optional: true }] })
    expect(plan.firstPromptPreamble).toContain('You are Payroll.')
    expect(plan.session.meta).toEqual({ agy: { disabledTools: ['invoke_subagent', 'schedule', 'start_subagent'] } })
  })
})

describe('readiness of a vault agent, per engine', () => {
  const info = (engine: VaultEngine) => ({ vaultId: 'v1', engine, kind: 'kit' as const, model: null, approval: 'ask' as const })

  it('locked first, then the runtime, then the login', async () => {
    expect(await vaultReadiness(depsFor('codex', { state: 'locked', runtimes: [], auth: {}, kv: {} }), info('codex'))).toMatchObject({ state: 'vault_locked' })
    expect(await vaultReadiness(depsFor('codex', { state: 'unlocked', runtimes: [], auth: {}, kv: {} }), info('codex'))).toMatchObject({ state: 'not_installed', reason: expect.stringContaining('Codex is not installed') })
    expect(await vaultReadiness(depsFor('codex', { state: 'unlocked', runtimes: codexRuntimes, auth: { codex: { loggedIn: false, keyName: 'OPENAI_API_KEY' } }, kv: {} }), info('codex')))
      .toEqual({ state: 'not_logged_in', reason: 'Codex is not signed in inside this vault. Add an OpenAI API key on the agent’s Security tab.' })
    expect(await vaultReadiness(depsFor('codex', { state: 'unlocked', runtimes: codexRuntimes, auth: { codex: { loggedIn: true, method: 'api_key' } }, kv: {} }), info('codex'))).toEqual({ state: 'ok', reason: null })
  })

  it('a tampered vault is not locked: no Unlock, and the reason names the build that made it', async () => {
    const tampered: Vault = { state: 'tampered', runtimes: codexRuntimes, auth: {}, kv: {} }
    const otherBuild = vi.fn(async () => 'dev' as const)
    const deps = { ...depsFor('codex', tampered), otherBuild }
    expect(await vaultReadiness(deps, info('codex'), 'u')).toEqual({
      state: 'vault_tampered', reason: "This vault was made by a development build of Cinna. This version can't open it: each build keeps its own vault keys."
    })
    expect(otherBuild).toHaveBeenCalledWith('u', 'v1')
    expect(deps.calls).toEqual([])
    // Tampered for any other reason, or the origin unknown: the plain sentence.
    expect(await vaultReadiness({ ...depsFor('codex', tampered), otherBuild: async () => null }, info('codex'), 'u'))
      .toEqual({ state: 'vault_tampered', reason: "This vault failed its integrity check and can't be opened." })
    expect(await vaultReadiness({ ...depsFor('codex', tampered), otherBuild: async () => { throw new Error('boom') } }, info('codex'), 'u'))
      .toEqual({ state: 'vault_tampered', reason: "This vault failed its integrity check and can't be opened." })
    // A turn planned on it fails with the same sentence, not "locked".
    expect(await createVaultCodexLauncher(deps).plan(ctx)).toEqual({
      error: "This vault was made by a development build of Cinna. This version can't open it: each build keeps its own vault keys."
    })
  })

  it('refuses a runtime that is not the one this app pins: another version, other bytes, or not the one vaultd runs', async () => {
    const auth = { codex: { loggedIn: true, method: 'api_key' as const } }
    const notPinned = { state: 'not_installed', reason: 'The Codex in this vault isn’t the one this app pins. Use Update dependencies on the agent’s Security tab.' }
    const pins = codexRuntimes.map((r) => ({ ...r }))
    // Same version, other bytes (a tampered executable that reached the vault).
    const tampered = [{ ...codexRuntimes[0]!, sha256: 'bad0' }, codexRuntimes[1]!]
    expect(await vaultReadiness(depsFor('codex', { state: 'unlocked', runtimes: tampered, auth, kv: {}, pins }), info('codex'))).toEqual(notPinned)
    expect(await createVaultCodexLauncher(depsFor('codex', { state: 'unlocked', runtimes: tampered, auth, kv: {}, pins })).plan(ctx)).toEqual({ error: notPinned.reason })
    // An adapter of another version.
    const oldAdapter = [codexRuntimes[0]!, { ...codexRuntimes[1]!, version: '2.4.0-00000000' }]
    expect(await vaultReadiness(depsFor('codex', { state: 'unlocked', runtimes: oldAdapter, auth, kv: {}, pins }), info('codex'))).toEqual(notPinned)
    // The pinned row is there, but another was installed after it: vaultd runs the last one.
    const shadowed = [...codexRuntimes, { ...codexRuntimes[0]!, version: '0.166.0', sha256: 'old0' }]
    expect(await vaultReadiness(depsFor('codex', { state: 'unlocked', runtimes: shadowed, auth, kv: {}, pins }), info('codex'))).toEqual(notPinned)
    // Exactly the pins: ready.
    expect(await vaultReadiness(depsFor('codex', { state: 'unlocked', runtimes: codexRuntimes, auth, kv: {}, pins }), info('codex'))).toEqual({ state: 'ok', reason: null })
  })

  it('OpenCode needs no adapter; it asks for its provider\'s key', async () => {
    const vault: Vault = {
      state: 'unlocked', runtimes: [{ engine: 'opencode', version: '2.2.5', kind: 'archive', sha256: 'x' }],
      auth: { opencode: { loggedIn: false, keyName: 'ANTHROPIC_API_KEY' } },
      kv: { 'cinna.launch': { kind: 'kit', model: 'claude-haiku-4-5', approval: 'ask', provider: 'anthropic' } }
    }
    expect(await vaultReadiness(depsFor('opencode', vault), info('opencode')))
      .toEqual({ state: 'not_logged_in', reason: 'OpenCode is not signed in inside this vault. Add an Anthropic API key on the agent’s Security tab.' })
  })

  it('Antigravity without a Gemini key is signed out, and says why; with one it is ready', async () => {
    const vault: Vault = { state: 'unlocked', runtimes: [{ engine: 'antigravity', version: '1.4.5', kind: 'archive', sha256: 'x' }], auth: { antigravity: { loggedIn: false, keyName: 'GEMINI_API_KEY' } }, kv: {} }
    expect(VAULT_ANTIGRAVITY_SIGNED_OUT).toBe('Set a Gemini API key; Google sign-in isn’t supported inside a vault yet.')
    expect(await vaultReadiness(depsFor('antigravity', vault), info('antigravity'))).toEqual({ state: 'not_logged_in', reason: VAULT_ANTIGRAVITY_SIGNED_OUT })
    expect(await createVaultAntigravityLauncher(depsFor('antigravity', vault)).plan(ctx)).toEqual({ error: VAULT_ANTIGRAVITY_SIGNED_OUT })
    vault.auth.antigravity = { loggedIn: true, method: 'api_key', keyName: 'GEMINI_API_KEY' }
    expect(await vaultReadiness(depsFor('antigravity', vault), info('antigravity'))).toEqual({ state: 'ok', reason: null })
  })
})
