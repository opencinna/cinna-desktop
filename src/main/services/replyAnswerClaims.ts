import type { ParkedAsk } from '../agents/drivers/driver'
import type { ReplyRegistration, AsyncRespondOutcome } from '../agents/drivers/replyDelivery'
import type { RequestResolution } from '../../shared/localAgentRequests'
import { ASK_NO_LONGER_WAITING, type InboxAnswerResult } from '../../shared/inbox'

interface Claim {
  signature: string
  state: 'sending' | 'accepted_pending' | 'uncertain'
  promise?: Promise<InboxAnswerResult>
  reason?: string
}
const claims = new WeakMap<object, Claim>()
const gone = (): InboxAnswerResult => ({ ok: false, code: 'no_longer_waiting', reason: ASK_NO_LONGER_WAITING })

/** One remote write per registration/answer, including after a lost acknowledgement. */
export function claimReplyAnswer(input: {
  registration: ReplyRegistration
  ask: ParkedAsk
  resolution: RequestResolution
  validate(): void
  commit(resolution: RequestResolution): void
}): Promise<InboxAnswerResult> {
  const { registration, ask } = input
  const binding = registration.binding
  if (!binding || !registration.isCurrent()) return Promise.resolve(gone())
  const normalized = binding.normalize?.(input.resolution) ?? { resolution: input.resolution }
  const effectiveResolution: RequestResolution = normalized.resolution.kind === 'permission' && normalized.remembered !== undefined
    ? { ...normalized.resolution, remembered: normalized.remembered } : normalized.resolution
  // The persistence hint does not change the remote allow/deny decision.
  const signature = JSON.stringify(effectiveResolution.kind === 'permission' ? { kind: 'permission', reply: effectiveResolution.reply } : effectiveResolution)
  let claim = claims.get(registration.token)
  if (claim && claim.signature !== signature) return Promise.resolve({ ok: false, code: 'answer_in_progress', reason: 'An answer is already being delivered for this request.' })
  if (claim?.promise) return claim.promise
  if (claim?.state === 'uncertain') return Promise.resolve({ ok: false, code: 'uncertain', reason: claim.reason })
  if (!claim) {
    claim = { signature, state: 'sending' }
    claims.set(registration.token, claim)
  }
  const ownedClaim = claim
  const validate = (): void => {
    if (!registration.isCurrent()) throw new Error(ASK_NO_LONGER_WAITING)
    input.validate()
    binding.validate()
  }
  const execute = async (): Promise<InboxAnswerResult> => {
    try { validate() } catch (error) {
      if (!registration.isCurrent()) return gone()
      if (ownedClaim.state === 'sending') claims.delete(registration.token)
      return { ok: false, code: 'unavailable', reason: error instanceof Error ? error.message : 'The request can no longer be delivered.' }
    }
    if (ownedClaim.state === 'sending') {
      let abort!: () => void
      const canceled = new Promise<null>((resolve) => { abort = () => resolve(null) })
      registration.signal.addEventListener('abort', abort, { once: true })
      let outcome: AsyncRespondOutcome | null
      try {
        // No host retry. An unclassified failure after dispatch is uncertain.
        outcome = await Promise.race([
          binding.respondAsync(ask, effectiveResolution, { signal: registration.signal }), canceled
        ])
      } catch (error) {
        outcome = { status: 'uncertain', reason: error instanceof Error ? error.message : 'The confirmation response was lost.' }
      } finally {
        registration.signal.removeEventListener('abort', abort)
      }
      if (!registration.isCurrent() || !outcome) return gone()
      if (outcome.status === 'not_sent') {
        claims.delete(registration.token)
        return { ok: false, code: 'unavailable', reason: outcome.reason }
      }
      if (outcome.status === 'uncertain') {
        ownedClaim.state = 'uncertain'
        ownedClaim.reason = `Confirmation status is unknown. Do not submit it again. ${outcome.reason}`
        return { ok: false, code: 'uncertain', reason: ownedClaim.reason }
      }
      ownedClaim.state = 'accepted_pending'
    }
    try {
      validate()
      input.commit(effectiveResolution)
      if (!registration.release(effectiveResolution)) return gone()
      return { ok: true, ...(normalized.remembered !== undefined ? { remembered: normalized.remembered } : {}) }
    } catch (error) {
      if (!registration.isCurrent()) return gone()
      return { ok: false, code: 'unavailable', reason: `The remote service accepted the answer, but it could not be recorded locally. Retry to save it without sending again. ${error instanceof Error ? error.message : ''}` }
    }
  }
  // Defer dispatch until the claim and shared promise are visible to every caller.
  const promise = Promise.resolve().then(execute)
  ownedClaim.promise = promise
  const clearPromise = (): void => { if (ownedClaim.promise === promise) ownedClaim.promise = undefined }
  void promise.then(clearPromise, clearPromise)
  return promise
}
