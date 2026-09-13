import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { claudeModelForComplexity } from '../../shared/engine'
import type { WorkComplexity } from '../../shared/modelFamilies'
import type { AgentRow } from '../db/agents'
const state = vi.hoisted(() => ({ profile: 'alice', workspace: '', phase: 'ready', reconcile: vi.fn(), warm: vi.fn(), openCodeModel: null as string | null, engine: 'claude', override: '', credential: '', complexity: 'complex', rows: [] as AgentRow[], execute: vi.fn(), reason: null as string | null }))
vi.mock('../db/agents', () => ({ agentRepo: {
  list: () => state.rows,
  getOwned: (_owner: string, id: string) => state.rows.find((row) => row.id === id),
  createRuntime: (_owner: string, input: { name: string; driver: string; config: Record<string, unknown> }) => {
    const row = { id: `builder-${state.rows.length}`, name: input.name, source: 'local', driver: input.driver, driverConfig: input.config, enabled: true } as AgentRow
    state.rows.push(row)
    return row
  }
} }))
vi.mock('../engine/engineConfigSource', () => ({ getCachedEngineModels: () => [], collectEngineConfigInput: state.warm }))
vi.mock('../db/users', () => ({ userRepo: { get: () => ({ cinnaServerUrl: `https://${state.profile}.example`, displayName: state.profile, username: state.profile }) } }))
vi.mock('../auth/scope', () => ({ getProfileScopeUserId: () => state.profile, getSettingsScopeUserId: () => 'default' }))
vi.mock('./localDevService', () => ({ localDevService: { getState: () => ({ phase: state.phase, detail: 'Account token could not be restored.', workspacePath: state.workspace, protocol: 'json', cliVersion: '1.0' }), executionContext: state.execute, reconcile: state.reconcile } }))
vi.mock('../services/appSettingsService', () => ({ appSettingsService: { getAll: () => ({ localDevelopmentEngine: state.override, localDevelopmentCredentialId: state.credential, localDevelopmentComplexity: state.complexity }) } }))
vi.mock('../services/localAgents/runtimeService', () => ({ runtimeService: { resolve: (input: { engine: string; credential?: string; complexity: WorkComplexity }) => ({ launcher: input.engine, credentialId: input.credential === 'missing' ? null : input.credential ?? null, modelId: input.engine === 'claude' ? claudeModelForComplexity(input.complexity) : state.openCodeModel, reason: state.reason }) } }))
vi.mock('../services/localAgents/defaultEngineService', () => ({ defaultEngineService: { current: () => state.engine } }))
const { developmentContext, readDevelopmentDocuments, prepareDevelopmentSession, contextForDevelopmentAgent, restoreDevelopmentContext, getDevelopmentSessionContext } = await import('./developmentSessionService')
let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cinna-build-test-'))
  state.workspace = join(root, 'account')
  mkdirSync(join(state.workspace, 'context'), { recursive: true })
  writeFileSync(join(state.workspace, 'CLAUDE.md'), 'Build with the account CLI.')
  writeFileSync(join(state.workspace, 'context/README.md'), 'Platform guide index')
  state.profile = 'alice'; state.engine = 'claude'; state.override = ''; state.credential = ''; state.complexity = 'complex'; state.rows = []; state.reason = null
  state.execute.mockReset().mockResolvedValue({})
  state.phase = 'ready'; state.reconcile.mockReset(); state.openCodeModel = null; state.warm.mockReset().mockResolvedValue({ providers: [], agents: [] })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('development sessions', () => {
  it('warms the OpenCode model catalogue when resuming a saved build after restart', async () => {
    state.engine = 'opencode'
    await prepareDevelopmentSession(developmentContext())
    state.reason = 'No model available in the cached catalogue.'
    state.warm.mockImplementation(async () => { state.openCodeModel = 'provider/complex-model'; state.reason = null })
    await expect(restoreDevelopmentContext(state.rows[0])).resolves.toMatchObject({ runtime: { modelId: 'provider/complex-model' }, blocker: null })
    expect(state.warm).toHaveBeenCalledTimes(1)
  })
  it('rejects runtime changes while warming a restored OpenCode catalogue', async () => {
    state.engine = 'opencode'
    await prepareDevelopmentSession(developmentContext())
    state.warm.mockImplementation(async () => { state.engine = 'claude' })
    await expect(restoreDevelopmentContext(state.rows[0])).rejects.toThrow('account or runtime changed')
  })
  it('owns the runtime prerequisite check and rejects a stale result', async () => {
    const probe = vi.fn().mockResolvedValue({ blocker: 'Install Claude Code.', installTool: 'claude' })
    await expect(getDevelopmentSessionContext(probe)).resolves.toMatchObject({ blocker: 'Install Claude Code.', installTool: 'claude' })
    probe.mockImplementation(async () => { state.complexity = 'simple'; return { blocker: null } })
    await expect(getDevelopmentSessionContext(probe)).rejects.toThrow('profile or runtime changed')
  })
  it.each(['idle', 'installing'])('waits for %s startup restoration before checking an existing builder', async (phase) => {
    await prepareDevelopmentSession(developmentContext())
    state.phase = phase
    let finish!: () => void
    state.reconcile.mockImplementation(() => new Promise<void>((resolve) => { finish = () => { state.phase = 'ready'; resolve() } }))
    let settled = false
    const restoring = restoreDevelopmentContext(state.rows[0]).then((value) => { settled = true; return value })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(state.reconcile).toHaveBeenCalledWith('alice')
    finish()
    await expect(restoring).resolves.toMatchObject({ profileId: 'alice', blocker: null })
  })
  it('keeps a real restoration failure actionable without retrying it on every probe', async () => {
    await prepareDevelopmentSession(developmentContext())
    state.phase = 'attention'
    await expect(restoreDevelopmentContext(state.rows[0])).rejects.toThrow('Account token could not be restored.')
    expect(state.reconcile).not.toHaveBeenCalled()
  })
  it('rejects an account switch during restoration', async () => {
    await prepareDevelopmentSession(developmentContext())
    state.phase = 'idle'
    state.reconcile.mockImplementation(async () => { state.profile = 'bob'; state.phase = 'ready' })
    await expect(restoreDevelopmentContext(state.rows[0])).rejects.toThrow('Cinna account, workspace, or build runtime changed')
  })
  it('defaults building to Opus and resolves a lower chosen complexity', () => {
    expect(developmentContext()).toMatchObject({ complexity: 'complex', runtime: { launcher: 'claude', modelId: 'opus' } })
    state.complexity = 'simple'
    expect(developmentContext()).toMatchObject({ complexity: 'simple', runtime: { modelId: 'haiku' } })
  })
  it('rejects changed Codex effort even though its model stays the CLI default', async () => {
    state.override = 'codex'
    const context = developmentContext()
    state.complexity = 'medium'
    await expect(prepareDevelopmentSession(context)).rejects.toThrow('build runtime changed')
    state.complexity = 'complex'
    state.execute.mockImplementation(async () => { state.complexity = 'simple' })
    await expect(prepareDevelopmentSession(context)).rejects.toThrow('changed while preparing')
    expect(state.rows).toHaveLength(0)
  })
  it('inherits the local-agent default unless building has its own runtime', async () => {
    expect(developmentContext().runtime.launcher).toBe('claude')
    state.override = 'codex'
    const context = developmentContext()
    expect(context.runtime.launcher).toBe('codex')
    const { agentId } = await prepareDevelopmentSession(context)
    expect(state.rows.find((row) => row.id === agentId)?.driverConfig?.developmentEngine).toBe('codex')
    state.engine = 'opencode'
    expect(contextForDevelopmentAgent(state.rows[0]).runtime.launcher).toBe('codex')
    state.override = ''
    expect(developmentContext().runtime.launcher).toBe('opencode')
  })
  it('uses the custom building credential only for an explicit OpenCode override', () => {
    state.override = 'opencode'; state.credential = 'build-key'
    expect(developmentContext().runtime.credentialId).toBe('build-key')
    state.override = ''
    expect(developmentContext().runtime.credentialId).toBeNull()
    state.override = 'opencode'; state.credential = 'missing'
    expect(developmentContext().blocker).toContain('credential is unavailable')
  })
  it('rejects a stale send when the building override changes during preparation', async () => {
    const context = developmentContext()
    state.execute.mockImplementation(async () => { state.override = 'codex' })
    await expect(prepareDevelopmentSession(context)).rejects.toThrow('changed while preparing')
    expect(state.rows).toHaveLength(0)
  })
  it('supplies actual CLI guides in the same prompt the user can inspect', () => {
    const context = developmentContext()
    expect(context.serverUrl).toBe('https://alice.example')
    expect(context.runtime.launcher).toBe('claude')
    for (const doc of context.documents) expect(context.instructions).toContain(doc.content)
    expect(context.documents.map((doc) => doc.path)).toEqual(['CLAUDE.md', 'context/README.md'])
  })
  it('does not follow guide symlinks outside the workspace or read credentials', () => {
    writeFileSync(join(root, 'private'), 'SECRET')
    rmSync(join(state.workspace, 'CLAUDE.md'))
    symlinkSync(join(root, 'private'), join(state.workspace, 'CLAUDE.md'))
    mkdirSync(join(state.workspace, '.cinna'))
    writeFileSync(join(state.workspace, '.cinna/account.json'), 'SECRET')
    expect(JSON.stringify(readDevelopmentDocuments(state.workspace))).not.toContain('SECRET')
    rmSync(join(state.workspace, 'CLAUDE.md'))
    symlinkSync(join(state.workspace, '.cinna/account.json'), join(state.workspace, 'CLAUDE.md'))
    expect(JSON.stringify(readDevelopmentDocuments(state.workspace))).not.toContain('SECRET')
  })
  it('reuses a builder for the account/runtime without creating a cloud agent or editing the workspace', async () => {
    const context = developmentContext()
    const first = await prepareDevelopmentSession(context)
    expect(await prepareDevelopmentSession(context)).toEqual(first)
    expect(state.rows).toHaveLength(1)
    expect(state.rows[0].driverConfig).toMatchObject({ developmentProfileId: 'alice', developmentEngine: 'claude', cwd: state.workspace })
    expect(readDevelopmentDocuments(state.workspace)).toEqual(context.documents)
  })
  it('rejects a send for the previously displayed Cinna account', async () => {
    const context = developmentContext()
    state.profile = 'bob'
    await expect(prepareDevelopmentSession(context)).rejects.toThrow('active Cinna instance changed')
    expect(state.execute).not.toHaveBeenCalled()
    expect(state.rows).toHaveLength(0)
  })
  it('does not save a builder if the account switches during preparation', async () => {
    const context = developmentContext()
    state.execute.mockImplementation(async () => { state.profile = 'bob' })
    await expect(prepareDevelopmentSession(context)).rejects.toThrow('changed while preparing')
    expect(state.rows).toHaveLength(0)
  })
  it('requires the runtime that was displayed when the message was composed', async () => {
    const context = developmentContext()
    state.engine = 'codex'
    await expect(prepareDevelopmentSession(context)).rejects.toThrow('build runtime changed')
    expect(state.execute).not.toHaveBeenCalled()
    expect(state.rows).toHaveLength(0)
  })
  it('refuses a saved session after its account or runtime changes', async () => {
    await prepareDevelopmentSession(developmentContext())
    const row = state.rows[0]
    state.engine = 'codex'
    expect(() => contextForDevelopmentAgent(row)).toThrow('build runtime changed')
    state.engine = 'claude'; state.profile = 'bob'
    expect(() => contextForDevelopmentAgent(row)).toThrow('Cinna account')
  })
  it('explains missing default credentials before preparing a session', async () => {
    state.engine = 'opencode'; state.reason = 'Choose an AI credential in Runtime settings.'
    const context = developmentContext()
    expect(context.blocker).toBe(state.reason)
    await expect(prepareDevelopmentSession(context)).rejects.toThrow(state.reason)
    expect(state.rows).toHaveLength(0)
  })
})
