/**
 * Hint catalog — the single source of truth for the rotating tip bar on the
 * new-chat screen.
 *
 * Two lanes share this list:
 *  - **Ambient** hints (no `trigger`) enter a shuffled rotation.
 *  - **Contextual** hints (with a `trigger`) never rotate; they preempt the bar
 *    when the user does something adjacent to the gesture being taught.
 *
 * Every hint is gated by `available` so we never teach something the user
 * can't act on right now (no "type `#`" when no agent declares prompts), and
 * retires via `retiredBy` once the user has demonstrably learned it — without
 * that, the bar turns into wallpaper and the contextual lane loses its punch.
 *
 * This file is documentation shipped inside the product. When a keybinding
 * changes, the hint that teaches it changes here too — see
 * `docs/ui/hints/hints.md` and `docs/ui/keyboard_shortcuts/keyboard_shortcuts.md`.
 */

/** Screens a hint may appear on. Only the new-chat screen is wired today. */
export type HintSurface = 'new-chat'

/**
 * Things the user did that hints care about. Emitted by the composer via
 * `useHintsStore.observe`; consumed as both retirement signals (`retiredBy`)
 * and contextual triggers (`trigger`).
 */
export type HintEvent =
  | 'note-attached'
  | 'note-expanded-inline'
  | 'note-picker-opened'
  | 'note-previewed'
  | 'prompt-picked'
  | 'command-picked'
  | 'mention-used'
  | 'capability-picked-via-menu'
  | 'mode-picked-via-menu'
  | 'mode-picked-via-tilde'
  | 'files-picked-via-menu'
  | 'files-dropped'
  | 'escape-pressed-once'
  | 'double-escape'
  | 'agent-with-prompts-selected'
  | 'agent-with-commands-selected'
  | 'minimal-view-entered'

/** A key name rendered as an inline chip rather than as literal text. */
export interface HintKey {
  key: string
}
export type HintSegment = string | HintKey

/** Terse constructor so catalog entries stay readable. */
export const k = (key: string): HintKey => ({ key })

export function isHintKey(segment: HintSegment): segment is HintKey {
  return typeof segment !== 'string'
}

/**
 * Placeholder for the platform modifier key. Resolved by {@link resolveKey} at
 * render time rather than at import time — this module stays a pure data
 * catalog with no DOM globals read on load, so it can be imported from a
 * node-environment test (see `vitest.config.ts`) without a browser shim.
 */
export const MOD_KEY = '\u0000mod'

/** Turn a catalog key into the label to display on this platform. */
export function resolveKey(key: string): string {
  if (key !== MOD_KEY) return key
  return typeof navigator !== 'undefined' && navigator.userAgent.includes('Macintosh')
    ? '⌘'
    : 'Ctrl'
}

/**
 * Everything a hint's `available` predicate may look at. Assembled by
 * `HintBar` from queries the new-chat screen already has in cache — adding a
 * field here should never cost a new IPC round-trip.
 */
export interface HintContext {
  hasNotes: boolean
  hasExamplePrompts: boolean
  hasCliCommands: boolean
  hasChatModes: boolean
  hasAgentsOrMcps: boolean
  hasPendingAgents: boolean
  canAttachFiles: boolean
}

export interface Hint {
  /** Stable slug — also the persistence key for usage counters. */
  id: string
  surfaces: readonly HintSurface[]
  segments: readonly HintSegment[]
  /** Can the user act on this right now? Absent ⇒ always eligible. */
  available?: (ctx: HintContext) => boolean
  /** Present ⇒ contextual: shown only when this event fires, never in rotation. */
  trigger?: HintEvent
  /** Observing one of these means the user knows the gesture. */
  retiredBy?: readonly HintEvent[]
  /** `retiredBy` observations tolerated before the hint drops out for good. */
  retireAfter?: number
}

/** Default number of observed uses before a hint stops appearing. */
export const DEFAULT_RETIRE_AFTER = 3

const NEW_CHAT: readonly HintSurface[] = ['new-chat']

/** Any picker at all is reachable — gates the generic popup-keys hint. */
const anyPicker = (c: HintContext): boolean =>
  c.hasNotes || c.hasExamplePrompts || c.hasCliCommands || c.hasChatModes || c.hasAgentsOrMcps

