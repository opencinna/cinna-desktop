/**
 * The AI spending level: how much context a chat may use before Cinna nudges
 * the user to start a new chat or compact. A preference, not a limit — nothing
 * is stopped or compacted automatically.
 *
 * Eco and Mid cap at 250K / 350K tokens and scale down on smaller windows (60% /
 * 80% of the window), so a 200K model still gets a budget it can reach. Greedy
 * is the model's full window.
 *
 * No data, no assistance: a reading whose window size is the adapter's guess
 * (`sizeAuthoritative: false`) or unknown has no budget at all, so nothing is
 * shown or announced from it.
 */

export type AiSpendingLevel = 'eco' | 'mid' | 'greedy'

export const AI_SPENDING_LEVELS: readonly AiSpendingLevel[] = ['eco', 'mid', 'greedy']

export const AI_SPENDING_LEVEL_LABEL: Record<AiSpendingLevel, string> = {
  eco: 'Eco',
  mid: 'Mid',
  greedy: 'Greedy'
}

export function isAiSpendingLevel(value: unknown): value is AiSpendingLevel {
  return value === 'eco' || value === 'mid' || value === 'greedy'
}

const CAP: Record<Exclude<AiSpendingLevel, 'greedy'>, { tokens: number; share: number }> = {
  eco: { tokens: 250_000, share: 0.6 },
  mid: { tokens: 350_000, share: 0.8 }
}

/** The context budget for a window of `size` tokens, as a whole number of tokens. */
export function contextBudget(level: AiSpendingLevel, size: number): number {
  if (level === 'greedy') return Math.round(size)
  const cap = CAP[level]
  return Math.round(Math.min(cap.tokens, cap.share * size))
}

export interface ContextHealth {
  budget: number
  /** `used / budget`, clamped to [0, 1]. */
  fill: number
  /** The budget is reached: `used >= budget`. */
  over: boolean
}

/** The context's standing against the budget, or null when the window size is not known for sure. */
export function contextHealth(
  level: AiSpendingLevel,
  context: { used: number; size: number; sizeAuthoritative: boolean }
): ContextHealth | null {
  if (!context.sizeAuthoritative || !(context.size > 0)) return null
  const budget = contextBudget(level, context.size)
  if (!(budget > 0)) return null
  const used = Math.max(0, context.used)
  return { budget, fill: Math.min(1, used / budget), over: used >= budget }
}
