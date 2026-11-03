import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComposerPathRef, PathMentionTake } from '../../../shared/pathMentions'

/**
 * A mention lands on the new-chat screen — unless that would throw away work
 * in progress (an open dialog, a screen other than the chat view). Then the
 * chips and the agent go into the new-chat draft quietly and a toast says so.
 */

const take = vi.hoisted(() => vi.fn<() => Promise<PathMentionTake>>())
;(window as unknown as { api: unknown }).api = { pathMention: { take, onPending: () => () => {} } }

const { takePathMentions } = await import('./usePathMentions')
const { useAuthStore } = await import('../stores/auth.store')
const { useChatStore } = await import('../stores/chat.store')
const { useUIStore } = await import('../stores/ui.store')
const { useToastStore } = await import('../stores/toast.store')
const { composerDraftKey, useComposerDraftStore } = await import('../stores/composerDraft.store')

const DRAFT = composerDraftKey('alice', 'new-chat')
const report: ComposerPathRef = { path: '/Users/me/docs/report.md', displayPath: '~/docs/report.md', kind: 'file' }
const site: ComposerPathRef = { path: '/Users/me/website', displayPath: '~/website', kind: 'dir' }

beforeEach(() => {
  useAuthStore.setState({ currentUser: { id: 'alice' } as never })
  useComposerDraftStore.setState({ drafts: {} })
  useUIStore.setState({ activeView: 'chat', sidebarTab: 'agents' as never, pendingAgentId: null, activeJobId: null })
  useChatStore.setState({ activeChatId: 'chat-open' })
  useToastStore.setState({ toast: null })
})
afterEach(() => { document.body.innerHTML = '' })

describe('takePathMentions', () => {
  it('on the chat view with nothing open, lands on the new-chat screen with the agent', async () => {
    take.mockResolvedValue({ refs: [report], agentId: 'folder:docs', agentMatch: 'folder' })
    await takePathMentions()
    expect(useUIStore.getState().pendingAgentId).toBe('folder:docs')
    expect(useUIStore.getState().sidebarTab).toBe('chats')
    expect(useComposerDraftStore.getState().drafts[DRAFT].pathRefs).toEqual([report])
    expect(useToastStore.getState().toast).toBeNull()
  })

  it('from Settings, adds the chips and the agent to the new-chat draft, stays put and says so', async () => {
    useUIStore.setState({ activeView: 'settings' as never })
    take.mockResolvedValue({ refs: [report], agentId: 'folder:docs', agentMatch: 'folder' })
    await takePathMentions()
    expect(useUIStore.getState().activeView).toBe('settings')
    expect(useUIStore.getState().sidebarTab).toBe('agents')
    expect(useUIStore.getState().pendingAgentId).toBeNull()
    expect(useChatStore.getState().activeChatId).toBe('chat-open')
    const draft = useComposerDraftStore.getState().drafts[DRAFT]
    expect(draft.pathRefs).toEqual([report])
    expect(draft.pendingAgentIds).toEqual(['folder:docs'])
    expect(useToastStore.getState().toast).toMatchObject({ message: 'report.md added to a new chat', link: null })
  })

  it('under an open dialog on the chat view, stays put and counts the items', async () => {
    const dialog = document.createElement('div')
    dialog.setAttribute('aria-modal', 'true')
    document.body.appendChild(dialog)
    useComposerDraftStore.getState().update(DRAFT, () => ({ pendingAgentIds: ['folder:kept'] }))
    take.mockResolvedValue({ refs: [report, site], agentId: null, agentMatch: null })
    await takePathMentions()
    expect(useUIStore.getState().sidebarTab).toBe('agents')
    expect(useChatStore.getState().activeChatId).toBe('chat-open')
    const draft = useComposerDraftStore.getState().drafts[DRAFT]
    expect(draft.pathRefs).toEqual([report, site])
    expect(draft.pendingAgentIds).toEqual(['folder:kept'])
    expect(useToastStore.getState().toast?.message).toBe('2 items added to a new chat')
  })

  it('a folder match replaces the agents the new-chat draft already had, quietly too', async () => {
    useComposerDraftStore.getState().update(DRAFT, () => ({ pendingAgentIds: ['folder:picked'] }))
    useUIStore.setState({ activeView: 'settings' as never })
    take.mockResolvedValue({ refs: [report], agentId: 'folder:docs', agentMatch: 'folder' })
    await takePathMentions()
    expect(useComposerDraftStore.getState().drafts[DRAFT].pendingAgentIds).toEqual(['folder:docs'])
  })

  describe('the most-recently-used fallback', () => {
    const recentTake: PathMentionTake = { refs: [report], agentId: 'folder:recent', agentMatch: 'recent' }

    it('lands on the new-chat screen keeping the agents the user picked', async () => {
      useComposerDraftStore.getState().update(DRAFT, () => ({ pendingAgentIds: ['folder:picked'] }))
      take.mockResolvedValue(recentTake)
      await takePathMentions()
      expect(useUIStore.getState().pendingAgentId).toBeNull()
      expect(useChatStore.getState().activeChatId).toBeNull()
      expect(useUIStore.getState().activeView).toBe('chat')
      const draft = useComposerDraftStore.getState().drafts[DRAFT]
      expect(draft.pendingAgentIds).toEqual(['folder:picked'])
      expect(draft.pathRefs).toEqual([report])
    })

    it('quietly, keeps the agents the user picked', async () => {
      useComposerDraftStore.getState().update(DRAFT, () => ({ pendingAgentIds: ['folder:picked'] }))
      useUIStore.setState({ activeView: 'settings' as never })
      take.mockResolvedValue(recentTake)
      await takePathMentions()
      const draft = useComposerDraftStore.getState().drafts[DRAFT]
      expect(draft.pendingAgentIds).toEqual(['folder:picked'])
      expect(draft.pathRefs).toEqual([report])
    })

    it.each([
      ['no new-chat draft', undefined],
      ['an empty agent list', [] as string[]]
    ])('is applied over %s', async (_label, pendingAgentIds) => {
      if (pendingAgentIds) useComposerDraftStore.getState().update(DRAFT, () => ({ pendingAgentIds }))
      take.mockResolvedValue(recentTake)
      await takePathMentions()
      expect(useUIStore.getState().pendingAgentId).toBe('folder:recent')
    })

    it('quietly, is applied to a draft with no agents', async () => {
      useUIStore.setState({ activeView: 'settings' as never })
      take.mockResolvedValue(recentTake)
      await takePathMentions()
      expect(useComposerDraftStore.getState().drafts[DRAFT].pendingAgentIds).toEqual(['folder:recent'])
    })
  })

  it('does nothing for an empty take', async () => {
    useUIStore.setState({ activeView: 'settings' as never })
    take.mockResolvedValue({ refs: [], agentId: null, agentMatch: null })
    await takePathMentions()
    expect(useComposerDraftStore.getState().drafts[DRAFT]).toBeUndefined()
    expect(useToastStore.getState().toast).toBeNull()
  })
})
