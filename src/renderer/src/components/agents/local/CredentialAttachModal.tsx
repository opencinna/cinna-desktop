import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Check, Loader2, Search, X } from 'lucide-react'
import type { ServiceCredentialAttachGroup } from '../../../../../shared/serviceCredentials'
import { useCredentialAttachOptions } from '../../../hooks/useServiceCredentials'
import { unwrapIpcError } from '../../../utils/ipcError'
import { credentialTypeIcon, credentialTypeName } from '../../settings/LocalCredentialForm'
import { cloudErrors } from '../../settings/ServiceCredentialsSection'

type Item = ServiceCredentialAttachGroup['items'][number]

function matches(item: Item, query: string): boolean {
  if (!query) return true
  const q = query.toLowerCase()
  return [item.name, credentialTypeName(item.type), item.serviceUri, item.ownerEmail].some(v => !!v && v.toLowerCase().includes(q))
}

/**
 * Picks credentials to attach to one local agent, grouped by where they live:
 * this computer, then each signed-in account. Attaching keeps the modal open
 * and the card in place (it turns into a disabled "Attached"); the attach
 * itself is owned by the caller, so it survives the modal closing.
 */
export function CredentialAttachModal({ open, agentId, onClose, onAttach }: {
  open: boolean
  agentId: string
  onClose: () => void
  /** Resolves once the reference is stored; rejects with the reason to show on the card. */
  onAttach: (group: string, ref: string) => Promise<void>
}): React.ReactPortal | null {
  const options = useCredentialAttachOptions(agentId, open)
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState<Set<string>>(new Set())
  const [attached, setAttached] = useState<Set<string>>(new Set())
  const [errors, setErrors] = useState<Record<string, string>>({})
  const cardRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setQuery(''); setErrors({}); setAttached(new Set())
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

  const groups = useMemo(() => (options.data?.groups ?? []).map(group => ({ ...group, visible: group.items.filter(item => matches(item, query)) })), [options.data, query])
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
  const searching = query.trim() !== ''
  const noMatches = searching && groups.every(group => group.visible.length === 0)

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
        <div className="px-4 pb-3">
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
            <input ref={inputRef} value={query} onChange={e => setQuery(e.target.value)} aria-label="Search credentials" placeholder="Search credentials…"
              className="w-full bg-[var(--color-bg)]/40 [[data-theme=light]_&]:bg-white/40 text-[var(--color-text)] pl-7 pr-2.5 py-1.5 rounded-md text-xs border border-[var(--color-accent)]/20 focus:border-[var(--color-accent)] focus:outline-none placeholder:text-[var(--color-text-muted)]" />
          </div>
        </div>
        <div className="px-4 pb-4 overflow-y-auto flex-1 min-h-0">
          {options.isLoading ? <div className="h-full flex items-center justify-center text-xs text-[var(--color-text-muted)]"><Loader2 size={14} className="animate-spin" /></div>
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
                {group.items.length === 0 ? <p className="text-[11px] text-[var(--color-text-muted)]">{group.key === 'local' ? 'No credentials on this computer yet.' : 'No credentials in this account.'}</p>
                  : <div className="grid grid-cols-2 gap-2">
                    {group.visible.map(item => {
                      const ref = item.cloudId ?? item.id, key = cardKey(group.key, ref)
                      const isAttached = item.attached || attached.has(key), busy = pending.has(key), error = errors[key]
                      const Icon = credentialTypeIcon(item.type)
                      return <div key={key} data-testid={`credential-card-${ref}`} className="flex flex-col p-3 rounded-lg border bg-[var(--color-bg-secondary)] border-[var(--color-border)]">
                        <div className="flex items-center gap-2">
                          <div className="shrink-0 w-7 h-7 rounded-md flex items-center justify-center bg-[var(--color-bg)] text-[var(--color-accent)]"><Icon size={14} /></div>
                          <span className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--color-text)]">{item.name}</span>
                        </div>
                        <div className="mt-1.5 text-[10px] truncate text-[var(--color-text-muted)]">{credentialTypeName(item.type)}{item.serviceUri ? ` · ${item.serviceUri}` : ''}</div>
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
                  </div>}
              </section>)}
            </div>}
        </div>
      </div>
    </div>,
    document.body
  )
}
