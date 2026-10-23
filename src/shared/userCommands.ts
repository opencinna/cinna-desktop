/**
 * Commands the user runs from an agent's message (Run, Run in background,
 * Edit and Run…), in the agent's folder. DTOs shared by main, preload and
 * renderer. A run is a session activity item of kind `command`; this module
 * carries only what the activity model does not.
 *
 * Refusals cross IPC as data, never as a thrown error code.
 */

import { autoRunRefusal, type AutoRunRefusal } from './commandRun'
import type { ScriptSpec } from './scriptSpec'

export interface UserCommandRunInput {
  chatId: string
  /** The persisted message the command was found in; its agent is the run's agent. */
  messageId: string
  command: string
  /**
   * The user saw the command in the Run Script window and chose to run it: main
   * runs what it was given. False (Run, Run in background from the menu):
   * main checks the own-command rule first and answers `needs_review`.
   */
  reviewed: boolean
  /**
   * The Run Script window's terminal width, in columns: the child sees it as
   * `COLUMNS`, so a tool that wraps or draws a table fits the window. Clamped
   * by main ({@link commandColumns}); absent means the default width.
   */
  columns?: number
}

/** `COLUMNS` for a run: the window's width, clamped, or the default when it sent none. */
export const COMMAND_COLUMNS = { min: 40, max: 400, default: 120 } as const

export function commandColumns(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return COMMAND_COLUMNS.default
  return Math.min(COMMAND_COLUMNS.max, Math.max(COMMAND_COLUMNS.min, Math.floor(value)))
}

export type UserCommandRunFailure = 'needs_review' | 'not_local' | 'folder_missing' | 'chat_not_found' | 'spawn_failed'

export type UserCommandRunResult =
  | { ok: true; itemId: string; folder: string }
  | {
      ok: false
      code: UserCommandRunFailure
      reason: string
      /** The agent's folder, when main resolved it: the Run Script window shows it. */
      folder?: string
    }

/**
 * The sentence the renderer shows for each refusal (a spawn error says its
 * own). Main's `needs_review` carries the own-command rule's reason instead,
 * and the Run Script window says why it holds a command itself
 * ({@link commandReviewReason}); this one is the fallback.
 */
export const USER_COMMAND_RUN_REASONS: Record<UserCommandRunFailure, string> = {
  needs_review: 'This command can change or delete files, so it runs after you check it.',
  not_local: 'Commands run only for agents on this computer.',
  folder_missing: 'The agent\'s folder is no longer on this computer.',
  chat_not_found: 'This chat is no longer available.',
  spawn_failed: 'The command could not be started.'
}

/** The Run Script window's guard line, by why the command does not look safe to run as is. */
export const COMMAND_REVIEW_REASONS: Record<AutoRunRefusal, string> = {
  several_commands: 'Several commands — check each before you run them.',
  not_read_only: 'This command isn\'t known to be read-only — check it before you run it.'
}

/** The guard line for a command the window opens on, or null for one that looks safe to run as is. */
export function commandReviewReason(command: string): string | null {
  const why = autoRunRefusal(command)
  return why === null ? null : COMMAND_REVIEW_REASONS[why]
}

/**
 * The agent's folder as the Run Script window and the rows show it: `~/…` under the
 * home folder, else as given. Main and renderer both use it, so the window's
 * folder reads the same whether the menu or main named the folder. Either
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

/** `userCommands:inspect`: what the Run Script window asks before it opens on a command. */
export interface UserCommandInspectInput {
  chatId: string
  messageId: string
  command: string
}

/**
 * The script's parameters, read statically (never by running it). `spec` is
 * null for anything main will not or cannot read — no script in the command,
 * a script outside the agent's folder and its pinned skills, a credential
 * file, one over the size cap, one whose parameters do not parse — and the
 * window then shows no form. A refusal is the chat or agent being gone.
 */
export type UserCommandInspectResult =
  | { ok: true; spec: ScriptSpec | null; folder: string }
  | { ok: false; code: Exclude<UserCommandRunFailure, 'needs_review' | 'spawn_failed'>; reason: string }

/**
 * `userCommands:chooseArgPath`: a path picked in a native open dialog that
 * starts in the agent's folder — relative to the folder when inside it, else
 * absolute. `canceled` when the user closed the dialog.
 */
export type UserCommandChooseArgPathResult =
  | { ok: true; path: string }
  | { ok: true; canceled: true }
  | { ok: false; code: Exclude<UserCommandRunFailure, 'needs_review' | 'spawn_failed'>; reason: string }

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
