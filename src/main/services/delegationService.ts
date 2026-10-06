import { isAbsolute, join } from 'node:path'
import { delegationRepo, type DelegationRow } from '../db/delegations'
import { handoverRepo } from '../db/handovers'
import { taskRepo } from '../db/tasks'
import { chatRepo } from '../db/chats'
import { visibleChat } from '../auth/chatScope'
import { taskInputRequestRepo } from '../db/taskInputRequests'
import { agentOverrideRepo } from '../db/agents'
import {
  delegationOriginKey, isOutsideOrigin, DELEGATION_TERMINAL_STATES, type DelegationResult
} from '../../shared/delegations'
import { parseTaskReport } from '../tasks/taskReport'
import { isHandoverId, MAX_HANDOVER_DEPTH, allowsAuto, HANDOVER_BRIEF_KEYS, HANDOVER_GATE_OPTIONS, recordedExecution } from '../../shared/handovers'
import { isTaskPriority, validateTaskCustomFields, type TaskCustomFields, type TaskPriority } from '../../shared/tasks'
import type { InboxAnswerCode, InboxAnswerResult } from '../../shared/inbox'
import type { RequestResolution } from '../../shared/localAgentRequests'
import { getProfileScopeUserId, getSettingsScopeUserId } from '../auth/scope'
import { userActivation } from '../auth/activation'
import { allAdapters } from '../tasks/adapters'
import { localAgentService } from './localAgents/localAgentService'
import { chatAnswersToAgent } from './chatRouting'
import { createDelegationBrief, createDelegationRevision, delegationBriefExists } from './delegationFiles'
import { taskService } from './taskService'
import { encodeTaskTarget, taskTargetKind } from '../../shared/taskTargets'
import { TASKS_PROTOCOL_VERSION } from '../kit/tasksProtocol'
import { taskExecutionService } from './taskExecutionService'
import type { RunScope } from './runExecutionService'
import { installTaskRunnerHooks } from './taskRunnerBridge'
import { createLogger } from '../logger/logger'

export interface DelegationSession {
  scope: RunScope
  chatId: string
  agentId: string
}

/** What `tasks_create` adds around a delegation; the delegation rules themselves are unchanged. */
export interface DelegationCreateOptions {
  /**
   * Called once the request is known to be new — after the idempotency lookup,
   * before anything is written — so a repeated id is answered even at a cap.
   * Throws to refuse.
   */
  beforeNew?(): void
}

interface Target {
  kind: 'bare' | 'kit' | 'cloud'
  agentId: string
  adapter?: string
}

interface TargetEntry {
  target: Target
  name: string
  /** A local agent's folder; null for a remote one. */
  folder: string | null
  acceptsDelegations: boolean
  /** The standing grant: a run starts without asking. */
  auto: boolean
  location: 'local' | 'remote'
  capabilities: TasksTargetCapabilities
}

/** What a target's channel carries, in the protocol's words. */
export interface TasksTargetCapabilities { structured_report: boolean; reply: boolean; priority: boolean; custom_fields: boolean; attachments: boolean }

/**
 * What each local channel carries today: a bare brief has fields for priority
 * and custom fields, a report.md and a revisions/ reply; a kit request has a
 * reply and nothing else. A remote target's are its adapter's.
 */
const LOCAL_CAPABILITIES: Record<'bare' | 'kit', TasksTargetCapabilities> = {
  bare: { structured_report: true, reply: true, priority: true, custom_fields: true, attachments: false },
  kit: { structured_report: true, reply: true, priority: false, custom_fields: false, attachments: false }
}

