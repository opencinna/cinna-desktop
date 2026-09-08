import { isCredentialUsable } from '../../../shared/credentials'

/** As much of a credential as {@link chatModeInactiveReason} reads. */
export interface ChatModeCredential {
  id: string
  name: string
  type: string
  enabled: boolean
  hasApiKey: boolean
  unsupported?: boolean
}

/**
 * Why a chat mode cannot start a chat, or null when it can.
 *
 * A chat mode is a preset over a credential, so it inherits that credential's
 * state: switch the credential off and every mode pinned to it stops working.
 * It does not degrade gracefully — `providerService.upsert` unregisters the
 * adapter on disable, so `chatStreamingService`'s `getAdapter` comes back
 * undefined and the turn fails with "Provider adapter not available" rather
 * than falling back to anything. This is the sentence that says so before the
 * user finds out that way — shared by the two cards that list modes
 * (`ChatModeCard` and `ManagedChatModeCard`) so the user-created list and the
 * account-provisioned one beside it cannot word the same state differently.
 *
 * **A mode with no credential is not inactive.** It runs on the default, which
 * is exactly what its own select says ("None (use default)"), and calling that
 * a problem would put a warning badge on the most ordinary chat mode there is.
 *
 * `providers === undefined` — the list has not loaded — also returns null, so a
 * card cannot flash "Inactive" on its first render and un-flash on its second
 * (ux_rules rule 1).
 */
export interface ChatModeInactive {
  /**
   * Three or four words beside the badge, in the header, where the list is
   * scanned. The badge itself says *that* the mode is inactive; this says
   * **which** of the three it is.
   *
   * It is not left to the badge's `title`, because a tooltip is only an
   * affordance for someone who already suspects there is something to hover
   * (ux_rules rule 11) — and the collapsed row is the state the tab opens in,
   * so it is the state that has to be legible. It matters most on the managed
   * card, whose header carries the *mode's own* on/off switch: without this,
   * `Inactive` beside an enabled toggle is two meanings of "off" in one row.
   */
  short: string
  /** The whole sentence, with the remedy. Rendered in the expanded card. */
  detail: string
}

export function chatModeInactiveReason(
  providerId: string | null | undefined,
  providers: ChatModeCredential[] | undefined
): ChatModeInactive | null {
  if (!providerId || providers === undefined) return null
  const bound = providers.find((provider) => provider.id === providerId) ?? null
  if (!bound) {
    return {
      short: 'credential missing',
      detail: 'This chat mode names an AI credential this machine no longer has.'
    }
  }
  if (!isCredentialUsable(bound)) {
    return {
      short: 'no API key',
      detail: `“${bound.name}” has no API key this app can use.`
    }
  }
  if (!bound.enabled) {
    return {
      short: 'credential switched off',
      detail: `“${bound.name}” is switched off. Turn it back on to use this chat mode.`
    }
  }
  return null
}

/**
 * The pill, and the muted half-sentence after it.
 *
 * Constants rather than a component because the two cards place them
 * differently — one beside the name, one in a row that already holds a default
 * star — and the shared thing is the styling and the wording, not the layout.
 * Both live at the settings badge/metadata scale so a chat-mode row reads at the
 * same size as the credential row one tab away (ux_rules rule 12).
 */
export const INACTIVE_BADGE_CLASS =
  'shrink-0 rounded-full bg-[var(--color-warning)]/15 px-1.5 py-0.5 text-[11px] font-medium text-[var(--color-warning)]'

/**
 * The cause, inline after the badge. Muted and 12px, so it reads as the
 * metadata it is rather than competing with the mode's name — and inline rather
 * than on its own line, so a card does not change height when it goes inactive.
 */
export const INACTIVE_CAUSE_CLASS = 'shrink-0 text-[12px] text-[var(--color-text-muted)]'
