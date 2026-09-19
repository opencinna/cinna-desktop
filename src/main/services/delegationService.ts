import { isAbsolute, join } from 'node:path'
import { delegationRepo, type DelegationRow } from '../db/delegations'
import { handoverRepo } from '../db/handovers'
import { taskRepo } from '../db/tasks'
import { chatRepo } from '../db/chats'
import { taskInputRequestRepo } from '../db/taskInputRequests'
import { agentOverrideRepo } from '../db/agents'
import {
  delegationOriginKey, isOutsideOrigin, DELEGATION_TERMINAL_STATES, type DelegationResult
} from '../../shared/delegations'
import { isHandoverId, MAX_HANDOVER_DEPTH, allowsAuto, HANDOVER_GATE_OPTIONS } from '../../shared/handovers'
import type { InboxAnswerCode, InboxAnswerResult } from '../../shared/inbox'
import type { RequestResolution } from '../../shared/localAgentRequests'
import { getProfileScopeUserId, getSettingsScopeUserId } from '../auth/scope'
import { userActivation } from '../auth/activation'
import { allAdapters } from '../tasks/adapters'
import { localAgentService } from './localAgents/localAgentService'
import { chatAnswersToAgent } from './chatRouting'
import { createDelegationBrief, createDelegationRevision } from './delegationFiles'
import { taskService } from './taskService'
import { taskExecutionService } from './taskExecutionService'
import type { RunScope } from './runExecutionService'
import { installTaskRunnerHooks } from './taskRunnerBridge'
import { createLogger } from '../logger/logger'

export interface DelegationSession {
  scope: RunScope
  chatId: string
  agentId: string
}

interface Target {
  kind: 'bare' | 'kit' | 'cloud'
  agentId: string
  adapter?: string
}

interface CloudTargetEntry {
  target: Target
  name: string
  folder: null
  acceptsDelegations: boolean
  auto: boolean
}

const logger = createLogger('delegations')
const creating = new Map<string, Promise<unknown>>()
const starting = new Set<string>()
// The same word and the same order as the file-handover gate (`HANDOVER_GATE_OPTIONS`): run, the
// standing permission, skip. One action has one label wherever the user meets it.
const RUN = HANDOVER_GATE_OPTIONS.run
const SKIP = HANDOVER_GATE_OPTIONS.skip
const GATE_PREFIX = 'delegation:'

/** Names for the card. A gate that says "the selected local agent" asks the user to approve a stranger. */
function gateNames(scope: RunScope, row: DelegationRow): { executor: string; requester: string } {
  const nameOf = (agentId: string | null): string | null => {
    if (!agentId) return null
    try { return localAgentService.get(scope.settingsUserId, agentId).name } catch { return null }
  }
  let assignee: string | null = null
  try { assignee = row.taskId ? taskService.getById(scope.profileUserId, row.taskId).assignee.name : null } catch { /* named generically below */ }
  return {
    executor: assignee ?? nameOf(row.channel === 'cloud' ? null : row.targetAgentId) ?? (row.channel === 'cloud' ? 'a cloud agent' : 'a local agent'),
    requester: nameOf(row.originAgentId) ?? 'another agent'
  }
}

function autoLabel(scope: RunScope, row: DelegationRow): string {
  const { executor, requester } = gateNames(scope, row)
  return row.channel === 'cloud'
    ? `Send and let ${requester} delegate to the cloud without asking`
    : `Run and auto-run delegations to ${executor}`
}

function requiredString(value: unknown, name: string, max = 100_000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(`Provide a nonempty ${name} (at most ${max} characters).`)
  }
  return value.trim()
}

function validateSession(session: DelegationSession) {
  const { profileUserId, settingsUserId } = session.scope
  userActivation.requireActivated()
  if (getProfileScopeUserId() !== profileUserId) throw new Error('The active profile changed.')

  const refusal = chatAnswersToAgent(profileUserId, session.chatId, session.agentId)
  if (refusal) throw new Error(`This session cannot delegate: ${refusal}`)

  const source = localAgentService.get(settingsUserId, session.agentId)
  if (!source.enabled || agentOverrideRepo.get(profileUserId, source.id)?.enabled === false) {
    throw new Error('The requesting agent is disabled.')
  }

  const task = taskRepo.getByChatId(profileUserId, session.chatId)
  const parent = task ? delegationRepo.byTaskId(profileUserId, task.id) : undefined
  return { source, task, parent }
}

