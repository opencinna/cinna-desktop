import type { DelegationDto } from '../../../shared/delegations'
import { unwrapIpcError } from './ipcError'

export function delegationStateLabel(delegation: DelegationDto): string {
  if (delegation.waitingOnUser) return 'Waiting on you'
  const labels: Record<DelegationDto['state'], string> = {
    seen: 'Received', gated: 'Waiting for approval', running: 'Running',
    waiting_external: 'Waiting for a report', blocked: 'Waiting for requester',
    done: 'Done', failed: 'Failed', skipped: 'Skipped', refused: 'Refused',
    creating: 'Creating', uncertain: 'Dispatch needs review', waiting_user: 'Waiting on you'
  }
  return labels[delegation.state]
}

/** Explain transport warnings without exposing internal codes or reply IDs. */
export function delegationNoteText(
  delegation: Pick<DelegationDto, 'warning' | 'refusalReason'> & Partial<Pick<DelegationDto, 'state' | 'dispatchError'>>
): string | null {
  // A stopped cloud dispatch says what to do in its own words; the row's warning is often only a
  // capability note ("no attachments") that explains nothing about why it needs review.
  if (delegation.dispatchError && (delegation.state === 'uncertain' || delegation.state === 'failed')) {
    return unwrapIpcError(delegation.dispatchError, delegation.dispatchError)
  }
  const warning = delegation.warning
  if (!warning) {
    if (delegation.refusalReason === 'depth_exceeded') return 'This delegation was refused because the work has already been handed on twice.'
    return delegation.refusalReason ? explainDetail('This delegation was refused', delegation.refusalReason) : null
  }
  const separator = warning.indexOf(':')
  const kind = separator < 0 ? warning : warning.slice(0, separator)
  const detail = separator < 0 ? '' : warning.slice(separator + 1)
  switch (kind) {
    case 'reply_uncertain':
      return 'Delivery of the follow-up could not be confirmed. Check the executor’s conversation before sending it again.'
    case 'reply_failed':
      return explainDetail('The follow-up could not be delivered to the executor', detail.replace(/^[\w-]{21}:/, ''))
    case 'reply_timed_out':
      return 'The executor’s conversation stayed busy, so the follow-up is still waiting to be delivered.'
    case 'start_refused':
      return explainDetail('The run could not be started', detail)
    case 'run_lost':
      return 'The app closed while the run was in progress, so the run was lost.'
    case 'task_removed':
      return 'The delegated task was removed.'
    case 'report_missing':
      return 'The executor ended its turn without reporting a result.'
    case 'wake_timed_out':
      return 'The requester’s conversation stayed busy, so the result could not be delivered.'
    case 'wake_failed':
    case 'wake_refused':
      return explainDetail('The result could not be delivered to the requester', detail)
    default:
      // Cloud capability gaps already arrive as sentences. Unknown internal
      // codes from a newer build must not become the user's only explanation.
      return /^[a-z]+(?:_[a-z]+)+$/.test(kind) ? 'This delegation needs attention. Check its task for details.' : warning
  }
}

function explainDetail(message: string, detail: string): string {
  const cleaned = unwrapIpcError(detail, '').trim()
  return cleaned ? `${message}: ${cleaned}` : `${message}.`
}
