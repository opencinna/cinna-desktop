import type { InboxAnswerResult } from '../../../shared/inbox'

/** Keeps the main-owned acknowledgment state available to both answer surfaces. */
export class AnswerDeliveryError extends Error {
  constructor(readonly result: InboxAnswerResult) {
    super(result.reason ?? 'That answer could not be delivered.')
  }
}