function originFor(session: DelegationSession, taskId: string | null) {
  return {
    originKind: taskId ? 'local_task' as const : 'local_chat' as const,
    originChatId: session.chatId,
    originTaskId: taskId,
    originAgentId: session.agentId
  }
}

function owned(session: DelegationSession, id: string): DelegationRow {
  const { task } = validateSession(session)
  const row = delegationRepo.getById(session.scope.profileUserId, id)
  const fromThisChat = row?.originChatId === session.chatId
  const fromThisTask = !!task && row?.originTaskId === task.id
  if (!row || (!fromThisChat && !fromThisTask) || row.originAgentId !== session.agentId) {
    throw new Error('This conversation did not request that delegation.')
  }
  return row
}

/** The `target` argument of `handover_create`, exactly as `handover_targets` returned it. */
function requireTarget(value: unknown): Target {
  const target = value as Target | undefined
  if (
    !target ||
    !['bare', 'kit', 'cloud'].includes(target.kind) ||
    typeof target.agentId !== 'string' ||
    Object.keys(target).some((key) => !['kind', 'agentId', 'adapter'].includes(key))
  ) {
    throw new Error('Choose a target from handover_targets.')
  }
  const adapterMismatch = target.kind === 'cloud'
    ? typeof target.adapter !== 'string' || !target.adapter.trim()
    : target.adapter !== undefined
  if (adapterMismatch) throw new Error('Use the exact target returned by handover_targets.')
  return target
}

function sameTarget(offered: { kind: string; agentId: string; adapter?: string }, target: Target): boolean {
  if (offered.kind !== target.kind || offered.agentId !== target.agentId) return false
  return target.kind !== 'cloud' || ('adapter' in offered && offered.adapter === target.adapter)
}

function createGateChat(scope: RunScope, row: DelegationRow) {
  return chatRepo.create(scope.profileUserId, {
    title: row.title,
    router: 'direct',
    agentId: row.channel === 'local' ? row.targetAgentId : null,
    hiddenFromList: true
  })
}

function gateQuestion(scope: RunScope, row: DelegationRow): string {
  const { executor, requester } = gateNames(scope, row)
  return row.channel === 'cloud'
    ? `Send “${row.title}” to ${executor} in the cloud, requested by ${requester}? Its brief leaves this machine and the service may charge for execution.`
    : `Run “${row.title}” on ${executor}, requested by ${requester}?`
}

function openGate(scope: RunScope, row: DelegationRow): void {
  if (!row.taskId || row.gateRequestId) return

  const existingChat = row.gateChatId ? chatRepo.getOwned(scope.profileUserId, row.gateChatId) : undefined
  const chat = existingChat ?? createGateChat(scope, row)
  const requestId = `${GATE_PREFIX}${row.id}`

  taskInputRequestRepo.open({
    requestId,
    taskId: row.taskId,
    chatId: chat.id,
    agentId: null,
    deliveryOwner: 'handover',
    resume: 'reply',
    request: {
      kind: 'question',
      questions: [{
        header: 'Delegation',
        question: gateQuestion(scope, row),
        options: [
          { label: RUN },
          { label: autoLabel(scope, row), description: 'Saved on this machine; change it on the agent’s Permissions tab.' },
          { label: SKIP }
        ],
        multiSelect: false
      }]
    }
  })
  delegationRepo.update(scope.profileUserId, row.id, {
    state: 'gated',
    gateRequestId: requestId,
    gateChatId: chat.id
  })
}

async function start(scope: RunScope, row: DelegationRow): Promise<void> {
  if (!row.taskId) throw new Error('This delegation’s task is gone.')
  if (starting.has(row.id)) return
  starting.add(row.id)
  try {
    if (getProfileScopeUserId() !== scope.profileUserId) throw new Error('The active profile changed.')

    if (row.channel === 'cloud') {
      const { delegationCloud } = await import('./delegationCloud')
      const task = taskService.getById(scope.profileUserId, row.taskId)
      await delegationCloud.dispatch(scope.profileUserId, row, task)
      delegationRepo.update(scope.profileUserId, row.id, { gateRequestId: null, gateChatId: null })
      if (row.gateChatId) chatRepo.permanentDelete(scope.profileUserId, row.gateChatId)
      return
    }

    const result = await taskExecutionService.start(
      scope,
      row.taskId,
      { kind: 'agent', agentId: row.targetAgentId },
      row.gateChatId ? { reuseChatId: row.gateChatId } : {}
    )
    delegationRepo.update(scope.profileUserId, row.id, {
      state: 'running',
      runId: result.runId,
      gateRequestId: null,
      gateChatId: null
    })
    const { delegationLifecycle } = await import('./delegationLifecycle')
    delegationLifecycle.watchTurn(scope, row.id, result.completed)
  } finally {
    starting.delete(row.id)
  }
}

