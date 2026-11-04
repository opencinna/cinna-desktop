import type { ComponentFinding, ComponentInfo, ComponentPlacement, DashboardsErrorCode } from '../../../../shared/dashboards'
import { isFolderAgentId } from '../../../../shared/localAgents'
import { useUIStore, type AgentPageTab } from '../../stores/ui.store'
import { useAuthStore } from '../../stores/auth.store'
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

/**
 * The agent's page, on one of its Settings tabs. A cloud agent (D6) opens its
 * external page, which takes the tabs it has (Dashboards) and shows Overview
 * for the rest.
 */
export function openAgentTab(agentId: string, tab: AgentPageTab): void {
  const ui = useUIStore.getState()
  const folder = isFolderAgentId(agentId)
  if (folder) ui.setActiveLocalAgentId(agentId)
  else ui.setActiveExternalAgentId(agentId)
  ui.setAgentPageMode('settings')
  ui.setAgentPageTabRequest(tab)
  ui.setSidebarTab('agents')
  ui.setActiveView(folder ? 'local-agent' : 'external-agent')
}

/** Settings → the profile's Agents, where a Cinna session that needs a new sign-in is renewed. */
export function openCinnaSignIn(): void {
  const ui = useUIStore.getState()
  ui.setSettingsMenu('profile-agents')
  ui.setActiveView('settings')
}

/** The profile's Cinna server as the user knows it (its host), for "Can't reach <server>.". */
export function useCinnaServerName(): string {
  const url = useAuthStore((s) => s.currentUser?.cinnaServerUrl)
  try {
    return new URL(url ?? '').host || 'the Cinna server'
  } catch {
    return 'the Cinna server'
  }
}

/** "Sales Agent in the cloud": how a cloud component names its agent on a card or in a dialog (D6.8). */
export function agentPlace(component: Pick<ComponentInfo, 'agentName' | 'cloud'>): string {
  return component.cloud ? `${component.agentName} in the cloud` : component.agentName
}

/**
 * The sentence for a refusal about a cloud agent (D6.10), with its names
 * filled in; null where main's own message is the one to show (core's
 * sentence for `adapter_unsupported`, and every local refusal).
 */
export function cloudRefusalSentence(code: DashboardsErrorCode | null, names: { agent: string; server: string }): string | null {
  switch (code) {
    case 'unreachable':
      return `Can’t reach ${names.server}.`
    case 'reauth_required':
      return `Sign in to ${names.server} again.`
    case 'env_unavailable':
      return `${names.agent}’s environment isn’t running.`
    case 'not_owner':
      return `Only ${names.agent}’s owner can add its components to a dashboard.`
    case 'wrong_server':
      return 'That dashboard was made on another Cinna server.'
    case 'not_found':
      return `${names.agent} is no longer available.`
    default:
      return null
  }
}

/** The refusals Retry can mend by default: the server did not answer. */
const RETRY_ON_DEFAULT: readonly DashboardsErrorCode[] = ['unreachable']

/**
 * A Retry link whose label never changes, so the row it sits in never
 * changes width while it runs (ux rule 1): in flight it is disabled and dimmed.
 */
export function RetryLink({ onRetry, retrying = false, className = COMPONENT_LINK }: { onRetry: () => void; retrying?: boolean; className?: string }): React.JSX.Element {
  return (
    <button type="button" className={`${className} disabled:cursor-default disabled:opacity-50`} onClick={onRetry} disabled={retrying} aria-busy={retrying || undefined}>
      Retry
    </button>
  )
}

/**
 * A cloud refusal's sentence and the way out it has: Retry where trying again
 * can mend it (`retryOn`; by default only where the server did not answer),
 * Open settings where the session needs a new sign-in. The sentence is main's
 * when there is no sentence of our own.
 */
export function CloudRefusal({
  code,
  message,
  names,
  onRetry,
  retrying = false,
  retryOn = RETRY_ON_DEFAULT,
  className = 'text-[11px]',
  tone = 'danger'
}: {
  code: DashboardsErrorCode | null
  message: string
  names: { agent: string; server: string }
  onRetry?: () => void
  retrying?: boolean
  /** The codes that offer Retry (with `onRetry`). */
  retryOn?: readonly DashboardsErrorCode[]
  className?: string
  tone?: 'danger' | 'quiet'
}): React.JSX.Element {
  const sentence = cloudRefusalSentence(code, names) ?? message
  return (
    <p role="alert" data-refusal={code ?? undefined} className={`m-0 ${className} ${tone === 'danger' ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-secondary)]'}`}>
      {sentence}
      {code !== null && retryOn.includes(code) && onRetry && (
        <>
          {' '}
          <RetryLink onRetry={onRetry} retrying={retrying} />
        </>
      )}
      {code === 'reauth_required' && (
        <>
          {' '}
          <button type="button" className={COMPONENT_LINK} onClick={openCinnaSignIn}>
            Open settings
          </button>
        </>
      )}
    </p>
  )
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

/**
 * "Needs the gmail credential. Open Credentials" — nothing runs until it is
 * attached. A cloud agent's credentials are attached on its server, so its
 * line links to the agent's page instead (none on that page itself).
 */
export function MissingCredentials({ component, scale, link = true }: { component: ComponentInfo; scale: ComponentScale; link?: boolean }): React.JSX.Element {
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
      credential{names.length === 1 ? '' : 's'}.
      {component.cloud ? (
        link && (
          <>
            {' '}
            <button type="button" className={COMPONENT_LINK} onClick={() => openAgentTab(component.agentId, 'overview')}>
              Open agent
            </button>
          </>
        )
      ) : (
        <>
          {' '}
          <button type="button" className={COMPONENT_LINK} onClick={() => openAgentTab(component.agentId, 'credentials')}>
            Open Credentials
          </button>
        </>
      )}
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
