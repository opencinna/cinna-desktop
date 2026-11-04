import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { Check, Copy, LayoutDashboard, X } from 'lucide-react'
import type { ComponentReferenceMiss, ComponentReferenceResolution } from '../../../../shared/dashboards'
import { parseComponentReference } from '../../../../shared/componentReference'
import { useCatalogItems } from '../../hooks/useCatalog'
import { useAddTile, useComponentReference } from '../../hooks/useDashboards'
import { useAuthStore } from '../../stores/auth.store'
import { composerDraftKey, useComposerDraftStore } from '../../stores/composerDraft.store'
import { useUIStore } from '../../stores/ui.store'
import { useCapabilities } from '../../hooks/useCapabilities'
import { unwrapIpcError } from '../../utils/ipcError'
import { AddToDashboardDialog } from './AddToDashboardDialog'
import { ComponentPreviewDialog } from './ComponentPreview'
import { COMPONENT_LINK, ComponentFindings, MissingCredentials, PlacementsLine, VIEW_LABELS, errorFindings, fixRequest, openAgentTab } from './componentParts'
import type { ComponentRefItem } from './componentReferences'

/**
 * The chat a reference is rendered in: its id (Ask to fix fills that chat's
 * composer) and the agent whose message it is (it wins a clash when the
 * reference names a slug or a bundle two agents have). Provided by the
 * transcript; outside one, a card resolves without a chat agent and offers
 * no Ask to fix.
 */
export interface ComponentRefScope {
  chatId: string | null
  agentId: string | null
}
export const ComponentRefScopeContext = createContext<ComponentRefScope>({ chatId: null, agentId: null })

/** Put text in a chat's composer, after what is typed there, and focus it. Never sends. */
export function fillChatComposer(chatId: string, text: string, options: { onlyIfEmpty?: boolean } = {}): void {
  const key = composerDraftKey(useAuthStore.getState().currentUser?.id, `chat:${chatId}`)
  const draft = useComposerDraftStore.getState().drafts[key]
  // A page's cinna.ask never touches what the owner is typing (the same rule as cinna-core's web host).
  if (options.onlyIfEmpty && draft && draft.text.trim() !== '') return
  useComposerDraftStore.getState().update(key, (draft) => ({
    text: draft.text.trim() === '' ? text : `${draft.text.replace(/\s+$/, '')}\n\n${text}`
  }))
  requestAnimationFrame(() => {
    document.querySelector<HTMLTextAreaElement>(`textarea[data-chat-composer="${CSS.escape(chatId)}"]`)?.focus()
  })
}

const BUTTON =
  'ambient-button inline-flex h-[22px] shrink-0 items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2 ' +
  'text-[11px] font-medium text-[var(--color-text)] transition-colors hover:bg-[var(--color-bg-hover)] disabled:cursor-not-allowed disabled:opacity-50'
const ICON_BUTTON =
  'inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] ' +
  'text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]'
const SHELL = 'block w-full max-w-[36rem] rounded-lg border border-[var(--color-border)] bg-[var(--color-overlay-panel)] px-3 py-2'
/** Every card is three fixed lines (title and actions, who, where): the skeleton is the same box. */
const TITLE_ROW = 'flex h-[22px] items-center gap-2'
const LINE_ROW = 'mt-1 flex h-4 items-center gap-1 text-[11px] leading-4'

/**
 * The cards of one message's component references (README §5.5): a compact
 * list, one card per component. Rendered for the `cinna-component-refs`
 * element `remarkComponentReferences` leaves in the tree.
 */
export function ComponentCardList({ items }: { items: ComponentRefItem[] }): React.JSX.Element | null {
  if (items.length === 0) return null
  return (
    <div className="my-2 flex flex-col gap-1.5" data-component-cards>
      {items.map((item) => <ComponentCard key={item.reference} reference={item.reference} label={item.label} />)}
    </div>
  )
}

/**
 * One reference as a card. It resolves through main (the spec, the cache and
 * the placements only — nothing runs, README D8) and shows, at one height in
 * every state: title, view and actions; the subtitle, owning agent and skill;
 * the placements, or why there is no component here. Errors, warnings and
 * missing credentials only exist when something is wrong, and come last.
 */
export function ComponentCard({ reference, label }: { reference: string; label: string | null }): React.JSX.Element {
  const scope = useContext(ComponentRefScopeContext)
  const query = useComponentReference(reference, scope.agentId)
  if (query.isPending) return <ComponentCardSkeleton />
  if (query.isError) {
    return (
      <MissCard reference={reference} label={label}>
        <span className="truncate text-[var(--color-text-secondary)]">{unwrapIpcError(query.error, 'This component could not be read.')}</span>
      </MissCard>
    )
  }
  const resolution = query.data
  if (!resolution.found) return <MissedReference reference={reference} label={label} resolution={resolution} />
  return <FoundCard reference={reference} label={label} resolution={resolution} chatId={scope.chatId} />
}

