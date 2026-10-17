import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Check, ExternalLink, Loader2, Plus, Search, X } from 'lucide-react'
import type { GoogleOAuthType, OAuthConnectFlow, ServiceCredentialAttachGroup } from '../../../../../shared/serviceCredentials'
import { credentialResult, oauthFlowKey, useCredentialAttachOptions, useOAuthConnectFlow } from '../../../hooks/useServiceCredentials'
import { unwrapIpcError } from '../../../utils/ipcError'
import { credentialTypeIcon, credentialTypeName, credentialTypeTitle } from '../../settings/LocalCredentialForm'
import { cloudErrors } from '../../settings/ServiceCredentialsSection'
import { CredentialOwnershipGlyph, CredentialStatusGlyph } from '../../settings/CredentialRow'
import { credentialHealth, credentialOwnership, oauthFlowErrorText } from '../../settings/credentialPresentation'

type Item = ServiceCredentialAttachGroup['items'][number]

function matches(item: Item, query: string): boolean {
  if (!query) return true
  const q = query.toLowerCase()
  return [item.name, credentialTypeName(item.type), item.serviceUri, item.ownerEmail, item.grantedUserEmail].some(v => !!v && v.toLowerCase().includes(q))
}

/** The four Google services New offers; each comes as a full and a read-only type. */
const googleServices = ['gmail', 'gdrive', 'gcalendar', 'gmeet'] as const
type GoogleService = typeof googleServices[number]
const googleType = (service: GoogleService, readOnly: boolean): GoogleOAuthType => `${service}_oauth${readOnly ? '_readonly' : ''}` as GoogleOAuthType
function splitGoogleType(type: GoogleOAuthType): { service: GoogleService; readOnly: boolean } {
  return { service: type.slice(0, type.indexOf('_')) as GoogleService, readOnly: type.endsWith('_readonly') }
}

const buttonClass = 'relative inline-flex items-center justify-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50'
const secondaryButton = `${buttonClass} border border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]`
const primaryButton = `${buttonClass} bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white`

/** A button whose label stays in place while it runs: the spinner covers it, so the button keeps its width. */
function BusyLabel({ busy, children }: { busy: boolean; children: string }): React.JSX.Element {
  return <><span className={busy ? 'invisible' : undefined}>{children}</span>{busy && <Loader2 size={12} aria-hidden className="absolute inset-0 m-auto animate-spin" />}</>
}

/**
 * The account a New credential goes to, for the chooser and the flow views: label then detail,
 * as the group headings show it, each part truncating so the line never wraps (rule 13).
 */
function AccountLine({ group, center = false }: { group: { label: string; detail: string } | undefined; center?: boolean }): React.JSX.Element {
  return <div data-testid="oauth-account" className={`mt-0.5 flex min-w-0 max-w-full items-baseline gap-1.5 text-[11px] text-[var(--color-text-muted)] ${center ? 'justify-center' : ''}`}>
    {group ? <><span className="min-w-0 shrink truncate font-medium text-[var(--color-text-secondary)]">{group.label}</span>
      {group.detail && <span className="min-w-0 shrink-[2] truncate">{group.detail}</span>}</>
      : <span className="min-w-0 truncate">This account</span>}
  </div>
}

/**
 * Picks credentials to attach to one local agent, grouped by where they live:
 * this computer, then each signed-in account. Attaching keeps the modal open
 * and the card in place (it turns into a disabled "Attached"); the attach
 * itself is owned by the caller, so it survives the modal closing.
 *
 * Each account also offers New Google credential: a chooser, then a waiting
 * view while the consent runs in the browser. That connect flow is main's
 * (`oauthFlow`), so closing the modal does not cancel it, and opening the
 * modal while one is waiting or failed shows it again.
 */
