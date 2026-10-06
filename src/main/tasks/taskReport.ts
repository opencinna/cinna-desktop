import type { HandoverReportStatus } from '../../shared/handovers'

/**
 * The arguments of `tasks_report`, checked once for both of its paths: a
 * delegation executor's report through the bus (`delegationService.report`)
 * and a report on any other task of the chat (`taskToolService.tasksReport`).
 */

function requiredText(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(`Provide a nonempty ${name} (at most ${max} characters).`)
  }
  return value.trim()
}

type ReportArtifact = TaskReport['artifacts'][number]

/** A path or URL, or `{ref, kind?, name?}`, within the schema's limits. */
function isArtifact(item: unknown): item is string | ReportArtifact {
  if (typeof item === 'string') return item.trim() !== '' && item.length <= 1024
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false
  const { ref, kind, name, ...rest } = item as Record<string, unknown>
  return Object.keys(rest).length === 0 &&
    typeof ref === 'string' && ref.trim() !== '' && ref.length <= 1024 &&
    (kind === undefined || kind === 'file' || kind === 'link') &&
    (name === undefined || (typeof name === 'string' && name.length <= 200))
}

/** A `tasks_report`, checked: what the bus and the own-task path both write from. */
export interface TaskReport {
  status: HandoverReportStatus
  summary: string
  question: string | null
  audience: 'requester' | 'user'
  artifacts: { kind?: 'file' | 'link'; name?: string; ref: string }[]
  body: string
}

const REPORT_STATUSES: readonly HandoverReportStatus[] = ['in_progress', 'blocked', 'done', 'failed']

/**
 * Check a `tasks_report`'s arguments. `audience` defaults to the requester
 * where an agent asked for the work, else to the user.
 */
export function parseTaskReport(input: Record<string, unknown>, defaultAudience: 'requester' | 'user'): TaskReport {
  if (!REPORT_STATUSES.includes(input.status as HandoverReportStatus)) {
    throw new Error('Choose a report status: in_progress, blocked, done or failed.')
  }
  const status = input.status as HandoverReportStatus
  const summary = requiredText(input.summary, 'summary', 1000)
  if (/[\r\n]/.test(summary)) throw new Error('The summary must be one line.')
  const question = input.question === undefined ? null : requiredText(input.question, 'question', 4000)
  if (status === 'blocked' && !question) throw new Error('A blocked report needs a question: say what you need to continue.')
  if (input.audience !== undefined && input.audience !== 'requester' && input.audience !== 'user') {
    throw new Error('Choose audience requester or user.')
  }
  const audience = (input.audience as 'requester' | 'user' | undefined) ?? defaultAudience
  if (input.body !== undefined && (typeof input.body !== 'string' || input.body.length > 100_000)) {
    throw new Error('The body must be text of at most 100000 characters.')
  }
  const raw = input.artifacts === undefined ? [] : input.artifacts
  if (!Array.isArray(raw) || raw.length > 100 || !raw.every(isArtifact)) {
    throw new Error('Artifacts must be a list of file paths or URLs, or of {ref, kind, name}.')
  }
  const artifacts = raw.map((item) => typeof item === 'string' ? { ref: item } : item)
  return {
    status,
    summary,
    question,
    audience,
    artifacts,
    body: typeof input.body === 'string' ? input.body : ''
  }
}
