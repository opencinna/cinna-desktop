/**
 * When a streamed fragment continues the last part instead of starting one.
 *
 * One rule, three callers: the main-process `StreamPartsAccumulator` (what is
 * persisted), and the renderer store's live blocks and live agent sub-threads.
 * They were three hand-kept copies, and a transcript that streams one way and
 * reloads another is exactly the drift three copies produce.
 *
 * Pure function, no runtime imports: shared by both Electron processes.
 */
import type { ContentKind, ToolStream } from './messageParts'

export interface PartMergeKey {
  kind: ContentKind
  toolName?: string
  toolId?: string
  toolStream?: ToolStream
  /**
   * The lane a part belongs to: a subagent's work carries the id of the Agent
   * call that launched it; the agent's own parts carry none (the main lane).
   */
  parentToolId?: string
}

/**
 * - Different kinds never merge.
 * - `file` never merges: two attachments are two badges.
 * - `tool_result` merges on `toolId` **and** `toolStream`, so interleaved
 *   stdout/stderr keep their chronology as separate parts.
 * - Everything else merges on `toolName` — and a `tool` part also refuses to
 *   merge when both sides name **different** `toolId`s. Two calls to one tool
 *   are two calls. Before this, two back-to-back permission asks (same reserved
 *   name, different `per_` ids) folded into one block, and the second ask's id —
 *   the address its answer is posted to — never reached the renderer, leaving
 *   that ask parked until its timeout. A fragment with no id still continues
 *   the part before it: an A2A backend may send `cinna.tool_id` on the first
 *   frame of a part only.
 */
export function continuesPart(last: PartMergeKey, next: PartMergeKey): boolean {
  if (last.kind !== next.kind || next.kind === 'file') return false
  // Two lanes never merge: a subagent's text is not the agent's own.
  if (last.parentToolId !== next.parentToolId) return false
  if (next.kind === 'tool_result') {
    return last.toolId === next.toolId && last.toolStream === next.toolStream
  }
  if (last.toolName !== next.toolName) return false
  if (next.kind === 'tool' && last.toolId && next.toolId) return last.toolId === next.toolId
  return true
}

/** Stable tool identity survives intervening permission and decision blocks.
 * Results retain their append order so stdout/stderr chronology is preserved.
 *
 * **Lanes.** A subagent's parts stream in between the agent's own, so "the
 * last part" means the last part *of the same lane* (same `parentToolId`;
 * none is the main lane). Parts of other lanes are skipped, so a paragraph
 * the agent is still writing is not cut by its subagent's tool calls. An
 * `undefined` entry — a caller's non-part block — counts as the main lane.
 * When nobody sets `parentToolId` everything is one lane and this is the
 * plain "continue the last part" rule.
 */
export function continuingPartIndex(parts: readonly (PartMergeKey | undefined)[], next: PartMergeKey): number {
  if (next.kind === 'tool' && next.toolId) {
    const index = parts.findIndex((part) => part?.kind === 'tool' && part.toolId === next.toolId && continuesPart(part, next))
    if (index >= 0) return index
  }
  let index = parts.length - 1
  while (index >= 0 && parts[index]?.parentToolId !== next.parentToolId) index -= 1
  return index >= 0 && parts[index] && continuesPart(parts[index]!, next) ? index : -1
}

/**
 * The tool input a part keeps when a fragment continues it — the same rule for
 * the accumulator, the live run cache and the renderer's live blocks.
 *
 * A fragment of the **same call** (same `toolId`) carrying a non-empty input
 * replaces the part's input: an engine fills a call's input in as the model
 * writes it (Claude's adapter opens a Skill call with `{}` and names the skill
 * in a later update), so the last one seen is the complete call. Otherwise the
 * first input captured stays, since an A2A backend may send `cinna.tool_input`
 * on the first frame of a part only.
 */
export function mergedToolInput(
  last: { toolInput?: Record<string, unknown>; toolId?: string },
  next: { toolInput?: Record<string, unknown>; toolId?: string }
): Record<string, unknown> | undefined {
  if (!next.toolInput) return last.toolInput
  if (!last.toolInput) return next.toolInput
  const sameCall = !!next.toolId && last.toolId === next.toolId
  return sameCall && Object.keys(next.toolInput).length > 0 ? next.toolInput : last.toolInput
}
