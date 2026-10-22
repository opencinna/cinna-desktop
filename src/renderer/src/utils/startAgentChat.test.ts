import { beforeEach, describe, expect, it } from 'vitest'
import { addToNewChat, startAgentChat } from './startAgentChat'
import { useAuthStore } from '../stores/auth.store'
import { useChatStore } from '../stores/chat.store'
import { useUIStore } from '../stores/ui.store'
import { composerDraftKey, useComposerDraftStore } from '../stores/composerDraft.store'
import type { ComposerPathRef } from '../../../shared/pathMentions'

const DRAFT = composerDraftKey('alice', 'dashboard')
const a: ComposerPathRef = { path: '/w/a', displayPath: '~/a', kind: 'dir' }
const b: ComposerPathRef = { path: '/w/b.md', displayPath: '~/b.md', kind: 'file' }

beforeEach(() => {
  useAuthStore.setState({ currentUser: { id: 'alice' } as never })
  useComposerDraftStore.setState({ drafts: {} })
  useUIStore.setState({ activeView: 'settings' as never, sidebarTab: 'agents' as never, pendingAgentId: null, activeJobId: null })
  useChatStore.setState({ activeChatId: 'chat-open' })
})

describe('startAgentChat with reference chips', () => {
  it('appends to the new-chat draft, skipping a path already there, and touches no text', () => {
    useComposerDraftStore.getState().update(DRAFT, () => ({ text: 'Typed already', pathRefs: [a] }))
    startAgentChat('folder:x', { pathRefs: [b, { ...a, displayPath: 'a' }] })
    const draft = useComposerDraftStore.getState().drafts[DRAFT]
    expect(draft.pathRefs).toEqual([a, b])
    expect(draft.text).toBe('Typed already')
    expect(useUIStore.getState().pendingAgentId).toBe('folder:x')
    expect(useUIStore.getState().activeView).toBe('chat')
    expect(useUIStore.getState().sidebarTab).toBe('chats')
  })

  it('with no agent, lands on the new-chat screen and leaves the agent selection alone', () => {
    useComposerDraftStore.getState().update(DRAFT, () => ({ pendingAgentIds: ['folder:kept'] }))
    startAgentChat(null, { pathRefs: [a] })
    expect(useUIStore.getState().pendingAgentId).toBeNull()
    expect(useChatStore.getState().activeChatId).toBeNull()
    expect(useUIStore.getState().activeView).toBe('chat')
    const draft = useComposerDraftStore.getState().drafts[DRAFT]
    expect(draft.pathRefs).toEqual([a])
    expect(draft.pendingAgentIds).toEqual(['folder:kept'])
  })

  it('still types a text draft on a line of its own', () => {
    useComposerDraftStore.getState().update(DRAFT, () => ({ text: 'First\n' }))
    startAgentChat('folder:x', { draft: 'Second' })
    expect(useComposerDraftStore.getState().drafts[DRAFT].text).toBe('First\nSecond')
    expect(useComposerDraftStore.getState().drafts[DRAFT].pathRefs).toEqual([])
  })
})

describe('a recent-fallback agent', () => {
  it('does not replace the agents already picked in the new-chat draft', () => {
    useComposerDraftStore.getState().update(DRAFT, () => ({ pendingAgentIds: ['folder:picked'] }))
    startAgentChat('folder:recent', { pathRefs: [a], agentMatch: 'recent' })
    expect(useUIStore.getState().pendingAgentId).toBeNull()
    expect(useChatStore.getState().activeChatId).toBeNull()
    addToNewChat('folder:recent', [b], 'recent')
    const draft = useComposerDraftStore.getState().drafts[DRAFT]
    expect(draft.pendingAgentIds).toEqual(['folder:picked'])
    expect(draft.pathRefs).toEqual([a, b])
  })

  it('is applied when the draft has no agents, and a folder match or an explicit pick always is', () => {
    startAgentChat('folder:recent', { agentMatch: 'recent' })
    expect(useUIStore.getState().pendingAgentId).toBe('folder:recent')
    addToNewChat('folder:recent', [a], 'recent')
    expect(useComposerDraftStore.getState().drafts[DRAFT].pendingAgentIds).toEqual(['folder:recent'])
    addToNewChat('folder:match', [a], 'folder')
    expect(useComposerDraftStore.getState().drafts[DRAFT].pendingAgentIds).toEqual(['folder:match'])
    startAgentChat('folder:shortcut')
    expect(useUIStore.getState().pendingAgentId).toBe('folder:shortcut')
  })
})