function CopyReferenceButton({ text }: { text: string }): React.JSX.Element {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timer = useRef<number | null>(null)
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current) }, [])
  const copy = async (): Promise<void> => {
    let ok = false
    try {
      ok = (await window.api.clipboard.writeText(text)).success === true
    } catch {
      ok = false
    }
    setState(ok ? 'copied' : 'failed')
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setState('idle'), 1500)
  }
  const title = state === 'copied' ? 'Copied' : state === 'failed' ? 'The clipboard refused the reference' : 'Copy reference'
  return (
    <button type="button" className={ICON_BUTTON} onClick={() => void copy()} title={title} aria-label={title}>
      {state === 'copied' ? <Check size={12} aria-hidden="true" /> : state === 'failed' ? <X size={12} className="text-[var(--color-danger)]" aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
    </button>
  )
}

/** The second line: the link's text, the owning agent, the skill — whichever are known. */
function WhoLine({ label, agentName, skill, fallback = null }: { label: string | null; agentName: string | null; skill: string | null; fallback?: string | null }): React.JSX.Element {
  const known = [label, agentName, skill ? `from skill ${skill}` : null].filter((part): part is string => !!part)
  // Nothing known about the agent: the reference's own agent segment, so the line is never blank.
  const parts = known.length > 0 ? known : fallback ? [fallback] : []
  return (
    <div className={`${LINE_ROW} text-[var(--color-text-muted)]`}>
      <span className="truncate">{parts.join(' · ')}</span>
    </div>
  )
}

function FoundCard({
  reference,
  label,
  resolution,
  chatId
}: {
  reference: string
  label: string | null
  resolution: Extract<ComponentReferenceResolution, { found: true }>
  chatId: string | null
}): React.JSX.Element {
  const { component, placements, canonicalReference } = resolution
  // Owned here, so its success outlives the dialog (ux rule 5).
  const addTile = useAddTile()
  const [adding, setAdding] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const blocked = component.missingCredentials.length > 0
  const runnable = component.valid && !blocked
  const needsId = component.manifestId === ''
  // Off, the card still previews; putting it on a dashboard waits until on (ux rule 15).
  const dashboardsOn = useCapabilities().dashboardsEnabled
  return (
    <div className={SHELL} data-component-card={reference} aria-label={`Component ${component.title}`} role="group">
      <div className={TITLE_ROW}>
        <LayoutDashboard size={14} className="shrink-0 text-[var(--color-accent)]" aria-hidden="true" />
        <span className="min-w-0 truncate text-xs font-medium text-[var(--color-text)]" title={component.title}>{component.title}</span>
        {component.view && (
          <span className="shrink-0 rounded bg-[var(--color-bg-tertiary)] px-1.5 py-px text-[10px] text-[var(--color-text-secondary)]">{VIEW_LABELS[component.view]}</span>
        )}
        <span className="flex-1" />
        {runnable && (
          <>
            <button type="button" className={BUTTON} onClick={() => setPreviewing(true)} aria-label={`Preview ${component.title}`}>
              Preview
            </button>
            {dashboardsOn && (
              <button
                type="button"
                className={BUTTON}
                onClick={() => setAdding(true)}
                disabled={needsId}
                title={needsId ? 'This agent needs an id first' : undefined}
                aria-label={`Add ${component.title} to a dashboard`}
              >
                Add to dashboard…
              </button>
            )}
          </>
        )}
        <CopyReferenceButton text={canonicalReference} />
      </div>
      <WhoLine label={label} agentName={component.agentName} skill={component.skill} />
      {/* An invalid component's errors follow below; only without any does the line say so. */}
      {(component.valid || errorFindings(component).length === 0) && (
        <div className={LINE_ROW}>
          {component.valid && blocked && placements.length === 0 ? (
            <MissingCredentials component={component} scale="chrome" />
          ) : component.valid ? (
            <PlacementsLine placements={placements} scale="chrome" />
          ) : (
            <span className="truncate text-[var(--color-danger)]">Has problems to fix</span>
          )}
        </div>
      )}
      {needsId && runnable && (
        <p className="m-0 mt-1.5 text-[11px] text-[var(--color-text-secondary)]">
          This agent needs an id first.{' '}
          <button type="button" className={COMPONENT_LINK} onClick={() => openAgentTab(component.agentId, 'folder')}>
            Open agent
          </button>
        </p>
      )}
      {blocked && (placements.length > 0 || !component.valid) && <div className="mt-1.5"><MissingCredentials component={component} scale="chrome" /></div>}
      {component.findings.length > 0 && (
        <div className="mt-1.5">
          <ComponentFindings
            component={component}
            scale="chrome"
            onAskToFix={chatId ? () => fillChatComposer(chatId, fixRequest(component, canonicalReference)) : undefined}
          />
        </div>
      )}
      {adding && <AddToDashboardDialog component={component} addTile={addTile} onClose={() => setAdding(false)} />}
      {previewing && <ComponentPreviewDialog component={component} onClose={() => setPreviewing(false)} />}
    </div>
  )
}

