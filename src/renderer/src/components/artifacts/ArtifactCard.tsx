import { createContext, useContext, useEffect, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Check, Copy, ExternalLink, FileText, Globe, Link2, Loader2, Share2, Trash2, TriangleAlert, X, CircleAlert } from 'lucide-react'
import { usePopover } from '../ui/usePopover'
import { ARTIFACTS_KEY, useArtifactDetail, useArtifactsSupport } from '../../hooks/useArtifacts'
import { useAuthStore } from '../../stores/auth.store'
import { useArtifactPublishStore } from '../../stores/artifactPublish.store'
import { useArtifactPreviewStore } from '../../stores/artifactPreview.store'
import { unwrapIpcError } from '../../utils/ipcError'
import {
  artifactAudience,
  artifactIdFromUrl,
  type ArtifactDetail,
  type ArtifactLinkInfo,
  type ArtifactsDetailOutcome,
  type ArtifactVisibility,
  type CreatedArtifactLink,
  type PublishedArtifact
} from '../../../../shared/artifacts'

/**
 * A labelled action at the size of the badges under the chat input
 * (`RouterBadge`): filled with a tint of the accent (`.artifact-card-button`),
 * and in the ambient glow's rotation while it is visible.
 */
export const CARD_ACTION =
  'artifact-card-button ambient-button inline-flex items-center justify-center gap-1 rounded-lg px-1.5 py-1 ' +
  'text-[11px] font-semibold tracking-wide whitespace-nowrap transition-colors ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ' +
  'disabled:cursor-not-allowed disabled:opacity-50'

/** Main's clipboard: `navigator.clipboard` refuses once a dialog took the focus. A refusal is said, never a silent "Copied". */
async function copyText(text: string): Promise<boolean> {
  try {
    return (await window.api.clipboard.writeText(text)).success === true
  } catch {
    return false
  }
}

/** "Copy" that says "Copied" for a moment, at a fixed width so nothing beside it moves. */
export function CopyButton({
  text,
  label,
  ariaLabel,
  onFailed,
  className = CARD_ACTION,
  minWidth = 'min-w-[5.25rem]'
}: {
  text: string
  label: string
  /** The accessible name while it says `label` (a card's "Copy link to <title>"). */
  ariaLabel?: string
  onFailed: (message: string) => void
  className?: string
  /** Wide enough for both `label` and "Copied". */
  minWidth?: string
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <button
      type="button"
      className={`${className} ${minWidth}`}
      aria-label={copied ? undefined : ariaLabel}
      onClick={async () => {
        if (await copyText(text)) setCopied(true)
        else onFailed('Couldn’t copy the link — the clipboard refused it.')
      }}
    >
      {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
      {copied ? 'Copied' : label}
    </button>
  )
}

/** The card's icon button: no surface until hovered, and a tooltip that fades in at once. */
function IconAction({
  label,
  tip,
  onClick,
  expanded,
  buttonRef,
  children
}: {
  label: string
  tip: string
  onClick: () => void
  expanded?: boolean
  buttonRef?: React.Ref<HTMLButtonElement>
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <span className="group/tip relative inline-flex">
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        aria-expanded={expanded}
        aria-haspopup={expanded === undefined ? undefined : 'dialog'}
        onClick={onClick}
        className="artifact-icon-button ambient-button inline-flex h-6 w-6 items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
      >
        {children}
      </button>
      <span
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-full z-20 mt-1 -translate-x-1/2 whitespace-nowrap rounded-md border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 text-[10px] text-[var(--color-text)] opacity-0 shadow-lg transition-opacity duration-100 group-hover/tip:opacity-100 group-focus-within/tip:opacity-100"
      >
        {tip}
      </span>
    </span>
  )
}

/** Copy link as an icon: a check and "Copied" for a moment. */
function CopyIconAction({ text, label, onFailed }: { text: string; label: string; onFailed: (message: string) => void }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <IconAction
      label={label}
      tip={copied ? 'Copied' : 'Copy link'}
      onClick={async () => {
        if (await copyText(text)) setCopied(true)
        else onFailed('Couldn’t copy the link — the clipboard refused it.')
      }}
    >
      {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
    </IconAction>
  )
}

/** The card's mark for a link made at publish that Share… still holds. */
const FRESH_LINK_MARK = 'New public link — open Share… to copy it'

/** A link created this once: its URL with Copy, and a dismiss. Never stored, so never shown again. */
function FreshLink({ link, onDismiss, onFailed, first = false }: { link: CreatedArtifactLink; onDismiss?: () => void; onFailed: (message: string) => void; first?: boolean }): React.JSX.Element {
  return (
    <span className={`${first ? '' : 'mt-2 '}block rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5`} data-artifact-fresh-link>
      <span className="flex items-center gap-2">
        <Link2 size={12} className="shrink-0 text-[var(--color-text-muted)]" aria-hidden />
        <code className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-text)]" title={link.url}>{link.url}</code>
        <CopyButton text={link.url} label="Copy" onFailed={onFailed} minWidth="min-w-[4.25rem]" />
        {onDismiss && (
          <button type="button" onClick={onDismiss} aria-label="Hide this link" title="Hide this link"
            className="rounded p-0.5 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]">
            <X size={12} />
          </button>
        )}
      </span>
      <span className="mt-0.5 block text-[10px] text-[var(--color-text-muted)]">
        Shown once — copy it now.{link.code ? ` Code: ${link.code}` : ''}
      </span>
    </span>
  )
}

