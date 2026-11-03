import { describe, expect, it, vi } from 'vitest'

vi.mock('../../logger/logger', () => ({ createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }) }))
vi.mock('../chatService', () => ({ chatService: {} }))
vi.mock('./dashboardService', () => ({ dashboardService: {} }))
vi.mock('../../db/dashboards', () => ({ dashboardRepo: {} }))

const { createPanelChatService } = await import('./panelChat')
type PanelChatDeps = import('./panelChat').PanelChatDeps

function setup(overrides: Partial<PanelChatDeps> = {}) {
  let n = 0
  const created: Array<{ userId: string; dashboardId: string; agentId: string; title: string }> = []
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
    ...overrides
  }
  return { service: createPanelChatService(deps), created }
}

describe('dashboards:panel-chat', () => {
  it('resumes the latest chat of (dashboard, agent) for the profile', () => {
    const latest = vi.fn(() => ({ id: 'old' }))
    const { service, created } = setup({ latest })
    expect(service.open('p1', { dashboardId: 'd1', agentId: 'folder:kit' })).toEqual({ ok: true, chatId: 'old' })
    expect(latest).toHaveBeenCalledWith('p1', 'd1', 'folder:kit')
    expect(created).toEqual([])
  })

  it('creates one when there is none, and always when fresh', () => {
    const { service, created } = setup({ latest: () => ({ id: 'old' }) })
    expect(service.open('p1', { dashboardId: 'd1', agentId: 'folder:kit', fresh: true })).toEqual({ ok: true, chatId: 'new-1' })
    // Titled "<dashboard> · <agent>", so several panel chats tell apart in Chats.
    expect(created).toEqual([{ userId: 'p1', dashboardId: 'd1', agentId: 'folder:kit', title: 'Sales · Sales Desk' }])
    const none = setup()
    expect(none.service.open('p1', { dashboardId: 'd1', agentId: 'folder:kit' })).toEqual({ ok: true, chatId: 'new-1' })
  })

  it('refuses, as data, an unknown dashboard, an unknown or non-kit agent and bad input', () => {
    const { service, created } = setup()
    expect(service.open('p1', { dashboardId: 'gone', agentId: 'folder:kit' })).toMatchObject({ ok: false, code: 'not_found' })
    expect(service.open('p1', { dashboardId: 'd1', agentId: 'folder:nobody' })).toMatchObject({ ok: false, code: 'not_found' })
    expect(service.open('p1', { dashboardId: 'd1', agentId: 'folder:bare' })).toMatchObject({ ok: false, code: 'not_kit_agent' })
    expect(service.open('p1', { dashboardId: 'd1' })).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(service.open('p1', { dashboardId: 'd1', agentId: 'folder:kit', fresh: 'yes' })).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(service.open('p1', null)).toMatchObject({ ok: false, code: 'invalid_input' })
    expect(created).toEqual([])
  })

  it('answers a failed creation as data', () => {
    const { service } = setup({ create: () => { throw new Error('Chat not found') } })
    expect(service.open('p1', { dashboardId: 'd1', agentId: 'folder:kit' })).toMatchObject({ ok: false, code: 'not_found' })
  })
})
