import type { MessageRow } from '../db/messages'

/**
 * The catch-up packet: what an agent missed while somebody else was answering.
 *
 * In a `human`-routed chat the user addresses one agent per message, so agent B
 * has no idea what agent A just said — and no protocol between them. This
 * builds the paragraph that goes in front of the user's text: the messages
 * since B's cursor, as a compact transcript.
 *
 * Pure over rows, and deliberately the same packet for **every** driver.
 * `capabilities.sessions === 'resumable'` does not exempt an agent from it: a
 * resumed session holds that agent's own turns, not the other agents', and the
 * gap is exactly the part it has never seen. What resumability *does* buy is a
 * smaller packet — an agent's own turns and the messages addressed to it are
 * dropped, because its session already has them.
 *
 * Phase 6 replaces the packet with a structured handoff note when a coordinator
 * hands off; the cursor mechanism stays either way.
 */

/** Default ceiling on the packet, in characters. See {@link buildCatchUpPacket}. */
export const CATCH_UP_CAP = 4000

/** What a single dropped-in-the-middle message is cut down to before the whole-packet cap applies. */
const PER_MESSAGE_CAP = 600

const HEADER =
  'Context from this chat that you have not seen. Other participants wrote it; you are not being asked about it directly.'
const FOOTER = 'End of context. The message that follows is addressed to you.'
const DROPPED = '[…earlier messages dropped to fit]'

export interface CatchUpInput {
  /** The chat's messages, in `sortOrder`. */
  messages: readonly MessageRow[]
  /** The agent about to take the turn. */
  agentId: string
  /** The last message id this agent has already seen; null when it has seen none. */
  cursorMessageId: string | null
  /** Display names by agent id, for the transcript labels. Missing ids fall back to `Agent`. */
  names?: ReadonlyMap<string, string>
  /** Character ceiling for the whole packet. Defaults to {@link CATCH_UP_CAP}. */
  cap?: number
}

/**
 * The packet, or null when the agent has missed nothing.
 *
 * Null — not an empty string — because "nothing to catch up on" is the ordinary
 * case (the same agent answering twice in a row) and the caller must send the
 * user's text unchanged rather than with an empty preamble on top of it.
 *
 * **A cursor that names a message this chat no longer has is treated as no
 * cursor at all**, and the whole thread is replayed. That is the safe side of
 * the failure: an agent re-reading context it has seen costs tokens, and an
 * agent silently missing the message it is being asked about costs the answer.
 */
export function buildCatchUpPacket(input: CatchUpInput): string | null {
  const { messages, agentId, cursorMessageId } = input
  const cap = input.cap ?? CATCH_UP_CAP

  const cursorIndex = cursorMessageId
    ? messages.findIndex((m) => m.id === cursorMessageId)
    : -1
  const gap = messages.slice(cursorIndex + 1)

  const lines: string[] = []
  for (const row of gap) {
    const line = renderRow(row, agentId, input.names)
    if (line) lines.push(line)
  }
  if (lines.length === 0) return null

  // Oldest first is what a transcript reads like, so the cap drops from the
  // *front* — the newest lines are the ones the agent most needs.
  const kept: string[] = []
  let budget = cap
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (budget - line.length < 0) {
      // Nothing fits at all: keep the newest line, truncated, rather than
      // returning a packet that is only a header and a marker.
      if (kept.length === 0) kept.unshift(clip(line, Math.max(cap, PER_MESSAGE_CAP)))
      kept.unshift(DROPPED)
      break
    }
    kept.unshift(line)
    budget -= line.length + 1
  }

  return [HEADER, '', ...kept, '', FOOTER].join('\n')
}

/**
 * One transcript line, or null for a row this agent should not be shown.
 *
 * What is dropped, and why:
 *  - **This agent's own replies** (`sourceAgentId`) and **the messages
 *    addressed to it** (`addressedAgentId`) — its own session holds both, and
 *    the message being sent right now is one of them (the send path persists
 *    the user row before the driver runs).
 *  - **`error` rows.** A desktop-side failure — a stream that dropped, a
 *    credential that expired — is not something that happened in the
 *    conversation, and its content is a JSON envelope.
 *  - **Empty rows.** A tool-only assistant turn has no text of its own.
 */
function renderRow(
  row: MessageRow,
  agentId: string,
  names: ReadonlyMap<string, string> | undefined
): string | null {
  if (row.sourceAgentId === agentId) return null
  if (row.role === 'error') return null

  switch (row.role) {
    case 'user': {
      if (row.addressedAgentId === agentId) return null
      const files = (row.attachments ?? []).map((a) => a.filename).filter(Boolean)
      const suffix = files.length > 0 ? ` (attached: ${files.join(', ')})` : ''
      const text = clip(row.content.trim(), PER_MESSAGE_CAP)
      if (!text && !suffix) return null
      return `[user] ${text}${suffix}`
    }
    case 'assistant': {
      const text = clip(row.content.trim(), PER_MESSAGE_CAP)
      if (!text) return null
      return `[${nameOf(row.sourceAgentId, names)}] ${text}`
    }
    case 'tool_call': {
      // The name, never the payload: a diff or a file listing is the bulk of a
      // thread and none of what the next agent needs from it.
      const who = nameOf(row.toolAgentId ?? row.sourceAgentId, names)
      const tool = row.toolName ?? 'a tool'
      return `[${who}] used ${tool}${row.toolError ? ' (failed)' : ''}`
    }
    case 'agent_transition': {
      const text = clip(row.content.trim(), PER_MESSAGE_CAP)
      return text ? `[note] ${text}` : null
    }
    default:
      return null
  }
}

function nameOf(
  agentId: string | null | undefined,
  names: ReadonlyMap<string, string> | undefined
): string {
  if (!agentId) return 'assistant'
  return names?.get(agentId) ?? 'agent'
}

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s*\n\s*/g, ' ')
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`
}

/**
 * The user's message with its catch-up packet in front, or the message
 * unchanged when there is nothing to catch up on.
 */
export function withCatchUp(packet: string | null, userContent: string): string {
  return packet ? `${packet}\n\n${userContent}` : userContent
}
