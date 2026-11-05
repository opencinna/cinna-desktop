import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Check, Link2 } from 'lucide-react'
import { useAuthStore } from '../../stores/auth.store'
import { formatSkillLink } from '../../../../shared/skillLink'
import { normalizeServerOrigin } from '../../../../shared/serverOrigin'
import { SettingsIconButton } from '../settings/SettingsLayout'

/** The start of the button's accessible name on every surface: `Copy install link for <name>` ({@link copyInstallLinkLabel}). */
export const COPY_INSTALL_LINK_LABEL = 'Copy install link'

/** The button's accessible name and tooltip, naming the skill (what E2E finds it by). */
export function copyInstallLinkLabel(name: string): string {
  return `${COPY_INSTALL_LINK_LABEL} for ${name}`
}
/** How long the button says Copied (OpenInMenu's `COPIED_REVERT_MS`). */
export const COPIED_REVERT_MS = 1500
export const COPY_INSTALL_LINK_FAILED = 'Couldn’t copy the install link — the clipboard refused it.'

/** How long a stored-origin fallback (main could not read the server's discovery) stands before it is asked again. */
const FALLBACK_STALE_MS = 30_000

/**
 * The shared link for a catalog skill of the active Cinna account
 * (`https://<server>/get/skill/<package_id>`), or null when there is none to
 * give: no Cinna account, a server the skill-link grammar would refuse, or no
 * package id.
 *
 * `<server>` is the server's web app, which main reads from its discovery
 * document (`web_origin`): a profile signed in on the backend origin would
 * otherwise copy a link no browser can open. Until main answers, and when it
 * has nothing better, it is the stored origin — so the link is there from the
 * first render and the button never appears late. A fallback after a failed
 * discovery is not kept for the session: it goes stale after 30 s.
 */
export function useSkillInstallLink(packageId: string | null | undefined): string | null {
  const user = useAuthStore((s) => (s.currentUser?.type === 'cinna_user' ? s.currentUser : null))
  const server = user?.cinnaServerUrl ?? null
  const stored = server ? normalizeServerOrigin(server) : null
  const linkable = stored?.ok === true && !!packageId
  const installOrigin = useQuery({
    queryKey: ['skill-link', 'install-origin', user?.id ?? null, server],
    queryFn: () => window.api.skillLinks.installOrigin(),
    enabled: linkable,
    // An answer the server gave is final; a fallback after a failed discovery is asked again.
    staleTime: (query) => (query.state.data?.fromDiscovery ? Infinity : FALLBACK_STALE_MS)
  })
  if (!stored?.ok || !packageId) return null
  return formatSkillLink(installOrigin.data?.origin ?? stored.origin, packageId)
}

const BARE_ICON =
  'shrink-0 rounded p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]'

/**
 * Copy install link (skill links, D4): writes the link through main's
 * clipboard and says Copied in place — the icon and the tooltip — for a
 * moment. Nothing else moves. A refusal goes to `onError` for the surface's
 * own error line (ux_rules rule 6); a success clears it.
 */
export function CopyInstallLinkButton({
  link,
  name,
  onError,
  variant = 'settings'
}: {
  link: string
  /** The skill's name as the surface shows it. */
  name: string
  onError: (message: string | null) => void
  /** `settings`: a Settings row icon button; `bare`: the catalog dialog's bare icon. */
  variant?: 'settings' | 'bare'
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), COPIED_REVERT_MS)
    return () => clearTimeout(timer)
  }, [copied])
  const copy = async (): Promise<void> => {
    let ok = false
    try {
      ok = (await window.api.clipboard.writeText(link)).success === true
    } catch {
      ok = false
    }
    if (ok) {
      onError(null)
      setCopied(true)
    } else {
      setCopied(false)
      onError(COPY_INSTALL_LINK_FAILED)
    }
  }
  const label = copyInstallLinkLabel(name)
  const title = copied ? 'Copied' : label
  const icon = copied ? <Check size={variant === 'settings' ? 14 : 13} aria-hidden="true" /> : <Link2 size={variant === 'settings' ? 14 : 13} aria-hidden="true" />
  const button = variant === 'settings' ? (
    <SettingsIconButton onClick={() => void copy()} title={title} aria-label={label}>
      {icon}
    </SettingsIconButton>
  ) : (
    <button type="button" onClick={() => void copy()} title={title} aria-label={label} className={BARE_ICON}>
      {icon}
    </button>
  )
  return (
    <>
      {button}
      {/* Said to a screen reader too; takes no room. */}
      <span aria-live="polite" className="sr-only">{copied ? 'Copied' : ''}</span>
    </>
  )
}
