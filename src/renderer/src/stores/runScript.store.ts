import { create } from 'zustand'
import { COMMAND_COLUMNS, commandReviewReason } from '../../../shared/userCommands'
import { commandScript } from '../../../shared/scriptArgs'
import type { ScriptSpec } from '../../../shared/scriptSpec'
import { unwrapIpcError } from '../utils/ipcError'
import type { CardOrigin } from '../utils/cardMotion'

/** The Run Script card's width cap in px (`max-w-5xl`). */
export const RUN_SCRIPT_CARD_MAX_WIDTH = 1024
/** A monospace cell of the window's 12px terminal, in px. */
const CELL_WIDTH = 7.25

/**
 * The columns a run started from the message menu gets, before the window
 * that will show it has measured its terminal: the card's width less its
 * border and padding, in cells.
 */
export function estimateRunColumns(viewportWidth = window.innerWidth): number {
  const card = Math.min(RUN_SCRIPT_CARD_MAX_WIDTH, Math.max(0, viewportWidth - 32))
  const cols = Math.floor((card - 2 - 24) / CELL_WIDTH)
  return Math.min(COMMAND_COLUMNS.max, Math.max(COMMAND_COLUMNS.min, cols))
}

/** Where a command was found, so main can resolve its agent and folder. */
export interface RunScriptSource {
  chatId: string
  /**
   * The persisted message the command is in; main takes the run's agent from
   * it. Null when the window was opened on a run this renderer did not start
   * (after a reload): the window then names any reply of the run's agent.
   */
  messageId: string | null
  /** The message's agent, for the ⋯ menu's file actions; null when unknown. */
  agentId: string | null
  /**
   * Opened from the file preview with no message: main resolves the agent as
   * the chat's own, by `agentId` (which it accepts only when it is the chat's
   * agent). Absent for a command from a message.
   */
  viaChatAgent?: boolean
  /** The agent's folder as the renderer knows it (raw), or main's `~/…` form; null until named. */
  folder: string | null
}

/**
 * What main resolves the agent by: the message, else the chat's agent for a
 * window opened from a file, else `fallbackMessageId` (a reply of the run's
 * agent); null when there is none.
 */
export function sourceInput(
  source: Pick<RunScriptSource, 'chatId' | 'messageId' | 'agentId' | 'viaChatAgent'>,
  fallbackMessageId: string | null = null
): { chatId: string; messageId: string } | { chatId: string; agentId: string } | null {
  if (source.messageId) return { chatId: source.chatId, messageId: source.messageId }
  if (source.viaChatAgent && source.agentId) return { chatId: source.chatId, agentId: source.agentId }
  return fallbackMessageId ? { chatId: source.chatId, messageId: fallbackMessageId } : null
}

export interface RunScriptWindow extends RunScriptSource {
  /** New on every open (never reused, even after a close), so the window starts fresh. */
  seq: number
  /** The command the window opened with; the command line starts from it. */
  command: string
  /**
   * The guard's sentence when the command does not look safe to run as is,
   * fixed at open; null for one that does.
   */
  reason: string | null
  /** The click that opened it, for the entrance; null after a keyboard open. */
  origin: CardOrigin | null
  /** Runs this window started or was opened on, oldest first; the last one is shown. */
  runs: string[]
  /**
   * The script's parameters, read by main as the window opened; null for no
   * form. Fixed for the window's life: the form is there from the open or
   * never (a late answer is dropped).
   */
  spec: ScriptSpec | null
}

/**
 * How long an open waits for main to read the script's parameters before it
 * shows the window without them. A cached answer comes well inside it.
 */
export const INSPECT_WAIT_MS = 150

/**
 * The script's spec for a window about to open, or null: no message to
 * resolve the agent by, no script in the command, a refusal, an error, or no
 * answer within {@link INSPECT_WAIT_MS} of `answer` being asked for.
 */
function specWithin(answer: Promise<ScriptSpec | null> | null): Promise<ScriptSpec | null> {
  if (answer === null) return Promise.resolve(null)
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), INSPECT_WAIT_MS) })
  return Promise.race([answer, late]).finally(() => clearTimeout(timer))
}

