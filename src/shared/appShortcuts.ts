/**
 * Global keyboard shortcuts that start a chat — ⌘N, ⇧⌘N and ⌘1–⌘9.
 *
 * The keys are Electron menu accelerators in the main process; each one sends
 * a single `app:shortcut` event carrying one of these payloads, and the
 * renderer decides what it means on the screen the user is looking at.
 */
export type AppShortcut =
  /** ⌘N — the new-chat screen, exactly like the TopBar `+`. */
  | { kind: 'new-chat' }
  /** ⇧⌘N — a new chat with the agent of the chat or agent page on screen. */
  | { kind: 'new-chat-same-agent' }
  /** ⌘<slot> — a new chat with the agent the user bound to that digit. */
  | { kind: 'agent'; slot: number }

/** The digits an agent can be bound to. */
export const AGENT_SHORTCUT_SLOTS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const

export type AgentShortcutSlot = (typeof AGENT_SHORTCUT_SLOTS)[number]

export function isAgentShortcutSlot(value: unknown): value is AgentShortcutSlot {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 9
}

/** One binding of a digit to an agent, per profile. */
export interface AgentShortcutDto {
  slot: number
  agentId: string
}
