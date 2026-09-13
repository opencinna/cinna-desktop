import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ profile: 'alice', user: { type: 'cinna_user', cinnaServerUrl: 'https://cinna.example' } as { type: string; cinnaServerUrl?: string }, installed: vi.fn(), discover: vi.fn(), clear: vi.fn(), updateCli: vi.fn(), refresh: vi.fn(), source: vi.fn() }))
vi.mock('../auth/scope', () => ({ getProfileScopeUserId: () => mocks.profile }))
vi.mock('../db/users', () => ({ userRepo: { get: () => mocks.user } }))
vi.mock('../auth/cinna-oauth', () => ({ clearEndpointCache: mocks.clear, discoverCinnaEndpoints: mocks.discover }))
vi.mock('./toolchain', () => ({ toolchain: { installedCli: mocks.installed }, localCliSource: mocks.source }))
vi.mock('./localDevService', () => ({ localDevService: { updateCli: mocks.updateCli } }))
vi.mock('../services/localAgents/toolDetectionService', () => ({ toolDetectionService: { refresh: mocks.refresh } }))

import { checkCinnaCliUpdate, updateCinnaCli } from './cliUpdateService'

beforeEach(() => {
  vi.resetAllMocks()
  mocks.profile = 'alice'
  mocks.user = { type: 'cinna_user', cinnaServerUrl: 'https://cinna.example' }
  mocks.installed.mockResolvedValue({ version: '0.3.0', path: '/managed/cinna' })
  mocks.discover.mockResolvedValue({ local_dev: { cinna_cli_version: '0.4.1' } })
  mocks.updateCli.mockResolvedValue(undefined)
  mocks.source.mockReturnValue(null)
})

describe('managed Cinna CLI updates', () => {
  it('checks the fresh server pin against the managed CLI', async () => {
    await expect(checkCinnaCliUpdate()).resolves.toEqual({ installedVersion: '0.3.0', targetVersion: '0.4.1', updateAvailable: true })
    expect(mocks.clear).toHaveBeenCalledOnce()
    expect(mocks.discover).toHaveBeenCalledWith('https://cinna.example')
  })
  it.each(['0.4.1', '0.5.0', 'unknown', null])('does not offer an update for installed %s', async (version) => {
    mocks.installed.mockResolvedValue({ version })
    expect((await checkCinnaCliUpdate()).updateAvailable).toBe(false)
    await expect(updateCinnaCli()).rejects.toThrow('No newer')
    expect(mocks.updateCli).not.toHaveBeenCalled()
  })
  it('does not replace an editable development checkout', async () => {
    mocks.source.mockReturnValue('/src/cinna-cli')
    expect((await checkCinnaCliUpdate()).updateAvailable).toBe(false)
  })
  it('has no update target without a connected Cinna server', async () => {
    mocks.user = { type: 'local' }
    expect((await checkCinnaCliUpdate()).updateAvailable).toBe(false)
    expect(mocks.discover).not.toHaveBeenCalled()
  })
  it('joins duplicate tool-only updates and refreshes detection', async () => {
    await Promise.all([updateCinnaCli(), updateCinnaCli()])
    expect(mocks.updateCli).toHaveBeenCalledExactlyOnceWith('alice', '0.4.1')
    expect(mocks.refresh).toHaveBeenCalledOnce()
  })
  it('surfaces an install failure and allows retry', async () => {
    mocks.updateCli.mockRejectedValueOnce(new Error('Installing cinna-cli 0.4.1 failed.'))
    await expect(updateCinnaCli()).rejects.toThrow('Installing cinna-cli 0.4.1 failed.')
    await expect(updateCinnaCli()).resolves.toBeUndefined()
  })
  it('rejects a profile switch during discovery before installing', async () => {
    mocks.discover.mockImplementation(async () => { mocks.profile = 'bob'; return { local_dev: { cinna_cli_version: '0.4.1' } } })
    await expect(updateCinnaCli()).rejects.toThrow('active profile changed')
    expect(mocks.updateCli).not.toHaveBeenCalled()
  })
  it('does not announce success after a profile switch during installation', async () => {
    mocks.updateCli.mockImplementation(async () => { mocks.profile = 'bob'; return { phase: 'ready', cliVersion: '0.4.1' } })
    await expect(updateCinnaCli()).rejects.toThrow('active profile changed')
  })
})
