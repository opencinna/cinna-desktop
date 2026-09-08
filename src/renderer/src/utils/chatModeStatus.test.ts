import { describe, expect, it } from 'vitest'
import { chatModeInactiveReason, type ChatModeCredential } from './chatModeStatus'

/**
 * The four-rung ladder behind a chat mode's `Inactive` badge.
 *
 * It is a pure function precisely so this can be tested without a card: the two
 * components that call it (`ChatModeCard` and the account-provisioned
 * `ManagedChatModeCard`) sit in different settings groups, and the thing that
 * must not drift between them is the ranking and the wording, not the markup.
 */

function credential(overrides: Partial<ChatModeCredential> = {}): ChatModeCredential {
  return {
    id: 'p1',
    name: 'Personal',
    type: 'anthropic',
    enabled: true,
    hasApiKey: true,
    unsupported: false,
    ...overrides
  }
}

describe('chatModeInactiveReason', () => {
  it('says nothing about a mode that has no credential', () => {
    // The most ordinary chat mode there is. It runs on the default, which is
    // exactly what its own select says — marking it would put a warning badge
    // on the majority of the list.
    expect(chatModeInactiveReason(null, [credential()])).toBeNull()
    expect(chatModeInactiveReason('', [credential()])).toBeNull()
  })

  it('says nothing about a healthy pairing', () => {
    expect(chatModeInactiveReason('p1', [credential()])).toBeNull()
  })

  it('says nothing while the provider list is still loading', () => {
    // A badge that appears on the first render and vanishes on the second is
    // the interface jumping (ux_rules rule 1) — and it would appear on *every*
    // mode, because an absent list matches nothing.
    expect(chatModeInactiveReason('p1', undefined)).toBeNull()
  })

  it('names a credential this machine no longer has', () => {
    expect(chatModeInactiveReason('gone', [credential()])).toMatchObject({
      short: 'credential missing',
      detail: expect.stringMatching(/names an AI credential this machine no longer has/)
    })
  })

  it('ranks a missing key above the off switch, because switching it on would not help', () => {
    const reason = chatModeInactiveReason(
      'p1',
      [credential({ hasApiKey: false, enabled: false })]
    )
    expect(reason?.short).toBe('no API key')
    expect(reason?.detail).toMatch(/“Personal” has no API key this app can use/)
    expect(reason?.detail).not.toMatch(/switched off/)
  })

  it('says a switched-off credential is switched off, with the remedy', () => {
    expect(chatModeInactiveReason('p1', [credential({ enabled: false })])).toMatchObject({
      // The badge says *that*; this says which of the three, in the collapsed
      // row where the list is actually scanned.
      short: 'credential switched off',
      detail: expect.stringMatching(/“Personal” is switched off\. Turn it back on to use this chat mode/)
    })
  })

  it('treats a keyless credential as fine, key or no key', () => {
    // Ollama has nothing to store. Judging it on `hasApiKey` is the mistake
    // `shared/credentials` exists to prevent, and it would mark every local
    // model's chat mode inactive.
    expect(
      chatModeInactiveReason('p1', [credential({ type: 'ollama', hasApiKey: false })])
    ).toBeNull()
  })

  it('calls a managed credential this app cannot call with unusable, not off', () => {
    // An Anthropic OAuth token: enabled, present, and not an API key.
    expect(
      chatModeInactiveReason('p1', [credential({ unsupported: true })])?.detail
    ).toMatch(/has no API key this app can use/)
  })
})
