import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, ArrowLeft, Check, Library, Loader2, Plug, Plus, Search, Terminal, X } from 'lucide-react'
import type { McpProviderData } from '../../../../../preload'
import { useMcpProviders } from '../../../hooks/useMcp'
import { unwrapIpcError } from '../../../utils/ipcError'
import { MCPRegistryPicker } from '../../settings/MCPRegistryPicker'
import { AddCustomMcpForm } from '../../settings/AddCustomMcpForm'
import { AddLocalMcpForm } from '../../settings/AddLocalMcpForm'
import { mcpProblem } from '../../settings/mcpPresentation'

type NewPanel = 'registry' | 'custom' | 'local' | null

function matches(provider: McpProviderData, query: string): boolean {
  if (!query) return true
  const q = query.toLowerCase()
  return [provider.name, provider.url, provider.command].some((v) => !!v && v.toLowerCase().includes(q))
}

/**
 * Picks MCP connectors to attach to one local agent: every connector already
 * set up on this computer, plus the three ways Settings → MCP adds a new one.
 *
 * Attaching an existing card keeps the modal open and turns the card into a
 * disabled "Attached", as the credential picker does. A connector created here
 * is attached the moment it exists, and the modal closes on it: the row on the
 * Addons tab is where its authorization is shown and finished. The attach
 * itself is owned by the caller, so it survives the modal closing.
 */