/** Ask main for the script's spec, when the command names a script and its source is known; null when there is nothing to ask. */
function askSpec(
  source: Pick<RunScriptSource, 'chatId' | 'messageId' | 'agentId' | 'viaChatAgent'>, command: string
): Promise<ScriptSpec | null> | null {
  const input = sourceInput(source)
  if (!input || commandScript(command) === null) return null
  try {
    return window.api.userCommands.inspect({ ...input, command })
      .then((result) => (result.ok ? result.spec : null))
      .catch(() => null)
  } catch {
    return null
  }
}

interface RunScriptState {
  window: RunScriptWindow | null
  /** Which start is in flight; the window cannot be closed meanwhile. */
  pending: 'run' | 'background' | null
  /** Why the last start did not happen; a line above the command line. */
  error: string | null
  /** How the last close went: a collapse shrinks into the Commands badge, a close fades. */
  exit: 'close' | 'collapse'
  /** Runs started here → the message they came from, so a reopened run can run again. */
  runSources: Record<string, RunScriptSource>
  /**
   * A click (or Enter) on a command in a reply: the window, nothing running.
   * For a script, the window shows once main has read its parameters, or
   * after {@link INSPECT_WAIT_MS} without them; resolves when it is shown (or
   * a later open took its place).
   */
  openFromCode: (request: RunScriptSource & { command: string; origin: CardOrigin | null }) => Promise<void>
  /** The badge's Open output: the window on that run (its parameters read as {@link openFromCode} does). */
  openForRun: (
    chatId: string,
    run: { id: string; title: string; agentId: string | null; detail: string | null },
    origin?: CardOrigin | null
  ) => Promise<void>
  /**
   * The menu's Run: start unreviewed, then open the window on the run (or
   * close nothing, for Run in background). A command main sends to review
   * opens the window with main's reason. Answers the reason for any other
   * refusal, which the menu shows itself; null when it is handled.
   */
  runFromMenu: (
    request: RunScriptSource & { command: string; origin: CardOrigin | null; columns: number },
    background: boolean
  ) => Promise<string | null>
  /** Run the window's command as reviewed; the window stays on the new run, or closes for a background start. */
  start: (command: string, background: boolean, columns: number, messageId?: string | null) => Promise<void>
  /** Ignored while a start is in flight. Never stops a run. */
  close: (how?: 'close' | 'collapse') => void
  /**
   * Close even while a start is in flight (the profile changed): the start's
   * answer then finds another window, or none, and opens nothing. Never stops a run.
   */
  dismiss: () => void
  /** A run was removed from the badge: forget it, and close a window showing it. */
  runRemoved: (chatId: string, itemId: string) => void
}

/**
 * A window's `seq`: monotonic for the app's life, so an open during the
 * previous window's exit never reuses its card.
 */
let lastSeq = 0
const nextSeq = (): number => ++lastSeq

/**
 * The latest open asked for. An open that waits for the script's parameters
 * shows its window only if no later open, close or dismiss came meanwhile.
 */
let lastOpen = 0

/**
 * The Run Script window: which command it shows, the runs started from it,
 * and its starts. A start lives here, not in the window, so its answer lands
 * even if the window unmounted (a TanStack mutate-level callback would be
 * dropped with it).
 */
