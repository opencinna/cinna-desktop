import type { AgentEngine } from './engine'
import type { WorkComplexity } from './modelFamilies'

/**
 * What a chat-mode session may use besides talking.
 *
 * - `none` — no tools at all;
 * - `connectors` — the agents and MCP servers attached to the chat;
 * - `workspace` — connectors plus the engine's own file and shell tools in the
 *   chat's folder. Accepted only for an engine in {@link WORKSPACE_POLICY_ENGINES}
 *   (or none, the Default runtime, while every engine is listed there).
 */
export type ChatToolPolicy = 'none' | 'connectors' | 'workspace'

export interface ChatModeRuntime {
  /** Null inherits this device's Default runtime. */
  engine?: AgentEngine | null
  /** The existing providerId is the runtime credential binding. */
  systemPrompt?: string
  toolPolicy?: ChatToolPolicy
  /**
   * The work tier the runtime resolves a model / effort from (shown as Effort:
   * Low / Medium / High). Null is "no preference". An explicit model wins.
   */
  complexity?: WorkComplexity | null
  /** Set only on a runtime mode: the engine it stands for. One per user and engine. */
  builtinEngine?: AgentEngine | null
}

/**
 * Engines whose `workspace` tool policy is implemented and verified. Until an
 * engine is listed here the service refuses `workspace` for it and the
 * settings offer the option disabled, with the reason.
 */
// Each verified by `<engine>.policy.workspace-*` in `make contract ENGINE=<engine>`.
export const WORKSPACE_POLICY_ENGINES: readonly AgentEngine[] = ['claude', 'codex', 'antigravity', 'opencode']

/**
 * No engine is the Default runtime: allowed, since every engine supports it.
 * The engine it resolves to is checked when a chat starts — `ensure` resolves
 * it, and `applyConductorToolPolicy` refuses an unverified one.
 */
export function supportsWorkspacePolicy(engine: AgentEngine | null | undefined): boolean {
  if (engine == null) return RUNTIME_MODE_ENGINES.every((each) => WORKSPACE_POLICY_ENGINES.includes(each))
  return WORKSPACE_POLICY_ENGINES.includes(engine)
}

/** The fixed order runtime modes are listed in, matching the Agents runtime cards. */
export const RUNTIME_MODE_ENGINES: readonly AgentEngine[] = ['claude', 'codex', 'antigravity', 'opencode']

/** The user-facing name of each runtime — also the Agents runtime cards' labels. */
export const RUNTIME_MODE_NAMES: Record<AgentEngine, string> = {
  claude: 'Claude Agent',
  codex: 'Codex',
  antigravity: 'Antigravity',
  opencode: 'OpenCode'
}

/** Whether a runtime mode may bind an AI credential: OpenCode runs on one, the CLIs on their own login. */
export const RUNTIME_MODE_TAKES_CREDENTIAL: Record<AgentEngine, boolean> = {
  claude: false,
  codex: false,
  antigravity: false,
  opencode: true
}

/**
 * The chat-mode colour that follows the theme instead of naming a colour: the
 * active accent, a server brand's when the profile has one. Default modes take
 * it; a non-default runtime mode keeps its engine's identity colour.
 */
export const THEME_COLOR_PRESET_ID = 'theme'

const RUNTIME_MODE_COLORS: Record<AgentEngine, string> = {
  claude: 'orange',
  codex: 'sky',
  antigravity: 'indigo',
  opencode: 'emerald'
}

export interface RuntimeModeDefaults {
  name: string
  toolPolicy: ChatToolPolicy
  complexity: WorkComplexity
  /** Empty: the conductor picks its default instructions from the tool policy. */
  systemPrompt: string
  colorPreset: string
}

/** What a runtime mode is created with, and what Reset to defaults restores. */
export function runtimeModeDefaults(engine: AgentEngine): RuntimeModeDefaults {
  return {
    name: RUNTIME_MODE_NAMES[engine],
    toolPolicy: supportsWorkspacePolicy(engine) ? 'workspace' : 'connectors',
    complexity: 'medium',
    systemPrompt: '',
    colorPreset: RUNTIME_MODE_COLORS[engine]
  }
}

/**
 * Everything Reset to defaults writes on a runtime mode (its star is kept):
 * shared by main's `chatModeService.reset` and the card, which shows the
 * result without waiting for the list and compares against it to know whether
 * there is anything to reset. Both the engine's colour and the theme's count as
 * a default one and are kept, so moving the star does not make a mode resettable;
 * any other colour goes to the one that mode would be given now.
 */
export function runtimeModeResetFields(
  engine: AgentEngine,
  current: { isDefault: boolean; colorPreset: string }
): RuntimeModeDefaults & {
  engine: AgentEngine; providerId: null; modelId: null; mcpProviderIds: string[]
} {
  const defaults = runtimeModeDefaults(engine)
  const colorPreset = current.colorPreset === THEME_COLOR_PRESET_ID || current.colorPreset === defaults.colorPreset
    ? current.colorPreset
    : current.isDefault ? THEME_COLOR_PRESET_ID : defaults.colorPreset
  return { ...defaults, colorPreset, engine, providerId: null, modelId: null, mcpProviderIds: [] }
}

/**
 * Whether a runtime can start a chat now, as far as main knows without asking
 * anything new: no CLI is spawned and nothing is downloaded to answer it.
 */
export type RuntimeModeAvailability =
  | 'ready'
  | 'needs_install'
  | 'installing'
  | 'needs_login'
  | 'needs_credential'
  | 'install_failed'

/** Offered in the composer: login is checked at chat start, as for any chat. */
export function isRuntimeModeActive(availability: RuntimeModeAvailability): boolean {
  return availability === 'ready' || availability === 'needs_login'
}

/** On a runtime-mode row of `chatmode:list` only. */
export interface ChatModeRuntimeStatus {
  engine: AgentEngine
  availability: RuntimeModeAvailability
}
