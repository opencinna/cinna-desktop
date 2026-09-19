import type { DelegationPatch, DelegationRow } from '../db/delegations'
import type { DelegationResult } from '../../shared/delegations'
import type { TaskDto } from '../../shared/tasks'
import {
  RemoteTaskError, UnsupportedRemoteOperation, type RemoteAsk, type RemoteBinding,
  type RemoteDelegationMetadata, type RemoteDelegationResult, type RemoteTaskAdapter,
  type RemoteTaskSnapshot
} from '../tasks/adapters/adapter'

export interface DelegationCloudWorld {
  adapterFor(id: string): RemoteTaskAdapter
  get(userId: string, id: string): DelegationRow | undefined
  patch(userId: string, id: string, patch: DelegationPatch): DelegationRow | undefined
  isActive(userId: string): boolean
  /** Invalidated by account/profile lifecycle even if a profile switches away and back. */
  captureConnection(userId: string): () => boolean
  saveBinding(userId: string, taskId: string, binding: RemoteBinding): void
  markRemote(userId: string, taskId: string): void
  applySnapshot(userId: string, taskId: string, snapshot: RemoteTaskSnapshot): void
}

export interface CloudDelegationPoll {
  result: DelegationResult | null
  warning: string | null
  waitingOnUser: boolean
  /** User asks are left to the ordinary remote-task Inbox integration. */
  asks: RemoteAsk[]
}

const metadataWarning = 'This service does not store structured delegation metadata; the chain is included in the brief.'
/** Below the return packet's own body cap, so the fallback decides what is dropped, not the cut. */
const FALLBACK_BODY_CHARS = 3500
const artifactWarning = 'This service does not expose remote attachments; inspect the remote task for files.'

function metadataOf(row: DelegationRow): RemoteDelegationMetadata {
  return { id: row.id, requesterKey: row.requesterKey, originKind: row.originKind,
    originAgentId: row.originAgentId, originChatId: row.originChatId, originTaskId: row.originTaskId,
    depth: row.depth, root: row.rootDelegationId, group: row.groupId }
}

function bindingOf(row: DelegationRow): RemoteBinding | null {
  return row.remoteTaskId && row.remoteConnectionId
    ? { adapter: row.remoteConnectionId, id: row.remoteTaskId, key: row.remoteTaskKey, url: row.remoteUrl, state: {} }
    : null
}

/** The profile or its connection went away mid-dispatch: the service refused nothing, so this is never a `failed`. */
class DispatchInterrupted extends RemoteTaskError {}