export function CredentialAttachModal({ open, agentId, onClose, onAttach }: {
  open: boolean
  agentId: string
  onClose: () => void
  /** Resolves once the reference is stored; rejects with the reason to show on the card. */
  onAttach: (group: string, ref: string) => Promise<void>
}): React.ReactPortal | null {
  const queryClient = useQueryClient()
  const options = useCredentialAttachOptions(agentId, open)
  const flowQuery = useOAuthConnectFlow(agentId, open)
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState<Set<string>>(new Set())
  const [attached, setAttached] = useState<Set<string>>(new Set())
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [choosing, setChoosing] = useState<{ group: string; service: GoogleService; readOnly: boolean } | null>(null)
  // One busy flag and one error line for whichever New view is showing: only one is ever on screen.
  const [busy, setBusy] = useState(false), [flowError, setFlowError] = useState('')
  const cardRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const radiosRef = useRef<HTMLDivElement>(null), reopenRef = useRef<HTMLButtonElement>(null), retryRef = useRef<HTMLButtonElement>(null)
  const focusedView = useRef<string | null>(null)
  const closedAt = useRef(0)
  const seen = useRef<{ id: string; state: OAuthConnectFlow['state'] } | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!open) { closedAt.current = Date.now(); return }
    setQuery(''); setErrors({}); setAttached(new Set()); setChoosing(null); setFlowError('')
    seen.current = null
    const t = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.preventDefault(); onClose() } }
    const onMouseDown = (e: MouseEvent): void => { if (cardRef.current && !cardRef.current.contains(e.target as Node)) onClose() }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onMouseDown)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onMouseDown) }
  }, [open, onClose])

  // An attached flow is dismissed. It closes the modal only when this opening watched it wait:
  // one that finished while the modal was closed is found on open, and the user came for something else.
  // Data from before the last close is a previous opening's (the query sleeps while closed); a flow
  // Reconnect put in the cache just before opening counts as watched.
  const flowData = flowQuery.data, flowUpdatedAt = flowQuery.dataUpdatedAt
  useEffect(() => {
    if (!open || flowData === undefined) return
    const before = seen.current, fresh = flowUpdatedAt >= closedAt.current
    if (fresh) seen.current = flowData ? { id: flowData.id, state: flowData.state } : null
    if (flowData?.state !== 'attached' || !fresh) return
    void window.api.serviceCredentials.cancelOAuth(agentId, flowData.id).catch(() => {})
    queryClient.setQueryData(oauthFlowKey(agentId), null)
    if (before?.id === flowData.id && before.state === 'waiting') onCloseRef.current()
  }, [open, flowData, flowUpdatedAt, agentId, queryClient])

  const groups = useMemo(() => (options.data?.groups ?? []).map(group => ({ ...group, visible: group.items.filter(item => matches(item, query)) })), [options.data, query])

  // A flow that failed to load reads as none: the list is still usable.
  const flow = flowQuery.data && flowQuery.data.state !== 'attached' ? flowQuery.data : null
  const view = flow ? flow.state : choosing ? 'choose' : 'list'
  // Swapping views unmounts the focused button: focus the new view's first move once it is usable
  // (Reopen browser, Retry, the chosen service). The search box gets it on open from the effect above.
  const viewKey = flow ? `${flow.state}:${flow.id}` : view
  useEffect(() => {
    if (!open) { focusedView.current = null; return }
    if (busy || focusedView.current === viewKey) return
    const first = focusedView.current === null
    focusedView.current = viewKey
    const target = view === 'list' ? (first ? null : inputRef.current)
      : view === 'choose' ? radiosRef.current?.querySelector<HTMLInputElement>('input:checked')
      : view === 'waiting' ? reopenRef.current : retryRef.current
    target?.focus()
  })
  if (!open) return null

  const cardKey = (group: string, ref: string) => `${group}:${ref}`
  const attach = async (group: string, item: Item) => {
    const ref = item.cloudId ?? item.id, key = cardKey(group, ref)
    setPending(p => new Set(p).add(key))
    setErrors(({ [key]: _, ...rest }) => rest)
    try {
      await onAttach(group, ref)
      setAttached(a => new Set(a).add(key))
    } catch (error) {
      setErrors(e => ({ ...e, [key]: unwrapIpcError(error) }))
    } finally {
      setPending(p => { const next = new Set(p); next.delete(key); return next })
    }
  }
  /** Runs one New action; a refusal stays in the view that asked (rule 6), a flow it answers replaces the cached one. */
  const run = async (action: () => Promise<OAuthConnectFlow | null>, after?: () => void) => {
    setBusy(true); setFlowError('')
    try {
      const next = await action()
      queryClient.setQueryData(oauthFlowKey(agentId), next)
      after?.()
    } catch (error) { setFlowError(unwrapIpcError(error)) } finally { setBusy(false) }
  }
  const sc = window.api.serviceCredentials
  const connect = (group: string, type: GoogleOAuthType) => run(async () => credentialResult(await sc.createOAuth(agentId, group, type)), () => setChoosing(null))
  const cancel = (flow: OAuthConnectFlow, after?: () => void) => run(async () => { credentialResult(await sc.cancelOAuth(agentId, flow.id)); return null }, after)
  const reopen = async (flow: OAuthConnectFlow) => {
    setBusy(true); setFlowError('')
    try { credentialResult(await sc.reopenOAuth(agentId, flow.id)) } catch (error) { setFlowError(unwrapIpcError(error)) } finally { setBusy(false) }
  }
  const retry = (flow: OAuthConnectFlow) => run(async () => credentialResult(flow.reconnect && flow.credentialId
    ? await sc.reconnectOAuth(agentId, flow.group, flow.credentialId)
    : await sc.createOAuth(agentId, flow.group, flow.type)))
  const newCredential = (group: string) => { setFlowError(''); setChoosing({ group, service: 'gmail', readOnly: false }) }

  const searching = query.trim() !== ''
  const noMatches = searching && groups.every(group => group.visible.length === 0)
  const groupOf = (key: string) => groups.find(group => group.key === key)

  const list = options.isLoading ? <div className="h-full flex items-center justify-center text-xs text-[var(--color-text-muted)]"><Loader2 size={14} className="animate-spin" /></div>
    : options.error ? <p role="alert" className="text-xs text-[var(--color-danger)]">{unwrapIpcError(options.error)}</p>
    : noMatches ? <div className="h-full flex items-center justify-center text-xs text-[var(--color-text-muted)]">No credentials match</div>
    : <div className="space-y-3">
      {groups.filter(group => !searching || group.visible.length > 0).map(group => <section key={group.key} aria-label={group.label}>
        <div className="mb-1.5 flex items-baseline gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
          <span>{group.label}</span>{group.detail && <span className="normal-case tracking-normal font-normal truncate">{group.detail}</span>}
        </div>
        {group.error && <div className="flex items-start gap-1.5 mb-2 px-2.5 py-1.5 rounded-md border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 text-[11px] text-[var(--color-text-secondary)]">
          <AlertTriangle size={12} className="mt-0.5 shrink-0 text-[var(--color-danger)]" />
          <span className="min-w-0">{cloudErrors[group.error] ?? 'Could not sync credentials from this profile. Try again.'}</span>
        </div>}
        {group.key === 'local' && group.items.length === 0 ? <p className="text-[11px] text-[var(--color-text-muted)]">No credentials on this computer yet.</p>
          : <div className="grid grid-cols-2 gap-2">
            {group.visible.map(item => {
              const ref = item.cloudId ?? item.id, key = cardKey(group.key, ref)
              const isAttached = item.attached || attached.has(key), busy = pending.has(key), error = errors[key]
              const Icon = credentialTypeIcon(item.type)
              // Only a problem is shown: a check on every healthy card would be noise.
              const health = credentialHealth(item)
              const typeName = credentialTypeName(item.type), typeTitle = credentialTypeTitle(item), titled = typeTitle !== typeName, isKey = item.type === 'agent_api'
              // A record named after its type (Core's Google records) says the granted account here instead of the type twice.
              const subLine = item.name === typeName ? item.grantedUserEmail ?? ''
                : `${typeName}${item.serviceUri ? ` · ${item.serviceUri}` : ''}${item.grantedUserEmail ? ` · ${item.grantedUserEmail}` : ''}`
              return <div key={key} data-testid={`credential-card-${ref}`} className="flex flex-col p-3 rounded-lg border bg-[var(--color-bg-secondary)] border-[var(--color-border)]">
                <div className="flex items-center gap-2">
                  <div role={titled ? 'img' : undefined} aria-label={titled ? typeTitle : undefined} title={titled ? typeTitle : undefined} className="shrink-0 w-7 h-7 rounded-md flex items-center justify-center bg-[var(--color-bg)] text-[var(--color-accent)]"><Icon size={14} aria-hidden /></div>
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--color-text)]">{item.name}</span>
                  {health.tone !== 'ok' && <CredentialStatusGlyph health={health} size={13} />}
                  {/* Who issued a key is the one fact its card would otherwise lose. */}
                  {isKey && <CredentialOwnershipGlyph ownership={credentialOwnership(item)} size={13} />}
                </div>
                <div title={titled ? typeTitle : undefined} className="mt-1.5 text-[10px] truncate text-[var(--color-text-muted)]">{subLine || <span aria-hidden>{'\u00a0'}</span>}</div>
                {item.relation === 'shared' && <div className="mt-0.5 text-[10px] truncate text-[var(--color-text-muted)]">Shared by {item.ownerEmail ?? 'owner'}</div>}
                <button type="button" aria-label={isAttached ? `${item.name} attached` : `Attach ${item.name}`} disabled={isAttached || busy} onClick={() => void attach(group.key, item)}
                  className={`mt-2 inline-flex items-center justify-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-colors disabled:cursor-not-allowed ${isAttached
                    ? 'border border-[var(--color-border)] text-[var(--color-text-muted)]'
                    : 'bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white disabled:opacity-50'}`}>
                  {isAttached ? <><Check size={11} />Attached</> : busy ? <><Loader2 size={11} className="animate-spin" />Attaching…</> : 'Attach'}
                </button>
                {error && <p role="alert" className="mt-1.5 text-[10px] text-[var(--color-danger)]">{error}</p>}
              </div>
            })}
            {group.key !== 'local' && !searching && <button type="button" onClick={() => newCredential(group.key)}
              className="flex flex-col p-3 rounded-lg border border-dashed border-[var(--color-border)] text-left transition-colors hover:border-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]">
              <span className="flex items-center gap-2">
                <span className="shrink-0 w-7 h-7 rounded-md flex items-center justify-center bg-[var(--color-bg)] text-[var(--color-accent)]"><Plus size={14} aria-hidden /></span>
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--color-accent)]">New Google credential</span>
              </span>
              <span className="mt-1.5 text-[10px] truncate text-[var(--color-text-muted)]">Gmail, Drive, Calendar or Meet</span>
              {/* The Attach button's line, unseen, so this card is as tall as a credential card. */}
              <span aria-hidden className="invisible mt-2 px-2 py-1 text-[11px] font-medium">Attach</span>
            </button>}
          </div>}
      </section>)}
    </div>

  let body: React.ReactNode
  if (view === 'choose' && choosing) {
    const type = googleType(choosing.service, choosing.readOnly)
    body = <div className="flex flex-col">
      <div className="text-xs font-medium text-[var(--color-text)]">New Google credential</div>
      <AccountLine group={groupOf(choosing.group)} />
      <div ref={radiosRef} role="radiogroup" aria-label="Google service" className="mt-3 space-y-1.5">
        {googleServices.map(service => {
          const Icon = credentialTypeIcon(googleType(service, false)), checked = choosing.service === service
          return <label key={service} className={`flex items-center gap-2 px-2.5 py-2 rounded-lg border cursor-pointer transition-colors bg-[var(--color-bg-secondary)] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--color-accent)] has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-[var(--color-bg)] ${checked ? 'border-[var(--color-accent)]' : 'border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]'}`}>
            <input type="radio" name="google-service" className="sr-only" checked={checked} disabled={busy} onChange={() => setChoosing({ ...choosing, service })} />
            <span className="shrink-0 w-7 h-7 rounded-md flex items-center justify-center bg-[var(--color-bg)] text-[var(--color-accent)]"><Icon size={14} aria-hidden /></span>
            <span className="min-w-0 flex-1 text-xs font-medium text-[var(--color-text)]">{credentialTypeName(googleType(service, false))}</span>
            {checked && <Check size={13} aria-hidden className="shrink-0 text-[var(--color-accent)]" />}
          </label>
        })}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button type="button" role="switch" aria-checked={choosing.readOnly} aria-label="Read-only" disabled={busy} onClick={() => setChoosing({ ...choosing, readOnly: !choosing.readOnly })}
          className={`relative h-4 w-7 shrink-0 rounded-full transition-colors disabled:opacity-50 ${choosing.readOnly ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-border)]'}`}>
          <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform ${choosing.readOnly ? 'left-[14px]' : 'left-0.5'}`} />
        </button>
        <span aria-hidden className="text-xs text-[var(--color-text)]">Read-only</span>
        <span className="text-[11px] text-[var(--color-text-muted)]">The agent can read but not change anything</span>
      </div>
      <p className="mt-3 text-[11px] text-[var(--color-text-muted)]">Will be named “{credentialTypeName(type)}”</p>
      {/* In flow, not pinned to the bottom: a refusal then lands below the buttons and moves nothing (rule 1). */}
      <div className="pt-4">
        <div className="flex justify-end gap-2">
          <button type="button" disabled={busy} onClick={() => { setChoosing(null); setFlowError('') }} className={secondaryButton}>Back</button>
          <button type="button" aria-label="Connect" aria-busy={busy} disabled={busy} onClick={() => void connect(choosing.group, type)} className={primaryButton}><BusyLabel busy={busy}>Connect</BusyLabel></button>
        </div>
        {flowError && <p role="alert" className="mt-2 text-right text-[11px] text-[var(--color-danger)]">{flowError}</p>}
      </div>
    </div>
  } else if (flow) {
    const service = credentialTypeName(flow.type), failed = flow.state === 'failed'
    body = <div className="flex flex-col items-center pt-12 text-center">
      <div className={`w-9 h-9 rounded-lg flex items-center justify-center bg-[var(--color-bg)] ${failed ? 'text-[var(--color-danger)]' : 'text-[var(--color-accent)]'}`}>
        {failed ? <AlertTriangle size={16} aria-hidden /> : <ExternalLink size={16} aria-hidden />}
      </div>
      {failed ? <>
        <div className="mt-3 text-sm font-medium text-[var(--color-text)]">{flow.reconnect ? `Could not reconnect ${service}` : `Could not connect ${service}`}</div>
        <AccountLine group={groupOf(flow.group)} center />
        <p role="alert" className="mt-1 max-w-sm text-[11px] text-[var(--color-text-secondary)]">{oauthFlowErrorText(flow.error)}</p>
        <div className="mt-4 flex gap-2">
          <button type="button" disabled={busy} onClick={() => void cancel(flow, flow.reconnect ? undefined : () => { const { service, readOnly } = splitGoogleType(flow.type); setChoosing({ group: flow.group, service, readOnly }) })} className={secondaryButton}>Back</button>
          <button ref={retryRef} type="button" aria-label="Retry" aria-busy={busy} disabled={busy} onClick={() => void retry(flow)} className={primaryButton}><BusyLabel busy={busy}>Retry</BusyLabel></button>
        </div>
      </> : <>
        <div className="mt-3 text-sm font-medium text-[var(--color-text)]">Finish in your browser</div>
        <AccountLine group={groupOf(flow.group)} center />
        <p className="mt-1 max-w-sm text-[11px] text-[var(--color-text-muted)]">Sign in to Google and allow {service} for this Cinna account. This closes by itself once Google confirms.</p>
        <div className="mt-4 flex gap-2">
          <button ref={reopenRef} type="button" disabled={busy} onClick={() => void reopen(flow)} className={secondaryButton}>Reopen browser</button>
          <button type="button" disabled={busy} onClick={() => void cancel(flow)} className={secondaryButton}>Cancel</button>
        </div>
      </>}
      {flowError && <p role="alert" className="mt-2 max-w-sm text-[11px] text-[var(--color-danger)]">{flowError}</p>}
    </div>
  }

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label="Attach credential" className="fixed inset-0 z-50 flex items-center justify-center px-4">
      <div ref={cardRef} className="w-full max-w-[34rem] h-[32rem] rounded-xl shadow-2xl flex flex-col overflow-hidden
          bg-[var(--color-accent)]/10 [[data-theme=light]_&]:bg-[var(--color-accent)]/4
          backdrop-blur-xl
          border border-[var(--color-accent)]/25 [[data-theme=light]_&]:border-[var(--color-accent)]/12">
        <div className="flex items-center justify-between px-4 pt-3.5 pb-2">
          <div className="text-sm font-semibold text-[var(--color-text)]">Attach credential</div>
          <button type="button" onClick={onClose} title="Close" aria-label="Close"
            className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"><X size={14} /></button>
        </div>
        {view === 'list' && <div className="px-4 pb-3">
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
            <input ref={inputRef} value={query} onChange={e => setQuery(e.target.value)} aria-label="Search credentials" placeholder="Search credentials…"
              className="w-full bg-[var(--color-bg)]/40 [[data-theme=light]_&]:bg-white/40 text-[var(--color-text)] pl-7 pr-2.5 py-1.5 rounded-md text-xs border border-[var(--color-accent)]/20 focus:border-[var(--color-accent)] focus:outline-none placeholder:text-[var(--color-text-muted)]" />
          </div>
        </div>}
        <div className="px-4 pb-4 overflow-y-auto flex-1 min-h-0">{view === 'list' ? list : body}</div>
      </div>
    </div>,
    document.body
  )
}
