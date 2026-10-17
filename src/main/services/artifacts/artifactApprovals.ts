/**
 * Approvals of an agent's `artifacts_publish`: the call waits here, in
 * memory, until the user answers on the transcript card, in the Inbox, or
 * through Edit… — or until the park timeout, or until the call is aborted.
 *
 * Keyed `art_<toolCallId>`. The provider that opened a request owns what
 * publishing means (`publish(edits?)`); this registry only holds the summary,
 * runs one answer at a time, and settles the waiting call exactly once.
 * A failed publish leaves the request pending, its reason returned to whoever
 * answered, so the user can retry, edit or deny.
 *
 * A stop or the park timeout that lands while an approved publish is
 * uploading waits for it: the upload cannot be called back, so the call
 * settles with what really happened — published, or the stop/timeout when
 * the publish failed.
 *
 * Core: no Electron. Notifications go through `host/events`.
 */

import { REQUEST_PARK_TIMEOUT_MS } from '../../../shared/localAgentRequests'
import { ASK_NO_LONGER_WAITING, type InboxAnswerCode, type InboxAnswerResult } from '../../../shared/inbox'
import type { RequestResolution } from '../../../shared/localAgentRequests'
import {
  ARTIFACT_APPROVAL_PREFIX,
  ARTIFACTS_APPROVALS_CHANNEL,
  type ArtifactApprovalAnswer,
  type ArtifactApprovalEdits,
  type ArtifactApprovalSummary,
  type ArtifactFailure,
  type ArtifactsPublishOutcome
} from '../../../shared/artifacts'

export type ApprovalOutcome =
  | { kind: 'published'; result: Extract<ArtifactsPublishOutcome, { ok: true }>; edited: boolean }
  | { kind: 'denied' }
  | { kind: 'timeout' }
  | { kind: 'cancelled' }

export interface ApprovalRequest {
  summary: ArtifactApprovalSummary
  profileUserId: string
  /** Publish now; `edits` are the user's changes from Edit…. */
  publish(edits?: ArtifactApprovalEdits): Promise<ArtifactsPublishOutcome>
}

interface Pending extends ApprovalRequest {
  busy: boolean
  /** A stop or timeout that arrived while busy; applied if the publish fails. */
  deferred: ApprovalOutcome | null
  settle(outcome: ApprovalOutcome): void
}

export interface ArtifactApprovalsDeps {
  publishEvent(channel: string, payload: unknown): void
  timeoutMs?: number
  /** Tests only: how long a stop waits for an upload already under way. */
  uploadGraceMs?: number
}

/** How long a stop or timeout waits for an approved upload to settle. */
const UPLOAD_GRACE_MS = 2 * 60_000

const fail = (code: ArtifactFailure['code'], message: string): ArtifactFailure => ({ ok: false, code, message })

