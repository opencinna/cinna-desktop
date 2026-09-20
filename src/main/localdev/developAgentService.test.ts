import { beforeEach, describe, expect, it, vi } from 'vitest'
const f = vi.hoisted(() => ({
  profile: 'p1',
  remote: { id: 'remote:a', name: 'Alpha', source: 'remote', remoteTargetType: 'agent', remoteTargetId: 'uuid-a', remoteMetadata: null as Record<string, unknown> | null },
  list: vi.fn(), cli: vi.fn(), test: vi.fn(), save: vi.fn(), context: vi.fn(), realpath: vi.fn()
}))
vi.mock('node:fs/promises', () => ({ realpath: f.realpath }))
vi.mock('../db/agents', () => ({ agentRepo: { getOwned: () => ({ ...f.remote }), list: f.list } }))
vi.mock('../auth/scope', () => ({ getProfileScopeUserId: () => f.profile, getSettingsScopeUserId: () => 'default' }))
vi.mock('./localDevService', () => ({ localDevService: { executionContext: f.context } }))
vi.mock('./cliRunner', () => ({ runCinnaCli: f.cli }))
vi.mock('../engine/binaryResolver', () => ({ configuredEnginePath: vi.fn(), realBinaryResolverDeps: vi.fn(), resolveEngineBinaryWith: async () => ({ path: '/tools/opencode' }) }))
vi.mock('../services/customAgentService', () => ({ customAgentService: { test: f.test, save: f.save } }))
const { developAgent } = await import('./developAgentService')
const status = (path?: string) => ({ exitCode: 0, result: { result: 'ok', agents: path ? [{ agent_id: 'uuid-a', path }] : [] } })

beforeEach(() => {
  vi.clearAllMocks()
  f.profile = 'p1'
  f.remote.remoteMetadata = null
  f.remote.remoteTargetId = 'uuid-a'
  f.list.mockReturnValue([])
  f.context.mockResolvedValue({ state: { workspacePath: '/account', cinnaBinPath: '/tools/cinna', protocol: 'json' }, env: { PATH: '/tools' } })
  f.realpath.mockImplementation(async (path: string) => path)
  f.test.mockResolvedValue({ token: 'receipt' })
  f.save.mockReturnValue({ id: 'dev-a' })
  f.cli.mockReset()
})

