/**
 * Which Cinna account a local agent's credentials come from when that account cannot supply them
 * now, and why: the pure half of `service-credentials:unavailable-accounts`. Facts in, answers out;
 * `service.ts` gathers the facts (profiles, the session's sign-outs and unlocks, derived account
 * keys) and `agentAccounts.ts` adds the agent's AI credential.
 */
import type { UnavailableAccountReason, UnavailableCredentialAccount } from '../../../shared/serviceCredentials'

/** What is known about the profile behind an account, for {@link unavailableReason}. */
export interface ProfileFacts {
  /** A profile row with this id still exists. */
  exists: boolean
  /** It is the current profile. */
  current: boolean
  /**
   * It was logged out of in this app session, or it is a Cinna profile with no stored tokens (a
   * Sign Out that kept this device's data, or a session revoked while it was current and then
   * switched away from: deliberately signed out too, since Switch + sign in is the action either
   * way). Ignored for the current profile, which reads as `session_expired`.
   */
  signedOut: boolean
  /** Its stored tokens name an account (the last derivation found a subject). */
  hasIdentity: boolean
  hasPassword: boolean
  /** Unlocked with its password in this app session. */
  unlocked: boolean
}

/**
 * Why the account cannot supply what the agent needs. `kind` says what it is asked for: attached
 * Core credentials follow every eligible account, so a profile with nothing against it is still
 * `signed_out` for them (its identity changed, or it is being derived); a provisioned AI credential
 * follows the current profile only, so the same profile is `other_profile` for it.
 *
 * Order: no profile known, deleted, current (its identity cannot be read: re-authenticate), signed
 * out this session (even when locked too, since that is what happened), no identity, locked.
 */
export function unavailableReason(facts: ProfileFacts | null, kind: 'credentials' | 'ai'): UnavailableAccountReason {
  if (!facts) return 'unknown'
  if (!facts.exists) return 'removed'
  if (facts.current) return 'session_expired'
  if (facts.signedOut) return 'signed_out'
  if (!facts.hasIdentity) return 'session_expired'
  if (facts.hasPassword && !facts.unlocked) return 'locked'
  return kind === 'ai' ? 'other_profile' : 'signed_out'
}

/** A provider row as {@link managedCredentialOwner} reads it. */
export interface ProviderOwnerRow { userId: string; id: string; name: string; managed: boolean }

/**
 * The account-provisioned (managed) AI credential of another profile that `reference` names, or
 * null: its exact id first, then its name as the resolver compares names (trimmed, any case).
 * Never by type, which would name an arbitrary profile's key. `byId` limits it to ids, for a
 * setting that stores one (the machine pin, Claude API Token mode's choice).
 */
export function managedCredentialOwner(reference: string, rows: readonly ProviderOwnerRow[], byId = false): ProviderOwnerRow | null {
  const ref = reference.trim()
  if (ref === '') return null
  const managed = rows.filter((row) => row.managed)
  const exact = managed.find((row) => row.id === ref)
  if (exact || byId) return exact ?? null
  const needle = ref.toLowerCase()
  return managed.find((row) => row.name.trim().toLowerCase() === needle) ?? null
}

/**
 * The credential accounts with the AI credential's owner folded in: onto the account of the same
 * key or profile when the agent has credentials there too, else as one more row.
 */
export function withAiCredentialOwner(accounts: readonly UnavailableCredentialAccount[], owner: UnavailableCredentialAccount | null): UnavailableCredentialAccount[] {
  if (!owner) return [...accounts]
  const at = accounts.findIndex((a) => a.key === owner.key || (a.userId !== null && a.userId === owner.userId))
  if (at < 0) return [...accounts, { ...owner, credentials: 0, aiCredential: true }]
  return accounts.map((a, i) => (i === at ? { ...a, aiCredential: true } : a))
}
