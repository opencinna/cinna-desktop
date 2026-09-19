import { describe, expect, it, vi } from 'vitest'
import type { DelegationRow } from '../db/delegations'
import type { TaskDto } from '../../shared/tasks'
import { createFakeRemote } from '../tasks/adapters/testSupport/fakeRemote'
import { RemoteTaskError } from '../tasks/adapters/adapter'
import { createDelegationCloudChannel, type DelegationCloudWorld } from './delegationCloud'

function fixture() {
  const remote = createFakeRemote({ capabilities: { idempotentCreate: true } })
  let row = { id: 'delegation', userId: 'profile', originKind: 'local_chat', originAgentId: 'agent',
    originChatId: 'chat', originTaskId: 'parent', requesterKey: 'research', targetKind: 'cloud',
    targetAgentId: 'remote-worker', channel: 'cloud', rootDelegationId: 'delegation', depth: 1,
    groupId: null, taskId: 'child', remoteConnectionId: 'fake', remoteTaskId: null,
    remoteTaskKey: null, remoteUrl: null, dispatchState: null, title: 'Research', brief: 'Find facts'
  } as DelegationRow
  const task = { id: 'child', goal: 'Find facts', title: 'Research', priority: 'normal',
    parentTaskId: null, artifacts: [], assignee: { kind: 'remote_agent', agentId: 'remote-worker', name: null }
  } as unknown as TaskDto
  const events: string[] = []
  let active = true
  const world: DelegationCloudWorld = {
    adapterFor: () => remote.adapter,
    get: () => row,
    patch: (_user, _id, patch) => { row = { ...row, ...patch }; events.push(patch.dispatchState ?? 'patch'); return row },
    isActive: () => active,
    captureConnection: () => () => true,
    saveBinding: vi.fn(), markRemote: vi.fn(), applySnapshot: vi.fn()
  }
  return { remote, task, world, events, row: () => row, deactivate: () => { active = false },
    channel: createDelegationCloudChannel(world) }
}

