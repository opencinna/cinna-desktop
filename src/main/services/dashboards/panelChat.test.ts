import { describe, expect, it, vi } from 'vitest'

vi.mock('../../logger/logger', () => ({ createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }) }))
vi.mock('../chatService', () => ({ chatService: {} }))
vi.mock('./dashboardService', () => ({ dashboardService: {} }))
vi.mock('../../db/dashboards', () => ({ dashboardRepo: {} }))
vi.mock('../../db/agents', () => ({ agentRepo: {}, agentSessionRepo: {} }))
vi.mock('./remote/coreDashboardsClient', () => ({ coreDashboardsClient: {} }))

const { createPanelChatService } = await import('./panelChat')
type PanelChatDeps = import('./panelChat').PanelChatDeps

function setup(overrides: Partial<PanelChatDeps> = {}) {
  let n = 0
  const created: Array<{ userId: string; dashboardId: string; agentId: string; title: string; coreSessionId?: string }> = []
  const deps: PanelChatDeps = {
    dashboard: (_userId, dashboardId) => (dashboardId === 'd1' ? { id: 'd1', name: 'Sales' } : null),
    isComponentAgent: (agentId) => agentId === 'folder:kit',
    isOtherLocalAgent: (agentId) => agentId === 'folder:bare',
    latest: () => null,
    agentName: (agentId) => (agentId === 'folder:kit' ? 'Sales Desk' : null),
    create: (userId, dashboardId, agentId, title) => {
      created.push({ userId, dashboardId, agentId, title })
      return { id: `new-${++n}` }
    },
    remoteAgent: (_userId, agentId) => (agentId === 'remote-row' ? { remoteTargetId: 'core-agent', name: 'Cloud Desk' } : null),
    coreDashboardId: (_userId, dashboardId) => (dashboardId === 'd1' ? 'core-d1' : null),
    openCoreChat: vi.fn(async (_userId: string, _core: string, _agent: string, fresh: boolean) => ({ ok: true as const, value: { session: { id: fresh ? 'S-new' : 'S1' } } })),
    seededSession: (chatId) => (chatId === 'old-cloud' ? 'S1' : chatId === 'stale-cloud' ? 'S0' : null),
    createRemote: (userId, dashboardId, agentId, title, coreSessionId) => {
      created.push({ userId, dashboardId, agentId, title, coreSessionId })
      return { id: `new-${++n}` }
    },
    ...overrides
  }
  return { service: createPanelChatService(deps), created, deps }
}

const setupWithDeps = setup

describe('dashboards:panel-chat', () => {
  it('resumes the latest chat of (dashboard, agent) for the profile', async () => {
    const latest = vi.fn(() => ({ id: 'old' }))
    const { service, created } = setup({ latest })
    expect(await service.open('p1', { dashboardId: 'd1', agentId: 'folder:kit' })).toEqual({ ok: true, chatId: 'old' })
    expect(latest).toHaveBeenCalledWith('p1', 'd1', 'folder:kit')
    expect(created).toEqual([])
  })

  it('creates one when there is none, and always when fresh', async () => {
    const { service, created } = setup({ latest: () => ({ id: 'old' }) })
    expect(await service.open('p1', { dashboardId: 'd1', agentId: 'folder:kit', fresh: true })).toEqual({ ok: true, chatId: 'new-1' })
    // Titled "<dashboard> · <agent>", so several panel chats tell apart in Chats.
    expect(created).toEqual([{ userId: 'p1', dashboardId: 'd1', agentId: 'folder:kit', title: 'Sales · Sales Desk' }])
    const none = setup()
    expect(await none.service.open('p1', { dashboardId: 'd1', agentId: 'folder:kit' })).toEqual({ ok: true, chatId: 'new-1' })
  })

  it('refuses, as data, an unknown dashboard, an unknown or non-kit agent and bad input', async () => {
    const { service, created } = setup()
    expect(await service.open('p1', { dashboardId: 'gone', agentId: 'folder:kit' })).toMatchObject({ ok: false, code: 'not_found' })
    expect(await service.open('p1', { dashboardId: 'd1', agentId: 'folder:nobody' })).toMatchObject({ ok: false, code: 'not_found' })
    expect(await service.open('p1', { dashboardId: 'd1', agentId: 'folder:bare' })).toMatchObject({ ok: false, code: 'not_kit_agent' })
    expect(await service.open('p1', { dashboardId: 'd1' })).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(await service.open('p1', { dashboardId: 'd1', agentId: 'folder:kit', fresh: 'yes' })).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(await service.open('p1', null)).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(created).toEqual([])
  })

  it('answers a failed creation as data', async () => {
    const { service } = setup({ create: () => { throw new Error('Chat not found') } })
    expect(await service.open('p1', { dashboardId: 'd1', agentId: 'folder:kit' })).toMatchObject({ ok: false, code: 'not_found' })
  })

  describe('a cloud agent (D6.6)', () => {
    it('resumes the latest chat while it continues the session core answered', async () => {
      const { service, created, deps } = setupWithDeps({ latest: () => ({ id: 'old-cloud' }) })
      expect(await service.open('p1', { dashboardId: 'd1', agentId: 'remote-row' })).toEqual({ ok: true, chatId: 'old-cloud' })
      expect(deps.openCoreChat).toHaveBeenCalledWith('p1', 'core-d1', 'core-agent', false)
      expect(created).toEqual([])
    })

    it('makes a chat seeded with core’s session when there is none, or the latest continues another one', async () => {
      const { service, created } = setup({ latest: () => ({ id: 'stale-cloud' }) })
      expect(await service.open('p1', { dashboardId: 'd1', agentId: 'remote-row' })).toEqual({ ok: true, chatId: 'new-1' })
      expect(created).toEqual([{ userId: 'p1', dashboardId: 'd1', agentId: 'remote-row', title: 'Sales · Cloud Desk', coreSessionId: 'S1' }])
    })

    it('asks core for a new session on New chat and makes a new chat', async () => {
      const { service, created, deps } = setupWithDeps({ latest: () => ({ id: 'old-cloud' }) })
      expect(await service.open('p1', { dashboardId: 'd1', agentId: 'remote-row', fresh: true })).toEqual({ ok: true, chatId: 'new-1' })
      expect(deps.openCoreChat).toHaveBeenCalledWith('p1', 'core-d1', 'core-agent', true)
      expect(created[0]).toMatchObject({ coreSessionId: 'S-new' })
    })

    it('refuses as data: no cloud tile yet, core unreachable, a sign-in, no session', async () => {
      const none = setup({ coreDashboardId: () => null })
      expect(await none.service.open('p1', { dashboardId: 'd1', agentId: 'remote-row' })).toMatchObject({ ok: false, code: 'not_found' })
      for (const code of ['unreachable', 'reauth_required', 'not_owner'] as const) {
        const { service, created } = setup({ openCoreChat: async () => ({ ok: false, code, message: 'no', status: null }) })
        expect(await service.open('p1', { dashboardId: 'd1', agentId: 'remote-row' })).toEqual({ ok: false, code, message: 'no' })
        expect(created).toEqual([])
      }
      const thrown = setup({ openCoreChat: async () => { throw new Error('boom') } })
      expect(await thrown.service.open('p1', { dashboardId: 'd1', agentId: 'remote-row' })).toMatchObject({ ok: false, code: 'unreachable' })
      const empty = setup({ openCoreChat: async () => ({ ok: true, value: { session: null } }) })
      expect(await empty.service.open('p1', { dashboardId: 'd1', agentId: 'remote-row' })).toMatchObject({ ok: false, code: 'not_found' })
    })
  })
})
