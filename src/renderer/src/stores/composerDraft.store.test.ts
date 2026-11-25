import { beforeEach, describe, expect, it } from 'vitest'
import { carryComposerDraft, composerDraftKey, NEW_CHAT_DRAFT_SURFACE, useComposerDraftStore } from './composerDraft.store'

/**
 * A Switch to <name> from the composer carries the message typed there to the profile switched to:
 * drafts are per profile and per surface, so without it the half-typed message stays behind.
 */

const draft = (key: string) => useComposerDraftStore.getState().drafts[key]
const type = (key: string, text: string, extra: Record<string, unknown> = {}) =>
  useComposerDraftStore.getState().update(key, () => ({ text, ...extra }))

beforeEach(() => useComposerDraftStore.setState({ drafts: {} }))

describe('carrying a draft to another profile', () => {
  it('moves the message to the same surface of the profile switched to', () => {
    const from = composerDraftKey('alice', 'agent:folder:kit')
    type(from, 'Summarise the week', { pathRefs: [{ path: '/a', displayPath: '~/a', kind: 'file' }], pastes: [{ id: 'p1', text: 'log' }] })
    carryComposerDraft(from, 'bob')
    const to = draft(composerDraftKey('bob', 'agent:folder:kit'))
    expect(to).toMatchObject({ text: 'Summarise the week', pastes: [{ id: 'p1', text: 'log' }], pathRefs: [{ path: '/a' }] })
    // Taken out of the old profile's draft, so it is not sent twice.
    expect(draft(from)).toMatchObject({ text: '', pastes: [], pathRefs: [] })
  })

  it('lands a chat’s message on the new-chat screen, where the switch goes', () => {
    const from = composerDraftKey('alice', 'chat:c1')
    type(from, 'hello')
    carryComposerDraft(from, 'bob')
    expect(draft(composerDraftKey('bob', NEW_CHAT_DRAFT_SURFACE))?.text).toBe('hello')
    expect(draft(composerDraftKey('bob', 'chat:c1'))).toBeUndefined()
  })

  it('lands a chat’s message addressed to its agent, so Send on the new-chat screen reaches that agent', () => {
    const from = composerDraftKey('alice', 'chat:c1')
    type(from, 'hello', { modeSelection: { id: 'mode-1' }, pendingMcpIds: ['mcp-1'] })
    type(composerDraftKey('bob', NEW_CHAT_DRAFT_SURFACE), '', { pendingAgentIds: ['other'], modeSelection: 'none', pendingMcpIds: ['mcp-2'] })
    carryComposerDraft(from, 'bob', { agentIds: ['folder:kit'] })
    // The agent replaces the pick there; mode and MCP picks are left as they were.
    expect(draft(composerDraftKey('bob', NEW_CHAT_DRAFT_SURFACE))).toMatchObject({
      text: 'hello', pendingAgentIds: ['folder:kit'], modeSelection: 'none', pendingMcpIds: ['mcp-2']
    })
  })

  it('carries the new-chat screen’s own agent pick, even with nothing typed', () => {
    const from = composerDraftKey('alice', NEW_CHAT_DRAFT_SURFACE)
    type(from, '', { pendingAgentIds: ['folder:kit'] })
    carryComposerDraft(from, 'bob', { agentIds: ['ignored'] })
    expect(draft(composerDraftKey('bob', NEW_CHAT_DRAFT_SURFACE))?.pendingAgentIds).toEqual(['folder:kit'])
    // An agent page is its own target: nothing is picked there.
    carryComposerDraft(composerDraftKey('alice', 'agent:folder:kit'), 'bob', { agentIds: ['folder:kit'] })
    expect(draft(composerDraftKey('bob', 'agent:folder:kit'))).toBeUndefined()
  })

  it('joins it after what the profile switched to already holds there', () => {
    const from = composerDraftKey('alice', NEW_CHAT_DRAFT_SURFACE)
    type(from, 'second')
    type(composerDraftKey('bob', NEW_CHAT_DRAFT_SURFACE), 'first\n')
    carryComposerDraft(from, 'bob')
    expect(draft(composerDraftKey('bob', NEW_CHAT_DRAFT_SURFACE))?.text).toBe('first\n\nsecond')
  })

  it('moves nothing while the old draft is sending, or when there is nothing typed', () => {
    const from = composerDraftKey('alice', NEW_CHAT_DRAFT_SURFACE)
    type(from, 'in flight', { sending: true })
    carryComposerDraft(from, 'bob')
    expect(draft(composerDraftKey('bob', NEW_CHAT_DRAFT_SURFACE))).toBeUndefined()
    expect(draft(from)?.text).toBe('in flight')
    carryComposerDraft(composerDraftKey('alice', 'agent:x'), 'bob')
    expect(draft(composerDraftKey('bob', 'agent:x'))).toBeUndefined()
  })
})
