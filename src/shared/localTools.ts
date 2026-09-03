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

/**
 * How a tool is offered:
 *  - `cli-assistant` — a coding assistant launched in a terminal at the folder
 *  - `editor` — opens the folder as a project
 *  - `runtime` — not launchable, but its presence gates features (uv, git, make)
 */
export type LocalToolKind = 'cli-assistant' | 'editor' | 'runtime'

/** Where the executable was found. */
export type LocalToolSource = 'path' | 'app-bundle'

export interface DetectedTool {
  id: LocalToolId
  kind: LocalToolKind
  /** Human label for the UI ("Claude Code", "VS Code"). */
  label: string
  /** Absolute path to the executable, or to the macOS `.app` bundle. */
  path: string | null
  available: boolean
  /** `app-bundle` means there is no CLI shim — launch through the bundle. */
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