/** A card for a reference with no component here: its name, and one sentence why (ux rule 9). */
function MissCard({ reference, label, agentName, children }: { reference: string; label: string | null; agentName?: string | null; children: React.ReactNode }): React.JSX.Element {
  const ref = parseComponentReference(reference)
  return (
    <div className={SHELL} data-component-card={reference} data-component-miss role="group" aria-label={`Component ${ref?.name ?? reference}`}>
      <div className={TITLE_ROW}>
        <LayoutDashboard size={14} className="shrink-0 text-[var(--color-text-muted)]" aria-hidden="true" />
        <span className="min-w-0 truncate font-mono text-xs text-[var(--color-text-secondary)]" title={reference}>{ref?.name ?? reference}</span>
        <span className="flex-1" />
        <CopyReferenceButton text={reference} />
      </div>
      <WhoLine
        label={label}
        agentName={agentName ?? null}
        skill={ref?.skill ?? null}
        fallback={ref ? (ref.agent.kind === 'slug' ? ref.agent.value : `${ref.agent.kind}:${ref.agent.value}`) : null}
      />
      <div className={LINE_ROW}>{children}</div>
    </div>
  )
}

const MISS_SENTENCE: Record<Exclude<ComponentReferenceMiss, 'bundle_not_installed'>, (agent: string) => string> = {
  agent_not_here: () => 'Its agent is not on this machine.',
  ambiguous: () => 'Two agents match this reference.',
  // Said of a reference, not a history: the component may never have existed.
  gone: (agent) => `Not in ${agent}.`,
  not_in_this_copy: (agent) => `Not in your copy of ${agent}.`,
  not_kit_agent: (agent) => `Components need a kit agent, and ${agent} is a plain folder.`
}

function MissedReference({
  reference,
  label,
  resolution
}: {
  reference: string
  label: string | null
  resolution: Extract<ComponentReferenceResolution, { found: false }>
}): React.JSX.Element {
  const { reason, agentName, agentId, bundleId } = resolution
  if (reason === 'bundle_not_installed') return <BundleMiss reference={reference} label={label} bundleId={bundleId} />
  const agent = agentName ?? 'its agent'
  return (
    <MissCard reference={reference} label={label} agentName={agentName}>
      <span className="truncate text-[var(--color-text-secondary)]" data-miss-reason={reason}>{MISS_SENTENCE[reason](agent)}</span>
      {reason === 'not_in_this_copy' && agentId && (
        <button type="button" className={`shrink-0 ${COMPONENT_LINK}`} onClick={() => openAgentTab(agentId, 'sharing')}>
          Open Sharing
        </button>
      )}
      {reason === 'gone' && agentId && (
        <button type="button" className={`shrink-0 ${COMPONENT_LINK}`} onClick={() => openAgentTab(agentId, 'dashboards')}>
          Open agent
        </button>
      )}
    </MissCard>
  )
}

/** A bundle no agent here records: named from the catalog when this profile can see it. */
function BundleMiss({ reference, label, bundleId }: { reference: string; label: string | null; bundleId: string | null }): React.JSX.Element {
  const catalog = useCatalogItems()
  const item = bundleId ? catalog.data?.items.find((candidate) => candidate.kind === 'agent' && candidate.id === bundleId) : undefined
  const name = item ? item.display_name || item.name : null
  const openInCatalog = (): void => {
    if (!item) return
    const ui = useUIStore.getState()
    ui.setCatalogItemRequest(item.uuid)
    ui.setSettingsMenu('profile-catalog')
    ui.setActiveView('settings')
  }
  return (
    <MissCard reference={reference} label={label} agentName={name}>
      <span className="truncate text-[var(--color-text-secondary)]" data-miss-reason="bundle_not_installed">
        {name ? `${name} is not installed.` : 'It belongs to an agent that is not installed.'}
      </span>
      {item && (
        <button type="button" className={`shrink-0 ${COMPONENT_LINK}`} onClick={openInCatalog}>
          Open in catalog
        </button>
      )}
    </MissCard>
  )
}

/** The card's box and three lines with nothing in them yet, so its arrival moves nothing (ux rule 1). */
export function ComponentCardSkeleton(): React.JSX.Element {
  const bar = 'inline-block rounded bg-[var(--color-bg-hover)]'
  return (
    <div className={`${SHELL} animate-pulse motion-reduce:animate-none`} aria-busy="true" aria-label="Reading the component" data-component-card-skeleton>
      <div className={TITLE_ROW}>
        <span className={`${bar} h-3.5 w-3.5 shrink-0`} />
        <span className={`${bar} h-3 w-40 max-w-full`} />
      </div>
      <div className={LINE_ROW}><span className={`${bar} h-2 w-28`} /></div>
      <div className={LINE_ROW}><span className={`${bar} h-2 w-36`} /></div>
    </div>
  )
}