export function createArtifactApprovals(deps: ArtifactApprovalsDeps) {
  const pending = new Map<string, Pending>()
  const changed = (chatId: string): void => deps.publishEvent(ARTIFACTS_APPROVALS_CHANNEL, { chatId })

  return {
    /**
     * Hold the call until it is answered, timed out or aborted. Resolves once,
     * never rejects. A second request with the same id replaces nothing: the
     * first one stands and the second is cancelled.
     */
    open(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalOutcome> {
      const { requestId, chatId } = request.summary
      if (pending.has(requestId) || signal?.aborted) return Promise.resolve({ kind: 'cancelled' })
      return new Promise<ApprovalOutcome>((resolve) => {
        let done = false
        const finish = (outcome: ApprovalOutcome): void => {
          if (done) return
          done = true
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          pending.delete(requestId)
          changed(chatId)
          resolve(outcome)
        }
        /** A stop or timeout: at once, unless a publish is under way — then after it settles. */
        const interrupt = (outcome: ApprovalOutcome): void => {
          const entry = pending.get(requestId)
          if (entry?.busy) {
            if (!entry.deferred) {
              entry.deferred = outcome
              // The upload has no deadline of its own (`cinnaSend` takes no
              // signal); a core that never answers must not hold the turn forever.
              const grace = setTimeout(() => finish(outcome), deps.uploadGraceMs ?? UPLOAD_GRACE_MS)
              grace.unref?.()
            }
            return
          }
          finish(outcome)
        }
        const onAbort = (): void => interrupt({ kind: 'cancelled' })
        const timer = setTimeout(() => interrupt({ kind: 'timeout' }), deps.timeoutMs ?? REQUEST_PARK_TIMEOUT_MS)
        timer.unref?.()
        signal?.addEventListener('abort', onAbort, { once: true })
        pending.set(requestId, { ...request, busy: false, deferred: null, settle: finish })
        changed(chatId)
      })
    },

    /** The pending approvals of a chat for this profile. */
    list(profileUserId: string, chatId: string): ArtifactApprovalSummary[] {
      return [...pending.values()]
        .filter((entry) => entry.profileUserId === profileUserId && entry.summary.chatId === chatId)
        .map((entry) => entry.summary)
    },

    has(requestId: string): boolean {
      return pending.has(requestId)
    },

    /**
     * Answer for the user. `deny` settles at once; `publish` runs the
     * provider's publish and settles only when it worked.
     */
    async answer(
      profileUserId: string,
      requestId: string,
      decision: 'publish' | 'deny',
      edits?: ArtifactApprovalEdits
    ): Promise<ArtifactApprovalAnswer> {
      const entry = pending.get(requestId)
      if (!entry) return fail('not_found', 'This request is no longer waiting.')
      if (entry.profileUserId !== profileUserId) return fail('forbidden', 'Switch to the profile this request belongs to.')
      if (entry.busy) return fail('invalid_input', 'This request is already being answered.')
      if (decision === 'deny') {
        entry.settle({ kind: 'denied' })
        return { ok: true }
      }
      entry.busy = true
      try {
        const result = await entry.publish(edits)
        if (!result.ok) {
          // Stopped or timed out meanwhile: nothing was published, and nobody waits for a retry.
          if (entry.deferred) entry.settle(entry.deferred)
          return result
        }
        entry.settle({ kind: 'published', result, edited: edits !== undefined })
        return {
          ok: true,
          artifact: result.artifact,
          ...(result.link ? { link: result.link } : {}),
          ...(result.warning ? { warning: result.warning } : {})
        }
      } catch (error) {
        if (entry.deferred) entry.settle(entry.deferred)
        return fail('request_failed', error instanceof Error ? error.message : String(error))
      } finally {
        entry.busy = false
      }
    }
  }
}

export type ArtifactApprovals = ReturnType<typeof createArtifactApprovals>

/**
 * The Inbox's way back to a pending approval: an answer to an `art_` row is
 * routed here (`installTaskRunnerHooks(…, 'artifacts')`). Publish runs the
 * same publish the card's button does; the provider then emits
 * `input_resolved`, which settles the row through `inboxService.closeAsk`.
 */
export function approvalInboxHook(approvals: ArtifactApprovals) {
  return {
    answer(userId: string, requestId: string, resolution: RequestResolution): Promise<InboxAnswerResult> | null {
      if (!requestId.startsWith(ARTIFACT_APPROVAL_PREFIX)) return null
      return (async (): Promise<InboxAnswerResult> => {
        if (!approvals.has(requestId)) return { ok: false, code: 'no_longer_waiting', reason: ASK_NO_LONGER_WAITING }
        const choice = resolution.kind === 'question' ? resolution.answers?.[0]?.[0] : undefined
        if (choice !== 'Publish' && choice !== 'Deny') return { ok: false, code: 'malformed', reason: 'Choose Publish or Deny.' }
        const answer = await approvals.answer(userId, requestId, choice === 'Publish' ? 'publish' : 'deny')
        if (answer.ok) return { ok: true }
        const code: InboxAnswerCode =
          answer.code === 'not_found' ? 'no_longer_waiting' : answer.code === 'forbidden' ? 'not_owned' : answer.code === 'invalid_input' ? 'answer_in_progress' : 'unavailable'
        return { ok: false, code, reason: answer.message }
      })()
    },
    taskChanged: (): void => {},
    chatRemoved: (): void => {},
    profileRemoved: (): void => {}
  }
}