async function startFailed(scope: RunScope, row: DelegationRow, error: unknown): Promise<void> {
  const current = delegationRepo.getById(scope.profileUserId, row.id) ?? row
  delegationRepo.update(scope.profileUserId, row.id, { warning: `start_refused:${String(error)}` })

  if (current.channel === 'cloud' && current.dispatchState) {
    // Once a remote write was attempted, the durable dispatch journal decides
    // recovery. Reopening an ordinary Run gate would disguise uncertain work.
    if (current.dispatchState === 'failed') {
      const { delegationLifecycle } = await import('./delegationLifecycle')
      delegationLifecycle.applyResult(scope, current, {
        status: 'failed',
        summary: current.dispatchError ?? String(error)
      })
    }
    return
  }
  openGate(scope, { ...current, gateRequestId: null, gateChatId: null })
}

function refused(code: InboxAnswerCode, reason: string): InboxAnswerResult {
  return { ok: false, code, reason }
}

export const delegationService = {
  async targets(session: DelegationSession, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const { source } = validateSession(session)
    const { profileUserId, settingsUserId } = session.scope

    const local = localAgentService.list(settingsUserId).agents.map((agent) => ({
      target: { kind: agent.kind, agentId: agent.id },
      name: agent.name,
      folder: agent.path,
      acceptsDelegations: agent.enabled && agentOverrideRepo.get(profileUserId, agent.id)?.enabled !== false,
      auto: agent.kind === 'bare' ? agent.desktop.handovers === 'auto' : agent.desktop.delegations === 'auto'
    }))
    for (const entry of local) {
      if (entry.target.kind !== 'bare' || !entry.auto) continue
      const { handoverGit } = await import('./handoverGit')
      entry.auto = allowsAuto(await handoverGit.check(entry.folder))
    }

    const cloud: CloudTargetEntry[] = []
    for (const adapter of allAdapters()) {
      try {
        const caps = adapter.capabilities()
        if (!caps.create || !caps.execute || !caps.assigneeDirectory) continue
        if (!(await adapter.availability(profileUserId)).ready) continue

        for (const assignee of await adapter.listAssignees(profileUserId)) {
          if (assignee.kind !== 'remote_agent') continue
          cloud.push({
            target: { kind: 'cloud', agentId: assignee.ref, adapter: adapter.id },
            name: assignee.name ?? assignee.ref,
            folder: null,
            acceptsDelegations: true,
            auto: source.desktop.cloudDelegations === 'auto'
          })
        }
      } catch (error) {
        logger.warn('Could not read remote delegation targets', { adapter: adapter.id, error: String(error) })
      }
    }

    signal?.throwIfAborted()
    return [...local, ...cloud]
  },

  list(session: DelegationSession) {
    const { task } = validateSession(session)
    return delegationRepo
      .listForOrigin(session.scope.profileUserId, session.chatId, task?.id)
      .map((row) => delegationRepo.toDto(row))
  },

  async create(session: DelegationSession, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted()
    const { task, parent } = validateSession(session)
    const { profileUserId, settingsUserId } = session.scope

    const id = requiredString(input.id, 'id', 64)
    if (!isHandoverId(id) || (input.group !== undefined && !isHandoverId(input.group))) {
      throw new Error('Use a valid handover id and group.')
    }
    const title = requiredString(input.title, 'title', 300)
    if (/[\r\n]/.test(title)) throw new Error('The title must be one line.')
    const brief = requiredString(input.brief, 'brief')
    if (input.execution !== undefined && input.execution !== 'ask' && input.execution !== 'auto') {
      throw new Error('Choose ask or auto execution.')
    }
    if (input.status !== undefined && input.status !== 'draft' && input.status !== 'ready') {
      throw new Error('Choose draft or ready status.')
    }
    const target = requireTarget(input.target)
    if (target.kind !== 'bare' && input.status === 'draft') {
      throw new Error('Drafts are available for bare-folder briefs only.')
    }
    const group = input.group as string | undefined
    const adapterId = target.adapter ?? null

    const origin = originFor(session, task?.id ?? null)
    const originKey = delegationOriginKey(origin)
    const key = JSON.stringify([profileUserId, originKey, target.kind, target.agentId, adapterId, id])
    const inflight = creating.get(key)
    if (inflight) return inflight

    const work = (async () => {
      // The key carries the origin task, so a chat that gained its task after asking would otherwise
      // miss its own earlier request and delegate the same work twice.
      const originKeys = [originKey, ...(task ? [delegationOriginKey(originFor(session, null))] : [])]
      const existing = originKeys
        .map((candidate) =>
          delegationRepo.byRequesterKey(profileUserId, candidate, target.kind, target.agentId, id, adapterId)
        )
        .find(Boolean)
      if (existing && target.kind !== 'bare') {
        const differs =
          existing.title !== title ||
          existing.brief !== brief ||
          (existing.remoteConnectionId ?? null) !== adapterId ||
          (existing.groupId ?? null) !== (input.group ?? null) ||
          existing.execution !== (input.execution ?? 'ask')
        if (differs) throw new Error('This id already belongs to another brief.')
        return { delegationId: existing.id, ...delegationRepo.toDto(existing) }
      }

      const depth = (parent?.depth ?? 0) + 1
      if (depth > MAX_HANDOVER_DEPTH) throw new Error(`Delegations are limited to depth ${MAX_HANDOVER_DEPTH}.`)

      const targetEntry = (await this.targets(session, signal)).find((entry) => sameTarget(entry.target, target))
      signal?.throwIfAborted()
      const fresh = validateSession(session)
      if ((fresh.task?.id ?? null) !== (task?.id ?? null) || (fresh.parent?.depth ?? 0) !== (parent?.depth ?? 0)) {
        throw new Error('This session’s task changed. Try again.')
      }
      if (!targetEntry?.acceptsDelegations) throw new Error('That target is unavailable for delegation.')
      const execution = input.execution === 'auto' ? 'auto' : 'ask'

      if (target.kind === 'bare') {
        const file = createDelegationBrief({
          folder: targetEntry.folder!,
          id,
          title,
          brief,
          execution,
          status: input.status === 'draft' ? 'draft' : 'ready',
          agentId: session.agentId,
          chatId: session.chatId,
          taskId: task?.id ?? null,
          depth,
          group
        })
        const { handoverService } = await import('./handoverService')
        await handoverService.scanFolderNow(targetEntry.folder!)

        const handover = handoverRepo.byAgentAndHandoverId(target.agentId, id)
        const delegation = handover ? delegationRepo.byHandoverId(profileUserId, handover.id) : undefined
        return {
          ...file,
          id: delegation?.id ?? null,
          delegationId: delegation?.id ?? null,
          handoverId: id,
          taskId: handover?.taskId ?? null,
          state: delegation?.state ?? 'draft'
        }
      }

      const row = delegationRepo.createWithTask(
        {
          userId: profileUserId,
          requesterKey: id,
          ...origin,
          originKey,
          targetKind: target.kind,
          targetAgentId: target.agentId,
          channel: target.kind === 'kit' ? 'local' : 'cloud',
          depth,
          ...(parent ? { rootDelegationId: parent.rootDelegationId } : {}),
          title,
          brief,
          execution,
          groupId: group,
          remoteConnectionId: adapterId
        },
        () =>
          taskService.create(profileUserId, {
            title,
            goal: brief,
            description: `${brief}\n\nThis is delegated work. Report progress, questions and completion with handover_report.`,
            assigneeKind: target.kind === 'kit' ? 'agent' : 'remote_agent',
            assigneeAgentId: target.agentId,
            assigneeName: targetEntry.name,
            executor: 'desktop',
            origin: 'local'
          })
      )

      // A chain somebody outside the app started (a terminal-written brief, later a cloud task) never
      // inherits the standing cloud grant: nobody in the app chose what is about to leave the machine.
      const root = parent ? delegationRepo.getById(profileUserId, parent.rootDelegationId) ?? parent : undefined
      const outside = [parent, root].some((link) => link && isOutsideOrigin(link.originKind))
      const allowed = target.kind === 'cloud'
        ? !outside && fresh.source.desktop.cloudDelegations === 'auto'
        : localAgentService.get(settingsUserId, target.agentId).desktop.delegations === 'auto'

      if (execution === 'auto' && allowed) {
        try {
          await start(session.scope, row)
        } catch (error) {
          await startFailed(session.scope, row, error)
        }
      } else {
        openGate(session.scope, row)
      }
      return { delegationId: row.id, ...delegationRepo.toDto(delegationRepo.getById(profileUserId, row.id)!) }
    })()

    creating.set(key, work)
    try {
      return await work
    } finally {
      creating.delete(key)
    }
  },

  async report(session: DelegationSession, input: Record<string, unknown>) {
    const { task, source } = validateSession(session)
    const row = task ? delegationRepo.byTaskId(session.scope.profileUserId, task.id) : undefined
    if (!row || row.targetAgentId !== session.agentId || row.channel === 'cloud') {
      throw new Error('This is not a delegation executor session.')
    }
    if (!['in_progress', 'blocked', 'done', 'failed'].includes(String(input.status))) {
      throw new Error('Choose a valid report status.')
    }
    const summary = requiredString(input.summary, 'summary', 2000)
    if (/[\r\n]/.test(summary)) throw new Error('The summary must be one line.')

    const validArtifacts =
      input.artifacts === undefined ||
      (Array.isArray(input.artifacts) &&
        input.artifacts.length <= 100 &&
        input.artifacts.every((item) => typeof item === 'string' && item.length <= 4096))
    if (!validArtifacts) throw new Error('Artifacts must be a list of file paths or URLs.')

    // A relative artifact is relative to the executor's own folder.
    const absolute = (ref: string) => (/^https?:\/\//.test(ref) || isAbsolute(ref) ? ref : join(source.path, ref))
    const result: DelegationResult = {
      status: input.status as DelegationResult['status'],
      summary,
      question: input.question === undefined ? undefined : requiredString(input.question, 'question', 4000),
      artifacts: (input.artifacts as string[] | undefined)?.map(absolute)
    }
    const { delegationLifecycle } = await import('./delegationLifecycle')
    delegationLifecycle.applyResult(session.scope, row, result)
    return { delegationId: row.id, status: result.status }
  },

  async reply(session: DelegationSession, input: Record<string, unknown>) {
    const row = owned(session, requiredString(input.id, 'delegation id', 100))
    const message = requiredString(input.message, 'message')

    if (row.channel === 'cloud') {
      const { delegationCloud } = await import('./delegationCloud')
      return delegationCloud.reply(session.scope.profileUserId, row, message)
    }
    if (row.channel === 'file') {
      const handover = row.handoverId ? handoverRepo.getById(row.userId, row.handoverId) : undefined
      if (!handover) throw new Error('This file handover is no longer available.')
      const path = createDelegationRevision(handover.folderPath, handover.handoverId, message)
      const { handoverService } = await import('./handoverService')
      await handoverService.scanFolderNow(handover.folderPath)
      return { delegationId: row.id, revisionPath: path }
    }
    const { delegationReplies } = await import('./delegationReplies')
    return delegationReplies.enqueue(session.scope, row, message)
  },

  answer(userId: string, requestId: string, resolution: RequestResolution): Promise<InboxAnswerResult> | null {
    if (!requestId.startsWith(GATE_PREFIX)) return null
    return (async () => {
      const row = delegationRepo.getById(userId, requestId.slice(GATE_PREFIX.length))
      const waiting =
        !!row?.taskId &&
        row.gateRequestId === requestId &&
        taskInputRequestRepo.getById(requestId)?.status === 'open'
      if (!row || !waiting) return refused('no_longer_waiting', 'This delegation is no longer waiting.')

      const choice = resolution.kind === 'question' ? resolution.answers?.[0]?.[0] : undefined
      // Matched against the card as it was shown: the standing label carries an agent's name, and
      // a rename between asking and answering must not turn the user's click into "malformed".
      const asked = taskInputRequestRepo.getById(requestId)?.request
      const offered = asked?.kind === 'question' ? (asked.questions[0]?.options ?? []).map((option) => option.label) : []
      const standing = offered.find((label) => label !== RUN && label !== SKIP)
      if (!choice || !offered.includes(choice)) {
        return refused('malformed', 'Choose one of the offered options.')
      }
      if (userId !== getProfileScopeUserId()) return refused('unavailable', 'Switch to this profile first.')
      const scope = { profileUserId: userId, settingsUserId: getSettingsScopeUserId() }

      if (choice === standing) {
        const cloud = row.channel === 'cloud'
        if (!row.originAgentId && cloud) return refused('unavailable', 'This delegation has no requesting agent.')
        localAgentService.setDelegationPermission(
          scope.settingsUserId,
          cloud ? row.originAgentId! : row.targetAgentId,
          cloud ? 'cloudDelegations' : 'delegations',
          'auto'
        )
      }
      if (!taskInputRequestRepo.settle(requestId, 'answered', resolution)) {
        return refused('already_answered', 'This gate was already answered.')
      }
      delegationRepo.update(userId, row.id, { gateRequestId: null, state: 'seen' })

      if (choice === SKIP) {
        const { delegationLifecycle } = await import('./delegationLifecycle')
        delegationLifecycle.skip(scope, row, 'The user skipped this delegation.')
        delegationRepo.update(userId, row.id, { gateChatId: null })
        if (row.gateChatId) chatRepo.permanentDelete(userId, row.gateChatId)
        return { ok: true as const }
      }

      try {
        await start(scope, row)
      } catch (error) {
        delegationRepo.update(userId, row.id, { warning: `start_refused:${String(error)}`, gateChatId: null })
        if (row.gateChatId) chatRepo.permanentDelete(userId, row.gateChatId)
        await startFailed(scope, row, error)
        return refused('unavailable', String(error))
      }
      return { ok: true as const }
    })()
  },

  async reconcile(scope: RunScope): Promise<void> {
    const { delegationLifecycle } = await import('./delegationLifecycle')
    delegationLifecycle.sweepLostRuns(scope)
    const { delegationReplies } = await import('./delegationReplies')
    delegationReplies.reconcile(scope)

    for (const row of delegationRepo.list(scope.profileUserId)) {
      if (getProfileScopeUserId() !== scope.profileUserId) return
      if (starting.has(row.id)) continue

      if (row.channel === 'cloud' && row.dispatchState === 'failed' && !row.resultDigest && row.taskId) {
        delegationLifecycle.applyResult(scope, row, {
          status: 'failed',
          summary: row.dispatchError ?? 'The remote dispatch failed.'
        })
      }
      if (row.channel === 'file' || !row.taskId || DELEGATION_TERMINAL_STATES.has(row.state)) continue

      try {
        // A crash after task creation but before its gate must not strand work.
        const gateOpen = () =>
          !!row.gateRequestId && taskInputRequestRepo.getById(row.gateRequestId)?.status === 'open'
        const stranded = row.state === 'seen' || (row.state === 'gated' && !gateOpen())
        if (stranded && !row.dispatchState) {
          const task = taskService.getById(scope.profileUserId, row.taskId)
          if (row.channel === 'local' && task.chatId) {
            delegationRepo.update(row.userId, row.id, { state: 'running', gateRequestId: null, gateChatId: null })
          } else {
            openGate(scope, { ...row, gateRequestId: null })
          }
          continue
        }
        if (row.channel !== 'cloud') continue

        const { delegationCloud } = await import('./delegationCloud')
        let current = row
        if (row.dispatchState && !['running', 'failed', 'uncertain'].includes(row.dispatchState)) {
          const task = taskService.getById(scope.profileUserId, row.taskId)
          current = await delegationCloud.dispatch(scope.profileUserId, row, task)
        }
        if (!current.remoteTaskId) continue

        const poll = await delegationCloud.poll(scope.profileUserId, current)
        if (poll.result) delegationLifecycle.applyResult(scope, current, poll.result)
        if (poll.warning && poll.warning !== current.warning) {
          delegationRepo.update(row.userId, row.id, { warning: poll.warning })
        }
      } catch (error) {
        logger.warn('Could not reconcile a delegation', { id: row.id, error: String(error) })
      }
    }
  }
}

installTaskRunnerHooks(
  {
    answer: delegationService.answer,
    taskChanged: () => {},
    chatRemoved: () => {},
    profileRemoved: () => {}
  },
  'delegations'
)