/** One `tasks_targets` entry, in the protocol's words (`tasks.schema.json`). */
export interface TasksTargetEntry {
  target: string
  name: string
  kind: 'folder' | 'kit' | 'cinna'
  location: 'local' | 'remote'
  folder: string | null
  acceptsDelegations: boolean
  capabilities: TasksTargetCapabilities
  protocol_version: number
  requires_approval: boolean
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

/**
 * Who may act from this session: an activated app, the profile the session
 * was opened under, a chat that answers to this agent, and an enabled agent.
 * Shared by the task tools (`taskToolService`), which act from the same
 * sessions.
 */
export function validateSession(session: DelegationSession) {
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

/** The `target` of a delegation: `tasks_create`'s `assignee`, decoded from the string `tasks_targets` returned. */
function requireTarget(value: unknown): Target {
  const target = value as Target | undefined
  if (
    !target ||
    !['bare', 'kit', 'cloud'].includes(target.kind) ||
    typeof target.agentId !== 'string' ||
    Object.keys(target).some((key) => !['kind', 'agentId', 'adapter'].includes(key))
  ) {
    throw new Error('Choose a target from tasks_targets.')
  }
  const adapterMismatch = target.kind === 'cloud'
    ? typeof target.adapter !== 'string' || !target.adapter.trim()
    : target.adapter !== undefined
  if (adapterMismatch) throw new Error('Use the exact target returned by tasks_targets.')
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

  const existingChat = row.gateChatId ? visibleChat(scope.profileUserId, row.gateChatId) : undefined
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

/**
 * `custom_fields` for a brief: valid task custom fields whose keys the brief
 * does not own (in any case — `Execution:` is a refusal there, not a field).
 */
function briefCustomFields(value: unknown): TaskCustomFields | undefined {
  if (value === undefined || value === null) return undefined
  const checked = validateTaskCustomFields(value)
  if ('error' in checked) throw new Error(checked.error)
  for (const key of Object.keys(checked.fields)) {
    if ((HANDOVER_BRIEF_KEYS as readonly string[]).includes(key.toLowerCase())) {
      throw new Error(`“${key}” is a brief field and cannot be a custom field.`)
    }
  }
  return Object.keys(checked.fields).length > 0 ? checked.fields : undefined
}

export const delegationService = {
  /** `tasks_targets`: every target with the string to pass as `tasks_create.assignee`. */
  async targets(session: DelegationSession, signal?: AbortSignal): Promise<{ protocol_version: number; targets: TasksTargetEntry[] }> {
    const entries = await this.targetEntries(session, signal)
    return {
      protocol_version: TASKS_PROTOCOL_VERSION,
      targets: entries.map((entry) => ({
        target: encodeTaskTarget(entry.target),
        name: entry.name,
        kind: taskTargetKind(entry.target.kind),
        location: entry.location,
        folder: entry.folder,
        acceptsDelegations: entry.acceptsDelegations,
        capabilities: entry.capabilities,
        protocol_version: TASKS_PROTOCOL_VERSION,
        requires_approval: !entry.auto
      }))
    }
  },

  /** The targets in the delegation service's own shape: what `create` matches a request against. */
  async targetEntries(session: DelegationSession, signal?: AbortSignal): Promise<TargetEntry[]> {
    signal?.throwIfAborted()
    const { source } = validateSession(session)
    const { profileUserId, settingsUserId } = session.scope

    const local: TargetEntry[] = localAgentService.list(settingsUserId).agents.map((agent) => ({
      target: { kind: agent.kind, agentId: agent.id },
      name: agent.name,
      folder: agent.path,
      acceptsDelegations: agent.enabled && agentOverrideRepo.get(profileUserId, agent.id)?.enabled !== false,
      auto: agent.kind === 'bare' ? agent.desktop.handovers === 'auto' : agent.desktop.delegations === 'auto',
      location: 'local' as const,
      capabilities: LOCAL_CAPABILITIES[agent.kind]
    }))
    for (const entry of local) {
      if (entry.target.kind !== 'bare' || !entry.auto) continue
      const { handoverGit } = await import('./handoverGit')
      entry.auto = allowsAuto(await handoverGit.check(entry.folder!))
    }

    const cloud: TargetEntry[] = []
    for (const adapter of allAdapters()) {
      try {
        const caps = adapter.capabilities()
        if (!caps.create || !caps.execute || !caps.assigneeDirectory) continue
        if (!(await adapter.availability(profileUserId)).ready) continue
        const support = await adapter.delegationSupport?.(profileUserId)
        const capabilities: TasksTargetCapabilities = {
          structured_report: support?.structuredResult === true,
          reply: support?.reply === true,
          priority: false,
          custom_fields: false,
          attachments: caps.writeArtifactKinds.includes('file')
        }

        for (const assignee of await adapter.listAssignees(profileUserId)) {
          if (assignee.kind !== 'remote_agent') continue
          cloud.push({
            target: { kind: 'cloud', agentId: assignee.ref, adapter: adapter.id },
            name: assignee.name ?? assignee.ref,
            folder: null,
            acceptsDelegations: true,
            auto: source.desktop.cloudDelegations === 'auto',
            location: 'remote',
            capabilities
          })
        }
      } catch (error) {
        logger.warn('Could not read remote delegation targets', { adapter: adapter.id, error: String(error) })
      }
    }

    signal?.throwIfAborted()
    return [...local, ...cloud]
  },

  /**
   * Delegate work: `tasks_create` with an `assignee`, its arguments mapped to
   * this shape (`target`, `brief`) by `taskToolService`. The task it creates
   * records the requesting agent and the delegation depth as its provenance.
   */
  async create(session: DelegationSession, input: Record<string, unknown>, signal?: AbortSignal, options: DelegationCreateOptions = {}): Promise<unknown> {
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
      throw new Error('Choose category draft or ready for a delegation.')
    }
    const target = requireTarget(input.target)
    // Drafts, and the priority and custom fields a brief carries as a task
    // file would, exist only in a bare folder's brief; other channels have
    // nowhere to put them.
    if (target.kind !== 'bare' && (input.status === 'draft' || input.priority !== undefined || input.customFields !== undefined)) {
      throw new Error(input.status === 'draft'
        ? 'Drafts are available for bare-folder briefs only.'
        : 'priority and custom_fields travel only in a bare-folder brief; leave them out for this target.')
    }
    const group = input.group as string | undefined
    const adapterId = target.adapter ?? null
    if (input.priority !== undefined && !isTaskPriority(input.priority)) {
      throw new Error('Choose a priority: low, normal, high or urgent.')
    }
    const priority = input.priority as TaskPriority | undefined
    const customFields = briefCustomFields(input.customFields)

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
          // An omitted `execution` has no opinion, so it matches whatever the first call recorded
          // (including a pre-upgrade `ask`); an explicit value still has to match.
          (input.execution !== undefined && existing.execution !== input.execution)
        if (differs) throw new Error('This id already belongs to another brief.')
        return { delegationId: existing.id, ...delegationRepo.toDto(existing) }
      }

      // One chain for delegations and own-queue tasks: the chat's task may be
      // an own-queue task deeper than any delegation above it.
      const depth = Math.max(parent?.depth ?? 0, task?.chainDepth ?? 0) + 1
      if (depth > MAX_HANDOVER_DEPTH) throw new Error(`Delegations are limited to depth ${MAX_HANDOVER_DEPTH}.`)

      const targetEntry = (await this.targetEntries(session, signal)).find((entry) => sameTarget(entry.target, target))
      signal?.throwIfAborted()
      const fresh = validateSession(session)
      if ((fresh.task?.id ?? null) !== (task?.id ?? null) || (fresh.parent?.depth ?? 0) !== (parent?.depth ?? 0)) {
        throw new Error('This session’s task changed. Try again.')
      }
      if (!targetEntry?.acceptsDelegations) throw new Error('That target is unavailable for delegation.')
      // A repeat of a bare brief already written (a draft has no delegation
      // row yet) is answered from its file below, not a new request.
      const repeatedBrief = target.kind === 'bare' && !!targetEntry.folder && delegationBriefExists(targetEntry.folder, id)
      if (!existing && !repeatedBrief) options.beforeNew?.()
      // Absent stays absent: the receiver's setting (or, for cloud, the sender's grant) decides,
      // and only an explicit `ask` forces a gate.
      const execution = input.execution === 'ask' || input.execution === 'auto' ? input.execution : null

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
          group,
          ...(priority ? { priority } : {}),
          ...(customFields ? { customFields } : {})
        })
        const { handoverService } = await import('./handoverService')
        await handoverService.scanFolderNow(targetEntry.folder!)

