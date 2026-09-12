import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ getOwned: vi.fn(), remove: vi.fn(), forget: vi.fn(), fetch: vi.fn() }))
vi.mock('../db/agents', () => ({ agentRepo: { getOwned: mocks.getOwned, delete: mocks.remove } }))
vi.mock('./agentReadinessService', () => ({ agentReadinessService: { forget: mocks.forget } }))
vi.mock('./cinna-http', () => ({ cinnaFetch: mocks.fetch }))
import { deleteRemoteAgent } from './remoteAgentActions'

const agent = { source: 'remote', remoteTargetType: 'agent', remoteTargetId: 'server-id', remoteMetadata: null }
beforeEach(() => { vi.resetAllMocks(); mocks.getOwned.mockReturnValue(agent); mocks.fetch.mockResolvedValue({}) })

describe('remote agent removal', () => {
  it('deletes on the selected profile’s server before pruning its cached agent', async () => {
    mocks.fetch.mockImplementation(async () => { expect(mocks.remove).not.toHaveBeenCalled() })
    await deleteRemoteAgent('profile', 'remote:agent')
    expect(mocks.getOwned).toHaveBeenCalledWith('profile', 'remote:agent')
    expect(mocks.fetch).toHaveBeenCalledWith('profile', '/api/v1/agents/server-id', { method: 'DELETE' })
    expect(mocks.remove).toHaveBeenCalledWith('profile', 'remote:agent')
    expect(mocks.forget).toHaveBeenCalledWith('remote:agent')
  })
  it('keeps the cached agent when the server refuses deletion', async () => {
    mocks.fetch.mockRejectedValue(new Error('Not enough permissions'))
    await expect(deleteRemoteAgent('profile', 'remote:agent')).rejects.toThrow('Not enough permissions')
    expect(mocks.remove).not.toHaveBeenCalled()
    expect(mocks.forget).not.toHaveBeenCalled()
  })
  it.each([null, { ...agent, source: 'local' }, { ...agent, remoteTargetType: 'route' }])('rejects agents outside the deletable profile targets (%j)', async (row) => {
    mocks.getOwned.mockReturnValue(row)
    await expect(deleteRemoteAgent('profile', 'id')).rejects.toThrow('cannot be deleted')
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
  it('requires uninstall for a consumer bundle, but permits deletion of its publisher working copy', async () => {
    mocks.getOwned.mockReturnValue({ ...agent, remoteMetadata: { bundle_uuid: 'bundle', is_publisher_install: false } })
    await expect(deleteRemoteAgent('profile', 'id')).rejects.toThrow('Uninstall')
    expect(mocks.fetch).not.toHaveBeenCalled()
    mocks.getOwned.mockReturnValue({ ...agent, remoteMetadata: { bundle_uuid: 'bundle', is_publisher_install: true } })
    await deleteRemoteAgent('profile', 'id')
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
  })
  it('rejects a cached target without a server identity', async () => {
    mocks.getOwned.mockReturnValue({ ...agent, remoteTargetId: null })
    await expect(deleteRemoteAgent('profile', 'id')).rejects.toThrow('cannot be deleted')
    expect(mocks.fetch).not.toHaveBeenCalled()
    expect(mocks.remove).not.toHaveBeenCalled()
    expect(mocks.forget).not.toHaveBeenCalled()
  })
  it('requires uninstall for the legacy bundle_id marker too', async () => {
    mocks.getOwned.mockReturnValue({ ...agent, remoteMetadata: { bundle_id: 'legacy-bundle' } })
    await expect(deleteRemoteAgent('profile', 'id')).rejects.toThrow('Uninstall')
    expect(mocks.fetch).not.toHaveBeenCalled()
    expect(mocks.remove).not.toHaveBeenCalled()
  })

})
