import { describe, it, expect, beforeEach, vi } from 'vitest'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * `agentService` merges each agent's last known readiness into its DTO and asks
 * for the rest in the background — never waiting on a probe, each row checked
 * in the scope it was listed from — and drops an answer when the agent is
 * deleted or switched off.
 *
 * Everything the service imports is stubbed to let it load; the readiness
 * cache is a spy, because what is under test is the service's use of it.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')

vi.mock('electron', () => ({
  net: { fetch: vi.fn() },
  app: { isPackaged: false, getAppPath: () => repoRoot, getVersion: () => '0.0.0-test', on: () => undefined }
}))
vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../db/users', () => ({ userRepo: { get: vi.fn() } }))
vi.mock('../security/keystore', () => ({ encryptApiKey: vi.fn(), decryptApiKey: vi.fn() }))
vi.mock('../agents/a2a-client', () => ({
  fetchAgentCard: vi.fn(),
  resolveProtocol: vi.fn(),
  AgentCardFetchError: class AgentCardFetchError extends Error {},
  A2aHttpError: class A2aHttpError extends Error {}
}))
vi.mock('../auth/cinna-tokens', () => ({ getCinnaAccessToken: vi.fn() }))
vi.mock('../auth/cinna-oauth', () => ({ CinnaReauthRequired: class CinnaReauthRequired extends Error {} }))
vi.mock('./cinna-http', () => ({ cinnaFetch: vi.fn() }))
vi.mock('./localAgents/localAgentService', () => ({ localAgentService: {} }))

const db = vi.hoisted(() => ({
  rows: new Map<string, unknown[]>(),
  overrides: [] as Array<{ agentId: string; enabled: boolean }>,
  getOwned: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  overrideSet: vi.fn()
}))
vi.mock('../db/agents', () => ({
  agentRepo: {
    list: (userId: string) => db.rows.get(userId) ?? [],
    getOwned: db.getOwned,
    update: db.update,
    delete: db.delete
  },
  agentOverrideRepo: { listForUser: () => db.overrides, set: db.overrideSet }
}))

const readiness = vi.hoisted(() => ({
  peek: vi.fn(),
  kick: vi.fn(),
  forget: vi.fn()
}))
vi.mock('./agentReadinessService', () => ({ agentReadinessService: readiness }))

const { agentService } = await import('./agentService')

function row(id: string, source: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: id,
    description: null,
    protocol: source === 'folder' ? 'local-folder' : 'a2a',
    cardUrl: null,
    endpointUrl: null,
    protocolInterfaceUrl: null,
    protocolInterfaceVersion: null,
    accessTokenEncrypted: null,
    cardData: null,
    skills: null,
    enabled: true,
    source,
    driver: source === 'folder' ? 'acp' : 'a2a',
    remoteTargetType: null,
    remoteTargetId: null,
    remoteMetadata: null,
    localPath: null,
    localRootId: null,
    createdAt: new Date(0),
    ...over
  }
}

beforeEach(() => {
  db.rows.clear()
  db.overrides = []
  for (const fn of [db.getOwned, db.update, db.delete, db.overrideSet]) fn.mockReset()
  readiness.peek.mockReset()
  readiness.kick.mockReset()
  readiness.forget.mockReset()
})

describe('agentService readiness', () => {
  it('marks builders for development settings and keeps them in their owning profile', () => {
    db.rows.set('default', [row('builder', 'local', { driver: 'acp', driverConfig: { launcher: 'custom', developmentProfileId: 'alice', developmentEngine: 'claude' } })])
    expect(agentService.listMerged('default', 'alice')[0]).toMatchObject({ id: 'builder', development: true })
    expect(agentService.listMerged('default', 'bob')).toEqual([])
  })
  it('carries each agent’s last known readiness on its DTO, null when unknown', () => {
    db.rows.set('default', [row('local-1', 'local'), row('folder:a', 'folder')])
    const down = { state: 'unreachable', reason: 'Could not reach the agent.' }
    readiness.peek.mockImplementation((id: string) => (id === 'local-1' ? down : null))

    const dtos = agentService.listMerged('default', 'default')
    expect(dtos.find((d) => d.id === 'local-1')?.readiness).toEqual(down)
    expect(dtos.find((d) => d.id === 'folder:a')?.readiness).toBeNull()
  })

  it.each([null, '', 'future-driver'])('lists unsupported driver %s without substituting identity or stale readiness', (driver) => {
    db.rows.set('default', [row('local-future', 'local', { driver })])
    readiness.peek.mockReturnValue({ state: 'ok', reason: null })
    const [dto] = agentService.listMerged('default', 'default')
    expect(dto.id).toBe('local-future')
    expect(dto.driver).toBe(driver)
    expect(dto.readiness).toMatchObject({ state: 'invalid', reason: expect.stringContaining('supported') })
    expect(dto.capabilities).toMatchObject({ streaming: false, attachments: 'none', commands: 'none', cwd: false })
    expect(db.update).not.toHaveBeenCalled()
  })

  it('asks for readiness in the background, each row in the scope it was listed from', () => {
    db.rows.set('default', [row('local-1', 'local'), row('folder:a', 'folder')])
    db.rows.set('profile', [row('remote:agent:x', 'remote')])
    db.overrides = [{ agentId: 'remote:agent:x', enabled: false }]

    agentService.listMerged('default', 'profile')

    expect(readiness.kick).toHaveBeenCalledTimes(1)
    const asked = (readiness.kick.mock.calls[0][0] as Array<{ userId: string; row: { id: string; enabled: boolean } }>)
      .map(({ userId, row: r }) => [r.id, userId, r.enabled])
    expect(asked).toEqual([
      ['local-1', 'default', true],
      ['folder:a', 'default', true],
      // The profile's own toggle is what the cache sees, so a switched-off
      // synced agent is not probed.
      ['remote:agent:x', 'profile', false]
    ])
  })

  it('forgets an agent’s answer when it is deleted', () => {
    db.getOwned.mockReturnValue(row('local-1', 'local'))
    agentService.delete('default', 'local-1')
    expect(readiness.forget).toHaveBeenCalledWith('local-1')
  })

  it('forgets an agent’s answer when it is switched off, and not when it is switched on', () => {
    db.getOwned.mockReturnValue(row('local-1', 'local'))
    agentService.setEnabled('default', 'default', 'local-1', true)
    expect(readiness.forget).not.toHaveBeenCalled()
    agentService.setEnabled('default', 'default', 'local-1', false)
    expect(readiness.forget).toHaveBeenCalledWith('local-1')
  })

  it('forgets a synced agent’s answer when its profile switches it off', () => {
    db.getOwned.mockReturnValue(row('remote:agent:x', 'remote'))
    agentService.setEnabled('default', 'profile', 'remote:agent:x', false)
    expect(readiness.forget).toHaveBeenCalledWith('remote:agent:x')
  })
})
