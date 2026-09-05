/**
 * Developer tools the desktop can hand a local agent folder to, plus the
 * actions it can ask for. Shared so the preload bridge and the renderer see
 * the same shapes the main-process detection service produces.
 */

/** Stable identifier of a detectable tool. Also the value the renderer sends back. */
export type LocalToolId =
  | 'claude'
  | 'codex'
  | 'opencode'
  | 'code'
  | 'cursor'
  | 'uv'
  | 'git'
  | 'make'
  | 'python3'
  | 'cinna'

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
