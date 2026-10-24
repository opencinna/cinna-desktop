/**
 * Core's last addon `policy` per settings scope (README §3.2), shared by the
 * directory that reads it and the services that honour it at install and
 * delivery (plugin hooks, stdio MCP). Until core sends one, or with no
 * account, {@link DEFAULT_ADDON_POLICY}: everything allowed. Memory only — a
 * restart starts from the default until the next directory read.
 *
 * Core: no Electron.
 */

import { DEFAULT_ADDON_POLICY, type AddonPolicy } from '../../../shared/addons/directory'

const policies = new Map<string, AddonPolicy>()

export const addonPolicies = {
  get(settingsUserId: string): AddonPolicy {
    return policies.get(settingsUserId) ?? DEFAULT_ADDON_POLICY
  },
  set(settingsUserId: string, policy: AddonPolicy): void {
    policies.set(settingsUserId, policy)
  },
  /** The map itself, for the directory's own reads. */
  store(): Map<string, AddonPolicy> {
    return policies
  },
  /** Tests: forget every policy. */
  _reset(): void {
    policies.clear()
  }
}
