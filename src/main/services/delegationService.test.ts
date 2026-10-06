import { beforeEach, describe, expect, it, vi } from 'vitest'
import { delegationRepo, type DelegationRow } from '../db/delegations'
import { encodeTaskTarget, type TaskTargetRef } from '../../shared/taskTargets'

const world = vi.hoisted(() => ({
  rows: new Map<string, DelegationRow>(), tasks: new Map<string, any>(), requests: new Map<string, any>(), parent: null as DelegationRow | null,
  task: null as { id: string } | null, active: 'profile', ownCreated: 0, handover: undefined as { id: string; taskId: string } | undefined, sourceAuto: false, targetAuto: false,
  briefs: new Set<string>(), start: vi.fn(), cloud: vi.fn(), result: vi.fn(), scan: vi.fn(), file: vi.fn(), permission: vi.fn(), refusal: null as string | null
}))
vi.mock('../db/delegations', () => ({ delegationRepo: {
  createWithTask: (input: any, createTask: () => { id: string }) => { const row = delegationRepo.insert(input); const task = createTask(); return delegationRepo.update(input.userId, row.id, { taskId: task.id }) },
  insert: (input: any) => { const row = { id: `d${world.rows.size}`, state: 'seen', taskId: null, remoteConnectionId: null, groupId: null, ...input }; world.rows.set(row.id, row); return row },
  update: (_user: string, id: string, patch: any) => { const row = world.rows.get(id); if (row) Object.assign(row, patch); return row },
  getById: (user: string, id: string) => { const row = world.rows.get(id); return row?.userId === user ? row : undefined },
  byHandoverId: () => undefined,
  byTaskId: () => world.parent,
  byRequesterKey: (user: string, origin: string, kind: string, target: string, key: string) => [...world.rows.values()].find((r) => r.userId === user && r.originKey === origin && r.targetKind === kind && r.targetAgentId === target && r.requesterKey === key),
  listForOrigin: () => [...world.rows.values()], toDto: (row: any) => row, list: () => [...world.rows.values()], listByOriginAgent: () => [],
  countForOriginChat: (user: string, chat: string) => [...world.rows.values()].filter((row) => row.userId === user && row.originChatId === chat).length
} }))
vi.mock('../db/handovers', () => ({ handoverRepo: { byAgentAndHandoverId: () => world.handover } }))
vi.mock('../db/tasks', () => ({ taskRepo: { getByChatId: () => world.task, countCreatedInChat: () => world.ownCreated, setProvenance: vi.fn(), list: () => [] } }))
vi.mock('../db/chats', () => ({ chatRepo: { create: () => ({ id: 'gate-chat' }), getOwned: () => ({ id: 'gate-chat' }), permanentDelete: vi.fn() } }))
vi.mock('../db/agents', () => ({ agentOverrideRepo: { get: () => undefined } }))
vi.mock('../db/taskInputRequests', () => ({ taskInputRequestRepo: {
  open: (input: any) => { const row = { ...input, status: 'open' }; world.requests.set(input.requestId, row); return row },
  getById: (id: string) => world.requests.get(id), settle: (id: string) => { const row = world.requests.get(id); if (row?.status !== 'open') return undefined; row.status = 'answered'; return row }
} }))
vi.mock('../auth/scope', () => ({ getProfileScopeUserId: () => world.active, getSettingsScopeUserId: () => 'settings' }))
vi.mock('../auth/activation', () => ({ userActivation: { requireActivated: vi.fn() } }))
vi.mock('../logger/logger', () => ({ createLogger: () => ({ warn: vi.fn() }) }))
vi.mock('../tasks/adapters', () => ({ allAdapters: () => [{ id: 'remote', capabilities: () => ({ create: true, execute: true, assigneeDirectory: true, writeArtifactKinds: ['file'] }), availability: async () => ({ ready: true }), delegationSupport: async () => ({ metadata: true, structuredResult: true, reply: false }), listAssignees: async () => [{ kind: 'remote_agent', ref: 'cloud-agent', name: 'Cloud' }] }] }))
vi.mock('./localAgents/localAgentService', () => ({ localAgentService: {
  get: (_user: string, id: string) => ({ id, enabled: true, kind: 'kit', path: '/tmp/agent', desktop: { delegations: world.targetAuto ? 'auto' : null, cloudDelegations: world.sourceAuto ? 'auto' : null } }),
  list: () => ({ agents: [{ id: 'kit', enabled: true, kind: 'kit', name: 'Kit', path: '/tmp/kit', desktop: { delegations: world.targetAuto ? 'auto' : null } }, { id: 'bare', enabled: true, kind: 'bare', name: 'Bare', path: '/tmp/bare', desktop: {} }] }),
  setDelegationPermission: world.permission
} }))
vi.mock('./chatRouting', () => ({ chatAnswersToAgent: () => world.refusal }))
vi.mock('./delegationFiles', () => ({ createDelegationBrief: world.file, createDelegationRevision: vi.fn(), delegationBriefExists: (_folder: string, id: string) => world.briefs.has(id) }))
vi.mock('./handoverService', () => ({ handoverService: { scanFolderNow: world.scan } }))
vi.mock('./taskService', () => ({ taskService: {
  create: (userId: string, input: any) => { const row = { id: `task-${world.tasks.size}`, userId, ...input }; world.tasks.set(row.id, row); return row },
  getById: (_user: string, id: string) => world.tasks.get(id)
} }))
vi.mock('./taskExecutionService', () => ({ taskExecutionService: { start: world.start } }))
vi.mock('./runExecutionService', () => ({ runExecutionService: { isRunning: () => false } }))
vi.mock('./taskRunnerBridge', () => ({ installTaskRunnerHooks: vi.fn() }))
vi.mock('./inboxService', () => ({ inboxService: {} }))
vi.mock('./delegationReplies', () => ({ delegationReplies: { reconcile: vi.fn(), enqueue: vi.fn() } }))
vi.mock('./delegationLifecycle', () => ({ delegationLifecycle: { watchTurn: vi.fn(), applyResult: world.result, sweepLostRuns: vi.fn() } }))
vi.mock('./delegationCloud', () => ({ delegationCloud: { dispatch: world.cloud } }))
const { delegationService } = await import('./delegationService')
const { DelegationToolProvider } = await import('./delegationToolProvider')
const session = { scope: { profileUserId: 'profile', settingsUserId: 'settings' }, chatId: 'chat', agentId: 'source' }
const input = { target: { kind: 'kit', agentId: 'kit' }, id: 'request-one', title: 'Work', brief: 'Implement the requested work.' }
/** The same request as `tasks_create` arguments: the encoded target as `assignee`, `description` for `brief`. */
const asTaskCreate = ({ target, brief, ...rest }: Record<string, unknown>) => ({ ...rest, assignee: encodeTaskTarget(target as TaskTargetRef), description: brief })
beforeEach(() => {
  world.briefs.clear(); world.rows.clear(); world.tasks.clear(); world.requests.clear(); world.parent = null; world.task = null; world.active = 'profile'; world.ownCreated = 0; world.handover = undefined; world.sourceAuto = false; world.targetAuto = false; world.refusal = null
  vi.clearAllMocks()
  world.start.mockResolvedValue({ runId: 'run', completed: new Promise(() => {}) })
  world.file.mockReturnValue({ status: 'ready', briefPath: '/tmp/brief.md' })
})
describe('delegation bus session authority and gates', () => {
  it('creates one independent task, asks by default, and deduplicates concurrent retries', async () => {
    world.task = { id: 'origin-task' }
    const [first, retry] = await Promise.all([delegationService.create(session, input), delegationService.create(session, input)])
    expect(first).toEqual(retry)
    expect(world.rows.size).toBe(1)
    expect(world.tasks.size).toBe(1)
    expect([...world.tasks.values()][0].parentTaskId).toBeUndefined()
    expect([...world.rows.values()][0]).toMatchObject({ originTaskId: 'origin-task', originAgentId: 'source', depth: 1, state: 'gated' })
    expect(world.start).not.toHaveBeenCalled()
  })
  it('records the requesting agent and the delegation depth on the task it creates', async () => {
    world.task = { id: 'parent-task' }; world.parent = { id: 'p', depth: 1, channel: 'local', rootDelegationId: 'p' } as DelegationRow
    await delegationService.create(session, input)
    expect([...world.tasks.values()][0]).toMatchObject({ createdByAgentId: 'source', chainDepth: 2 })
  })
  it('asks the new-request hook only for a new request, so a repeat is answered at the cap', async () => {
    const beforeNew = vi.fn()
    const first = await delegationService.create(session, input, undefined, { beforeNew }) as { delegationId: string }
    expect(beforeNew).toHaveBeenCalledTimes(1)
    const refusing = vi.fn(() => { throw new Error('at the cap') })
    const again = await delegationService.create(session, input, undefined, { beforeNew: refusing }) as { delegationId: string }
    expect(again.delegationId).toBe(first.delegationId)
    expect(refusing).not.toHaveBeenCalled()
    await expect(delegationService.create(session, { ...input, id: 'new-work' }, undefined, { beforeNew: refusing })).rejects.toThrow('at the cap')
    expect(world.tasks.size).toBe(1)
  })
  it('answers a repeated bare brief at the cap: only a new request asks the hook', async () => {
    const { delegationOriginKey } = await import('../../shared/delegations')
    const originKey = delegationOriginKey({ originKind: 'local_chat', originChatId: 'chat', originTaskId: null, originAgentId: 'source' })
    world.rows.set('bare-row', { id: 'bare-row', userId: 'profile', originKey, targetKind: 'bare', targetAgentId: 'bare', requesterKey: 'request-one' } as DelegationRow)
    const refusing = vi.fn(() => { throw new Error('at the cap') })
    await delegationService.create(session, { ...input, target: { kind: 'bare', agentId: 'bare' } }, undefined, { beforeNew: refusing })
    expect(refusing).not.toHaveBeenCalled()
    await expect(delegationService.create(session, { ...input, id: 'other-work', target: { kind: 'bare', agentId: 'bare' } }, undefined, { beforeNew: refusing })).rejects.toThrow('at the cap')
    expect(world.file).toHaveBeenCalledTimes(1)
  })
  it('answers a repeated draft bare brief at the cap, as handover_create did: a draft has no delegation row yet', async () => {
    world.file.mockReturnValue({ status: 'draft', briefPath: '/tmp/brief.md' })
    const draft = { ...input, target: { kind: 'bare', agentId: 'bare' }, status: 'draft' }
    world.briefs.add('request-one')
    const refusing = vi.fn(() => { throw new Error('at the cap') })
    await expect(delegationService.create(session, draft, undefined, { beforeNew: refusing })).resolves.toMatchObject({ state: 'draft' })
    expect(refusing).not.toHaveBeenCalled()
    expect(world.file).toHaveBeenCalledTimes(1)
    await expect(delegationService.create(session, { ...draft, id: 'new-draft' }, undefined, { beforeNew: refusing })).rejects.toThrow('at the cap')
  })
  it('counts an own-queue chat task’s chain depth: a depth-2 own task cannot delegate', async () => {
    world.task = { id: 'own-task', chainDepth: 2 } as { id: string }
    await expect(delegationService.create(session, input)).rejects.toThrow('depth 2')
    expect(world.tasks.size).toBe(0)
    world.task = { id: 'own-task', chainDepth: 1 } as { id: string }
    await delegationService.create(session, input)
    expect([...world.tasks.values()][0]).toMatchObject({ chainDepth: 2 })
  })
  it('records provenance on the task a bare brief’s intake made', async () => {
    const { taskRepo } = await import('../db/tasks')
    world.handover = { id: 'h1', taskId: 'intake-task' }
    await delegationService.create(session, { ...input, target: { kind: 'bare', agentId: 'bare' } })
    expect(taskRepo.setProvenance).toHaveBeenCalledWith('profile', 'intake-task', { createdByAgentId: 'source', chainDepth: 1 })
  })
  it('lets the target kit Delegations setting decide, and asks whatever it says without it', async () => {
    await delegationService.create(session, input)
    await delegationService.create(session, { ...input, id: 'asked-auto', execution: 'auto' })
    expect(world.start).not.toHaveBeenCalled()
    world.targetAuto = true
    await delegationService.create(session, { ...input, id: 'absent-work' })
    expect(world.start).toHaveBeenCalledTimes(1)
    await delegationService.create(session, { ...input, id: 'auto-work', execution: 'auto' })
    expect(world.start).toHaveBeenCalledTimes(2)
    const byKey = (key: string) => [...world.rows.values()].find((row) => row.requesterKey === key)
    expect(byKey('absent-work')?.execution).toBe('receiver')
    expect(byKey('auto-work')?.execution).toBe('auto')
  })
  it('matches a repeated request that omits execution to the stored row, whatever it recorded', async () => {
    for (const [id, execution] of [['was-ask', 'ask'], ['was-auto', 'auto'], ['was-absent', undefined]] as const) {
      const first = await delegationService.create(session, { ...input, id, ...(execution ? { execution } : {}) }) as { delegationId: string }
      const again = await delegationService.create(session, { ...input, id }) as { delegationId: string }
      expect(again.delegationId).toBe(first.delegationId)
    }
    expect(world.tasks.size).toBe(3)
    // An explicit value is an opinion, and a different one is a different brief.
    await expect(delegationService.create(session, { ...input, id: 'was-ask', execution: 'auto' })).rejects.toThrow('another brief')
    await expect(delegationService.create(session, { ...input, id: 'was-absent', execution: 'ask' })).rejects.toThrow('another brief')
    await expect(delegationService.create(session, { ...input, id: 'was-auto', execution: 'auto' })).resolves.toBeTruthy()
  })
  it('gates an explicit ask even where the kit target runs delegations automatically', async () => {
    world.targetAuto = true
    const created = await delegationService.create(session, { ...input, execution: 'ask' }) as { state: string; execution: string }
    expect(world.start).not.toHaveBeenCalled()
    expect(created).toMatchObject({ state: 'gated', execution: 'ask' })
  })
  it('sends a cloud request that says nothing about execution when the requester holds the grant', async () => {
    world.sourceAuto = true
    await delegationService.create(session, { ...input, target: { kind: 'cloud', agentId: 'cloud-agent', adapter: 'remote' } })
    expect(world.cloud).toHaveBeenCalledTimes(1)
  })
  it('asks before an absent-execution cloud request from a chain started outside the app', async () => {
    world.task = { id: 'parent-task' }; world.sourceAuto = true
    world.parent = { id: 'outside', depth: 1, channel: 'file', originKind: 'external', rootDelegationId: 'outside' } as DelegationRow
    const created = await delegationService.create(session, { ...input, target: { kind: 'cloud', agentId: 'cloud-agent', adapter: 'remote' } }) as { state: string }
    expect(world.cloud).not.toHaveBeenCalled()
    expect(created.state).toBe('gated')
  })
  it('writes no execution into a bare brief unless the requester said one', async () => {
    await delegationService.create(session, { ...input, target: { kind: 'bare', agentId: 'bare' } })
    expect(world.file).toHaveBeenLastCalledWith(expect.objectContaining({ execution: null }))
    await delegationService.create(session, { ...input, id: 'asked-work', target: { kind: 'bare', agentId: 'bare' }, execution: 'ask' })
    expect(world.file).toHaveBeenLastCalledWith(expect.objectContaining({ execution: 'ask' }))
  })
  it('carries tasks_create’s priority and custom fields into a bare brief, and refuses them elsewhere', async () => {
    const tools = new DelegationToolProvider(session)
    const bare = { ...asTaskCreate({ ...input, target: { kind: 'bare', agentId: 'bare' } }), priority: 'high', custom_fields: { estimate: 3, labels: ['ui'] } }
    await tools.callTool('tasks_create', bare)
    expect(world.file).toHaveBeenLastCalledWith(expect.objectContaining({ priority: 'high', customFields: { estimate: 3, labels: ['ui'] } }))
    await expect(tools.callTool('tasks_create', { ...bare, id: 'brief-key', custom_fields: { Execution: 'auto' } })).rejects.toThrow('brief field')
    await expect(tools.callTool('tasks_create', { ...bare, id: 'bad-priority', priority: 'soon' })).rejects.toThrow('priority')
    await expect(tools.callTool('tasks_create', { ...asTaskCreate(input), priority: 'high' })).rejects.toThrow('bare-folder brief')
    await expect(tools.callTool('tasks_create', { ...asTaskCreate(input), custom_fields: { a: 1 } })).rejects.toThrow('bare-folder brief')
    expect(world.file).toHaveBeenCalledTimes(1)
    expect(world.tasks.size).toBe(0)
  })
  it('takes cloud permission from the requester and dispatches only the new task', async () => {
    world.task = { id: 'parent-task' }; world.sourceAuto = true
    await delegationService.create(session, { ...input, target: { kind: 'cloud', agentId: 'cloud-agent', adapter: 'remote' }, execution: 'auto' })
    expect(world.cloud).toHaveBeenCalledWith('profile', expect.objectContaining({ originTaskId: 'parent-task' }), expect.objectContaining({ id: 'task-0' }))
    expect(world.start).not.toHaveBeenCalled()
  })
  it('asks before a cloud delegation whose chain was started from outside the app, grant or no grant', async () => {
    world.task = { id: 'parent-task' }; world.sourceAuto = true
    world.parent = { id: 'outside', depth: 1, channel: 'file', originKind: 'external', rootDelegationId: 'outside' } as DelegationRow
    const created = await delegationService.create(session, { ...input, target: { kind: 'cloud', agentId: 'cloud-agent', adapter: 'remote' }, execution: 'auto' }) as { state: string }
    expect(world.cloud).not.toHaveBeenCalled()
    expect(created.state).toBe('gated')
  })
  it('returns the earlier request when the chat gained its task after asking', async () => {
    const first = await delegationService.create(session, input) as { delegationId: string }
    world.task = { id: 'late-task' }
    const again = await delegationService.create(session, input) as { delegationId: string }
    expect(again.delegationId).toBe(first.delegationId)
    expect(world.tasks.size).toBe(1)
  })
  it('rejects a depth-3 cross-channel request before creating any task', async () => {
    world.task = { id: 'parent-task' }; world.parent = { depth: 2, channel: 'cloud' } as DelegationRow
    await expect(delegationService.create(session, input)).rejects.toThrow('depth 2')
    expect(world.tasks.size).toBe(0)
  })
  it('requires a cloud adapter and rejects adapters on local targets', async () => {
    await expect(delegationService.create(session, { ...input, target: { kind: 'cloud', agentId: 'cloud-agent' } })).rejects.toThrow('exact target')
    await expect(delegationService.create(session, { ...input, target: { ...input.target, adapter: 'invented' } })).rejects.toThrow('exact target')
    expect(world.tasks.size).toBe(0)
  })
  it('rejects a switched profile, invalid session origin and unknown target', async () => {
    world.active = 'other'
    await expect(delegationService.create(session, input)).rejects.toThrow('profile changed')
    world.active = 'profile'; world.refusal = 'wrong agent'
    await expect(delegationService.create(session, input)).rejects.toThrow('wrong agent')
    world.refusal = null
    await expect(delegationService.create(session, { ...input, target: { kind: 'kit', agentId: 'unknown' } })).rejects.toThrow('unavailable')
    expect(world.tasks.size).toBe(0)
  })
  it('creates bare work through a file and immediate scan, never the local direct channel', async () => {
    await delegationService.create(session, { ...input, target: { kind: 'bare', agentId: 'bare' } })
    expect(world.file).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'source', chatId: 'chat', depth: 1, folder: '/tmp/bare' }))
    expect(world.scan).toHaveBeenCalledWith('/tmp/bare')
    expect(world.tasks.size).toBe(0)
  })
  it('answers a gate once and persists cloud standing permission on its requester', async () => {
    await delegationService.create(session, { ...input, target: { kind: 'cloud', agentId: 'cloud-agent', adapter: 'remote' } })
    const request = [...world.requests.values()][0]
    const labels = request.request.questions[0].options.map((option: { label: string }) => option.label)
    // Same word and order as the file-handover gate: run, the standing permission, skip.
    expect(labels[0]).toBe('Run')
    expect(labels[2]).toBe('Skip')
    const choice = labels[1]
    expect(choice).toContain('delegate to the cloud without asking')
    const answer = { kind: 'question' as const, answers: [[choice]] }
    expect(await delegationService.answer('profile', request.requestId, answer)).toEqual({ ok: true })
    expect(world.permission).toHaveBeenCalledWith('settings', 'source', 'cloudDelegations', 'auto')
    expect((await delegationService.answer('profile', request.requestId, answer))?.ok).toBe(false)
    expect(world.cloud).toHaveBeenCalledTimes(1)
  })
  it('does not accept work after the requesting turn is canceled during discovery', async () => {
    const controller = new AbortController()
    const targets = vi.spyOn(delegationService, 'targetEntries').mockImplementationOnce(async () => {
      controller.abort(new Error('Requester stopped'))
      return []
    })
    const tools = new DelegationToolProvider(session)
    await expect(tools.callTool('tasks_create', asTaskCreate(input), { signal: controller.signal })).rejects.toThrow('Requester stopped')
    expect(world.rows.size).toBe(0)
    expect(world.tasks.size).toBe(0)
    targets.mockRestore()
  })
  it('recovers a gate after interruption between approval and executor acceptance', async () => {
    await delegationService.create(session, input)
    const row = [...world.rows.values()][0]
    const oldRequest = [...world.requests.values()][0]
    oldRequest.status = 'answered'
    row.gateRequestId = null
    row.state = 'seen'
    await delegationService.reconcile(session.scope)
    expect(row.state).toBe('gated')
    expect(world.requests.get(`delegation:${row.id}`)?.status).toBe('open')
    expect(world.start).not.toHaveBeenCalled()
  })
  it('offers the eight tasks_* tools and no old name, forbids forged origin fields, and warns on unchanged reads', async () => {
    const tools = new DelegationToolProvider(session)
    expect(tools.getTools().map((tool) => tool.name)).toEqual(['tasks_targets', 'tasks_list', 'tasks_get', 'tasks_create', 'tasks_update', 'tasks_comment', 'tasks_report', 'tasks_reply'])
    for (const old of ['handover_report', 'handover_targets', 'handover_list', 'handover_reply', 'task_create', 'task_update', 'task_comment']) {
      await expect(tools.callTool(old, {})).rejects.toThrow('not offered')
    }
    await expect(tools.callTool('tasks_create', { ...asTaskCreate(input), depth: 0 })).rejects.toThrow('unknown argument')
    await tools.callTool('tasks_list', {})
    expect(await tools.callTool('tasks_list', {})).toMatchObject({ content: { notice: 'Nothing has changed since your last call in this turn; end your turn.' } })
    expect(await new DelegationToolProvider(session).callTool('tasks_list', {})).toEqual({ content: { tasks: [] } })
  })
  it('lists targets as protocol entries whose target string tasks_create takes back', async () => {
    world.sourceAuto = true
    const { content } = await new DelegationToolProvider(session).callTool('tasks_targets', {}) as { content: { protocol_version: number; targets: Record<string, unknown>[] } }
    expect(content.protocol_version).toBe(1)
    expect(content.targets).toEqual([
      expect.objectContaining({ target: 'kit:kit', name: 'Kit', kind: 'kit', location: 'local', requires_approval: true, protocol_version: 1,
        capabilities: { structured_report: true, reply: true, priority: false, custom_fields: false, attachments: false } }),
      expect.objectContaining({ target: 'folder:bare', kind: 'folder', location: 'local', folder: '/tmp/bare',
        capabilities: { structured_report: true, reply: true, priority: true, custom_fields: true, attachments: false } }),
      expect.objectContaining({ target: 'cinna:remote:cloud-agent', name: 'Cloud', kind: 'cinna', location: 'remote', requires_approval: false,
        capabilities: { structured_report: true, reply: false, priority: false, custom_fields: false, attachments: true } })
    ])
    await expect(new DelegationToolProvider(session).callTool('tasks_create', { ...asTaskCreate(input), assignee: 'kit' })).rejects.toThrow('tasks_targets')
    await new DelegationToolProvider(session).callTool('tasks_create', asTaskCreate(input))
    expect([...world.rows.values()][0]).toMatchObject({ targetKind: 'kit', targetAgentId: 'kit' })
  })
  it('refuses reporting from a requester chat and applying a stranger’s reply', async () => {
    await expect(delegationService.report(session, { status: 'done', summary: 'Done' })).rejects.toThrow('executor session')
    world.rows.set('foreign', { id: 'foreign', userId: 'profile', originAgentId: 'other', originChatId: 'other' } as DelegationRow)
    await expect(delegationService.reply(session, { ref: 'foreign', message: 'change it' })).rejects.toThrow('did not request')
    expect(world.result).not.toHaveBeenCalled()
  })
  it('sends an executor’s report through the bus with its body, audience and artifacts, and wants a question when blocked', async () => {
    world.task = { id: 'exec-task' }
    world.parent = { id: 'd-exec', taskId: 'exec-task', targetAgentId: 'source', channel: 'local' } as DelegationRow
    await expect(delegationService.report(session, { status: 'blocked', summary: 'Stuck' })).rejects.toThrow('question')
    const answer = await delegationService.report(session, { status: 'done', summary: 'Built', body: 'All of it.', artifacts: ['out/a.txt', { ref: 'https://x.test/r', kind: 'link' }] })
    expect(answer).toEqual({ delegationId: 'd-exec', taskId: 'exec-task', status: 'done' })
    expect(world.result).toHaveBeenCalledWith(session.scope, world.parent, {
      status: 'done', summary: 'Built', question: undefined, artifacts: ['/tmp/agent/out/a.txt', 'https://x.test/r'], body: 'All of it.', audience: 'requester'
    })
  })
  it('resolves a reply by the delegated task’s ref, and still by the delegation id', async () => {
    world.rows.set('d-own', { id: 'd-own', userId: 'profile', originAgentId: 'source', originChatId: 'chat', channel: 'local', taskId: 'child-task' } as DelegationRow)
    world.parent = world.rows.get('d-own')!
    const { delegationReplies } = await import('./delegationReplies')
    await delegationService.reply(session, { ref: 'child-task', message: 'Use v2.' })
    world.parent = null
    await delegationService.reply(session, { ref: 'd-own', message: 'Use v3.' })
    expect(vi.mocked(delegationReplies.enqueue).mock.calls.map((call) => [(call[1] as DelegationRow).id, call[2]])).toEqual([['d-own', 'Use v2.'], ['d-own', 'Use v3.']])
  })
})