export const HINTS: readonly Hint[] = [
  // ---- Ambient rotation ---------------------------------------------------
  {
    id: 'notes-attach',
    surfaces: NEW_CHAT,
    segments: ['Type ', k('?'), ' to attach one of your notes to the message'],
    available: (c) => c.hasNotes,
    // Opening the picker IS the gesture this teaches. Crediting `note-attached`
    // as well would count one uninterrupted `?`-then-Enter flow twice and
    // retire the hint a third sooner than intended.
    retiredBy: ['note-picker-opened']
  },
  {
    id: 'notes-expand',
    surfaces: NEW_CHAT,
    segments: [
      'Right after picking a note, press ',
      k('Enter'),
      ' on an empty message to paste its text inline instead of attaching it as a file'
    ],
    available: (c) => c.hasNotes,
    retiredBy: ['note-expanded-inline']
  },
  {
    id: 'prompts-hash',
    surfaces: NEW_CHAT,
    segments: ['Type ', k('#'), ' to pick one of the agent’s suggested prompts'],
    available: (c) => c.hasExamplePrompts,
    retiredBy: ['prompt-picked']
  },
  {
    id: 'commands-slash',
    surfaces: NEW_CHAT,
    segments: ['Type ', k('/'), ' to run one of the agent’s commands'],
    available: (c) => c.hasCliCommands,
    retiredBy: ['command-picked']
  },
  {
    id: 'mention-at',
    surfaces: NEW_CHAT,
    segments: ['Type ', k('@'), ' to bring an agent or MCP server into the chat'],
    available: (c) => c.hasAgentsOrMcps,
    retiredBy: ['mention-used']
  },
  {
    id: 'mode-tilde',
    surfaces: NEW_CHAT,
    segments: ['Type ', k('~'), ' in an empty message to switch chat mode'],
    available: (c) => c.hasChatModes,
    retiredBy: ['mode-picked-via-tilde']
  },
  {
    id: 'popup-keys',
    surfaces: NEW_CHAT,
    segments: [
      'In any picker: ',
      k('↑'),
      ' ',
      k('↓'),
      ' to move, ',
      k('Enter'),
      ' or ',
      k('Tab'),
      ' to accept, ',
      k('Esc'),
      ' to close'
    ],
    available: anyPicker
  },
  {
    id: 'shift-enter',
    surfaces: NEW_CHAT,
    segments: [k('Shift'), ' + ', k('Enter'), ' starts a new line without sending']
  },
  {
    id: 'double-esc',
    surfaces: NEW_CHAT,
    segments: ['Press ', k('Esc'), ' twice to clear the agents you’ve selected'],
    available: (c) => c.hasPendingAgents,
    retiredBy: ['double-escape']
  },
  {
    id: 'drag-drop',
    surfaces: NEW_CHAT,
    segments: ['Drag files straight onto the message box to attach them'],
    available: (c) => c.canAttachFiles,
    retiredBy: ['files-dropped']
  },
  {
    // Taught here although it works only in an open chat: the new-chat screen
    // is the only surface with a hint bar. Once found, it is known.
    id: 'minimal-view-wipe',
    surfaces: NEW_CHAT,
    segments: ['In a chat, swipe the pointer back and forth across the message box three times for a minimal view'],
    retiredBy: ['minimal-view-entered'],
    retireAfter: 1
  },
  {
    id: 'plus-menu',
    surfaces: NEW_CHAT,
    segments: [
      'The ',
      k('+'),
      ' button does everything ',
      k('@'),
      ', ',
      k('~'),
      ' and attach do — for when you’d rather click'
    ]
  },
  {
    id: 'preview-attachment',
    surfaces: NEW_CHAT,
    segments: [
      'Click an attached .md, .csv or .json badge to preview it without downloading'
    ],
    available: (c) => c.canAttachFiles
  },
  {
    id: 'preview-note',
    surfaces: NEW_CHAT,
    segments: ['Click a note badge to read the note without leaving the chat'],
    available: (c) => c.hasNotes,
    retiredBy: ['note-previewed']
  },
  {
    id: 'chat-modes',
    surfaces: NEW_CHAT,
    segments: ['Pick a chat mode to preset the model and MCP servers for a chat'],
    available: (c) => c.hasChatModes,
    retiredBy: ['mode-picked-via-menu', 'mode-picked-via-tilde']
  },
  {
    id: 'logs-shortcut',
    surfaces: NEW_CHAT,
    segments: ['Press ', k(MOD_KEY), ' + ', k('`'), ' to open the app logs']
  },
  {
    id: 'new-chat-shortcut',
    surfaces: NEW_CHAT,
    segments: ['Press ', k(MOD_KEY), ' + ', k('N'), ' from any screen to start a new chat']
  },
  {
    id: 'new-chat-same-agent-shortcut',
    surfaces: NEW_CHAT,
    segments: [
      'In an agent’s chat or on its page, ',
      k('Shift'),
      ' + ',
      k(MOD_KEY),
      ' + ',
      k('N'),
      ' starts a new chat with the same agent'
    ]
  },
  {
    id: 'agent-shortcut-setting',
    surfaces: NEW_CHAT,
    segments: [
      'Give an agent a shortcut under Settings → Interface on its page, then press ',
      k(MOD_KEY),
      ' + ',
      k('1'),
      '–',
      k('9'),
      ' to start a chat with it'
    ]
  },

  // ---- Contextual (preempt the rotation) ----------------------------------
  {
    id: 'ctx-notes-expand',
    surfaces: NEW_CHAT,
    trigger: 'note-attached',
    segments: [
      'Press ',
      k('Enter'),
      ' now, on an empty message, to paste this note’s text inline instead of attaching it as a file'
    ],
    retiredBy: ['note-expanded-inline']
  },
  {
    id: 'ctx-popup-keys',
    surfaces: NEW_CHAT,
    trigger: 'note-picker-opened',
    segments: [
      k('↑'),
      ' ',
      k('↓'),
      ' to move, ',
      k('Enter'),
      ' or ',
      k('Tab'),
      ' to pick, ',
      k('Esc'),
      ' to cancel'
    ]
  },
  {
    id: 'ctx-mode-tilde',
    surfaces: NEW_CHAT,
    trigger: 'mode-picked-via-menu',
    segments: [
      'Next time: type ',
      k('~'),
      ' in an empty message to switch mode from the keyboard'
    ],
    retiredBy: ['mode-picked-via-tilde']
  },
  {
    id: 'ctx-mention-at',
    surfaces: NEW_CHAT,
    trigger: 'capability-picked-via-menu',
    segments: [
      'Next time: type ',
      k('@'),
      ' to add agents and MCP servers without the mouse'
    ],
    retiredBy: ['mention-used']
  },
  {
    id: 'ctx-prompts-hash',
    surfaces: NEW_CHAT,
    trigger: 'agent-with-prompts-selected',
    segments: ['This agent has suggested prompts — type ', k('#'), ' to browse them'],
    available: (c) => c.hasExamplePrompts,
    retiredBy: ['prompt-picked']
  },
  {
    id: 'ctx-commands-slash',
    surfaces: NEW_CHAT,
    trigger: 'agent-with-commands-selected',
    segments: ['This agent exposes commands — type ', k('/'), ' to run one'],
    available: (c) => c.hasCliCommands,
    retiredBy: ['command-picked']
  },
  {
    id: 'ctx-drag-drop',
    surfaces: NEW_CHAT,
    trigger: 'files-picked-via-menu',
    segments: ['You can also drop files straight onto the message box'],
    retiredBy: ['files-dropped']
  },
  {
    id: 'ctx-double-esc',
    surfaces: NEW_CHAT,
    trigger: 'escape-pressed-once',
    segments: ['Press ', k('Esc'), ' again to clear your agent selection'],
    available: (c) => c.hasPendingAgents,
    retiredBy: ['double-escape']
  }
]

export function findHint(id: string): Hint | null {
  return HINTS.find((h) => h.id === id) ?? null
}

/** Plain-text form of a hint — used for dwell-time sizing and tooltips. */
export function hintText(hint: Hint): string {
  return hint.segments.map((s) => (isHintKey(s) ? resolveKey(s.key) : s)).join('')
}
