/**
 * Core's last addon `policy` (README §3.2), shared by the directory that
 * reads it and the services that honour it at install and delivery (plugin
 * hooks, stdio MCP, the public registries, custom connectors).
 *
 * **Per account, not per settings scope.** The settings scope is the same for
 * every profile (`auth/scope.ts`), so the policy belongs to the active Cinna
 * account (`<profile>@<server origin>`): signed out, or on a profile that is
 * not a Cinna one, it is {@link DEFAULT_ADDON_POLICY} — today's behaviour.
 * The `settingsUserId` the callers pass names the scope the read is for; it
 * does not pick the policy.
 *
 * **Kept across restarts.** Each policy core sends is written through
 * (`db/addonPolicies.ts`), so a restart with core unreachable applies the
 * last one read rather than failing open. An account core never sent one for
 * reads the default. A store that cannot be read (no database, in a test)
 * falls back to memory, then the default.
 *
 * Core: no Electron.
 */

import { DEFAULT_ADDON_POLICY, type AddonPolicy } from '../../../shared/addons/directory'
import { getProfileScopeUserId } from '../../auth/scope'
import { userRepo } from '../../db/users'
import { addonPolicyRepo } from '../../db/addonPolicies'

export interface AddonPolicyDeps {
  /** The active Cinna account's key, or null: signed out, or not a Cinna profile. */
  account(): string | null
  load(account: string): unknown
  save(account: string, policy: AddonPolicy): void
}

/** `<profile>@<origin>` of the active profile when it is a Cinna one. */
function activeAccount(): string | null {
  const profile = getProfileScopeUserId()
  const user = userRepo.get(profile)
  if (!user || user.type !== 'cinna_user' || !user.cinnaServerUrl) return null
  try {
    return `${profile}@${new URL(user.cinnaServerUrl).origin}`
  } catch {
    return null
  }
}

const defaultDeps: AddonPolicyDeps = {
  account: activeAccount,
  load: (account) => addonPolicyRepo.get(account),
  save: (account, policy) => addonPolicyRepo.set(account, policy)
}

let deps: AddonPolicyDeps = defaultDeps
const policies = new Map<string, AddonPolicy>()

/** A stored policy as the four flags; null when it is not one (a flag missing or not a boolean). */
export function storedPolicy(raw: unknown): AddonPolicy | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  const keys = Object.keys(DEFAULT_ADDON_POLICY) as Array<keyof AddonPolicy>
  if (!keys.every((key) => typeof value[key] === 'boolean')) return null
  return Object.fromEntries(keys.map((key) => [key, value[key] as boolean])) as unknown as AddonPolicy
}

function account(): string | null {
  try {
    return deps.account()
  } catch {
    return null
  }
}

function policyOf(key: string): AddonPolicy {
  const known = policies.get(key)
  if (known) return known
  let stored: AddonPolicy | null = null
  try {
    stored = storedPolicy(deps.load(key))
  } catch {
    stored = null
  }
  if (stored) policies.set(key, stored)
  return stored ?? DEFAULT_ADDON_POLICY
}

export const addonPolicies = {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  get(_settingsUserId: string): AddonPolicy {
    const key = account()
    return key === null ? DEFAULT_ADDON_POLICY : policyOf(key)
  },

  /**
   * Core sent `policy`: remember it for the account the read was started for
   * (`forAccount`, from {@link addonPolicies.accountKey} at the start — the
   * active one when not given), and write it through. Ignored with no account.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  set(_settingsUserId: string, policy: AddonPolicy, forAccount?: string | null): void {
    const key = forAccount !== undefined ? forAccount : account()
    if (key === null) return
    const before = policies.get(key)
    policies.set(key, policy)
    if (before && JSON.stringify(before) === JSON.stringify(policy)) return
    try {
      deps.save(key, policy)
    } catch {
      // Memory still holds it for this session.
    }
  },

  /** The directory's view: what core last sent for the active account (undefined: nothing yet, or no account). */
  /** The active account's key now (`<profile>@<origin>`), or null: what a read carries to {@link addonPolicies.set}. */
  accountKey(): string | null {
    return account()
  },

  store(): {
    get(settingsUserId: string): AddonPolicy | undefined
    set(settingsUserId: string, policy: AddonPolicy, forAccount?: string | null): void
    account(): string | null
  } {
    return {
      get: (settingsUserId) => (account() === null ? undefined : addonPolicies.get(settingsUserId)),
      set: (settingsUserId, policy, forAccount) => addonPolicies.set(settingsUserId, policy, forAccount),
      account: () => account()
    }
  },

  /** Tests: other account / storage reads. */
  _configure(next: Partial<AddonPolicyDeps>): void {
    deps = { ...defaultDeps, ...next }
    policies.clear()
  },

  /** Tests: forget every policy in memory and go back to the real reads. */
  _reset(): void {
    deps = defaultDeps
    policies.clear()
  }
}