export function McpAttachModal({ open, attachedIds, onClose, onAttach }: {
  open: boolean
  attachedIds: readonly string[]
  onClose: () => void
  /** Resolves once the link is stored; rejects with the reason to show on the card. */
  onAttach: (mcpProviderId: string) => Promise<void>
}): React.ReactPortal | null {
  const { data: providers, isLoading, error: listError } = useMcpProviders()
  const [query, setQuery] = useState('')
  const [panel, setPanel] = useState<NewPanel>(null)
  const [pending, setPending] = useState<Set<string>>(new Set())
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [createError, setCreateError] = useState('')
  const cardRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  // Read inside the window listeners, which are bound once per open.
  const panelRef = useRef<NewPanel>(null)
  panelRef.current = panel

  useEffect(() => {
    if (!open) return
    setQuery(''); setErrors({}); setPanel(null); setCreateError('')
    const t = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [open])

  useEffect(() => {
    if (!open) return
    // An open form holds what the user typed: Escape steps back to the list
    // only through the form's own Cancel, and a click outside closes nothing
    // (ux_rules rule 13 — an open form is not replaced by another control).
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || panelRef.current) return
      e.preventDefault(); onClose()
    }
    const onMouseDown = (e: MouseEvent): void => {
      if (panelRef.current) return
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onMouseDown)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onMouseDown) }
  }, [open, onClose])

  const visible = useMemo(() => (providers ?? []).filter((p) => matches(p, query)), [providers, query])
  if (!open) return null

  const attach = async (id: string): Promise<void> => {
    setPending((p) => new Set(p).add(id))
    setErrors(({ [id]: _, ...rest }) => rest)
    try {
      await onAttach(id)
    } catch (error) {
      setErrors((e) => ({ ...e, [id]: unwrapIpcError(error) }))
    } finally {
      setPending((p) => { const next = new Set(p); next.delete(id); return next })
    }
  }
  // The connector exists by now, in the global list, whatever happens next; a
  // failed attach keeps the modal open on the list, where its card says why and
  // offers Attach again.
  const created = (id: string): void => {
    setPanel(null)
    setCreateError('')
    onAttach(id).then(onClose, (error) => setCreateError(unwrapIpcError(error)))
  }

  const empty = (providers ?? []).length === 0
  const newButton =
    'flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-dashed border-[var(--color-border)] ' +
    'text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:border-[var(--color-text-muted)] transition-colors'

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label="Attach MCP connector" className="fixed inset-0 z-50 flex items-center justify-center px-4">
      <div ref={cardRef} className="w-full max-w-[34rem] h-[32rem] rounded-xl shadow-2xl flex flex-col overflow-hidden
          bg-[var(--color-accent)]/10 [[data-theme=light]_&]:bg-[var(--color-accent)]/4
          backdrop-blur-xl
          border border-[var(--color-accent)]/25 [[data-theme=light]_&]:border-[var(--color-accent)]/12">
        <div className="flex items-center justify-between px-4 pt-3.5 pb-2">
          <div className="text-sm font-semibold text-[var(--color-text)]">Attach MCP connector</div>
          {/* With a form open this is the form's way out, back to the list —
              never past it to close what holds the user's input (rule 13). */}
          <button type="button" onClick={panel ? () => setPanel(null) : onClose} title={panel ? 'Back to connectors' : 'Close'} aria-label={panel ? 'Back to connectors' : 'Close'}
            className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors">{panel ? <ArrowLeft size={14} /> : <X size={14} />}</button>
        </div>
        {panel ? (
          <div className="px-4 pb-4 overflow-y-auto flex-1 min-h-0">
            {panel === 'registry' ? <MCPRegistryPicker onClose={() => setPanel(null)} onCreated={created} closeLabel="Back" />
              : panel === 'custom' ? <AddCustomMcpForm onClose={() => setPanel(null)} onCreated={created} />
              : <AddLocalMcpForm onClose={() => setPanel(null)} onCreated={created} />}
          </div>
        ) : <>
          <div className="px-4 pb-3">
            <div className="relative">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
              <input ref={inputRef} value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search connectors" placeholder="Search connectors…"
                className="w-full bg-[var(--color-bg)]/40 [[data-theme=light]_&]:bg-white/40 text-[var(--color-text)] pl-7 pr-2.5 py-1.5 rounded-md text-xs border border-[var(--color-accent)]/20 focus:border-[var(--color-accent)] focus:outline-none placeholder:text-[var(--color-text-muted)]" />
            </div>
          </div>
          <div className="px-4 pb-3 overflow-y-auto flex-1 min-h-0">
            {isLoading ? <div className="h-full flex items-center justify-center text-xs text-[var(--color-text-muted)]"><Loader2 size={14} className="animate-spin" /></div>
              : listError ? <p role="alert" className="text-xs text-[var(--color-danger)]">{unwrapIpcError(listError)}</p>
              : empty ? <div className="h-full flex items-center justify-center text-xs text-[var(--color-text-muted)]">No connectors on this computer yet. Add one below.</div>
              : visible.length === 0 ? <div className="h-full flex items-center justify-center text-xs text-[var(--color-text-muted)]">No connectors match</div>
              : <div className="grid grid-cols-2 gap-2">
                {visible.map((provider) => {
                  const isAttached = attachedIds.includes(provider.id), busy = pending.has(provider.id), error = errors[provider.id]
                  // Only a problem is shown: a check on every healthy card would be noise (rule 13).
                  const problem = mcpProblem(provider)
                  return <div key={provider.id} data-testid={`mcp-card-${provider.id}`} className="flex flex-col p-3 rounded-lg border bg-[var(--color-bg-secondary)] border-[var(--color-border)]">
                    <div className="flex items-center gap-2">
                      <div className="shrink-0 w-7 h-7 rounded-md flex items-center justify-center bg-[var(--color-bg)] text-[var(--color-accent)]"><Plug size={14} /></div>
                      <span className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--color-text)]">{provider.name}</span>
                      {problem && <span role="img" aria-label={problem} title={problem} className="shrink-0 inline-flex text-[var(--color-warning)]"><AlertTriangle size={13} aria-hidden /></span>}
                    </div>
                    <div className="mt-1.5 text-[10px] truncate font-mono text-[var(--color-text-muted)]" title={provider.url ?? provider.command}>
                      {provider.transportType === 'stdio' ? [provider.command, ...(provider.args ?? [])].join(' ') : provider.url}
                    </div>
                    <button type="button" aria-label={isAttached ? `${provider.name} attached` : `Attach ${provider.name}`} disabled={isAttached || busy} onClick={() => void attach(provider.id)}
                      className={`mt-2 inline-flex items-center justify-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-colors disabled:cursor-not-allowed ${isAttached
                        ? 'border border-[var(--color-border)] text-[var(--color-text-muted)]'
                        : 'bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white disabled:opacity-50'}`}>
                      {isAttached ? <><Check size={11} />Attached</> : busy ? <><Loader2 size={11} className="animate-spin" />Attaching…</> : 'Attach'}
                    </button>
                    {error && <p role="alert" className="mt-1.5 text-[10px] text-[var(--color-danger)]">{error}</p>}
                  </div>
                })}
              </div>}
          </div>
          <div className="px-4 pb-4 pt-1 space-y-2">
            <div className="flex gap-2">
              <button type="button" onClick={() => setPanel('registry')} className={newButton}><Library size={13} />From Registry</button>
              <button type="button" onClick={() => setPanel('custom')} className={newButton}><Plus size={13} />Custom MCP</button>
              <button type="button" onClick={() => setPanel('local')} className={newButton}><Terminal size={13} />Local MCP</button>
            </div>
            {createError && <p role="alert" className="text-[11px] text-[var(--color-danger)]">The connector was added to Settings → MCP but not attached: {createError}</p>}
          </div>
        </>}
      </div>
    </div>,
    document.body
  )
}
