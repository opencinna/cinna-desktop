import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkillLinkIntent } from '../../../shared/skillLink'

/**
 * A `cinna://skill/…` deep link raises the offer on the composer on screen —
 * the open chat, the start screen, an agent page in chat mode — or, where
 * there is none, on a new chat after switching to it; then it is consumed by
 * its own `receivedAt`.
 */

const getPending = vi.fn<() => Promise<SkillLinkIntent | null>>()
const consume = vi.fn(async () => ({ success: true }))
let pushed: ((intent: SkillLinkIntent) => void) | null = null
const onIntent = vi.fn((handler: (intent: SkillLinkIntent) => void) => {
  pushed = handler
  return () => {
    pushed = null
  }
})
window.api = { skillLinks: { getPending, consume, onIntent } } as never

const { _resetSkillLinkIntents, raiseSkillLinkIntent, useSkillLinkIntents, watchSkillLinkScreen } = await import('./useSkillLinkIntents')
const { useUIStore } = await import('../stores/ui.store')
const { useChatStore } = await import('../stores/chat.store')
const { NEW_CHAT_KEY, useSkillLinkOfferStore } = await import('../stores/skillLinkOffer.store')

const LINK = { origin: 'https://cinna.test', packageId: 'test.erp', form: 'cinna' as const, serverGiven: true }
let at = 1000
const intent = (): SkillLinkIntent => ({ link: LINK, receivedAt: ++at })
const offer = () => useSkillLinkOfferStore.getState().offer

beforeEach(() => {
  _resetSkillLinkIntents()
  getPending.mockReset().mockResolvedValue(null)
  consume.mockClear()
  useSkillLinkOfferStore.setState({ offer: null })
  useChatStore.getState().setActiveChatId(null)
  useUIStore.setState({
    activeView: 'chat',
    agentPageMode: 'chat',
    sidebarTab: 'chats',
    activeLocalAgentId: null,
    activeExternalAgentId: null,
    dashboardPanelOpen: false,
    dashboardChatsStash: null,
    minimalView: false
  })
})

describe('raiseSkillLinkIntent', () => {
  it('raises on the open chat’s composer, and consumes that intent', () => {
    useChatStore.getState().setActiveChatId('chat-1')
    const arrived = intent()
    raiseSkillLinkIntent(arrived)
    expect(offer()).toMatchObject({ link: LINK, chatKey: 'chat-1' })
    expect(consume).toHaveBeenCalledWith(arrived.receivedAt)
    expect(useUIStore.getState().activeView).toBe('chat')
  })

  it('raises on the start screen’s composer', () => {
    raiseSkillLinkIntent(intent())
    expect(offer()?.chatKey).toBe(NEW_CHAT_KEY)
  })

  it('raises on an agent page’s new-chat composer in chat mode, without leaving it', () => {
    useUIStore.setState({ activeView: 'local-agent', agentPageMode: 'chat' })
    raiseSkillLinkIntent(intent())
    expect(offer()?.chatKey).toBe(NEW_CHAT_KEY)
    expect(useUIStore.getState().activeView).toBe('local-agent')
  })

  it.each([
    ['Settings', { activeView: 'settings' }],
    ['an agent page in settings mode', { activeView: 'local-agent', agentPageMode: 'settings' }],
    ['the Inbox', { activeView: 'inbox' }]
  ])('from %s, switches to a new chat and raises there', (_label, state) => {
    useChatStore.getState().setActiveChatId('chat-1')
    useUIStore.setState(state as never)
    raiseSkillLinkIntent(intent())
    expect(useUIStore.getState().activeView).toBe('chat')
    expect(useChatStore.getState().activeChatId).toBeNull()
    expect(offer()?.chatKey).toBe(NEW_CHAT_KEY)
  })
})

describe('a dashboard', () => {
  it('raises on the open chat panel’s composer: the panel’s chat is the selection while it shows it', () => {
    useChatStore.getState().setActiveChatId('panel-chat')
    useUIStore.setState({ activeView: 'dashboard', dashboardPanelOpen: true, dashboardChatsStash: { chatId: 'chats-chat' } })
    raiseSkillLinkIntent(intent())
    expect(offer()?.chatKey).toBe('panel-chat')
    expect(useUIStore.getState().activeView).toBe('dashboard')
  })

  it('with the panel closed, or not showing its chat yet, falls back to a new chat', () => {
    useChatStore.getState().setActiveChatId('chats-chat')
    useUIStore.setState({ activeView: 'dashboard', dashboardPanelOpen: true, dashboardChatsStash: null })
    raiseSkillLinkIntent(intent())
    expect(useUIStore.getState().activeView).toBe('chat')
    expect(offer()?.chatKey).toBe(NEW_CHAT_KEY)
  })
})

