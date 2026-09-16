/**
 * How much of a turn's output a copy holds, to choose between two copies of a
 * reply that was cut off: what streamed here (or the rows a kill left), and
 * what the server kept. A server that crashed or stopped mid-turn keeps only
 * what it flushed, which can be less than the app already showed.
 *
 * Kept free of Electron and the database: the live turn and relaunch
 * recovery both use it.
 */
import type { MessagePart } from '../../shared/messageParts'

export interface OutputSize {
  /** The sum of the parts' text lengths. */
  textLength: number
  /** How many parts. */
  parts: number
}

export const NO_OUTPUT: OutputSize = { textLength: 0, parts: 0 }

export function outputSizeOf(parts: readonly Pick<MessagePart, 'text'>[]): OutputSize {
  return { textLength: parts.reduce((sum, part) => sum + (part.text?.length ?? 0), 0), parts: parts.length }
}

/** Whether `a` holds at least as much as `b`: by text length, then by part count. */
export function isAtLeastAsRich(a: OutputSize, b: OutputSize): boolean {
  if (a.textLength !== b.textLength) return a.textLength > b.textLength
  return a.parts >= b.parts
}
