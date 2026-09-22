import type { ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, ChevronDown, ExternalLink, Laptop, User, Users, XCircle } from 'lucide-react'
import { unwrapIpcError } from '../../utils/ipcError'
import { credentialTypeIcon, credentialTypeName } from './LocalCredentialForm'
import { SettingsBadge, SettingsIconButton } from './SettingsLayout'
import type { AccountReference, CredentialHealth, CredentialOwnership } from './credentialPresentation'

const toneIcon = { ok: CheckCircle2, warning: AlertTriangle, error: XCircle }
const toneColor = { ok: 'text-[var(--color-success)]', warning: 'text-[var(--color-warning)]', error: 'text-[var(--color-danger)]' }
const ownershipIcon = { owned: User, shared: Users, local: Laptop }

/** A glyph that carries a sentence: `title` for the pointer, `role="img"` + name for everyone else. */
function Glyph({ label, className, children }: { label: string; className: string; children: ReactNode }): React.JSX.Element {
  return <span role="img" aria-label={label} title={label} className={`inline-flex shrink-0 ${className}`}>{children}</span>
}

/** The row's status glyph, also used on the attach picker's cards. */
export function CredentialStatusGlyph({ health, size = 14 }: { health: CredentialHealth; size?: number }): React.JSX.Element {
  const Icon = toneIcon[health.tone]
  return <Glyph label={health.label} className={toneColor[health.tone]}><Icon size={size} aria-hidden /></Glyph>
}

/**
 * An account in its standard form, "Name <email> host", everywhere a
 * credential list names one: the remote settings header and the agent's
 * attachment groups. The host opens the server in the browser.
 */
export function AccountReferenceLabel({ reference, onError, className = '' }: { reference: AccountReference; onError: (message: string) => void; className?: string }): React.JSX.Element {
  return <span className={`min-w-0 truncate ${className}`}>
    <span className="text-[var(--color-text-secondary)]">{reference.name}</span>
    {reference.email && <> &lt;{reference.email}&gt;</>}
    {' '}<a href={reference.serverUrl} title={reference.serverUrl} className="text-[var(--color-accent)] hover:underline"
      onClick={e => { e.preventDefault(); void openExternalUrl(reference.serverUrl, onError) }}>{reference.host}</a>
  </span>
}

/** Opens a URL in the browser, reporting a refused open (`{ success: false }`) or a thrown IPC error. */
export async function openExternalUrl(url: string, onError: (message: string) => void): Promise<void> {
  try {
    const result = await window.api.system.openExternal(url)
    if (!result.success) onError(result.error)
  } catch (err) { onError(unwrapIpcError(err)) }
}

/** "Manage" for a cloud record: opens Core's page for that credential. */
export function ManageCredentialButton({ name, url, onError, disabled }: { name: string; url: string; onError: (message: string) => void; disabled?: boolean }): React.JSX.Element {
  return <SettingsIconButton disabled={disabled} aria-label={`Manage ${name}`} title="Manage on the remote" onClick={() => void openExternalUrl(url, onError)}>
    <ExternalLink size={14} />
  </SettingsIconButton>
}

/**
 * One service credential, the same in every list: type icon, name, type badge,
 * status, ownership, Service URI, then the row's actions on the right. Every
 * element is one line and fixed-size, so no state change moves a neighbour.
 *
 * `expandable` makes the header toggle a body below it (the local list's edit
 * form). The toggle is a real button for keyboard use; the whole header also
 * takes the click, and `actions` stop their clicks from reaching it.
 */
export function CredentialRow({ name, type, serviceUri, health, ownership, actions, expandable, children }: {
  name: string
  type?: string
  serviceUri?: string | null
  health: CredentialHealth
  ownership?: CredentialOwnership | null
  actions?: ReactNode
  /** `disabled` locks the toggle while another form holds unsaved input. */
  expandable?: { expanded: boolean; onToggle: () => void; disabled?: boolean }
  children?: ReactNode
}): React.JSX.Element {
  const TypeIcon = type ? credentialTypeIcon(type) : null
  const OwnerIcon = ownership ? ownershipIcon[ownership.kind] : null
  const content = <>
    {TypeIcon && <TypeIcon size={16} aria-hidden className="shrink-0 text-[var(--color-accent)]" />}
    <span title={name} className="min-w-0 shrink truncate text-[14px] font-medium">{name}</span>
    {type && <SettingsBadge>{credentialTypeName(type)}</SettingsBadge>}
    <CredentialStatusGlyph health={health} />
    {ownership && OwnerIcon && <Glyph label={ownership.label} className="text-[var(--color-text-muted)]"><OwnerIcon size={14} aria-hidden /></Glyph>}
    {serviceUri && <code title={`Service URI: ${serviceUri}`} className="min-w-0 shrink-[2] truncate rounded bg-[var(--color-bg-tertiary)] px-1.5 py-px font-mono text-[12px] text-[var(--color-text-secondary)]">{serviceUri}</code>}
  </>
  const actionBox = actions ? <div className="flex shrink-0 items-center gap-1.5" onClick={e => e.stopPropagation()}>{actions}</div> : null
  return <div className="overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]">
    {expandable
      ? <div className={`flex items-center gap-2 px-4 py-2.5 transition-colors ${expandable.disabled ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-[var(--color-bg-hover)]'}`} onClick={() => { if (!expandable.disabled) expandable.onToggle() }}>
        {/* No onClick of its own: its click (and Enter/Space) bubbles to the header. */}
        <button type="button" aria-expanded={expandable.expanded} disabled={expandable.disabled} className="flex min-w-0 flex-1 items-center gap-2 rounded text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]">{content}</button>
        {actionBox}
        <ChevronDown size={14} aria-hidden className={`shrink-0 text-[var(--color-text-muted)] transition-transform duration-200 ${expandable.expanded ? 'rotate-180' : ''}`} />
      </div>
      : <div className="flex items-center gap-2 px-4 py-2.5"><div className="flex min-w-0 flex-1 items-center gap-2">{content}</div>{actionBox}</div>}
    {children}
  </div>
}
