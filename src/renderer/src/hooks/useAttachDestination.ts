import { useProviders } from './useProviders'
import { useAuthStore } from '../stores/auth.store'
import { isCredentialUsable } from '../../../shared/credentials'

/**
 * Can files this user attaches go anywhere at all?
 *
 * True when the profile is Cinna-linked (bytes upload to the Cinna backend) or
 * any enabled LLM provider has a key (bytes land in the local store). Used by
 * the new-chat composer to gate the `[+]` button and drag-drop, and by the hint
 * bar to gate the attachment tips — a single rule so the bar can never advertise
 * an affordance the composer is hiding.
 *
 * Note this is the *pre-creation* gate only. An active chat narrows further on
 * the resolved destination and the model's media capability; see `ChatInput`.
 */
export function useHasAttachDestination(): boolean {
  const isCinnaUser = useAuthStore((s) => s.currentUser?.type === 'cinna_user')
  const { data: providers } = useProviders()
  return isCinnaUser || (providers ?? []).some((p) => p.enabled && isCredentialUsable(p))
}
