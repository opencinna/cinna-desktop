import type { AgentEngine, EngineLoginId } from './engine'

/**
 * A vendor desktop app found on this Mac — Claude Desktop, ChatGPT — whose
 * subscription the matching CLI engine can use. Only the id, the name shown
 * and the engine cross IPC; the bundle path stays in main.
 */
export type DesktopAppId = 'claude-desktop' | 'chatgpt'

export interface DetectedDesktopApp {
  id: DesktopAppId
  label: string
  engine: EngineLoginId
}

export function isDesktopAppId(value: unknown): value is DesktopAppId {
  return value === 'claude-desktop' || value === 'chatgpt'
}

/**
 * Where a running connect is: the pinned CLI downloading, its login being
 * asked, or the vendor's sign-in waiting in the browser.
 */
export type DesktopAppConnectPhase = 'installing' | 'checking' | 'signing-in'

export interface DesktopAppConnectRunning {
  appId: DesktopAppId
  phase: DesktopAppConnectPhase
}

/** How one connect ended. Returned as data — a thrown error's code does not survive IPC. */
export interface DesktopAppConnectResult {
  outcome: 'enabled' | 'cancelled' | 'failed'
  reason?: string
}

/** What the busy button reads, by phase. */
export const DESKTOP_APP_PHASE_LABEL: Record<DesktopAppConnectPhase, string> = {
  installing: 'Installing…',
  checking: 'Checking…',
  'signing-in': 'Sign in in your browser…'
}

/** The short name a button says ("Use Claude" / "Use ChatGPT"). */
export const DESKTOP_APP_BUTTON_LABEL: Record<DesktopAppId, string> = {
  'claude-desktop': 'Use Claude',
  chatgpt: 'Use ChatGPT'
}

/**
 * Which detected apps the banner offers: not dismissed, and not already what
 * chats and agents run on — the same two facts `adoptDesktopEngine` changes.
 *
 * The Default runtime alone is not enough: a machine whose `claude` locked it
 * to Claude, onboarded with an API key, has a default chat mode naming
 * `opencode`, so its chats spend the key and pressing "Use Claude" still
 * changes something. `defaultModeEngine` is that mode's engine, `null` when
 * there is no default mode or it names none (both inherit the Default runtime).
 * An unknown Default runtime (`undefined`) hides nothing on that ground.
 */
export function visibleDesktopApps(
  detected: readonly DetectedDesktopApp[],
  dismissed: readonly string[],
  defaultEngine: AgentEngine | undefined,
  defaultModeEngine: AgentEngine | null = null
): DetectedDesktopApp[] {
  const inUse = (engine: AgentEngine): boolean =>
    engine === defaultEngine && (defaultModeEngine === null || defaultModeEngine === engine)
  return detected.filter((app) => !dismissed.includes(app.id) && !inUse(app.engine))
}

/** Whose subscription each app stands for, in the one-app sentence. */
const DESKTOP_APP_SUBSCRIPTION: Record<DesktopAppId, string> = { 'claude-desktop': 'Claude', chatgpt: 'ChatGPT' }

/** The banner's one sentence, for one app or two. */
export function desktopAppsBannerText(apps: readonly DetectedDesktopApp[]): string {
  if (apps.length === 1) {
    const app = apps[0]
    return `${app.label} is installed — use your ${DESKTOP_APP_SUBSCRIPTION[app.id]} subscription as Cinna's default for chats and agents.`
  }
  const names = apps.map((app) => app.label)
  const list = names.length === 2 ? `${names[0]} and ${names[1]}` : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  return `${list} are installed — use either subscription as Cinna's default for chats and agents.`
}
