import { CircleAlert, CircleCheck, CircleHelp } from 'lucide-react'
import type { ChatRunResult } from '../../../../shared/chatRunResult'

/** The unread-result icon a chat row and a job row show, one table for both. */
export const resultIndicators = {
  completed: { icon: CircleCheck, label: 'Completed — unread results', color: 'text-[var(--color-success)]' },
  needs_input: { icon: CircleHelp, label: 'Needs input — unread results', color: 'text-[var(--color-warning)]' },
  failed: { icon: CircleAlert, label: 'Failed — unread results', color: 'text-[var(--color-danger)]' }
}

export type ResultIndicator = (typeof resultIndicators)[keyof typeof resultIndicators]

/** A result the user has not looked at yet; never while a run is going, never a cancel. */
export function unreadResultIndicator(result: ChatRunResult | null | undefined, isRunning: boolean): ResultIndicator | null {
  return !isRunning && result?.unread && result.status !== 'canceled' ? resultIndicators[result.status] : null
}