export const useRunScriptStore = create<RunScriptState>((set, get) => ({
  window: null,
  pending: null,
  error: null,
  exit: 'close',
  runSources: {},

  openFromCode: async ({ command, origin, ...source }) => {
    if (get().pending) return
    const ticket = ++lastOpen
    const asked = askSpec(source, command)
    // Nothing to ask: the window opens at once, in this task.
    const spec = asked === null ? null : await specWithin(asked)
    set((state) => state.pending || ticket !== lastOpen ? state : {
      window: {
        ...source, command, origin, runs: [], seq: nextSeq(), spec,
        reason: commandReviewReason(command)
      },
      error: null
    })
  },

  openForRun: async (chatId, run, origin = null) => {
    if (get().pending) return
    const ticket = ++lastOpen
    const known = get().runSources[run.id]
    const asked = askSpec({ chatId, messageId: known?.messageId ?? null, agentId: known?.agentId ?? null, viaChatAgent: known?.viaChatAgent }, run.title)
    const spec = asked === null ? null : await specWithin(asked)
    set((state) => {
      if (state.pending || ticket !== lastOpen) return state
      const source = state.runSources[run.id] ?? known
      return {
        window: {
          chatId,
          messageId: source?.messageId ?? null,
          agentId: source?.agentId ?? run.agentId,
          ...(source?.viaChatAgent ? { viaChatAgent: true } : {}),
          folder: source?.folder ?? run.detail,
          command: run.title,
          reason: null,
          origin,
          runs: [run.id],
          seq: nextSeq(),
          spec
        },
        error: null
      }
    })
  },

  runFromMenu: async ({ command, origin, columns, ...source }, background) => {
    if (get().pending) return null
    // The window shown when Run was chosen: the answer opens a window only if
    // that one (or none) is still up, never over one opened meanwhile.
    const seqAtCall = get().window?.seq ?? null
    const ticket = ++lastOpen
    const mayOpen = (): boolean => {
      const { window: shown, pending } = get()
      return !pending && ticket === lastOpen && (shown === null || shown.seq === seqAtCall)
    }
    // Asked alongside the run, so the window rarely waits for it.
    const asked = background ? null : askSpec(source, command)
    const result = await window.api.userCommands.run({
      chatId: source.chatId, messageId: source.messageId ?? '', command, reviewed: false, columns
    })
    if (result.ok) {
      const known = { ...source, folder: result.folder }
      set((state) => ({ runSources: { ...state.runSources, [result.itemId]: known } }))
      // Not opened: the run still shows in the Commands badge.
      if (!background && mayOpen()) {
        const spec = await specWithin(asked)
        if (mayOpen()) {
          set({ window: { ...known, command, origin, reason: null, runs: [result.itemId], seq: nextSeq(), spec }, error: null })
        }
      }
      return null
    }
    if (result.code === 'needs_review') {
      // Nothing ran: with another window up, the menu says why instead.
      if (!mayOpen()) return result.reason
      const spec = await specWithin(asked)
      if (!mayOpen()) return result.reason
      set({
        window: {
          ...source, folder: result.folder ?? source.folder, command, origin, reason: result.reason, runs: [], seq: nextSeq(), spec
        },
        error: null
      })
      return null
    }
    return result.reason
  },

  start: async (command, background, columns, fallbackMessageId = null) => {
    const shown = get().window
    if (!shown || get().pending) return
    if (command.trim() === '') {
      set({ error: 'Type a command to run.' })
      return
    }
    const input = sourceInput(shown, fallbackMessageId)
    if (!input) {
      set({ error: 'The message this command came from is no longer in the chat.' })
      return
    }
    const messageId = 'messageId' in input ? input.messageId : null
    set({ pending: background ? 'background' : 'run', error: null })
    try {
      const result = await window.api.userCommands.run({ ...input, command, reviewed: true, columns })
      const still = get().window?.seq === shown.seq
      if (!result.ok) {
        set(still ? { pending: null, error: result.reason } : { pending: null })
        return
      }
      const source: RunScriptSource = {
        chatId: shown.chatId, messageId, agentId: shown.agentId, folder: result.folder,
        ...(messageId === null ? { viaChatAgent: true } : {})
      }
      set((state) => ({ pending: null, runSources: { ...state.runSources, [result.itemId]: source } }))
      if (!still) return
      if (background) {
        set({ window: null, error: null, exit: 'close' })
      } else {
        set((state) => state.window
          ? { window: { ...state.window, ...source, runs: [...state.window.runs, result.itemId] }, error: null }
          : state)
      }
    } catch (error) {
      const still = get().window?.seq === shown.seq
      const reason = unwrapIpcError(error, 'The command could not be started.')
      set(still ? { pending: null, error: reason } : { pending: null })
    }
  },

  close: (how = 'close') => set((state) => {
    if (state.pending || !state.window) return state
    lastOpen++
    return { window: null, error: null, exit: how }
  }),

  dismiss: () => {
    // An open still waiting for its parameters opens nothing either.
    lastOpen++
    set((state) => state.window ? { window: null, error: null, exit: 'close' } : state)
  },

  runRemoved: (chatId, itemId) => set((state) => {
    const runSources = { ...state.runSources }
    delete runSources[itemId]
    const showing = state.window?.chatId === chatId && state.window.runs[state.window.runs.length - 1] === itemId
    return showing && !state.pending ? { runSources, window: null, error: null, exit: 'close' } : { runSources }
  })
}))
