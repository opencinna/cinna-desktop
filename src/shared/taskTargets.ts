/**
 * The `target` string of the Cinna Task Protocol: what `tasks_targets` hands
 * an agent and `tasks_create.assignee` hands back. Opaque to the agent; main
 * encodes and decodes it here, and nowhere else.
 *
 * - `folder:<agentId>` — a bare folder agent (a brief in its `.cinna/handovers/`)
 * - `kit:<agentId>` — a local kit agent (a native task run here)
 * - `cinna:<adapterId>:<agentId>` — a remote agent behind a task adapter
 *
 * Every part is URI-encoded, so a `:` inside an id can never be read as a
 * separator: a string decodes to exactly one target or to nothing.
 */

/** The internal delegation channel a target names. */
export type TaskTargetChannelKind = 'bare' | 'kit' | 'cloud'

/** The target as the delegation service reads it. */
export interface TaskTargetRef {
  kind: TaskTargetChannelKind
  agentId: string
  /** Remote targets only: the adapter the agent lives behind. */
  adapter?: string
}

/** The protocol's word for a target's kind. */
export type TaskTargetKind = 'folder' | 'kit' | 'cinna'

const PROTOCOL_KIND: Record<TaskTargetChannelKind, TaskTargetKind> = { bare: 'folder', kit: 'kit', cloud: 'cinna' }

export function taskTargetKind(kind: TaskTargetChannelKind): TaskTargetKind {
  return PROTOCOL_KIND[kind]
}

export function encodeTaskTarget(target: TaskTargetRef): string {
  const agent = encodeURIComponent(target.agentId)
  if (target.kind === 'cloud') return `cinna:${encodeURIComponent(target.adapter ?? '')}:${agent}`
  return `${PROTOCOL_KIND[target.kind]}:${agent}`
}

function decodePart(part: string): string | null {
  if (!part) return null
  try {
    const decoded = decodeURIComponent(part)
    // Only the canonical encoding is accepted, so one target has one string.
    return encodeURIComponent(decoded) === part ? decoded : null
  } catch {
    return null
  }
}

/** The target a string names; null for anything `encodeTaskTarget` would not have written. */
export function decodeTaskTarget(value: unknown): TaskTargetRef | null {
  if (typeof value !== 'string' || value.length > 256) return null
  const parts = value.split(':')
  if (parts[0] === 'cinna') {
    if (parts.length !== 3) return null
    const adapter = decodePart(parts[1])
    const agentId = decodePart(parts[2])
    return adapter && agentId ? { kind: 'cloud', agentId, adapter } : null
  }
  if (parts.length !== 2) return null
  const agentId = decodePart(parts[1])
  if (!agentId) return null
  if (parts[0] === 'folder') return { kind: 'bare', agentId }
  if (parts[0] === 'kit') return { kind: 'kit', agentId }
  return null
}
