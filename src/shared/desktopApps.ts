import { isEngineLoginId, type AgentEngine, type EngineLoginId } from './engine'

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

/** Which detected apps the banner offers: those the user has not waved away. */
export function visibleDesktopApps(
  detected: readonly DetectedDesktopApp[],
  dismissed: readonly string[]
): DetectedDesktopApp[] {
  return detected.filter((app) => !dismissed.includes(app.id))
}

/** One CLI engine as the banner judges it: its login probe, and whether its binary is here. */
export interface CliRuntimeSetup {
  auth: 'logged_in' | 'logged_out' | 'unknown'
  /** A binary is on this machine: the one the turns run (`ready`), or the user's own on PATH. */
  installed: boolean
}

/** What {@link hasWorkingRuntime} decides from. */
export interface RuntimeSetup {
  defaultEngine: AgentEngine
  /** Some AI credential is enabled and usable — what OpenCode runs on. */
  hasActiveCredential: boolean
  cli: Record<EngineLoginId, CliRuntimeSetup>
}

/**
 * Whether this machine already has something chats and agents can run on —
 * in which case the banner has nothing to fix and says nothing.
 *
 * The offer is for a Mac with **no** working runtime. It is not a nudge to
 * move a working setup onto a subscription: which engine or key a user's
 * chats spend is their choice, and a banner that keeps questioning it is
 * noise. So any one of these is enough:
 *
 * - the Default runtime is OpenCode and a credential it can run on exists;
 * - `claude` or `codex` is signed in — Default runtime or not;
 * - `claude` or `codex` is installed and its probe could not tell. Uncertain
 *   is not a reason to nag. A probe with **no binary** also answers
 *   `unknown` (there is nothing to ask), and that one is not working — it is
 *   the Mac the offer exists for.
 */
export function hasWorkingRuntime(setup: RuntimeSetup): boolean {
  if (settledByCredential(setup.defaultEngine, setup.hasActiveCredential)) return true
  return (Object.values(setup.cli) as CliRuntimeSetup[]).some(
    (cli) => cli.auth === 'logged_in' || (cli.auth === 'unknown' && cli.installed)
  )
}

/**
 * The Default runtime runs on an AI credential (not on a CLI login) and one is
 * enabled — working, without asking any CLI. The login engines are exactly the
 * ones that do not run on a credential.
 */
export function settledByCredential(defaultEngine: AgentEngine, hasActiveCredential: boolean): boolean {
  return hasActiveCredential && !isEngineLoginId(defaultEngine)
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
