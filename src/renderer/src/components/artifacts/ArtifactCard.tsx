import { createContext, useContext, useEffect, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Check, Copy, ExternalLink, FileText, Globe, Link2, Loader2, Share2, Trash2, X } from 'lucide-react'
import { usePopover } from '../ui/usePopover'
import { ARTIFACTS_KEY, useArtifactDetail, useArtifactsSupport } from '../../hooks/useArtifacts'
import { useAuthStore } from '../../stores/auth.store'
import { useArtifactPublishStore } from '../../stores/artifactPublish.store'
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

/** A labelled action at the chat scale: the text colour, a border, so it reads as a button (ux_rules 11). */
const CARD_ACTION =
  'inline-flex items-center justify-center gap-1 rounded-md border border-[var(--color-border)] px-2 py-0.5 text-[11px] font-medium ' +
  'text-[var(--color-text)] transition-colors hover:bg-[var(--color-bg-hover)] disabled:cursor-not-allowed disabled:opacity-50'

/** Main's clipboard: `navigator.clipboard` refuses once a dialog took the focus. A refusal is said, never a silent "Copied". */
async function copyText(text: string): Promise<boolean> {
  try {
    return (await window.api.clipboard.writeText(text)).success === true
  } catch {
    return false
  }
}

/** "Copy" that says "Copied" for a moment, at a fixed width so nothing beside it moves. */
function CopyButton({
  text,
  label,
  ariaLabel,
  onFailed
}: {
  text: string
  label: string
  /** The accessible name while it says `label` (a card's "Copy link to <title>"). */
  ariaLabel?: string
  onFailed: (message: string) => void
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
      className={`${CARD_ACTION} min-w-[5.75rem]`}
      aria-label={copied ? undefined : ariaLabel}
      onClick={async () => {
        if (await copyText(text)) setCopied(true)
        else onFailed('Couldn’t copy the link — the clipboard refused it.')
      }}
    >
      {copied ? <Check size={11} aria-hidden /> : <Copy size={11} aria-hidden />}
      {copied ? 'Copied' : label}
    </button>
  )
}

/** A link created this once: its URL with Copy, and a dismiss. Never stored, so never shown again. */
function FreshLink({ link, onDismiss, onFailed }: { link: CreatedArtifactLink; onDismiss?: () => void; onFailed: (message: string) => void }): React.JSX.Element {
  return (
    <span className="mt-2 block rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5" data-artifact-fresh-link>
      <span className="flex items-center gap-2">
        <Link2 size={12} className="shrink-0 text-[var(--color-text-muted)]" aria-hidden />
        <code className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-text)]" title={link.url}>{link.url}</code>
        <CopyButton text={link.url} label="Copy" onFailed={onFailed} />
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
  popover
}: {
  artifact: PublishedArtifact
  instanceName?: string
  popover: ReturnType<typeof usePopover<HTMLButtonElement, HTMLDivElement>>
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
      className="app-popover-surface z-[100] w-80 space-y-3 rounded-lg border border-[var(--color-border)] p-3 text-xs shadow-lg"
    >
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
          {busy === 'create' ? <Loader2 size={11} className="animate-spin motion-reduce:animate-none" aria-hidden /> : <Link2 size={11} aria-hidden />}
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
 * A published artifact in the chat: icon by kind, title, revision and
 * audience, then Open (the core page in the browser), Copy link and — for
 * the owner — Share…. Built from spans so it may also stand in for a link
 * inside a paragraph of agent text.
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
  const [placement, setPlacement] = useState<'above-right' | 'below-right'>('above-right')
  const popover = usePopover<HTMLButtonElement, HTMLDivElement>(placement, { keepTopWhileOpen: true })
  const freshLink = useArtifactPublishStore((s) => s.freshLinks[artifact.id])
  const warning = useArtifactPublishStore((s) => s.warnings[artifact.id])
  const dismissFreshLink = useArtifactPublishStore((s) => s.dismissFreshLink)
  const dismissWarning = useArtifactPublishStore((s) => s.dismissWarning)
  const [message, setMessage] = useState<string | null>(null)
  const Icon = artifact.kind === 'site' ? Globe : FileText
  // Who can see it is core's fact: grants are made on core's page and never
  // reach the local row, so the owner's card reads it (shared with Share…'s
  // read and a link card's); the row stands in until core answers or if it fails.
  const detailQuery = useArtifactDetail(artifact.id, canShare)
  const current = detailQuery.data?.ok ? detailQuery.data.detail : null
  const audience = artifactAudience(current ?? artifact, instanceName)
  return (
    <span
      role="group"
      aria-label={`Artifact ${artifact.title}`}
      data-artifact-card={artifact.id}
      className="my-1 block max-w-lg rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2 not-italic"
    >
      <span className="flex items-center gap-3">
        <Icon size={18} className="shrink-0 text-[var(--color-accent)]" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-[var(--color-text)]" title={artifact.title}>{artifact.title}</span>
          <span className="block text-[10px] text-[var(--color-text-muted)]">
            rev {artifact.revision} · {audience}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            className={CARD_ACTION}
            aria-label={`Open ${artifact.title}`}
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
            <ExternalLink size={11} aria-hidden />
            Open
          </button>
          <CopyButton text={artifact.url} label="Copy link" ariaLabel={`Copy link to ${artifact.title}`} onFailed={setMessage} />
          {canShare && (
            <button
              type="button"
              ref={popover.triggerRef}
              className={CARD_ACTION}
              aria-label={`Share ${artifact.title}`}
              aria-expanded={popover.open}
              aria-haspopup="dialog"
              onClick={() => {
                if (!popover.open) {
                  const rect = popover.triggerRef.current?.getBoundingClientRect()
                  setPlacement(rect && rect.top < window.innerHeight / 2 ? 'below-right' : 'above-right')
                }
                popover.setOpen(!popover.open)
              }}
            >
              <Share2 size={11} aria-hidden />
              Share…
            </button>
          )}
        </span>
      </span>
      {freshLink && <FreshLink link={freshLink} onDismiss={() => dismissFreshLink(artifact.id)} onFailed={setMessage} />}
      {warning && (
        <span className="mt-1.5 flex items-start gap-1 text-[10px] text-[var(--color-warning)]">
          <span className="flex-1">{warning}</span>
          <button type="button" aria-label="Hide this note" title="Hide this note" onClick={() => dismissWarning(artifact.id)}
            className="rounded p-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
            <X size={11} />
          </button>
        </span>
      )}
      {message && <span role="alert" className="mt-1 block text-[10px] text-[var(--color-danger)]">{message}</span>}
      {canShare && <SharePopover artifact={artifact} instanceName={instanceName} popover={popover} />}
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
      className="my-1 block max-w-lg animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2 motion-reduce:animate-none"
    >
      <span className="flex items-center gap-3">
        <span className={`${bar} h-[18px] w-[18px] shrink-0`} />
        <span className="min-w-0 flex-1">
          <span className="block text-xs"><span className={`${bar} h-3 w-40 max-w-full`} />&nbsp;</span>
          <span className="block text-[10px]"><span className={`${bar} h-2 w-24`} />&nbsp;</span>
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
