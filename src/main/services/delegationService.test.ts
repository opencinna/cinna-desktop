import { beforeEach, describe, expect, it, vi } from 'vitest'
import { delegationRepo, type DelegationRow } from '../db/delegations'

const world = vi.hoisted(() => ({
  rows: new Map<string, DelegationRow>(), tasks: new Map<string, any>(), requests: new Map<string, any>(), parent: null as DelegationRow | null,
  task: null as { id: string } | null, active: 'profile', sourceAuto: false, targetAuto: false,
  start: vi.fn(), cloud: vi.fn(), result: vi.fn(), scan: vi.fn(), file: vi.fn(), permission: vi.fn(), refusal: null as string | null
}))
vi.mock('../db/delegations', () => ({ delegationRepo: {
  createWithTask: (input: any, createTask: () => { id: string }) => { const row = delegationRepo.insert(input); const task = createTask(); return delegationRepo.update(input.userId, row.id, { taskId: task.id }) },
  insert: (input: any) => { const row = { id: `d${world.rows.size}`, state: 'seen', taskId: null, remoteConnectionId: null, groupId: null, ...input }; world.rows.set(row.id, row); return row },
  update: (_user: string, id: string, patch: any) => { const row = world.rows.get(id); if (row) Object.assign(row, patch); return row },
  getById: (user: string, id: string) => { const row = world.rows.get(id); return row?.userId === user ? row : undefined },
  byTaskId: () => world.parent,
  byRequesterKey: (user: string, origin: string, kind: string, target: string, key: string) => [...world.rows.values()].find((r) => r.userId === user && r.originKey === origin && r.targetKind === kind && r.targetAgentId === target && r.requesterKey === key),
  listForOrigin: () => [...world.rows.values()], toDto: (row: any) => row, list: () => [...world.rows.values()]
} }))
vi.mock('../db/handovers', () => ({ handoverRepo: { byAgentAndHandoverId: () => undefined } }))
vi.mock('../db/tasks', () => ({ taskRepo: { getByChatId: () => world.task } }))
vi.mock('../db/chats', () => ({ chatRepo: { create: () => ({ id: 'gate-chat' }), getOwned: () => ({ id: 'gate-chat' }), permanentDelete: vi.fn() } }))
vi.mock('../db/agents', () => ({ agentOverrideRepo: { get: () => undefined } }))
vi.mock('../db/taskInputRequests', () => ({ taskInputRequestRepo: {
  open: (input: any) => { const row = { ...input, status: 'open' }; world.requests.set(input.requestId, row); return row },
  getById: (id: string) => world.requests.get(id), settle: (id: string) => { const row = world.requests.get(id); if (row?.status !== 'open') return undefined; row.status = 'answered'; return row }
} }))
vi.mock('../auth/scope', () => ({ getProfileScopeUserId: () => world.active, getSettingsScopeUserId: () => 'settings' }))
vi.mock('../auth/activation', () => ({ userActivation: { requireActivated: vi.fn() } }))
vi.mock('../logger/logger', () => ({ createLogger: () => ({ warn: vi.fn() }) }))
vi.mock('../tasks/adapters', () => ({ allAdapters: () => [{ id: 'remote', capabilities: () => ({ create: true, execute: true, assigneeDirectory: true }), availability: async () => ({ ready: true }), listAssignees: async () => [{ kind: 'remote_agent', ref: 'cloud-agent', name: 'Cloud' }] }] }))
vi.mock('./localAgents/localAgentService', () => ({ localAgentService: {
  get: (_user: string, id: string) => ({ id, enabled: true, kind: 'kit', path: '/tmp/agent', desktop: { delegations: world.targetAuto ? 'auto' : null, cloudDelegations: world.sourceAuto ? 'auto' : null } }),
  list: () => ({ agents: [{ id: 'kit', enabled: true, kind: 'kit', name: 'Kit', path: '/tmp/kit', desktop: { delegations: world.targetAuto ? 'auto' : null } }, { id: 'bare', enabled: true, kind: 'bare', name: 'Bare', path: '/tmp/bare', desktop: {} }] }),
  setDelegationPermission: world.permission
} }))
vi.mock('./chatRouting', () => ({ chatAnswersToAgent: () => world.refusal }))
vi.mock('./delegationFiles', () => ({ createDelegationBrief: world.file, createDelegationRevision: vi.fn() }))
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
beforeEach(() => {
  world.rows.clear(); world.tasks.clear(); world.requests.clear(); world.parent = null; world.task = null; world.active = 'profile'; world.sourceAuto = false; world.targetAuto = false; world.refusal = null
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
  it('requires both requested auto and the target kit permission', async () => {
    await delegationService.create(session, { ...input, execution: 'auto' })
    expect(world.start).not.toHaveBeenCalled()
    world.targetAuto = true
    await delegationService.create(session, { ...input, id: 'second-work', execution: 'auto' })
    expect(world.start).toHaveBeenCalledTimes(1)
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
    const targets = vi.spyOn(delegationService, 'targets').mockImplementationOnce(async () => {
      controller.abort(new Error('Requester stopped'))
      return []
    })
    const tools = new DelegationToolProvider(session, false)
    await expect(tools.callTool('handover_create', input, { signal: controller.signal })).rejects.toThrow('Requester stopped')
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
  it('offers report only to executors, forbids forged origin fields, and warns on unchanged reads', async () => {
    const tools = new DelegationToolProvider(session, false)
    expect(tools.getTools().some((tool) => tool.name === 'handover_report')).toBe(false)
    await expect(tools.callTool('handover_report', {})).rejects.toThrow('not offered')
    await expect(tools.callTool('handover_create', { ...input, depth: 0 })).rejects.toThrow('unknown argument')
    await tools.callTool('handover_list', {})
    expect(await tools.callTool('handover_list', {})).toMatchObject({ content: { notice: expect.stringContaining('end your turn') } })
    expect(await new DelegationToolProvider(session, false).callTool('handover_list', {})).toEqual({ content: { delegations: [] } })
  })
  it('refuses reporting from a requester chat and applying a stranger’s reply', async () => {
    await expect(delegationService.report(session, { status: 'done', summary: 'Done' })).rejects.toThrow('executor session')
    world.rows.set('foreign', { id: 'foreign', userId: 'profile', originAgentId: 'other', originChatId: 'other' } as DelegationRow)
    await expect(delegationService.reply(session, { id: 'foreign', message: 'change it' })).rejects.toThrow('did not request')
    expect(world.result).not.toHaveBeenCalled()
  })
})
