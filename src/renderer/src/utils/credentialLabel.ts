import { isCredentialActive } from '../../../shared/credentials'

/** As much of a credential as {@link credentialOptionLabel} reads. */
export interface LabelledCredential {
  name: string
  type: string
  enabled: boolean
  hasApiKey: boolean
  unsupported?: boolean
}

/**
 * How a credential is written **inside a select**, when the list it sits in may
 * contain one that cannot run.
 *
 * Three settings surfaces offer a credential to pick — a chat mode's, Settings
 * → Local Agents' pinned agent default, and the agent page's "Runs with" — and
 * each of them, for its own good reason, can end up listing one that is
 * switched off, has no key, or is otherwise inert. They each solved that
 * differently: one appended a marker, one rendered the bare name, and one said
 * nothing at all. So the same credential was described three ways across three
 * screens the user reaches from the same settings list (ux_rules rule 12).
 *
 * The suffix, not a colour or an icon: an `<option>` cannot be styled portably,
 * which is exactly why this is a wording problem rather than a CSS one.
 */
export function credentialOptionLabel(provider: LabelledCredential): string {
  return isCredentialActive(provider) ? provider.name : `${provider.name} — inactive`
}
