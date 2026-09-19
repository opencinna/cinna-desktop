import type { ChatListSummary } from '../../../shared/chatListSummary'
/**
 * The two values of the sidebar chat-row tooltip. Pure: `now` and the locale
 * are parameters, so a given chat reads the same in a test as on screen.
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** `Today 14:32` · `Yesterday 09:05` · `12 Sep, 14:32` · `12 Sep 2025, 14:32`. */
export function formatChatStarted(startedAt: Date, now: Date, locale?: string): string {
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(startedAt)
  // Calendar days, not 24-hour spans: 23:50 last night is yesterday at 00:10.
  // Rounded because a DST change makes one of those days 23 or 25 hours long.
  const daysAgo = Math.round((startOfDay(now) - startOfDay(startedAt)) / DAY)
  if (daysAgo === 0) return `Today ${time}`
  if (daysAgo === 1) return `Yesterday ${time}`
  const date = new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    ...(startedAt.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' as const })
  }).format(startedAt)
  return `${date}, ${time}`
}

/** `under a minute` · `25 min` · `2 h` · `2 h 5 min` · `1 day` · `3 days`. */
export function formatChatDuration(ms: number): string {
  if (ms < MINUTE) return 'under a minute'
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)} min`
  if (ms < DAY) {
    const hours = Math.floor(ms / HOUR)
    const minutes = Math.floor((ms % HOUR) / MINUTE)
    return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`
  }
  const days = Math.max(1, Math.round(ms / DAY))
  return days === 1 ? '1 day' : `${days} days`
}

/**
 * `25 min · 14 messages`. A span needs two ends: with fewer than two messages
 * there is nothing that lasted, and the row goes.
 */
export function formatChatLasted(
  firstMessageAt: Date | null,
  lastMessageAt: Date | null,
  messageCount: number
): string | null {
  if (messageCount < 2 || !firstMessageAt || !lastMessageAt) return null
  return `${formatChatDuration(Math.max(0, lastMessageAt.getTime() - firstMessageAt.getTime()))} · ${messageCount} messages`
}

/** `Writer, Reviewer` · `A, B, C +2` — never more than three names. */
export function formatChatOthers(others: string[]): string {
  const shown = others.slice(0, 3).join(', ')
  return others.length > 3 ? `${shown} +${others.length - 3}` : shown
}

/** Whether there is anything to tell beyond when the chat started: who, who else, or how long. */
export function hasChatSummaryContent(summary: ChatListSummary): boolean {
  return summary.with.name !== '' || summary.others.length > 0 ||
    formatChatLasted(summary.firstMessageAt, summary.lastMessageAt, summary.messageCount) !== null
}
