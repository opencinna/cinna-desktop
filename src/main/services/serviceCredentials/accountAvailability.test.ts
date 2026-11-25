import { describe, expect, it } from 'vitest'
import { managedCredentialOwner, unavailableReason, withAiCredentialOwner, type ProfileFacts } from './accountAvailability'
import type { UnavailableCredentialAccount } from '../../../shared/serviceCredentials'

const facts = (over: Partial<ProfileFacts> = {}): ProfileFacts =>
  ({ exists: true, current: false, signedOut: false, hasIdentity: true, hasPassword: false, unlocked: false, ...over })

describe('why an account cannot supply credentials', () => {
  it('names each reason, most decisive first', () => {
    expect(unavailableReason(null, 'credentials')).toBe('unknown')
    expect(unavailableReason(facts({ exists: false, current: true, signedOut: true }), 'credentials')).toBe('removed')
    // The current profile whose identity cannot be read: re-authenticate, not switch.
    expect(unavailableReason(facts({ current: true, hasIdentity: false }), 'credentials')).toBe('session_expired')
    expect(unavailableReason(facts({ current: true }), 'credentials')).toBe('session_expired')
    // Logged out this session, even with a password nobody unlocked since (logout clears unlocks).
    expect(unavailableReason(facts({ signedOut: true, hasPassword: true }), 'credentials')).toBe('signed_out')
    expect(unavailableReason(facts({ hasIdentity: false, hasPassword: true }), 'credentials')).toBe('session_expired')
    expect(unavailableReason(facts({ hasPassword: true }), 'credentials')).toBe('locked')
    expect(unavailableReason(facts({ hasPassword: true, unlocked: true }), 'credentials')).toBe('signed_out')
  })

  it('says an otherwise usable profile is simply not the current one for an AI credential', () => {
    expect(unavailableReason(facts(), 'ai')).toBe('other_profile')
    expect(unavailableReason(facts(), 'credentials')).toBe('signed_out')
    expect(unavailableReason(facts({ hasPassword: true }), 'ai')).toBe('locked')
  })
})

describe('the profile behind a managed AI credential', () => {
  const rows = [
    { userId: 'bob', id: 'managed:1', name: 'Anthropic (Team)', managed: true },
    { userId: 'alice', id: 'managed:2', name: 'OpenAI (Work)', managed: true },
    { userId: 'carol', id: 'own-key', name: 'OpenAI (Work)', managed: false }
  ]
  it('matches the exact id first, then the name as the resolver compares it, never by type or an unmanaged row', () => {
    expect(managedCredentialOwner('managed:1', rows)?.userId).toBe('bob')
    expect(managedCredentialOwner('  openai (work) ', rows)?.userId).toBe('alice')
    expect(managedCredentialOwner('openai', rows)).toBeNull()
    expect(managedCredentialOwner('own-key', rows)).toBeNull()
    expect(managedCredentialOwner('', rows)).toBeNull()
  })
  it('matches only ids for a setting that stores one', () => {
    expect(managedCredentialOwner('OpenAI (Work)', rows, true)).toBeNull()
    expect(managedCredentialOwner('managed:2', rows, true)?.userId).toBe('alice')
  })
})

describe('folding the AI credential into the account rows', () => {
  const account = (over: Partial<UnavailableCredentialAccount>): UnavailableCredentialAccount => ({
    key: 'k1', userId: 'alice', name: 'Alice', email: 'alice@corp.com', host: 'core.corp.com', reason: 'signed_out', current: false, credentials: 2, aiCredential: false, ...over
  })
  it('marks the account already listed, by key or by profile', () => {
    expect(withAiCredentialOwner([account({})], account({ credentials: 0, aiCredential: true, reason: 'other_profile' }))).toEqual([account({ aiCredential: true })])
    expect(withAiCredentialOwner([account({})], account({ key: 'user:alice', credentials: 0, aiCredential: true }))).toEqual([account({ aiCredential: true })])
  })
  it('adds a row for another profile, and changes nothing without an owner', () => {
    const bob = account({ key: 'k2', userId: 'bob', name: 'Bob', credentials: 0, aiCredential: true, reason: 'locked' })
    expect(withAiCredentialOwner([account({})], bob)).toEqual([account({}), bob])
    expect(withAiCredentialOwner([account({})], null)).toEqual([account({})])
  })
})