describe('Develop from an agent page', () => {
  it('syncs a missing workspace and creates a local coding connection in the returned directory', async () => {
    f.cli.mockResolvedValueOnce(status()).mockResolvedValueOnce({ exitCode: 0 }).mockResolvedValueOnce(status('/account/agents/alpha'))
    expect(await developAgent('remote:a')).toEqual({ agentId: 'dev-a' })
    expect(f.cli.mock.calls[1][0]).toMatchObject({ args: ['agent', 'sync', 'uuid-a'], cwd: '/account', env: { CINNA_NO_INPUT: '1' } })
    expect(f.save).toHaveBeenCalledWith(expect.objectContaining({ name: 'Develop Alpha', testToken: 'receipt', config: expect.objectContaining({ cwd: '/account/agents/alpha', command: ['/usr/bin/env', 'PATH=/tools', '/tools/opencode', 'acp'] }) }))
  })

  it('reuses a workspace and existing coding connection without syncing over local work', async () => {
    f.cli.mockResolvedValue(status('/account/agents/alpha'))
    f.list.mockReturnValue([{ id: 'existing-dev', name: 'Develop Alpha', driver: 'acp', driverConfig: { launcher: 'custom', cwd: '/account/agents/alpha' } }])
    expect(await developAgent('remote:a')).toEqual({ agentId: 'existing-dev' })
    expect(f.cli).toHaveBeenCalledOnce()
    expect(f.save).not.toHaveBeenCalled()
  })

  it('refuses consumer bundle installs before calling the CLI', async () => {
    f.remote.remoteMetadata = { bundle_uuid: 'bundle', is_publisher_install: false }
    await expect(developAgent('remote:a')).rejects.toThrow('not available')
    expect(f.cli).not.toHaveBeenCalled()
  })

  it('does not start a coding session when sync fails', async () => {
    f.cli.mockResolvedValueOnce(status()).mockResolvedValueOnce({ exitCode: 1 })
    await expect(developAgent('remote:a')).rejects.toThrow('Could not sync')
    expect(f.test).not.toHaveBeenCalled()
  })

  it('rejects a workspace outside this account', async () => {
    f.cli.mockResolvedValue(status('/other/private'))
    await expect(developAgent('remote:a')).rejects.toThrow('outside')
    expect(f.test).not.toHaveBeenCalled()
  })

  it('does not create a connection under a newly selected profile', async () => {
    f.cli.mockImplementation(async () => { f.profile = 'p2'; return status('/account/agents/alpha') })
    await expect(developAgent('remote:a')).rejects.toThrow('profile changed')
    expect(f.save).not.toHaveBeenCalled()
  })

  it('joins repeated Develop clicks for the same agent', async () => {
    f.cli.mockResolvedValue(status('/account/agents/alpha'))
    const first = developAgent('remote:a')
    expect(developAgent('remote:a')).toBe(first)
    await first
    expect(f.test).toHaveBeenCalledOnce()
  })

  it.each([
    { can_build: false },
    { is_foreign_install: true },
    { bundle_uuid: 'bundle', is_publisher_install: false }
  ])('refuses ineligible metadata before preparing a workspace (%j)', async (metadata) => {
    f.remote.remoteMetadata = metadata
    await expect(developAgent('remote:a')).rejects.toThrow('not available')
    expect(f.context).not.toHaveBeenCalled()
    expect(f.cli).not.toHaveBeenCalled()
  })

  /*
    Both shapes an owner can have. The second is the one that regressed: an
    agent created on the server and never published carries a `bundle_id` and
    no `bundle_uuid`, and counting the former as bundle membership hid Develop
    from the person who wrote the agent.
  */
  it.each([
    { bundle_id: 'bundle', bundle_uuid: 'bundle', is_publisher_install: true },
    { bundle_id: 'com.acme.research', bundle_uuid: null, is_publisher_install: false }
  ])('allows an agent of the caller’s own (%j) while keeping the same workspace checks', async (metadata) => {
    f.remote.remoteMetadata = metadata
    f.cli.mockResolvedValue(status('/account/agents/alpha'))
    expect(await developAgent('remote:a')).toEqual({ agentId: 'dev-a' })
    expect(f.save).toHaveBeenCalledOnce()
  })

  it.each(['/account', '/elsewhere/private'])('rejects a reported folder whose real path is %s', async (resolved) => {
    f.cli.mockResolvedValue(status('/account/agents/link'))
    f.realpath.mockImplementation(async (path: string) => path === '/account' ? path : resolved)
    await expect(developAgent('remote:a')).rejects.toThrow('outside')
    expect(f.test).not.toHaveBeenCalled()
    expect(f.save).not.toHaveBeenCalled()
  })

  it('rechecks development eligibility after the CLI returns', async () => {
    f.cli.mockImplementation(async () => {
      f.remote.remoteMetadata = { can_build: false }
      return status('/account/agents/alpha')
    })
    await expect(developAgent('remote:a')).rejects.toThrow('no longer available')
    expect(f.test).not.toHaveBeenCalled()
    expect(f.save).not.toHaveBeenCalled()
  })

  it('rejects a target identity replaced while account status was pending', async () => {
    f.cli.mockImplementation(async () => {
      f.remote.remoteTargetId = 'replacement-id'
      return status('/account/agents/alpha')
    })
    await expect(developAgent('remote:a')).rejects.toThrow('no longer available')
    expect(f.test).not.toHaveBeenCalled()
    expect(f.save).not.toHaveBeenCalled()
  })

  it('does not save a connection when the profile changes during its Test', async () => {
    f.cli.mockResolvedValue(status('/account/agents/alpha'))
    f.test.mockImplementation(async () => {
      f.profile = 'p2'
      return { token: 'receipt' }
    })
    await expect(developAgent('remote:a')).rejects.toThrow('profile changed')
    expect(f.save).not.toHaveBeenCalled()
  })

  it('releases a failed preparation so a repaired attempt can run', async () => {
    f.cli.mockResolvedValue(status('/account/agents/alpha'))
    f.test.mockRejectedValueOnce(new Error('Engine could not initialize'))
    await expect(developAgent('remote:a')).rejects.toThrow('Engine could not initialize')
    expect(f.save).not.toHaveBeenCalled()
    expect(await developAgent('remote:a')).toEqual({ agentId: 'dev-a' })
    expect(f.test).toHaveBeenCalledTimes(2)
    expect(f.save).toHaveBeenCalledOnce()
  })

  it('rejects a CLI without workspace reporting instead of guessing or syncing a path', async () => {
    f.cli.mockResolvedValue({ exitCode: 0, result: { result: 'ok' } })
    await expect(developAgent('remote:a')).rejects.toThrow('cannot report agent workspaces')
    expect(f.cli).toHaveBeenCalledOnce()
    expect(f.test).not.toHaveBeenCalled()
  })

})
