/**
 * Commands the user runs from an agent's message (Run, Run in background,
 * Edit and Run…), in the agent's folder. DTOs shared by main, preload and
 * renderer. A run is a session activity item of kind `command`; this module
 * carries only what the activity model does not.
 *
 * Refusals cross IPC as data, never as a thrown error code.
 */

export interface UserCommandRunInput {
  chatId: string
  /** The persisted message the command was found in; its agent is the run's agent. */
  messageId: string
  command: string
  /**
   * The user saw the command in the edit dialog and chose to run it: main
   * runs what it was given. False (Run, Run in background from the menu):
   * main checks the own-command rule first and answers `needs_review`.
   */
  reviewed: boolean
}

export type UserCommandRunFailure = 'needs_review' | 'not_local' | 'folder_missing' | 'chat_not_found' | 'spawn_failed'

export type UserCommandRunResult =
  | { ok: true; itemId: string; folder: string }
  | {
      ok: false
      code: UserCommandRunFailure
      reason: string
      /** The agent's folder, when main resolved it: the edit dialog shows it. */
      folder?: string
    }

/**
 * The sentence the renderer shows for each refusal (a spawn error says its
 * own). Main's `needs_review` carries the own-command rule's reason instead;
 * this one is for a command the menu itself sent to review.
 */
export const USER_COMMAND_RUN_REASONS: Record<UserCommandRunFailure, string> = {
  needs_review: 'This command can change or delete files, so it runs after you check it.',
  not_local: 'Commands run only for agents on this computer.',
  folder_missing: 'The agent\'s folder is no longer on this computer.',
  chat_not_found: 'This chat is no longer available.',
  spawn_failed: 'The command could not be started.'
}

/**
 * The agent's folder as the edit dialog and the rows show it: `~/…` under the
 * home folder, else as given. Main and renderer both use it, so the dialog's
 * "Runs in" reads the same whether the menu or main named the folder. Either
 * separator (macOS / Windows); an already shortened path is left alone.
 */
export function homeDisplayPath(path: string, home: string | null | undefined): string {
  if (!home) return path
  const bare = home.replace(/[\\/]+$/, '')
  if (bare === '') return path
  if (path === bare) return '~'
  for (const sep of ['/', '\\']) if (path.startsWith(bare + sep)) return '~' + path.slice(bare.length)
  return path
}

/** Why an output could not be read, attached or removed. */
export type UserCommandOutputFailure = 'not_found' | 'running' | 'chat_not_found' | 'unreadable'

export const USER_COMMAND_OUTPUT_REASONS: Record<UserCommandOutputFailure, string> = {
  not_found: 'This run\'s output is no longer available.',
  running: 'The command is still running.',
  chat_not_found: 'This chat is no longer available.',
  unreadable: 'The output could not be read.'
}

/** `userCommands:outputFile`: the formatted output written to a file the composer attaches. */
export type UserCommandOutputFileResult =
  | { ok: true; path: string; filename: string }
  | { ok: false; code: UserCommandOutputFailure; reason: string }

/** `userCommands:outputText`: the same formatted output, as text. */
export type UserCommandOutputTextResult =
  | { ok: true; text: string; filename: string }
  | { ok: false; code: UserCommandOutputFailure; reason: string }

export type UserCommandDismissResult =
  | { ok: true }
  | { ok: false; code: UserCommandOutputFailure; reason: string }

export function userCommandOutputRefusal<T extends { ok: false; code: UserCommandOutputFailure; reason: string }>(
  code: UserCommandOutputFailure
): T {
  return { ok: false, code, reason: USER_COMMAND_OUTPUT_REASONS[code] } as T
}

/** How a run ended, for the output panel's header. */
export interface UserCommandEnd {
  state: 'completed' | 'failed' | 'stopped' | 'lost'
  exitCode: number | null
  signal: string | null
}

/**
 * `userCommands:output(chatId, itemId)` frames, over a MessagePort: one
 * `start` (the command, folder and the log's tail, at most 2 MB), then live
 * `chunk`s, then one `end`. A run main does not know answers one `missing`.
 */
export type UserCommandOutputFrame =
  | { type: 'start'; command: string; folder: string; startedAt: number; backlog: string }
  | { type: 'chunk'; data: string }
  | { type: 'end'; end: UserCommandEnd; endedAt: number }
  | { type: 'missing' }

export function isUserCommandOutputFrame(value: unknown): value is UserCommandOutputFrame {
  const type = (value as { type?: unknown } | null)?.type
  return type === 'start' || type === 'chunk' || type === 'end' || type === 'missing'
}

/** The SGR / CSI / OSC escapes a terminal draws and a text attachment must not carry. */
export function stripAnsi(text: string): string {
  return text
    // OSC: ESC ] … BEL or ESC \
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // CSI: ESC [ params intermediates final
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    // Two-character escapes (ESC c, ESC =, …)
    .replace(/\x1b[@-Z\\-_]/g, '')
    // A carriage return that redraws a line keeps only what was drawn last.
    .split('\n').map((line) => {
      const parts = line.split('\r')
      return parts.length > 1 ? parts.filter((part) => part !== '').pop() ?? '' : line
    }).join('\n')
}
