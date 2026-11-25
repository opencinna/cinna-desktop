import { create } from 'zustand'
import { useAuthStore } from './auth.store'
import { CINNA_REAUTH_REQUIRED_CODE, type ReauthRequiredEvent } from '../../../shared/cinnaErrors'

/**
 * Global Cinna re-auth state. A single app-level modal ({@link ReauthModal})
 * reads this so any failing surface — catalog list, agent status, remote
 * sync — can raise one consistent "session expired" prompt instead of each
 * feature owning its own banner. Errors flip the flag via
 * {@link flagReauthFromError}; the inline surfaces (catalog banner, Connection
 * settings card) still work as before.
 */
interface ReauthStore {
  /** Drives the modal's visibility. */
  reauthRequired: boolean
  /** Which account/connection lost its session (from the main broadcast).
   *  Null when raised by the renderer-side fallback, which has no details. */
  info: ReauthRequiredEvent | null
  /** Set once the user closes the modal — suppresses re-opening on the next
   *  failed poll so we don't nag. Reset on a successful re-auth. */
  dismissed: boolean
  /** Raised by {@link ReauthStore.promptSignIn}: the profile was signed out on
   *  purpose, so the modal asks to sign in rather than reporting an expiry.
   *  Kept until a re-auth succeeds or the modal is dismissed. */
  signIn: boolean
  /** Raise the prompt (no-op while dismissed). Optional account details from
   *  the main broadcast are kept; the renderer fallback passes none. */
  requireReauth: (info?: ReauthRequiredEvent | null) => void
  /** Re-auth succeeded — clear everything so a future expiry prompts again. */
  clearReauth: () => void
  /** User closed the modal without re-authenticating. */
  dismiss: () => void
  /** Open the prompt for a profile just switched into that has no session
   *  (signed out): a deliberate switch, so an earlier "Not now" does not hold.
   *  A later {@link ReauthStore.requireReauth} keeps this variant and its info. */
  promptSignIn: (info: ReauthRequiredEvent) => void
}

export const useReauthStore = create<ReauthStore>((set) => ({
  reauthRequired: false,
  info: null,
  dismissed: false,
  signIn: false,
  requireReauth: (info) =>
    set((s) =>
      s.dismissed ? s : { reauthRequired: true, info: s.signIn ? s.info : (info ?? s.info) }
    ),
  clearReauth: () => set({ reauthRequired: false, info: null, dismissed: false, signIn: false }),
  dismiss: () => set({ reauthRequired: false, dismissed: true, signIn: false }),
  promptSignIn: (info) => set({ reauthRequired: true, info, dismissed: false, signIn: true })
}))

/**
 * True when an error (from a query, mutation, or raw IPC call) signals the
 * active Cinna session is gone. Covers both wire codes: `reauth_required`
 * (CinnaApiError from REST fetches like `catalog:list`) and
 * `cinna_reauth_required` (agent stream events).
 */
export function isReauthRequiredError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code
  return code === 'reauth_required' || code === CINNA_REAUTH_REQUIRED_CODE
}

/**
 * Flip the global reauth flag when a reauth-required error surfaces — but only
 * for Cinna accounts, which are the only ones that can act on the prompt.
 * Wired into the QueryClient's query/mutation caches in `App.tsx`.
 */
export function flagReauthFromError(err: unknown): void {
  if (!isReauthRequiredError(err)) return
  if (useAuthStore.getState().currentUser?.type !== 'cinna_user') return
  useReauthStore.getState().requireReauth()
}