function dateText(iso: string | null): string {
  if (!iso) return ''
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

/**
 * Share…: who can see it, and the public links — two independent facts.
 * Reads core's current state each time it opens (the local row follows); a
 * new link's URL is shown here once. Portaled and labelled; errors are said
 * inside and close nothing. The checked choice takes the focus once core has
 * answered; Escape closes it and gives the focus back to Share….
 *
 * Revoking asks inline, in the link's own row (Cancel where the pointer was);
 * a revoked link stays in its place, inert and marked, until the popover
 * closes, so no row moves under the pointer.
 */
function SharePopover({
  artifact,
  instanceName,
  popover,
  warning,
  onDismissWarning,
  freshLink,
  onDismissFreshLink
}: {
  artifact: PublishedArtifact
  instanceName?: string
  popover: ReturnType<typeof usePopover<HTMLButtonElement, HTMLDivElement>>
  /** A publish whose sharing step failed: said here, at the top, until dismissed. */
  warning?: string
  onDismissWarning: () => void
  /** The public link made at publish, shown once: here, at the top, until dismissed. */
  freshLink?: CreatedArtifactLink
  onDismissFreshLink: () => void
}): React.JSX.Element | null {
  const queryClient = useQueryClient()
  const profileId = useAuthStore((s) => s.currentUser?.id ?? null)
  const detailQuery = useArtifactDetail(artifact.id, popover.open)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<CreatedArtifactLink | null>(null)
  /** The link whose revoke is being confirmed. */
  const [confirming, setConfirming] = useState<string | null>(null)
  /** Links revoked while open: kept in place, marked, until it closes. */
  const [revoked, setRevoked] = useState<Record<string, ArtifactLinkInfo>>({})
  /** The order links were first shown in this opening, so a revoke moves no row. */
  const order = useRef<string[]>([])
  const focused = useRef(false)
  const { setOpen, triggerRef, popoverRef } = popover
  const key = [...ARTIFACTS_KEY, 'detail', profileId, artifact.id]

  useEffect(() => {
    if (!popover.open) return
    setError(null)
    setCreated(null)
    setConfirming(null)
    setRevoked({})
    order.current = []
    focused.current = false
    void queryClient.invalidateQueries({ queryKey: key })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [popover.open])

  // Escape closes it from anywhere inside and gives the focus back to Share… (as TaskActionsMenu's dialogs do).
  useEffect(() => {
    if (!popover.open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
      triggerRef.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [popover.open, setOpen, triggerRef])

  const outcome = detailQuery.data
  const detail: ArtifactDetail | null = outcome?.ok ? outcome.detail : null
  const visibility: ArtifactVisibility = detail?.visibility ?? artifact.visibility

  // The checked choice takes the focus once it can (the radios wait for core's answer).
  useEffect(() => {
    if (!popover.open || !detail || !popover.style || focused.current) return
    const checked = popoverRef.current?.querySelector<HTMLInputElement>('input[type="radio"]:checked')
    if (checked) {
      checked.focus()
      focused.current = true
    }
  }, [popover.open, popover.style, detail, popoverRef])

  if (!popover.open || !popover.style) return null
  const shown = [...(detail?.links.filter((link) => link.live && !revoked[link.id]) ?? []), ...Object.values(revoked)]
  for (const link of shown) if (!order.current.includes(link.id)) order.current.push(link.id)
  shown.sort((a, b) => order.current.indexOf(a.id) - order.current.indexOf(b.id))
  const loadError = outcome && !outcome.ok ? outcome.message : detailQuery.error ? unwrapIpcError(detailQuery.error, 'Could not read the artifact.') : null

  const act = async (
    name: string,
    run: () => Promise<{ ok: true; detail?: ArtifactDetail | null } | { ok: false; message: string }>,
    done?: () => void
  ): Promise<void> => {
    if (busy) return
    setBusy(name)
    setError(null)
    try {
      const result = await run()
      if (!result.ok) setError(result.message)
      else {
        done?.()
        if (result.detail) queryClient.setQueryData<ArtifactsDetailOutcome>(key, { ok: true, detail: result.detail })
      }
    } catch (err) {
      setError(unwrapIpcError(err, 'Could not change the sharing.'))
    } finally {
      setBusy(null)
    }
  }

  const sectionLabel = 'mb-1 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]'
  return createPortal(
    <div
      ref={popover.popoverRef}
      role="dialog"
      aria-label={`Share ${artifact.title}`}
      style={popover.style}
      className="z-[100] w-80 space-y-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-overlay-panel)] p-3 text-xs shadow-xl backdrop-blur-xl"
    >
      {warning && (
        <div data-artifact-share-warning className="flex items-start gap-1.5 text-[11px] leading-relaxed text-[var(--color-warning)]">
          <TriangleAlert size={12} className="mt-0.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">{warning}</span>
          <button type="button" aria-label="Hide this note" title="Hide this note" onClick={onDismissWarning}
            className="rounded p-0.5 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]">
            <X size={11} />
          </button>
        </div>
      )}
      {freshLink && (
        <div data-artifact-share-fresh-link>
          <div className={sectionLabel}>New public link</div>
          <FreshLink link={freshLink} onDismiss={onDismissFreshLink} onFailed={setError} first />
        </div>
      )}
      <div role="radiogroup" aria-label="Who can see it">
        <div className={sectionLabel}>Who can see it</div>
        {(
          [
            ['private', 'Only me'],
            ['instance', `Everyone on ${instanceName || 'the instance'}`]
          ] as Array<[ArtifactVisibility, string]>
        ).map(([value, text]) => (
          <label key={value} className="flex items-center gap-2 py-0.5 text-[var(--color-text)]">
            <input
              type="radio"
              name={`share-${artifact.id}`}
              checked={visibility === value}
              // Not disabled while busy: a radio that is disabled drops the keyboard focus.
              disabled={!detail}
              onChange={() => void act(`visibility-${value}`, () => window.api.artifacts.setVisibility(artifact.id, value))}
            />
            {text}
            {busy === `visibility-${value}` && <Loader2 size={11} className="animate-spin motion-reduce:animate-none" aria-hidden />}
          </label>
        ))}
      </div>
      <div>
        <div className={sectionLabel}>Public links</div>
        {!detail && !loadError && (
          <div className="flex items-center gap-1.5 py-0.5 text-[var(--color-text-muted)]">
            <Loader2 size={11} className="animate-spin motion-reduce:animate-none" aria-hidden />
            Reading…
          </div>
        )}
        {detail && shown.length === 0 && !created && <div className="py-0.5 text-[var(--color-text-muted)]">Anyone with a link can open it. None yet.</div>}
        {shown.length > 0 && (
          <ul aria-label="Public links" className="space-y-0.5">
            {shown.map((link) => {
              const gone = revoked[link.id] !== undefined
              const asking = confirming === link.id && !gone
              return (
                <li key={link.id} className={`py-0.5 ${gone ? 'opacity-60' : ''}`} data-artifact-link={gone ? 'revoked' : 'live'}>
                  <span className="flex items-center gap-2">
                    <code className={`text-[11px] text-[var(--color-text)] ${gone ? 'line-through' : ''}`}>{link.tokenPrefix}…</code>
                    {asking ? (
                      <span className="min-w-0 flex-1 text-[11px] font-medium text-[var(--color-text)]">Revoke?</span>
                    ) : (
                      <span className="min-w-0 flex-1 truncate text-[10px] text-[var(--color-text-muted)]">
                        {dateText(link.createdAt)} · {link.expiresAt ? `expires ${dateText(link.expiresAt)}` : 'no expiry'}
                        {link.needsCode ? ' · code' : ''}
                      </span>
                    )}
                    {gone ? (
                      <span className="px-1 text-[10px] font-medium text-[var(--color-text-muted)]">Revoked</span>
                    ) : asking ? (
                      <>
                        <button
                          type="button"
                          className={`${CARD_ACTION} text-[var(--color-danger)]`}
                          disabled={busy !== null}
                          aria-busy={busy === `revoke-${link.id}` || undefined}
                          onClick={() =>
                            void act(`revoke-${link.id}`, () => window.api.artifacts.revokeLink(artifact.id, link.id), () => {
                              setRevoked((current) => ({ ...current, [link.id]: link }))
                              setConfirming(null)
                            })
                          }
                        >
                          {busy === `revoke-${link.id}` && <Loader2 size={11} className="animate-spin motion-reduce:animate-none" aria-hidden />}
                          Revoke
                        </button>
                        {/* Cancel sits where the trash was: a second click there keeps the link. */}
                        <button type="button" className={CARD_ACTION} disabled={busy !== null} onClick={() => setConfirming(null)}>
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        aria-label={`Revoke link ${link.tokenPrefix}`}
                        title="Revoke this link"
                        disabled={busy !== null}
                        onClick={() => {
                          setError(null)
                          setConfirming(link.id)
                        }}
                        className="rounded p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-danger)]/20 hover:text-[var(--color-danger)] disabled:opacity-50"
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </span>
                  {asking && <span className="mt-0.5 block text-[10px] text-[var(--color-text-muted)]">People with this link lose access.</span>}
                </li>
              )
            })}
          </ul>
        )}
        {created && <FreshLink link={created} onFailed={setError} />}
        <button
          type="button"
          className={`${CARD_ACTION} mt-2`}
          disabled={busy !== null || !detail}
          onClick={() =>
            void act('create', async () => {
              const result = await window.api.artifacts.createLink(artifact.id)
              if (result.ok) setCreated(result.link)
              return result
            })
          }
        >
          {busy === 'create' ? <Loader2 size={11} className="animate-spin motion-reduce:animate-none" aria-hidden /> : <Link2 size={12} aria-hidden />}
          Create link
        </button>
      </div>
      {(error || loadError) && (
        <p role="alert" className="text-[11px] leading-relaxed text-[var(--color-danger)]">{error ?? loadError}</p>
      )}
    </div>,
    document.body
  )
}

/**
 * A published artifact in the chat, in two bordered pieces.
 *
 * The card: icon by kind, title, revision and audience, as one target that
 * opens the in-app preview. A publish whose sharing step failed shows a small
 * warning mark there; Share… says what happened.
 *
 * Its actions: Open (the core page in the browser), Copy link and — for the
 * owner — Share…, as icon buttons in a row kept under the card, faded in on
 * hover or keyboard focus. At rest only the card is seen, and nothing moves.
 *
 * Built from spans so it may also stand in for a link inside a paragraph of
 * agent text.
 */
export function ArtifactCard({
  artifact,
  instanceName,
  canShare = true
}: {
  artifact: PublishedArtifact
  instanceName?: string
  canShare?: boolean
}): React.JSX.Element {
  // Opens toward the larger side of the window: a card near the top would
  // hang an above-popover off the top edge, one near the composer the bottom.
  const [placement, setPlacement] = useState<'above-left' | 'below-left'>('above-left')
  const popover = usePopover<HTMLButtonElement, HTMLDivElement>(placement, { keepTopWhileOpen: true })
  const freshLink = useArtifactPublishStore((s) => s.freshLinks[artifact.id])
  const warning = useArtifactPublishStore((s) => s.warnings[artifact.id])
  const dismissFreshLink = useArtifactPublishStore((s) => s.dismissFreshLink)
  const dismissWarning = useArtifactPublishStore((s) => s.dismissWarning)
  const openPreview = useArtifactPreviewStore((s) => s.open)
  const [message, setMessage] = useState<string | null>(null)
  const [hovered, setHovered] = useState(false)
  const [focusWithin, setFocusWithin] = useState(false)
  const Icon = artifact.kind === 'site' ? Globe : FileText
  // Who can see it is core's fact: grants are made on core's page and never
  // reach the local row, so the owner's card reads it (shared with Share…'s
  // read and a link card's); the row stands in until core answers or if it fails.
  const detailQuery = useArtifactDetail(artifact.id, canShare)
  const current = detailQuery.data?.ok ? detailQuery.data.detail : null
  // Deleted on core: main forgets the row on that 404, so the card leaves the
  // chat the next time it opens; until then it says so instead of an audience.
  const gone = detailQuery.data?.ok === false && detailQuery.data.code === 'gone'
  const audience = gone ? `deleted on ${instanceName || 'the instance'}` : artifactAudience(current ?? artifact, instanceName)
  const shareable = canShare && !gone
  // Out while pointed at or focused, and while Share… is open (the pointer is in its popover then).
  const drawerOut = hovered || focusWithin || popover.open
  return (
    <span
      role="group"
      aria-label={`Artifact ${artifact.title}`}
      data-artifact-card={artifact.id}
      className="relative isolate my-1 block w-[30%] min-w-[16rem] not-italic"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocusWithin(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusWithin(false)
      }}
    >
      <span
        data-artifact-card-main
        data-ambient-card
        className="ambient-button relative z-[1] block rounded-lg border border-[var(--color-border)] bg-[var(--color-overlay-panel)] backdrop-blur-xl"
      >
        <button
          type="button"
          data-artifact-card-body
          aria-label={gone ? `${artifact.title}, deleted on ${instanceName || 'the instance'}` : `Preview ${artifact.title}`}
          disabled={gone}
          onClick={(event) => {
            // A keyboard press has no point to grow from (detail 0).
            const origin = event.detail > 0 ? { x: event.clientX, y: event.clientY } : null
            openPreview(current ?? artifact, instanceName, origin)
          }}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors enabled:hover:bg-[var(--color-bg-hover)]/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)] disabled:cursor-default"
        >
          <Icon size={18} className="shrink-0 text-[var(--color-accent)]" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-medium leading-4 text-[var(--color-text)]" title={artifact.title}>{artifact.title}</span>
            <span className="flex items-center gap-1 text-[10px] leading-[14px] text-[var(--color-text-muted)]">
              <span className="truncate">rev {artifact.revision} · {audience}</span>
              {warning && shareable && (
                <span
                  role="img"
                  data-artifact-warning-mark
                  aria-label="Sharing did not finish — open Share… for details"
                  title="Sharing did not finish — open Share… for details"
                  className="inline-flex shrink-0 text-[var(--color-warning)]"
                >
                  <TriangleAlert size={11} aria-hidden />
                </span>
              )}
              {freshLink && shareable && (
                <span
                  role="img"
                  data-artifact-fresh-link-mark
                  aria-label={FRESH_LINK_MARK}
                  title={FRESH_LINK_MARK}
                  className="inline-flex shrink-0 text-[var(--color-accent)]"
                >
                  <Link2 size={11} aria-hidden />
                </span>
              )}
              {/* Open or Copy link failed: a mark whose tooltip (and alert) is the sentence, so the card keeps its one row. */}
              {message && (
                <span role="alert" data-artifact-error-mark title={message} className="inline-flex shrink-0 text-[var(--color-danger)]">
                  <CircleAlert size={11} aria-hidden />
                  <span className="sr-only">{message}</span>
                </span>
              )}
            </span>
          </span>
        </button>
      </span>
      {/* Under the card, in a row kept for them so nothing moves: icon buttons that fade in on hover or focus. */}
      <span
        data-artifact-card-drawer={drawerOut ? 'out' : 'in'}
        className={`artifact-card-drawer flex h-7 items-center gap-0.5 px-1 ${drawerOut ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
      >
        <IconAction
          label={`Open ${artifact.title}`}
          tip="Open in the browser"
          onClick={async () => {
            setMessage(null)
            try {
              const result = await window.api.system.openExternal(artifact.url)
              if (!result.success) setMessage(result.error || 'Couldn’t open the browser.')
            } catch (err) {
              setMessage(unwrapIpcError(err, 'Couldn’t open the browser.'))
            }
          }}
        >
          <ExternalLink size={13} aria-hidden />
        </IconAction>
        <CopyIconAction text={artifact.url} label={`Copy link to ${artifact.title}`} onFailed={setMessage} />
        {shareable && (
          <IconAction
            buttonRef={popover.triggerRef}
            label={`Share ${artifact.title}`}
            tip="Share…"
            expanded={popover.open}
            onClick={() => {
              if (!popover.open) {
                const rect = popover.triggerRef.current?.getBoundingClientRect()
                setPlacement(rect && rect.top < window.innerHeight / 2 ? 'below-left' : 'above-left')
              }
              popover.setOpen(!popover.open)
            }}
          >
            <Share2 size={13} aria-hidden />
          </IconAction>
        )}
      </span>
      {shareable && (
        <SharePopover
          artifact={artifact}
          instanceName={instanceName}
          popover={popover}
          warning={warning}
          onDismissWarning={() => dismissWarning(artifact.id)}
          freshLink={freshLink}
          onDismissFreshLink={() => dismissFreshLink(artifact.id)}
        />
      )}
    </span>
  )
}

/**
 * A link to `/artifact/<uuid>` in agent text: a skeleton at the card's height
 * at once, then the card; the ordinary link on a failure. Artifacts
 * unsupported, or any other path, is the link and no read at all.
 *
 * The id is read from the profile's own server whatever the link's host, since
 * core's frontend origin is known only once core has named it in an artifact
 * URL (`ArtifactsSupport.linkOrigins`), and a link a colleague or the CLI made
 * comes first. Off those origins the card is drawn only when core's own `url`
 * for that id is on the link's origin, so a look-alike host stays a link.
 */
/**
 * Artifacts this transcript already draws as a card (a publish's card, an
 * agent's tool row). A link to one of them stays a link: an agent that names
 * the URL it was just given would otherwise put a second card under the first.
 */
export const ShownArtifactsContext = createContext<ReadonlySet<string>>(new Set())

export function ArtifactLinkCard({ href, link }: { href: string; link: ReactElement }): React.JSX.Element {
  const support = useArtifactsSupport()
  const shown = useContext(ShownArtifactsContext)
  const artifactId = support.supported ? artifactIdFromUrl(href) : null
  if (!artifactId || shown.has(artifactId)) return link
  const known = artifactIdFromUrl(href, support.linkOrigins ?? []) !== null
  return <LoadedArtifactLinkCard artifactId={artifactId} link={link} instanceName={support.instanceName} origin={known ? null : new URL(href).origin} />
}

function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin
  } catch {
    return false
  }
}

function LoadedArtifactLinkCard({ artifactId, link, instanceName, origin }: { artifactId: string; link: ReactElement; instanceName?: string; origin: string | null }): React.JSX.Element {
  // A refetch keeps the last answer on screen (TanStack keeps `data` while it reads again).
  const query = useArtifactDetail(artifactId)
  const outcome = query.data
  if (outcome?.ok && (origin === null || sameOrigin(outcome.detail.url, origin))) {
    return <ArtifactCard artifact={outcome.detail} instanceName={instanceName} canShare={outcome.detail.isOwner} />
  }
  if (query.isPending && query.fetchStatus !== 'idle') return <ArtifactCardSkeleton />
  return link
}

/** The card's frame and line heights with nothing in them yet, so the card's arrival moves nothing. */
function ArtifactCardSkeleton(): React.JSX.Element {
  const bar = 'inline-block rounded bg-[var(--color-bg-hover)] align-middle'
  return (
    <span
      aria-busy="true"
      aria-label="Reading the artifact"
      data-artifact-card-skeleton
      className="mb-8 mt-1 block w-[30%] min-w-[16rem] animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-overlay-panel)] backdrop-blur-xl motion-reduce:animate-none"
    >
      {/* The card's body row: the same padding and line boxes (16px + 14px). */}
      <span className="flex items-center gap-3 px-3 py-2">
        <span className={`${bar} h-[18px] w-[18px] shrink-0`} />
        <span className="min-w-0 flex-1">
          <span className="flex h-4 items-center"><span className={`${bar} h-3 w-40 max-w-full`} /></span>
          <span className="flex h-[14px] items-center"><span className={`${bar} h-2 w-24`} /></span>
        </span>
      </span>
    </span>
  )
}

/** The Publish dialog and the progress/changed subscriptions. Mounted once, beside the file preview. */
export function useArtifactProgress(): void {
  const setPhase = useArtifactPublishStore((s) => s.setPhase)
  const ref = useRef(setPhase)
  ref.current = setPhase
  useEffect(() => window.api.artifacts.onProgress(({ operationId, phase }) => ref.current(operationId, phase)), [])
}