/** Durable outbound work. A requester task is never handed off or modified here. */
export function createDelegationCloudChannel(world: DelegationCloudWorld) {
  const pending = new Map<string, Promise<DelegationRow>>()
  function active(userId: string): void {
    if (!world.isActive(userId)) throw new RemoteTaskError('invalid_request', 'The requesting profile is no longer active.')
  }
  function current(userId: string, id: string): DelegationRow {
    const row = world.get(userId, id)
    if (!row || row.userId !== userId || row.channel !== 'cloud') {
      throw new RemoteTaskError('invalid_request', 'That cloud delegation no longer belongs to this profile.')
    }
    return row
  }
  function patch(userId: string, id: string, update: DelegationPatch): DelegationRow {
    const row = world.patch(userId, id, update)
    if (!row) throw new RemoteTaskError('invalid_request', 'That cloud delegation no longer exists.')
    return row
  }

  async function dispatchWork(userId: string, supplied: DelegationRow, task: TaskDto): Promise<DelegationRow> {
    const connectionCurrent = world.captureConnection(userId)
    const assertActive = () => {
      if (!world.isActive(userId)) throw new DispatchInterrupted('invalid_request', 'The requesting profile is no longer active.')
      if (!connectionCurrent()) throw new DispatchInterrupted('invalid_request', 'The cloud connection changed during dispatch.')
    }
    assertActive()
    let row = current(userId, supplied.id)
    // A row already journalled `creating` may have a remote task nobody bound. If it can no longer
    // pass these checks it would be retried, refused and left `creating` on every tick — holding the
    // task pull back for good. It is settled as uncertain instead: the create may have landed.
    const settleUnbound = (message: string): void => {
      if (row.dispatchState === 'creating' && !row.remoteTaskId) {
        patch(userId, row.id, { dispatchState: 'uncertain', state: 'uncertain', dispatchError: message })
      }
    }
    const refuse: (message: string) => never = (message) => {
      settleUnbound(message)
      throw new RemoteTaskError('invalid_request', message)
    }
    if (!row.remoteConnectionId || !row.taskId || row.taskId !== task.id || task.id === row.originTaskId || task.parentTaskId) {
      refuse('A cloud delegation needs its own independent task and a service.')
    }
    if (task.assignee.kind !== 'remote_agent' || task.assignee.agentId !== row.targetAgentId) {
      refuse('The child task assignee does not match the approved cloud target.')
    }
    let adapter: RemoteTaskAdapter
    let caps: ReturnType<RemoteTaskAdapter['capabilities']>
    try {
      adapter = world.adapterFor(row.remoteConnectionId)
      caps = adapter.capabilities()
      if (!caps.create || !caps.execute) throw new UnsupportedRemoteOperation(adapter.id, 'execute a delegation')
      // Refuse before spending anything remotely: links are not disguised as uploads.
      for (const artifact of task.artifacts) {
        if (!caps.writeArtifactKinds.includes(artifact.kind)) throw new UnsupportedRemoteOperation(adapter.id, `store a ${artifact.kind} artifact`)
      }
    } catch (error) {
      // A service that went away or lost a capability refuses on every retry, exactly like the checks above.
      settleUnbound(error instanceof Error ? error.message : String(error))
      throw error
    }
    if (row.dispatchState === 'running' || row.dispatchState === 'failed' || row.dispatchState === 'uncertain') return row
    // A restart cannot tell whether either side-effect finished. Never replay it.
    if (row.dispatchState === 'executing' || row.dispatchState === 'uploading') {
      return patch(userId, row.id, { dispatchState: 'uncertain', state: 'uncertain',
        dispatchError: 'The previous dispatch was interrupted. Check the remote task before retrying.' })
    }
    const availability = await adapter.availability(userId)
    assertActive()
    if (!availability.ready) throw new RemoteTaskError('unavailable', availability.reason ?? 'The service is unavailable.')
    const supportsMetadata = caps.delegationMetadata || (await adapter.delegationSupport?.(userId))?.metadata === true
    assertActive()
    let binding = bindingOf(row)
    if (!binding) {
      if (row.dispatchState === 'creating' && !caps.idempotentCreate) {
        return patch(userId, row.id, { dispatchState: 'uncertain', state: 'uncertain',
          dispatchError: 'The create acknowledgement was lost and this service cannot safely retry it.' })
      }
      row = patch(userId, row.id, { dispatchState: 'creating', state: 'creating', dispatchError: null })
      const metadata = metadataOf(row)
      const outgoing = supportsMetadata ? task : {
        ...task, goal: `${task.goal}\n\nDelegation context (desktop-owned):\n${JSON.stringify(metadata)}`
      }
      try {
        binding = await adapter.create(userId, outgoing, null, supportsMetadata ? metadata : undefined)
        if (binding.adapter !== adapter.id || !binding.id) throw new RemoteTaskError('unavailable', 'The service returned an invalid task binding.')
        // Keep an acknowledged identity even if the profile switched during create.
        row = patch(userId, row.id, { remoteTaskId: binding.id, remoteTaskKey: binding.key,
          remoteUrl: binding.url, dispatchState: 'created', dispatchError: null,
          warning: supportsMetadata ? null : metadataWarning })
      } catch (error) {
        const safeRefusal = error instanceof RemoteTaskError && error.code !== 'unavailable'
        patch(userId, row.id, { dispatchState: safeRefusal ? 'failed' : 'creating',
          ...(safeRefusal && { state: 'failed' as const }), dispatchError: error instanceof Error ? error.message : String(error) })
        throw error
      }
    }
    // Binding and executor live only on the child. Binding is recovered after a crash
    // between the journal commit and task update; no second create is needed.
    world.saveBinding(userId, task.id, binding)
    assertActive()
    world.markRemote(userId, task.id)
    let sent = false
    try {
      if (task.artifacts.length) {
        for (const artifact of task.artifacts) {
          assertActive()
          if (!sent) patch(userId, row.id, { dispatchState: 'uploading' })
          sent = true
          await adapter.putArtifact(userId, binding, artifact)
        }
      }
      assertActive()
      patch(userId, row.id, { dispatchState: 'executing', dispatchError: null })
      sent = true
      await adapter.execute(userId, binding)
      return patch(userId, row.id, { dispatchState: 'running', state: 'running', dispatchError: null })
    } catch (error) {
      if (error instanceof DispatchInterrupted) {
        // Nothing sent yet: the next reconcile on this profile resumes from the acknowledged create.
        patch(userId, row.id, sent
          ? { dispatchState: 'uncertain', state: 'uncertain', dispatchError: error.message }
          : { dispatchState: 'created', dispatchError: error.message })
        throw error
      }
      const safeRefusal = error instanceof RemoteTaskError && error.code !== 'unavailable'
      patch(userId, row.id, { dispatchState: safeRefusal ? 'failed' : 'uncertain',
        state: safeRefusal ? 'failed' : 'uncertain', dispatchError: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }

  async function read(userId: string, row: DelegationRow) {
    const connectionCurrent = world.captureConnection(userId)
    const assertActive = () => {
      active(userId)
      if (!connectionCurrent()) throw new RemoteTaskError('invalid_request', 'The cloud connection changed while reading the delegation.')
    }
    assertActive()
    const binding = bindingOf(row)
    if (!binding) return null
    const adapter = world.adapterFor(binding.adapter)
    const snapshot = await adapter.fetch(userId, binding)
    assertActive()
    if (snapshot.binding.id !== binding.id || snapshot.binding.adapter !== binding.adapter) {
      throw new RemoteTaskError('invalid_request', 'The service changed the delegated task identity.')
    }
    return { adapter, binding, snapshot, assertActive }
  }

  return {
    dispatch(userId: string, row: DelegationRow, task: TaskDto): Promise<DelegationRow> {
      const key = JSON.stringify([userId, row.id])
      const existing = pending.get(key)
      if (existing) return existing
      const operation = dispatchWork(userId, row, task).finally(() => pending.delete(key))
      pending.set(key, operation)
      return operation
    },

    async poll(userId: string, supplied: DelegationRow): Promise<CloudDelegationPoll> {
      const row = current(userId, supplied.id)
      const fetched = await read(userId, row)
      if (!fetched) return { result: null, warning: null, waitingOnUser: false, asks: [] }
      const { adapter, binding, snapshot, assertActive } = fetched
      if (row.taskId) world.applySnapshot(userId, row.taskId, snapshot)
      const blocked = snapshot.status === 'blocked'
      const terminal = ['completed', 'error', 'cancelled', 'archived'].includes(snapshot.status)
      if ((row.dispatchState === 'uncertain' || row.dispatchState === 'executing') &&
          (blocked || terminal || await adapter.liveSession(userId, binding) === true)) {
        assertActive()
        patch(userId, row.id, { dispatchState: 'running', dispatchError: null, state: 'running' })
      }
      // A task that ended after an answered question keeps its last `in_progress`
      // report. The terminal status is the newer fact; otherwise the requester is never woken.
      // The same holds for a `blocked` report on a task somebody finished or answered on the web:
      // a task that has ended is not waiting on a question.
      const stale = terminal && (snapshot.result?.status === 'in_progress' || snapshot.result?.status === 'blocked')
      const reported = stale ? undefined : snapshot.result
      const resumedWithoutReport = !snapshot.result && snapshot.status === 'in_progress' &&
        (row.state === 'blocked' || row.state === 'waiting_user')
      if (!blocked && !terminal && !reported && !resumedWithoutReport) {
        return { result: null, warning: null, waitingOnUser: false, asks: [] }
      }
      const caps = adapter.capabilities()
      const asks = blocked && caps.asks ? await adapter.listOpenAsks(userId, binding) : []
      assertActive()
      let result: RemoteDelegationResult | null = reported ?? (resumedWithoutReport ? {
        status: 'in_progress', summary: 'The cloud task resumed.', question: null,
        body: '', artifacts: [], audience: 'user'
      } : null)
      const warnings: string[] = []
      if (!result) {
        const comments = caps.comments ? await adapter.listComments(userId, binding) : []
        const newestFirst = [...comments].sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
        // An agent that files no `result` answers in plain messages; without them
        // the requester is woken with a status and none of the work.
        const said = newestFirst.filter(comment => comment.type === 'message' && comment.fromAgent && comment.body.trim())
        const filed = newestFirst.find(comment => comment.type === 'result')
        // The packet carries a bounded body and the answer is what the agent said last, so the
        // budget is spent from the newest message backwards and then put back in order.
        const kept: string[] = []
        let budget = FALLBACK_BODY_CHARS
        for (const comment of said) {
          if (kept.length && comment.body.length > budget) break
          kept.push(comment.body.slice(0, budget))
          budget -= comment.body.length + 2
          if (budget <= 0) break
        }
        const latest = filed ?? (kept.length ? { body: kept.reverse().join('\n\n') } : undefined)
        const summary = (filed ?? said[0])?.body.split('\n').find(line => line.trim()) ?? snapshot.errorMessage ??
          (blocked ? 'The cloud task is waiting on the user.' : snapshot.status === 'completed' ? 'The cloud task completed.' : 'The cloud task stopped.')
        result = { status: blocked ? 'blocked' : snapshot.status === 'completed' ? 'done' : 'failed',
          summary, body: latest?.body ?? snapshot.errorMessage ?? '', artifacts: [], audience: 'user' }
        warnings.push('The remote agent filed no structured result; the task status and its latest result comment or messages were used.')
      }
      const artifacts = [...result.artifacts]
      if (caps.readArtifacts && adapter.listArtifacts) artifacts.push(...await adapter.listArtifacts(userId, binding))
      else warnings.push(artifactWarning)
      assertActive()
      // Missing audience is explicitly a user question, including on newer servers.
      const audience = result.audience === 'requester' ? 'requester' : 'user'
      const normalized: DelegationResult = { ...result, audience, resultId: result.askId ?? undefined,
        question: result.status === 'blocked' ? result.question : null,
        artifacts: [...new Set(artifacts.map(artifact => artifact.ref))] }
      const warning = warnings.length ? warnings.join(' ') : null
      patch(userId, row.id, { warning })
      return { result: normalized, warning, waitingOnUser: result.status === 'blocked' && audience === 'user', asks }
    },

    async reply(userId: string, supplied: DelegationRow, message: string) {
      if (!message.trim()) throw new RemoteTaskError('invalid_request', 'A reply must contain a message.')
      const replyingTo = current(userId, supplied.id)
      const fetched = await read(userId, replyingTo)
      if (!fetched) throw new RemoteTaskError('invalid_request', 'That delegation has no remote task yet.')
      const { adapter, binding, snapshot, assertActive } = fetched
      const result = snapshot.result
      if (!result || result.status !== 'blocked' || result.audience !== 'requester' || !result.askId) {
        throw new RemoteTaskError('invalid_request', 'This cloud task is not waiting for a requester reply. User questions stay in the Inbox.')
      }
      if (!adapter.capabilities().asks) throw new UnsupportedRemoteOperation(adapter.id, 'answer a delegation')
      const asks = await adapter.listOpenAsks(userId, binding)
      assertActive()
      const ask = asks.find(candidate => candidate.id === result.askId)
      if (!ask) return { delivered: false }
      if (ask.audience === 'user' || ask.request.kind !== 'question') {
        throw new RemoteTaskError('invalid_request', 'That question must be answered by the user.')
      }
      const outcome = await adapter.answerAsk(userId, binding, ask.id, {
        kind: 'question', answers: ask.request.questions.map(() => [message])
      })
      assertActive()
      const latest = current(userId, supplied.id)
      // A newer report can arrive while the reply is being admitted. Only
      // clear the question represented by the state captured before sending.
      if (outcome.delivered && latest.resultDigest === replyingTo.resultDigest &&
          (latest.state === 'blocked' || latest.state === 'waiting_user')) {
        patch(userId, latest.id, { state: 'running', resultStatus: 'in_progress',
          question: null, questionAudience: null })
      }
      return outcome
    }
  }
}

// Load the production graph only when used; the transport core stays testable without Electron.
let production: Promise<ReturnType<typeof createDelegationCloudChannel>> | undefined
function productionChannel() {
  return production ??= Promise.all([
    import('../db/delegations'), import('../tasks/adapters'), import('./taskService'),
    import('../auth/activation'), import('../auth/scope'), import('./taskSyncService')
  ]).then(([{ delegationRepo }, { adapterFor }, { taskService }, { userActivation }, scope, { taskSyncService }]) =>
    createDelegationCloudChannel({
      adapterFor, get: (userId, id) => delegationRepo.getById(userId, id),
      patch: (userId, id, update) => delegationRepo.update(userId, id, update),
      isActive: userId => userActivation.isActivated() && scope.getProfileScopeUserId() === userId,
      captureConnection: userId => taskSyncService.captureConnection(userId),
      saveBinding: (userId, taskId, binding) => { taskService.bindRemote(userId, taskId, binding) },
      markRemote: (userId, taskId) => { taskService.handOffToRemote(userId, taskId) },
      applySnapshot: (userId, taskId, snapshot) => {
        taskService.applyRemoteSnapshot(userId, taskId, { status: snapshot.status, errorMessage: snapshot.errorMessage,
          updatedAt: snapshot.updatedAt, binding: snapshot.binding })
      }
    }))
}

export const delegationCloud = {
  async dispatch(userId: string, row: DelegationRow, task: TaskDto) {
    return (await productionChannel()).dispatch(userId, row, task)
  },
  async poll(userId: string, row: DelegationRow) { return (await productionChannel()).poll(userId, row) },
  async reply(userId: string, row: DelegationRow, message: string) {
    return (await productionChannel()).reply(userId, row, message)
  }
}