        const handover = handoverRepo.byAgentAndHandoverId(target.agentId, id)
        const delegation = handover ? delegationRepo.byHandoverId(profileUserId, handover.id) : undefined
        // The intake made the task; the tool call that asked for it is its provenance.
        if (handover?.taskId) taskRepo.setProvenance(profileUserId, handover.taskId, { createdByAgentId: session.agentId, chainDepth: depth })
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
          execution: recordedExecution(execution),
          groupId: group,
          remoteConnectionId: adapterId
        },
        () =>
          taskService.create(profileUserId, {
            title,
            goal: brief,
            description: `${brief}\n\nThis is delegated work. Report progress, questions and completion with tasks_report.`,
            assigneeKind: target.kind === 'kit' ? 'agent' : 'remote_agent',
            assigneeAgentId: target.agentId,
            assigneeName: targetEntry.name,
            executor: 'desktop',
            origin: 'local',
            createdByAgentId: session.agentId,
            chainDepth: depth
          })
      )

      // A chain somebody outside the app started (a terminal-written brief, later a cloud task) never
      // inherits the standing cloud grant: nobody in the app chose what is about to leave the machine.
      const root = parent ? delegationRepo.getById(profileUserId, parent.rootDelegationId) ?? parent : undefined
      const outside = [parent, root].some((link) => link && isOutsideOrigin(link.originKind))
      const allowed = target.kind === 'cloud'
        ? !outside && fresh.source.desktop.cloudDelegations === 'auto'
        : localAgentService.get(settingsUserId, target.agentId).desktop.delegations === 'auto'

      if (execution !== 'ask' && allowed) {
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

  /**
   * `tasks_report` on a delegation executor's own task: the result goes
   * through the bus (`delegationLifecycle.applyResult`), which writes the
   * task's status, handoff note and artifacts and wakes the requester. An
   * identical repeat is recognised there by its digest and changes nothing.
   */
  async report(session: DelegationSession, input: Record<string, unknown>) {
    const { task, source } = validateSession(session)
    const row = task ? delegationRepo.byTaskId(session.scope.profileUserId, task.id) : undefined
    if (!row || row.targetAgentId !== session.agentId || row.channel === 'cloud') {
      throw new Error('This is not a delegation executor session.')
    }
    const report = parseTaskReport(input, 'requester')
    // A relative artifact is relative to the executor's own folder.
    const absolute = (ref: string) => (/^https?:\/\//.test(ref) || isAbsolute(ref) ? ref : join(source.path, ref))
    const result: DelegationResult = {
      status: report.status,
      summary: report.summary,
      question: report.question ?? undefined,
      artifacts: report.artifacts.map((artifact) => absolute(artifact.ref)),
      ...(report.body ? { body: report.body } : {}),
      audience: report.audience
    }
    const { delegationLifecycle } = await import('./delegationLifecycle')
    delegationLifecycle.applyResult(session.scope, row, result)
    return { delegationId: row.id, taskId: row.taskId, status: result.status }
  },

  /** `tasks_reply`: `ref` is the delegated task (or, as before, the delegation's own id). */
  async reply(session: DelegationSession, input: Record<string, unknown>) {
    const ref = requiredString(input.ref, 'ref', 128)
    const byTask = delegationRepo.byTaskId(session.scope.profileUserId, ref)
    const row = owned(session, byTask?.id ?? ref)
    const message = requiredString(input.message, 'message', 64_000)

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