describe('cloud delegation channel', () => {
  it('persists before dispatch, creates independent work and coalesces retries', async () => {
    const f = fixture()
    const create = f.remote.adapter.create.bind(f.remote.adapter)
    const spy = vi.spyOn(f.remote.adapter, 'create').mockImplementation(async (...args) => {
      expect(f.row().dispatchState).toBe('creating')
      expect(args[1].id).toBe('child')
      expect(args[1].parentTaskId).toBeNull()
      expect(args[2]).toBeNull()
      return create(...args)
    })
    const execute = vi.spyOn(f.remote.adapter, 'execute')
    await Promise.all([f.channel.dispatch('profile', f.row(), f.task), f.channel.dispatch('profile', f.row(), f.task)])
    await f.channel.dispatch('profile', f.row(), f.task)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(f.row().dispatchState).toBe('running')
    expect(f.world.markRemote).toHaveBeenCalledWith('profile', 'child')
  })

  it('recovers a lost create acknowledgement with the same idempotent child id', async () => {
    const f = fixture()
    const original = f.remote.adapter.create.bind(f.remote.adapter)
    vi.spyOn(f.remote.adapter, 'create').mockImplementationOnce(async (...args) => {
      await original(...args)
      throw new RemoteTaskError('unavailable', 'lost acknowledgement')
    })
    await expect(f.channel.dispatch('profile', f.row(), f.task)).rejects.toThrow('lost acknowledgement')
    expect(f.row().dispatchState).toBe('creating')
    await f.channel.dispatch('profile', f.row(), f.task)
    expect((await f.remote.adapter.list('profile', null))).toHaveLength(1)
  })

  it('never retries an execution whose acknowledgement was lost', async () => {
    const f = fixture()
    const execute = vi.spyOn(f.remote.adapter, 'execute').mockRejectedValue(new RemoteTaskError('unavailable', 'lost execution'))
    await expect(f.channel.dispatch('profile', f.row(), f.task)).rejects.toThrow()
    expect(f.row().dispatchState).toBe('uncertain')
    await f.channel.dispatch('profile', f.row(), f.task)
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('does not execute after the profile changes during create', async () => {
    const f = fixture()
    const original = f.remote.adapter.create.bind(f.remote.adapter)
    vi.spyOn(f.remote.adapter, 'create').mockImplementation(async (...args) => {
      const binding = await original(...args); f.deactivate(); return binding
    })
    const execute = vi.spyOn(f.remote.adapter, 'execute')
    await expect(f.channel.dispatch('profile', f.row(), f.task)).rejects.toMatchObject({ code: 'invalid_request' })
    expect(execute).not.toHaveBeenCalled()
    expect(f.row().remoteTaskId).toBeTruthy()
  })

  it('does not execute after switching away and back to the same profile', async () => {
    const f = fixture()
    let current = true
    f.world.captureConnection = () => () => current
    const original = f.remote.adapter.create.bind(f.remote.adapter)
    vi.spyOn(f.remote.adapter, 'create').mockImplementation(async (...args) => {
      const binding = await original(...args); current = false; return binding
    })
    const execute = vi.spyOn(f.remote.adapter, 'execute')
    await expect(f.channel.dispatch('profile', f.row(), f.task)).rejects.toMatchObject({ code: 'invalid_request' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('uploads supported local files before executing and never sends a path as an attachment URL', async () => {
    const f = fixture()
    f.task.artifacts = [{ kind: 'file', ref: '/workspace/result.txt', name: 'Result' }]
    const original = f.remote.adapter.putArtifact.bind(f.remote.adapter)
    vi.spyOn(f.remote.adapter, 'putArtifact').mockImplementation(async (...args) => {
      expect(f.row().dispatchState).toBe('uploading')
      return original(...args)
    })
    await f.channel.dispatch('profile', f.row(), f.task)
    expect(f.remote.stored(f.row().remoteTaskId!)?.artifacts).toEqual(f.task.artifacts)
    expect(f.events.indexOf('uploading')).toBeLessThan(f.events.indexOf('executing'))
  })

  it('does not blindly retry create on a service that has no idempotency guarantee', async () => {
    const f = fixture()
    const caps = f.remote.adapter.capabilities()
    vi.spyOn(f.remote.adapter, 'capabilities').mockReturnValue({ ...caps, idempotentCreate: false })
    f.world.patch('profile', f.row().id, { dispatchState: 'creating' })
    await f.channel.dispatch('profile', f.row(), f.task)
    expect(f.row().dispatchState).toBe('uncertain')
    expect(f.remote.requests()).toBe(0)
  })

  it('returns the latest result comment and spells out missing artifact support', async () => {
    const f = fixture()
    await f.channel.dispatch('profile', f.row(), f.task)
    f.remote.touch(f.row().remoteTaskId!, { status: 'completed', comments: [
      { id: 'latest', type: 'result', body: 'New result', author: null, createdAt: new Date(20) },
      { id: 'old', type: 'result', body: 'Old result', author: null, createdAt: new Date(10) }
    ] })
    const polled = await f.channel.poll('profile', f.row())
    expect(polled.result).toMatchObject({ status: 'done', body: 'New result' })
    expect(polled.warning).toContain('attachments')
  })

  it('keeps a profile switch before execute resumable instead of failing the delegation', async () => {
    const f = fixture()
    const execute = vi.spyOn(f.remote.adapter, 'execute')
    // The acknowledged create is stored; the profile goes away before anything is executed.
    ;(f.world.markRemote as ReturnType<typeof vi.fn>).mockImplementation(() => f.deactivate())
    await expect(f.channel.dispatch('profile', f.row(), f.task)).rejects.toThrow('no longer active')
    expect(execute).not.toHaveBeenCalled()
    expect(f.row()).toMatchObject({ dispatchState: 'created' })
    expect(f.row().state).not.toBe('failed')
  })

  it('does not keep a finished task waiting on the question it left behind', async () => {
    const f = fixture()
    await f.channel.dispatch('profile', f.row(), f.task)
    f.remote.touch(f.row().remoteTaskId!, { status: 'completed',
      result: { status: 'blocked', summary: 'Need scope', question: 'Which file?', body: '', artifacts: [], audience: 'requester', askId: 'ask' } })
    const polled = await f.channel.poll('profile', f.row())
    expect(polled.result).toMatchObject({ status: 'done', question: null })
    expect(polled.waitingOnUser).toBe(false)
  })

  it('keeps the agent’s last message when its chatter exceeds the packet body', async () => {
    const f = fixture()
    await f.channel.dispatch('profile', f.row(), f.task)
    f.remote.touch(f.row().remoteTaskId!, { status: 'completed', comments: [
      { id: 'preamble', type: 'message', body: 'thinking aloud '.repeat(400), author: 'Cloud agent', fromAgent: true, createdAt: new Date(10) },
      { id: 'answer', type: 'message', body: 'The answer is 42.', author: 'Cloud agent', fromAgent: true, createdAt: new Date(20) }
    ] })
    const polled = await f.channel.poll('profile', f.row())
    expect(polled.result?.body).toBe('The answer is 42.')
    expect(polled.result?.summary).toBe('The answer is 42.')
  })

  it('settles an unbound create as uncertain once its task can no longer be dispatched', async () => {
    const f = fixture()
    f.world.patch('profile', f.row().id, { dispatchState: 'creating' })
    const edited = { ...f.task, assignee: { kind: 'remote_agent', agentId: 'someone-else', name: null } } as typeof f.task
    await expect(f.channel.dispatch('profile', f.row(), edited)).rejects.toMatchObject({ code: 'invalid_request' })
    expect(f.row()).toMatchObject({ dispatchState: 'uncertain', state: 'uncertain' })
    expect(f.remote.requests()).toBe(0)
  })

  it('settles an unbound create as uncertain when the service can no longer execute', async () => {
    const f = fixture()
    f.world.patch('profile', f.row().id, { dispatchState: 'creating' })
    const caps = f.remote.adapter.capabilities()
    vi.spyOn(f.remote.adapter, 'capabilities').mockReturnValue({ ...caps, execute: false })
    await expect(f.channel.dispatch('profile', f.row(), f.task)).rejects.toThrow()
    expect(f.row()).toMatchObject({ dispatchState: 'uncertain', state: 'uncertain' })
  })

  it('leaves a dispatch interrupted after its first upload uncertain, never replayed', async () => {
    const f = fixture()
    const task = { ...f.task, artifacts: [{ kind: 'file', name: 'a.txt', ref: '/tmp/a.txt' }, { kind: 'file', name: 'b.txt', ref: '/tmp/b.txt' }] } as typeof f.task
    const put = vi.spyOn(f.remote.adapter, 'putArtifact').mockImplementation(async () => { f.deactivate() })
    const execute = vi.spyOn(f.remote.adapter, 'execute')
    await expect(f.channel.dispatch('profile', f.row(), task)).rejects.toThrow('no longer active')
    expect(put).toHaveBeenCalledTimes(1)
    expect(execute).not.toHaveBeenCalled()
    expect(f.row()).toMatchObject({ dispatchState: 'uncertain', state: 'uncertain' })
  })

  it('falls back to what the remote agent said when it filed no result comment', async () => {
    const f = fixture()
    await f.channel.dispatch('profile', f.row(), f.task)
    f.remote.touch(f.row().remoteTaskId!, { status: 'completed', comments: [
      { id: 'sys', type: 'status_change', body: 'new → in_progress', author: null, createdAt: new Date(5) },
      { id: 'first', type: 'message', body: 'Looked at the module.', author: 'Cloud agent', fromAgent: true, createdAt: new Date(10) },
      { id: 'user', type: 'message', body: 'A note from a person', author: 'Owner', createdAt: new Date(15) },
      { id: 'last', type: 'message', body: 'Version is 16.0.16.\nDetails follow.', author: 'Cloud agent', fromAgent: true, createdAt: new Date(20) }
    ] })
    const polled = await f.channel.poll('profile', f.row())
    expect(polled.result).toMatchObject({ status: 'done', summary: 'Version is 16.0.16.',
      body: 'Looked at the module.\n\nVersion is 16.0.16.\nDetails follow.' })
  })

  it('settles a task that ended after an answered question left its report in progress', async () => {
    const f = fixture()
    await f.channel.dispatch('profile', f.row(), f.task)
    f.remote.touch(f.row().remoteTaskId!, { status: 'completed',
      result: { status: 'in_progress', summary: 'Need the language', question: null, body: '', artifacts: [], audience: 'requester', askId: 'answered' },
      comments: [{ id: 'said', type: 'message', body: 'Bonjour.', author: 'Cloud agent', fromAgent: true, createdAt: new Date(10) }] })
    const polled = await f.channel.poll('profile', f.row())
    expect(polled.result).toMatchObject({ status: 'done', summary: 'Bonjour.' })
  })

  it('leaves legacy user questions to the Inbox and refuses agent replies', async () => {
    const f = fixture()
    await f.channel.dispatch('profile', f.row(), f.task)
    f.remote.touch(f.row().remoteTaskId!, { status: 'blocked' })
    f.remote.plantAsk(f.row().remoteTaskId!, { id: 'ask', request: { kind: 'question', questions: [{ question: 'Pay?', options: [], multiSelect: false }] } })
    const polled = await f.channel.poll('profile', f.row())
    expect(polled.waitingOnUser).toBe(true)
    expect(polled.result?.audience).toBe('user')
    await expect(f.channel.reply('profile', f.row(), 'Yes')).rejects.toMatchObject({ code: 'invalid_request' })
  })

  it('routes a structured requester question and replies only to its exact ask', async () => {
    const f = fixture()
    await f.channel.dispatch('profile', f.row(), f.task)
    f.remote.touch(f.row().remoteTaskId!, { status: 'blocked', result: {
      status: 'blocked', summary: 'Need scope', question: 'Which file?', body: 'Choose', artifacts: [], audience: 'requester', askId: 'ask'
    } })
    f.remote.plantAsk(f.row().remoteTaskId!, { id: 'ask', audience: 'requester', request: { kind: 'question', questions: [{ question: 'Which file?', options: [], multiSelect: false }] } })
    expect((await f.channel.poll('profile', f.row())).waitingOnUser).toBe(false)
    expect(await f.channel.reply('profile', f.row(), 'README')).toEqual({ delivered: true })
  })

  it('carries report identity and observes resumed work after a user answers', async () => {
    const f = fixture()
    await f.channel.dispatch('profile', f.row(), f.task)
    f.world.patch('profile', f.row().id, { state: 'waiting_user', resultStatus: 'blocked' })
    f.remote.touch(f.row().remoteTaskId!, { status: 'in_progress', result: {
      status: 'in_progress', summary: 'Need scope', question: 'Which file?', body: 'Choose',
      artifacts: [], audience: 'user', askId: 'answered-question'
    } })
    const resumed = await f.channel.poll('profile', f.row())
    expect(resumed.result).toMatchObject({ status: 'in_progress', resultId: 'answered-question', question: null })
    expect(resumed.waitingOnUser).toBe(false)
    f.remote.touch(f.row().remoteTaskId!, { status: 'blocked', result: {
      status: 'blocked', summary: 'Need scope', question: 'Which file?', body: 'Choose',
      artifacts: [], audience: 'requester', askId: 'next-question'
    } })
    expect((await f.channel.poll('profile', f.row())).result).toMatchObject({ resultId: 'next-question' })
  })

  it('clears legacy waiting state when the remote resumes without a structured result', async () => {
    const f = fixture()
    await f.channel.dispatch('profile', f.row(), f.task)
    f.world.patch('profile', f.row().id, { state: 'waiting_user', resultStatus: 'blocked' })
    f.remote.touch(f.row().remoteTaskId!, { status: 'in_progress' })
    expect((await f.channel.poll('profile', f.row())).result).toMatchObject({ status: 'in_progress', question: null })
  })

  it('clears a replied question after delivery without overwriting a newer report', async () => {
    const f = fixture()
    await f.channel.dispatch('profile', f.row(), f.task)
    f.world.patch('profile', f.row().id, { state: 'blocked', resultStatus: 'blocked', resultDigest: 'old', question: 'Which file?', questionAudience: 'requester' })
    f.remote.touch(f.row().remoteTaskId!, { status: 'blocked', result: {
      status: 'blocked', summary: 'Need scope', question: 'Which file?', body: '',
      artifacts: [], audience: 'requester', askId: 'ask'
    } })
    f.remote.plantAsk(f.row().remoteTaskId!, { id: 'ask', audience: 'requester', request: { kind: 'question', questions: [{ question: 'Which file?', options: [], multiSelect: false }] } })
    expect(await f.channel.reply('profile', f.row(), 'README')).toEqual({ delivered: true })
    expect(f.row()).toMatchObject({ state: 'running', resultStatus: 'in_progress', question: null, questionAudience: null })

    f.world.patch('profile', f.row().id, { state: 'blocked', resultStatus: 'blocked', resultDigest: 'old' })
    f.remote.plantAsk(f.row().remoteTaskId!, { id: 'ask', audience: 'requester', request: { kind: 'question', questions: [{ question: 'Which file?', options: [], multiSelect: false }] } })
    vi.spyOn(f.remote.adapter, 'answerAsk').mockImplementation(async () => {
      f.world.patch('profile', f.row().id, { state: 'blocked', resultStatus: 'blocked', resultDigest: 'new', question: 'Which version?' })
      return { delivered: true }
    })
    await f.channel.reply('profile', f.row(), 'README')
    expect(f.row()).toMatchObject({ state: 'blocked', resultStatus: 'blocked', resultDigest: 'new', question: 'Which version?' })
  })

  it('refuses unsupported outgoing artifacts before creating remote work', async () => {
    const f = fixture()
    const caps = f.remote.adapter.capabilities()
    vi.spyOn(f.remote.adapter, 'capabilities').mockReturnValue({ ...caps, writeArtifactKinds: ['file'] })
    f.task.artifacts = [{ kind: 'link', name: 'Spec', ref: 'https://example.test/spec' }]
    await expect(f.channel.dispatch('profile', f.row(), f.task)).rejects.toMatchObject({ code: 'unsupported' })
    expect(f.remote.requests()).toBe(0)
  })

  it('refuses a child with a different assignee than the approved cloud target', async () => {
    const f = fixture()
    f.task.assignee = { kind: 'agent', agentId: null, name: null }
    await expect(f.channel.dispatch('profile', f.row(), f.task)).rejects.toMatchObject({ code: 'invalid_request' })
    expect(f.remote.requests()).toBe(0)
    f.task.assignee = { kind: 'remote_agent', agentId: 'another-agent', name: null }
    await expect(f.channel.dispatch('profile', f.row(), f.task)).rejects.toMatchObject({ code: 'invalid_request' })
    expect(f.remote.requests()).toBe(0)
  })
})
