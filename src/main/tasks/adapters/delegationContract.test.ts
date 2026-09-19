import { describe, expect, it, vi } from 'vitest'
import type { TaskDto } from '../../../shared/tasks'
import { createFakeRemote } from './testSupport/fakeRemote'
import { createCinnaTaskAdapter } from './cinnaTaskAdapter'
import { createFakeCinnaServer } from './testSupport/fakeCinnaServer'
import type { RemoteDelegationMetadata } from './adapter'
import { invalidateCinnaSession } from '../../auth/cinna-session'

const task = {
  id: 'delegated-task', title: 'Research', goal: 'Find the answer', description: null,
  priority: 'normal', parentTaskId: null, assignee: { kind: 'remote_agent', agentId: 'worker', name: null }
} as TaskDto
const metadata: RemoteDelegationMetadata = {
  id: 'delegation', requesterKey: 'research', originKind: 'local_chat',
  originAgentId: 'requester', originChatId: 'chat', originTaskId: 'parent',
  depth: 2, root: 'root-delegation', group: 'research-group'
}

describe('delegation adapter contract', () => {
  it('carries the chain independently of the remote task tree and creates idempotently', async () => {
    const remote = createFakeRemote({ capabilities: { delegationMetadata: true, idempotentCreate: true } })
    const first = await remote.adapter.create('profile', task, null, metadata)
    const repeated = await remote.adapter.create('profile', task, null, metadata)
    expect(repeated.id).toBe(first.id)
    expect(remote.stored(first.id)?.parentId).toBeNull()
    expect(remote.stored(first.id)?.delegation).toEqual(metadata)
  })

  it('refuses metadata before dispatch when the remote has no structured representation', async () => {
    const remote = createFakeRemote({ capabilities: { delegationMetadata: false } })
    await expect(remote.adapter.create('profile', task, null, metadata)).rejects.toMatchObject({ code: 'unsupported' })
    expect(remote.requests()).toBe(0)
  })

  it('reads a structured result, question audience and remote artifacts without losing them', async () => {
    const remote = createFakeRemote({ capabilities: { readArtifacts: true } })
    const binding = await remote.adapter.create('profile', task, null)
    const result = { status: 'blocked' as const, summary: 'Choose a source', question: 'Which source?',
      audience: 'requester' as const, askId: 'ask-1', body: 'Two candidates', artifacts: [] }
    remote.touch(binding.id, { result, artifacts: [{ kind: 'link', ref: 'https://example.test/report', name: 'Report' }] })
    expect((await remote.adapter.fetch('profile', binding)).result).toEqual(result)
    expect(await remote.adapter.listArtifacts!('profile', binding)).toEqual([
      { kind: 'link', ref: 'https://example.test/report', name: 'Report' }
    ])
  })

  it('does not claim unimplemented backend metadata support while retaining safe top-level creates', async () => {
    const server = createFakeCinnaServer()
    const adapter = createCinnaTaskAdapter(server.world)
    expect(adapter.capabilities().idempotentCreate).toBe(true)
    expect(adapter.capabilities().delegationMetadata).not.toBe(true)
    await expect(adapter.create('profile', task, null, metadata)).rejects.toMatchObject({ code: 'unsupported' })
    expect(server.calls().filter(call => call.method !== 'GET')).toHaveLength(0)
  })

  it('negotiates a new backend contract, sends metadata, reads results and answers the exact question', async () => {
    const server = createFakeCinnaServer({ delegations: true })
    const adapter = createCinnaTaskAdapter(server.world)
    expect(await adapter.delegationSupport!('profile')).toEqual({ metadata: true, structuredResult: true, reply: true })
    const binding = await adapter.create('profile', task, null, metadata)
    expect(server.calls().filter(call => call.path.includes('delegation-capabilities'))).toHaveLength(1)
    expect(server.task(binding.id)?.delegation_metadata).toMatchObject({ requester_key: 'research', origin_task_id: 'parent', depth: 2 })
    server.task(binding.id)!.delegation_result = { id: 'question', status: 'blocked', summary: 'Input',
      question: 'Which file?', audience: 'requester', artifacts: [], body: 'Context' }
    server.task(binding.id)!.status = 'blocked'
    expect((await adapter.fetch('profile', binding)).result).toMatchObject({ askId: 'question', audience: 'requester' })
    expect((await adapter.listOpenAsks('profile', binding))[0]).toMatchObject({ id: 'question', audience: 'requester' })
    expect(await adapter.answerAsk('profile', binding, 'question', { kind: 'question', answers: [['README']] })).toEqual({ delivered: true })
    // The raw answer: the server quotes the question to the executor itself.
    expect(server.task(binding.id)!.delegation_result?.reply_message).toBe('README')
  })

  it('invalidates negotiated metadata support when the account credentials change', async () => {
    const server = createFakeCinnaServer({ delegations: true })
    const adapter = createCinnaTaskAdapter(server.world)
    await adapter.delegationSupport!('replacement-profile')
    invalidateCinnaSession('replacement-profile')
    await expect(adapter.create('replacement-profile', task, null, metadata)).rejects.toMatchObject({ code: 'unsupported' })
    expect(server.calls().filter(call => call.method !== 'GET')).toHaveLength(0)
  })

  it('keeps successful negotiation while another delegation probes the same server', async () => {
    const server = createFakeCinnaServer({ delegations: true })
    const adapter = createCinnaTaskAdapter(server.world)
    await adapter.delegationSupport!('parallel-profile')
    const request = server.world.request.bind(server.world)
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    vi.spyOn(server.world, 'request').mockImplementation(async (userId, path, options) => {
      if (path.endsWith('/delegation-capabilities')) await held
      return request(userId, path, options)
    })
    const probing = adapter.delegationSupport!('parallel-profile')
    try {
      await expect(adapter.create('parallel-profile', task, null, metadata)).resolves.toMatchObject({ id: expect.any(String) })
    } finally {
      release()
      await probing
    }
  })
})
