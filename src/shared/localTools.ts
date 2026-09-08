/**
 * Developer tools the desktop can hand a local agent folder to, plus the
 * actions it can ask for. Shared so the preload bridge and the renderer see
 * the same shapes the main-process detection service produces.
 */

/**
 * Every detectable tool, as a runtime list so a setting can be validated
 * against it (`localAgentsDefaultTool`). {@link LocalToolId} is derived from
 * it rather than the other way round so the two cannot drift.
 */
export const LOCAL_TOOL_IDS = [
  'claude',
  'codex',
  'opencode',
  'code',
  'cursor',
  'uv',
  'git',
  'make',
  'python3',
  'cinna'
] as const

/** Stable identifier of a detectable tool. Also the value the renderer sends back. */
export type LocalToolId = (typeof LOCAL_TOOL_IDS)[number]

export function isLocalToolId(value: unknown): value is LocalToolId {
  return typeof value === 'string' && (LOCAL_TOOL_IDS as readonly string[]).includes(value)
}

/**
 * How a tool is offered:
 *  - `cli-assistant` — a coding assistant launched in a terminal at the folder
 *  - `editor` — opens the folder as a project
 *  - `runtime` — not launchable, but its presence gates features (uv, git, make)
 */
export type LocalToolKind = 'cli-assistant' | 'editor' | 'runtime'

/**
 * Where the executable was found.
 *
 * `managed` is the desktop's own copy under `userData` — today only cinna-cli,
 * installed by `src/main/localdev/toolchain.ts`. It ranks *below* `path` here
 * on purpose: this list answers "what can the user open a folder with", and a
 * `cinna` the user installed themselves is the one their terminal will run.
 * Desktop-spawned processes take the opposite view and always use the managed
 * copy, because that is the one whose version the app pins.
 */
export type LocalToolSource = 'path' | 'app-bundle' | 'managed'

/**
 * The kinds a folder can be *opened with*, and so the only kinds that may be
 * the user's default tool. A `runtime` tool is detected for feature gating
 * and never launched.
 */
export const LAUNCHABLE_TOOL_KINDS: readonly LocalToolKind[] = ['cli-assistant', 'editor']

/** The open-in action a launchable tool is used with. */
export function actionForTool(tool: Pick<DetectedTool, 'kind'>): OpenInAction {
  return tool.kind === 'editor' ? 'editor' : 'terminal-command'
}

export interface DetectedTool {
  id: LocalToolId
  kind: LocalToolKind
  /** Human label for the UI ("Claude Code", "VS Code"). */
  label: string
  /** Absolute path to the executable, or to the macOS `.app` bundle. */
  path: string | null
  available: boolean
  /**
   * `app-bundle` means there is no CLI shim — launch through the bundle.
   * `managed` means Cinna installed it into its own data directory.
   */
  source: LocalToolSource | null
  /**
   * What `<bin> --version` said, trimmed to the version itself, or null.
   *
   * Null has three meanings the UI must not conflate with each other: the tool
   * is not installed, it was found as a macOS app bundle (there is no CLI to
   * ask), or it is installed and the probe failed or timed out. `available`
   * and `source` are what separate them.
   */
  version: string | null
}

/** What the renderer wants done with a folder. */
export type OpenInAction =
  /** Run a CLI assistant in a system terminal, cwd = folder. */
  | 'terminal-command'
  /** Open the folder as a project in an editor. */
  | 'editor'
  /** Reveal the folder in Finder / Explorer / the desktop file manager. */
  | 'reveal'
  /** Open a system terminal at the folder, running nothing. */
  | 'terminal'

export interface OpenInRequest {
  /** Absolute path to the agent folder. Validated against the agents roots in main. */
  folder: string
  /** Required for `terminal-command` and `editor`; ignored otherwise. */
  toolId?: LocalToolId
  action: OpenInAction
}
