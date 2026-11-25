import { getProfileScopeUserId } from './scope'

/**
 * The active profile, only once one is activated: what a run started by the app on the user's
 * behalf (a status refresh, a dashboard's command or endpoint) records as the profile it works
 * for. Session-only and import-light; the hub installs the activation check (`hub/core.ts`), so
 * this module does not pull in `activation.ts` and everything it imports. Until then: none.
 */
let activated: () => boolean = () => false

export function installActivatedCheck(check: () => boolean): void { activated = check }

export function activatedProfileUserId(): string | null {
  return activated() ? getProfileScopeUserId() : null
}
