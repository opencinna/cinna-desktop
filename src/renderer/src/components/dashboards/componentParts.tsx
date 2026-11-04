import type { ComponentFinding, ComponentInfo, ComponentPlacement } from '../../../../shared/dashboards'
import { useUIStore, type AgentPageTab } from '../../stores/ui.store'
import { useCapabilities } from '../../hooks/useCapabilities'

/**
 * The pieces a component is drawn with wherever it is listed — the agent's
 * Dashboards tab, a chat's component card, a tile (ux rule 13: one object,
 * one look). Each takes the type scale of the surface it renders into
 * (`settings` 14/13/12, `chrome` the denser chat and dashboard scale).
 */
export type ComponentScale = 'settings' | 'chrome'

export const VIEW_LABELS: Record<string, string> = { markdown: 'Markdown', table: 'Table', list: 'List', metrics: 'Metrics', html: 'Page' }

const LINE: Record<ComponentScale, string> = { settings: 'text-[12px]', chrome: 'text-[11px]' }
export const COMPONENT_LINK = 'font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] transition-colors'

export function openDashboard(dashboardId: string): void {
  const ui = useUIStore.getState()
  ui.setActiveDashboardId(dashboardId)
  ui.setSidebarTab('dashboards')
  ui.setActiveView('dashboard')
}

/** The agent's page, on one of its Settings tabs. */
export function openAgentTab(agentId: string, tab: AgentPageTab): void {
  const ui = useUIStore.getState()
  ui.setActiveLocalAgentId(agentId)
  ui.setAgentPageMode('settings')
  ui.setAgentPageTabRequest(tab)
  ui.setSidebarTab('agents')
  ui.setActiveView('local-agent')
}

/** "On Sales overview, Ops" with each dashboard a link, or "Not on a dashboard yet." */
export function PlacementsLine({ placements, scale }: { placements: ComponentPlacement[]; scale: ComponentScale }): React.JSX.Element {
  // With Dashboards off there is no dashboard view to open: the names stay, as text.
  const dashboardsOn = useCapabilities().dashboardsEnabled
  return (
    <p className={`m-0 min-w-0 ${LINE[scale]} truncate text-[var(--color-text-secondary)]`}>
      {placements.length === 0 ? (
        'Not on a dashboard yet.'
      ) : (
        <>
          On{' '}
          {placements.map((p, index) => (
            <span key={p.tileId}>
              {index > 0 && ', '}
              {dashboardsOn ? (
                <button type="button" className={COMPONENT_LINK} onClick={() => openDashboard(p.dashboardId)} title={`Open ${p.dashboardName}`}>
                  {p.dashboardName}
                </button>
              ) : (
                p.dashboardName
              )}
            </span>
          ))}
        </>
      )}
    </p>
  )
}

/** The placements that show this component (a component is named by agent, skill and name). */
export function placementsOf(component: ComponentInfo, placements: ComponentPlacement[]): ComponentPlacement[] {
  return placements.filter((p) => p.component === component.name && (p.skill ?? null) === (component.skill ?? null))
}

/** "Needs the gmail credential. Attach it" — nothing runs until it is attached. */
export function MissingCredentials({ component, scale }: { component: ComponentInfo; scale: ComponentScale }): React.JSX.Element {
  const names = component.missingCredentials
  return (
    <p className={`m-0 ${LINE[scale]} text-[var(--color-text-secondary)]`} data-missing-credentials>
      Needs the{' '}
      {names.map((name, index) => (
        <span key={name}>
          {index > 0 && (index === names.length - 1 ? ' and ' : ', ')}
          <code className="font-mono">{name}</code>
        </span>
      ))}{' '}
      credential{names.length === 1 ? '' : 's'}.{' '}
      <button type="button" className={COMPONENT_LINK} onClick={() => openAgentTab(component.agentId, 'credentials')}>
        Open Credentials
      </button>
    </p>
  )
}

/** A finding's message, with its `backticked` spans as code (core writes field names and paths that way). */
export function FindingText({ text }: { text: string }): React.JSX.Element {
  const parts = text.split('`')
  // An odd count of backticks leaves the text as it is.
  if (parts.length % 2 === 0) return <>{text}</>
  return <>{parts.map((part, index) => (index % 2 === 1 ? <code key={index} className="font-mono">{part}</code> : part))}</>
}

export function errorFindings(component: ComponentInfo): ComponentFinding[] {
  return component.findings.filter((finding) => finding.severity === 'error')
}

/** The text Ask to fix puts in the composer: what is wrong, and where. Never sent by itself. */
export function fixRequest(component: ComponentInfo, reference: string): string {
  const lines = errorFindings(component).map((f) => `- ${f.path}${f.field ? ` (${f.field})` : ''}: ${f.message}`)
  return `Please fix the dashboard component ${component.title} so it passes the check:\n${reference}\n\n${lines.join('\n')}`
}

/**
 * Errors first, in the danger colour, then warnings, quietly. With
 * `onAskToFix`, errors end in **Ask to fix**.
 */
export function ComponentFindings({
  component,
  scale,
  onAskToFix
}: {
  component: ComponentInfo
  scale: ComponentScale
  onAskToFix?: () => void
}): React.JSX.Element | null {
  const errors = errorFindings(component)
  const warnings = component.findings.filter((finding) => finding.severity === 'warning')
  if (errors.length === 0 && warnings.length === 0) return null
  const item = (finding: ComponentFinding, index: number): React.JSX.Element => (
    <li key={`${finding.path}:${finding.code}:${finding.field ?? ''}:${index}`} className="m-0 break-words" title={finding.path}>
      <FindingText text={finding.message} />
    </li>
  )
  return (
    <div className="space-y-1">
      {errors.length > 0 && (
        <ul className={`m-0 list-none space-y-0.5 p-0 ${LINE[scale]} text-[var(--color-danger)]`} aria-label={`Problems with ${component.title}`}>
          {errors.map(item)}
        </ul>
      )}
      {warnings.length > 0 && (
        <ul className={`m-0 list-none space-y-0.5 p-0 ${LINE[scale]} text-[var(--color-text-muted)]`} aria-label={`Warnings for ${component.title}`}>
          {warnings.map(item)}
        </ul>
      )}
      {errors.length > 0 && onAskToFix && (
        <button type="button" className={`${LINE[scale]} ${COMPONENT_LINK}`} onClick={onAskToFix}>
          Ask to fix
        </button>
      )}
    </div>
  )
}