describe('watchSkillLinkScreen', () => {
  let stop: (() => void) | null = null
  const raise = (chatKey: string): void => useSkillLinkOfferStore.getState().raise(LINK, chatKey)
  const watch = (): void => {
    stop = watchSkillLinkScreen()
  }
  afterEach(() => {
    stop?.()
    stop = null
  })

  it('the start screen → a chat puts the start screen’s offer away', () => {
    watch()
    raise(NEW_CHAT_KEY)
    useChatStore.getState().setActiveChatId('chat-x')
    expect(offer()).toBeNull()
  })

  it('the first send on the start screen opening its chat counts as a switch', () => {
    watch()
    raise(NEW_CHAT_KEY)
    // The send creates the chat and selects it.
    useChatStore.getState().setActiveChatId('chat-new')
    expect(offer()).toBeNull()
  })

  it('chat X → New chat → X does not bring it back', () => {
    useChatStore.getState().setActiveChatId('chat-x')
    watch()
    raise('chat-x')
    useChatStore.getState().setActiveChatId(null)
    expect(offer()).toBeNull()
    useChatStore.getState().setActiveChatId('chat-x')
    expect(offer()).toBeNull()
  })

  it('agent A’s page → agent B’s page puts it away, though both key their composer “new”', () => {
    useUIStore.setState({ activeView: 'local-agent', agentPageMode: 'chat', activeLocalAgentId: 'folder:a' })
    watch()
    raise(NEW_CHAT_KEY)
    useUIStore.getState().setActiveLocalAgentId('folder:b')
    expect(offer()).toBeNull()
  })

  it('an agent page → the start screen is a switch too', () => {
    useUIStore.setState({ activeView: 'local-agent', agentPageMode: 'chat', activeLocalAgentId: 'folder:a' })
    watch()
    raise(NEW_CHAT_KEY)
    useUIStore.getState().setActiveView('chat')
    expect(offer()).toBeNull()
  })

  it('a change that keeps the composer on screen keeps the offer', () => {
    useChatStore.getState().setActiveChatId('chat-x')
    watch()
    raise('chat-x')
    useUIStore.setState({ sidebarTab: 'agents' })
    useChatStore.setState({ isStreaming: true })
    expect(offer()?.chatKey).toBe('chat-x')
  })

  it('an offer mid-move (Switch to profile) survives the screen change it causes', () => {
    useChatStore.getState().setActiveChatId('chat-x')
    watch()
    raise('chat-x')
    useSkillLinkOfferStore.getState().moveTo(NEW_CHAT_KEY, { from: 'chat-x' })
    useUIStore.getState().setActiveView('settings')
    expect(offer()).toMatchObject({ chatKey: NEW_CHAT_KEY, pendingFrom: 'chat-x' })
  })

  it('an offer raised on the composer on screen leaves minimal view; one elsewhere does not', () => {
    useChatStore.getState().setActiveChatId('chat-x')
    useUIStore.setState({ minimalView: true })
    watch()
    raise('chat-y')
    expect(useUIStore.getState().minimalView).toBe(true)
    raise('chat-x')
    expect(useUIStore.getState().minimalView).toBe(false)
  })

  it('a deep link in minimal view lands on the chat and leaves minimal view', () => {
    useChatStore.getState().setActiveChatId('chat-x')
    useUIStore.setState({ minimalView: true })
    watch()
    raiseSkillLinkIntent(intent())
    expect(offer()?.chatKey).toBe('chat-x')
    expect(useUIStore.getState().minimalView).toBe(false)
  })
})

describe('useSkillLinkIntents', () => {
  it('takes what main buffered on mount, and each push after', async () => {
    const buffered = intent()
    getPending.mockResolvedValue(buffered)
    const view = renderHook(() => useSkillLinkIntents())
    await waitFor(() => expect(consume).toHaveBeenCalledWith(buffered.receivedAt))
    expect(offer()?.link).toEqual(LINK)

    useSkillLinkOfferStore.setState({ offer: null })
    const later = intent()
    pushed?.(later)
    expect(offer()).not.toBeNull()
    expect(consume).toHaveBeenCalledWith(later.receivedAt)
    view.unmount()
    expect(pushed).toBeNull()
  })

  it('raises an intent once when the pull and a push both carry it', async () => {
    const both = intent()
    getPending.mockResolvedValue(both)
    renderHook(() => useSkillLinkIntents())
    pushed?.(both)
    await waitFor(() => expect(consume).toHaveBeenCalled())
    await Promise.resolve()
    expect(consume).toHaveBeenCalledTimes(1)
  })
})
