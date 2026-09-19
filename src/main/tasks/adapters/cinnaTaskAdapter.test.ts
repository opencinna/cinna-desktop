import { describe, expect, it } from 'vitest'
import { createCinnaTaskAdapter } from './cinnaTaskAdapter'
import { createFakeCinnaServer, type FakeCinnaServer } from './testSupport/fakeCinnaServer'
import { RemoteTaskError, UnsupportedRemoteOperation, type RemoteBinding } from './adapter'
import type { TaskDto } from '../../../shared/tasks'

/**
 * What the contract suite cannot check: that the bytes on the wire are the ones
 * cinna-core's Pydantic models actually name.
 *
 * `adapterContract.test.ts` asserts the *shape of the seam* — only `create`
 * invents a binding, a denial unbinds, a refusal does not. It would pass an
 * adapter that sent `description` where the server wants `current_description`,
 * because the fake server it runs against is the same file's idea of cinna.
 * These are the assertions that make that fake accountable: every field name
 * below was read out of `backend/app/models/tasks/input_task.py` and
 * `backend/app/models/sessions/session.py` at `793782a3`.
 */

const USER = 'u-1'

function makeTask(overrides: Partial<TaskDto> = {}): TaskDto {
  const now = new Date('2026-09-11T10:00:00.000Z')
  return {
    id: 'tsk_local',
    title: 'Reconcile payouts',
    goal: 'Reconcile payouts for the last 7 days',
    description: 'The ledger and the bank disagree by £12.',
    status: 'new',
    priority: 'high',
    router: 'direct',
    origin: 'local',
    executor: 'desktop',
    executorDevice: null,
    runsHere: true,
    chatId: null,
    assignee: { agentId: null, name: null, kind: 'model' },
    parentTaskId: null,
    subtaskCount: 0,
    subtaskCompletedCount: 0,
    remote: null,
    handoffNote: null,
    artifacts: [],
    budget: null,
    errorMessage: null,
    jobId: null,
    jobRunId: null,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
    ...overrides
  }
}

function world(): { server: FakeCinnaServer; adapter: ReturnType<typeof createCinnaTaskAdapter> } {
  const server = createFakeCinnaServer()
  return { server, adapter: createCinnaTaskAdapter(server.world) }
}

async function bound(): Promise<{
  server: FakeCinnaServer
  adapter: ReturnType<typeof createCinnaTaskAdapter>
  binding: RemoteBinding
}> {
  const { server, adapter } = world()
  const binding = await adapter.create(USER, makeTask(), null)
  return { server, adapter, binding }
}

describe('cinnaTaskAdapter — the payload', () => {
  it('creates with cinna’s own field names and the desktop’s id as the idempotency key', async () => {
    const { server, adapter } = world()
    const binding = await adapter.create(USER, makeTask(), null)

    const create = server.calls().find((c) => c.method === 'POST' && c.path === '/api/v1/tasks/')
    expect(create?.body).toEqual({
      original_message: 'Reconcile payouts for the last 7 days',
      title: 'Reconcile payouts',
      priority: 'high',
      // The desktop's own task id. It is what makes a create retried after a
      // lost response return the first task, and what re-binds local tasks to
      // their cinna counterparts after a reinstall.
      external_ref: 'tsk_local'
    })
    expect(binding.adapter).toBe('cinna')
    expect(binding.key).toMatch(/^TASK-\d+$/)
    expect(binding.url).toBe(`https://cinna.test/tasks/${binding.key}`)
  })

  it('sends the goal, not the description — they are different fields and only one is editable', async () => {
    const { server, adapter } = world()
    await adapter.create(USER, makeTask(), null)
    const body = server.calls()[0]?.body as Record<string, unknown>
    // `original_message` is immutable on cinna and is what `TaskPatch` refuses
    // to update here. Sending the description would make the remote's
    // permanent record of the ask a paraphrase that could never be corrected.
    expect(body.original_message).toBe('Reconcile payouts for the last 7 days')
    expect(body).not.toHaveProperty('current_description')
    expect(body).not.toHaveProperty('description')
  })

  it('is idempotent on a retry, as the server promises', async () => {
    const { adapter } = world()
    const first = await adapter.create(USER, makeTask(), null)
    const second = await adapter.create(USER, makeTask(), null)
    expect(second.id).toBe(first.id)
  })

  it('only names an agent the service could possibly know', async () => {
    const { server, adapter } = world()
    // A desktop agent's row id means nothing on cinna, so it is not sent.
    await adapter.create(
      USER,
      makeTask({ assignee: { agentId: 'agt_local_1', name: 'Ledger', kind: 'agent' } }),
      null
    )
    expect(server.calls()[0]?.body).not.toHaveProperty('selected_agent_id')

    const remote = createFakeCinnaServer()
    const other = createCinnaTaskAdapter(remote.world)
    await other.create(
      USER,
      makeTask({ assignee: { agentId: 'agt-cloud-9', name: 'Ledger', kind: 'remote_agent' } }),
      null
    )
    expect((remote.calls()[0]?.body as Record<string, unknown>).selected_agent_id).toBe(
      'agt-cloud-9'
    )
  })

  it('creates a subtask through the parent’s route, never at top level', async () => {
    const { server, adapter, binding } = await bound()
    const child = await adapter.create(
      USER,
      makeTask({ id: 'tsk_child', parentTaskId: 'tsk_local' }),
      binding
    )
    expect(server.calls().map((c) => c.path)).toContain(
      `/api/v1/tasks/${binding.id}/subtasks/`
    )
    const children = await adapter.listSubtasks(USER, binding)
    expect(children.map((c) => c.binding.id)).toContain(child.id)
  })

  it('refuses a subtask whose parent binding was not supplied, before asking', async () => {
    const { server, adapter } = world()
    const before = server.requests()
    await expect(
      adapter.create(USER, makeTask({ id: 'tsk_child', parentTaskId: 'tsk_local' }), null)
    ).rejects.toMatchObject({ code: 'invalid_request' })
    expect(server.requests()).toBe(before)
  })
})

describe('cinnaTaskAdapter — the dirty-field patch', () => {
  it('sends only what changed, and nothing else', async () => {
    const { server, adapter, binding } = await bound()
    await adapter.pushFields(USER, binding, { title: 'Renamed' })

    const patch = server.calls().find((c) => c.method === 'PATCH')
    // The one assertion that stops the whole-record PATCH this phase names as
    // the bug it is most likely to ship: a field nobody touched, sent anyway,
    // overwrites whatever the web edited since the last pull.
    expect(patch?.body).toEqual({ title: 'Renamed' })
    expect(patch?.body).not.toHaveProperty('current_description')
    expect(patch?.body).not.toHaveProperty('priority')
    expect(patch?.body).not.toHaveProperty('selected_agent_id')
  })

  it('maps description onto current_description', async () => {
    const { server, adapter, binding } = await bound()
    await adapter.pushFields(USER, binding, { description: 'Now understood.' })
    expect(server.calls().find((c) => c.method === 'PATCH')?.body).toEqual({
      current_description: 'Now understood.'
    })
  })

  it('sends nothing at all for an empty patch', async () => {
    const { server, adapter, binding } = await bound()
    const before = server.requests()
    const next = await adapter.pushFields(USER, binding, {})
    expect(server.requests()).toBe(before)
    expect(next.id).toBe(binding.id)
  })

  it('refuses to assign someone who only exists on this device', async () => {
    const { server, adapter, binding } = await bound()
    const before = server.requests()
    await expect(
      adapter.pushFields(USER, binding, {
        assignee: { ref: 'agt_local_1', name: 'Ledger', kind: 'agent' }
      })
    ).rejects.toMatchObject({ code: 'invalid_request' })
    expect(server.requests()).toBe(before)
  })
})

describe('cinnaTaskAdapter — the status write', () => {
  it('never lets a status the route would refuse leave the process', async () => {
    const { server, adapter, binding } = await bound()
    for (const status of ['archived', 'new', 'refining'] as const) {
      const before = server.requests()
      await expect(adapter.pushStatus(USER, binding, status)).rejects.toBeInstanceOf(
        RemoteTaskError
      )
      expect(server.requests(), `${status} reached the service`).toBe(before)
    }
  })

  it('files a task away through the archive route, which owns archived_at', async () => {
    const { server, adapter, binding } = await bound()
    await adapter.archive(USER, binding)
    expect(server.calls().map((c) => c.path)).toContain(`/api/v1/tasks/${binding.id}/archive`)
    expect(server.task(binding.id)?.status).toBe('archived')
  })

  it('carries the reason, because the status history is an audit trail', async () => {
    const { server, adapter, binding } = await bound()
    await adapter.pushStatus(USER, binding, 'in_progress', 'Running on this desktop')
    expect(server.calls().find((c) => c.path.endsWith('/status'))?.body).toEqual({
      status: 'in_progress',
      reason: 'Running on this desktop'
    })
  })

  /**
   * §5.12 rule 2, from the adapter's side: one step, not a destination. Walking
   * the path is `taskSyncService`'s job (`taskStatusPath`), and an adapter that
   * tried to do it here would be guessing at the remote's table.
   */
  it('refuses a step the remote’s table forbids — and keeps the binding', async () => {
    const { adapter, binding } = await bound()
    let thrown: unknown
    try {
      await adapter.pushStatus(USER, binding, 'completed')
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(RemoteTaskError)
    // `rejected`, not `not_ours`. Both are 400 on cinna-core, and reading the
    // status line alone would have unbound the task on the one failure this
    // phase most expects to see.
    expect((thrown as RemoteTaskError).code).toBe('rejected')
  })
})

describe('cinnaTaskAdapter — what a 400 means', () => {
  it('unbinds only on a 400 that is exactly the ownership refusal', async () => {
    const { server, adapter, binding } = await bound()
    server.behave('not_ours')
    await expect(adapter.fetch(USER, binding)).rejects.toMatchObject({ code: 'not_ours' })
  })

  it('does not unbind over an agent the account cannot use', async () => {
    const { adapter, binding } = await bound()
    // `verify_agent_access` raises `PermissionDeniedError("Not enough
    // permissions for this agent")` — 400, four words longer, and about the
    // assignee rather than the task. A prefix match here would throw away a
    // binding because the user picked the wrong agent.
    let thrown: unknown
    try {
      await adapter.pushFields(USER, binding, {
        assignee: { ref: 'someone-elses-agent', name: null, kind: 'remote_agent' }
      })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(RemoteTaskError)
    expect((thrown as RemoteTaskError).code).toBe('rejected')
    expect((thrown as RemoteTaskError).code).not.toBe('not_ours')
  })

  it('unbinds on a 404, which is the one status that means it alone', async () => {
    const { adapter } = world()
    const ghost: RemoteBinding = {
      adapter: 'cinna',
      id: 'ct-gone',
      key: 'TASK-99',
      url: null,
      state: {}
    }
    await expect(adapter.fetch(USER, ghost)).rejects.toMatchObject({ code: 'not_ours' })
  })

  it('retries a transport failure rather than unbinding over it', async () => {
    const { server, adapter, binding } = await bound()
    server.behave('transport')
    await expect(adapter.fetch(USER, binding)).rejects.toMatchObject({ code: 'unavailable' })
  })
})

describe('cinnaTaskAdapter — reading a task back', () => {
  it('carries the goal, which a replica could never be given later', async () => {
    const { adapter, binding } = await bound()
    const snapshot = await adapter.fetch(USER, binding)
    // `taskRepo.create` requires a goal and `TaskPatch` refuses to update it:
    // a pull with no goal in the snapshot would have to invent one, for ever.
    expect(snapshot.goal).toBe('Reconcile payouts for the last 7 days')
    expect(snapshot.title).toBe('Reconcile payouts')
    expect(snapshot.priority).toBe('high')
  })

  it('reads a zoneless timestamp as UTC, which is what the server means by it', async () => {
    const { adapter, binding } = await bound()
    const snapshot = await adapter.fetch(USER, binding)
    // FastAPI serialises naive UTC. `new Date('…T10:00:00')` is *local* in
    // JavaScript — east of Greenwich every pulled task would look hours older
    // than it is, and `updated_since` would hide the change that produced it.
    const drift = Math.abs(snapshot.updatedAt.getTime() - Date.now())
    expect(drift).toBeLessThan(60_000)
  })

  it('says whether work is live on the remote, from its sessions and not its status', async () => {
    const { server, adapter, binding } = await bound()
    expect(await adapter.liveSession(USER, binding)).toBe(false)

    // A task can sit `in_progress` with nothing running: cinna recomputes the
    // status from its sessions, so the status is the wrong thing to ask.
    server.touch(binding.id, { status: 'in_progress' })
    server.startSession(binding.id, '')
    expect(await adapter.liveSession(USER, binding)).toBe(false)

    server.startSession(binding.id, 'running')
    expect(await adapter.liveSession(USER, binding)).toBe(true)
  })

  it('does not ask about sessions to fetch a task', async () => {
    const { server, adapter, binding } = await bound()
    server.startSession(binding.id, 'running')
    const before = server.calls().length

    await adapter.fetch(USER, binding)

    // **One request, and the point is which one is absent.** Until step 11 the
    // snapshot carried a `liveSession` field, so every `fetch` also listed the
    // task's sessions — one extra round trip per watched replica per pull pass,
    // for an answer `patchFrom` had nowhere to put and threw away. The question
    // is asked by `liveSession`, once, by somebody about to take the task over.
    expect(server.calls().slice(before).map((c) => c.path)).toEqual([
      `/api/v1/tasks/${binding.id}/detail`
    ])
  })

  it('asks for the active set with no cursor, and for everything changed with one', async () => {
    const { server, adapter } = world()
    await adapter.list(USER, null)
    await adapter.list(USER, new Date('2026-09-11T09:00:00.000Z'))
    const paths = server.calls().map((c) => c.path)
    expect(paths[0]).toContain('status=active')
    expect(paths[1]).toContain('updated_since=2026-09-11T09%3A00%3A00.000Z')
    // A cursor is the filter; adding a status filter on top of it would hide
    // exactly the tasks that just finished.
    expect(paths[1]).not.toContain('status=')
  })

  it('pages until the server stops, so a reconcile sees the whole set', async () => {
    const { server, adapter } = world()
    for (let i = 0; i < 150; i++) server.seed({ title: `Task ${i}` })
    const all = await adapter.list(USER, null)
    expect(all).toHaveLength(150)
    expect(server.calls().filter((c) => c.path.startsWith('/api/v1/tasks/?'))).toHaveLength(2)
  })

  describe('paging a delta', () => {
    /** `n` tasks, changed at one-second intervals from `start`. */
    function changedRows(server: FakeCinnaServer, n: number, start: number): string[] {
      const ids: string[] = []
      for (let i = 0; i < n; i++) {
        const task = server.seed({ title: `Task ${i}` })
        server.touch(task.id, { updated_at: new Date(start + i * 1000) })
        ids.push(task.id)
      }
      return ids
    }

    it('advances the cursor instead of skipping, because the sort key moves', async () => {
      const { server, adapter } = world()
      const ids = changedRows(server, 150, Date.parse('2026-09-11T09:00:00.000Z'))

      const seen = await adapter.list(USER, new Date('2026-09-11T08:00:00.000Z'))

      expect(new Set(seen.map((s) => s.binding.id))).toEqual(new Set(ids))
      // The server's own docstring says not to: with `updated_since` the sort
      // key is mutable, so offset paging over it can skip unread rows.
      expect(server.calls().some((c) => c.path.includes('skip='))).toBe(false)
    })

    it('does not lose the row a concurrent edit pushed past the page boundary', async () => {
      const { server } = world()
      const ids = changedRows(server, 150, Date.parse('2026-09-11T09:00:00.000Z'))

      // While page 2 is in flight, a cinna agent touches a task that was near
      // the front. It moves to the tail and everything below it shifts up one
      // — so an offset of 100 would begin one row late and the old row 100
      // would never be returned by any page.
      let pages = 0
      const racing = createCinnaTaskAdapter({
        ...server.world,
        request: async (userId, path, opts) => {
          if (path.includes('updated_since') && pages++ === 1) {
            server.touch(ids[40], { updated_at: new Date(Date.parse('2026-09-11T23:00:00.000Z')) })
          }
          return server.world.request(userId, path, opts)
        }
      })

      const seen = await racing.list(USER, new Date('2026-09-11T08:00:00.000Z'))
      expect(new Set(seen.map((s) => s.binding.id))).toEqual(new Set(ids))
    })

    it('does not cut a tie group in half at a page boundary', async () => {
      const { server, adapter } = world()
      const ids = changedRows(server, 150, Date.parse('2026-09-11T09:00:00.000Z'))
      // Rows 95–104 written in one instant, straddling the boundary. Advancing
      // to the last row's timestamp — the server's own advice — would exclude
      // the rest of the group, because the filter is strictly greater and there
      // is no `after_id` to disambiguate with. Ties are routine here: a status
      // change commits the task *and* posts a comment, and both touch the
      // column.
      const tie = new Date(Date.parse('2026-09-11T09:01:35.000Z'))
      for (let i = 95; i < 105; i++) server.touch(ids[i], { updated_at: tie })

      const seen = await adapter.list(USER, new Date('2026-09-11T08:00:00.000Z'))
      expect(new Set(seen.map((s) => s.binding.id))).toEqual(new Set(ids))
    })
  })

  it('does not report a finished task in the active set — which is why a reconcile confirms', async () => {
    const { server, adapter } = world()
    const done = server.seed({ status: 'completed' })
    server.seed({ status: 'in_progress' })
    const active = await adapter.list(USER, null)
    // `parse_status_filter`'s `active` excludes completed, cancelled and
    // archived. A reconcile that deleted whatever the list omits would delete
    // every task the user ever finished.
    expect(active.map((s) => s.binding.id)).not.toContain(done.id)
  })
})

describe('cinnaTaskAdapter — handing work over', () => {
  it('treats a 200 that says success: false as a refusal', async () => {
    const { server, adapter, binding } = await bound()
    server.refuseExecute()
    let thrown: unknown
    try {
      await adapter.execute(USER, binding)
    } catch (err) {
      thrown = err
    }
    // On cinna a failure to start is not an HTTP error. An adapter that read
    // the status line alone would report a handover as successful and leave
    // the task on a service that never picked it up.
    expect(thrown).toBeInstanceOf(RemoteTaskError)
    expect((thrown as RemoteTaskError).code).toBe('rejected')
  })

  it('posts the handoff note as the comment type cinna’s own agents read', async () => {
    const { server, adapter, binding } = await bound()
    await adapter.putHandoffNote(USER, binding, 'Half done; the ledger is open.')
    expect(server.calls().find((c) => c.path.endsWith('/comments/'))?.body).toEqual({
      content: 'Half done; the ledger is open.',
      comment_type: 'result'
    })
  })

  it('maps the seam’s three comment words onto cinna’s', async () => {
    const { server, adapter, binding } = await bound()
    await adapter.addComment(USER, binding, { type: 'note', body: 'a note' })
    await adapter.addComment(USER, binding, { type: 'system', body: 'a system line' })
    const types = server
      .calls()
      .filter((c) => c.path.endsWith('/comments/') && c.method === 'POST')
      .map((c) => (c.body as { comment_type: string }).comment_type)
    expect(types).toEqual(['message', 'system'])
  })

  it('reads a comment type it has never heard of rather than refusing it', async () => {
    const { server, adapter, binding } = await bound()
    server.task(binding.id)?.comments.push({
      id: 'cm-1',
      comment_type: 'something_a_newer_agent_invented',
      content: 'hello',
      author_name: 'An agent',
      created_at: new Date()
    })
    const [comment] = await adapter.listComments(USER, binding)
    expect(comment.type).toBe('something_a_newer_agent_invented')
  })

  it('reads beyond the first comment page so a delegation can find the latest result', async () => {
    const { adapter, server, binding } = await bound()
    for (let index = 0; index < 101; index++) {
      await adapter.addComment(USER, binding, { type: index === 100 ? 'result' : 'note', body: `Comment ${index}` })
    }
    const comments = await adapter.listComments(USER, binding)
    expect(comments).toHaveLength(101)
    expect(comments.at(-1)?.body).toBe('Comment 100')
    expect(server.calls().some(call => call.path.includes('skip=100'))).toBe(true)
  })

  it('stores a file and refuses a link, because cinna has nowhere to put one', async () => {
    const { server, adapter, binding } = await bound()
    await adapter.putArtifact(USER, binding, {
      kind: 'file',
      name: 'report.md',
      ref: '/tmp/report.md'
    })
    expect(server.calls().map((c) => c.path)).toContain('/api/v1/files/upload')
    expect(server.task(binding.id)?.files).toHaveLength(1)

    await expect(
      adapter.putArtifact(USER, binding, {
        kind: 'link',
        name: 'The pull request',
        ref: 'https://example.test/pr/1'
      })
    ).rejects.toBeInstanceOf(UnsupportedRemoteOperation)
  })
})

describe('cinnaTaskAdapter — an ask', () => {
  it('turns an unanswered tool question into the run vocabulary', async () => {
    const { server, adapter, binding } = await bound()
    server.plantAsk(binding.id, [
      {
        question: 'Which ledger?',
        header: 'Ledger',
        multiSelect: true,
        options: [{ label: 'Sales', description: 'The sales ledger' }, { label: 'Payouts' }]
      }
    ])

    const [ask] = await adapter.listOpenAsks(USER, binding)
    // The same `InputRequest` a parked ACP permission arrives as, so the inbox
    // renders both with one component and no second union exists to drift.
    expect(ask.request).toEqual({
      kind: 'question',
      questions: [
        {
          question: 'Which ledger?',
          header: 'Ledger',
          multiSelect: true,
          options: [{ label: 'Sales', description: 'The sales ledger' }, { label: 'Payouts' }]
        }
      ]
    })
    expect(ask.createdAt).toBeInstanceOf(Date)
  })

  it('collapses the same question asked twice in one response', async () => {
    const { server, adapter, binding } = await bound()
    const repeated = {
      question: 'Which ledger?',
      multiSelect: false,
      options: [{ label: 'Sales' }]
    }
    server.plantAsk(binding.id, [repeated, repeated])
    const [ask] = await adapter.listOpenAsks(USER, binding)
    expect(ask.request.kind === 'question' && ask.request.questions).toHaveLength(1)
  })

  it('answers in the format cinna’s own modal writes, linked to the question', async () => {
    const { server, adapter, binding } = await bound()
    const askId = server.plantAsk(binding.id, [
      { question: 'Which ledger?', multiSelect: true, options: [{ label: 'Sales' }] }
    ])

    expect(
      await adapter.answerAsk(USER, binding, askId, {
        kind: 'question',
        answers: [['Sales', 'Payouts']]
      })
    ).toEqual({ delivered: true })

    const post = server.calls().find((c) => c.path.endsWith('/messages/stream'))
    expect(post?.body).toEqual({
      content: 'Which ledger?\nAnswers:\n- Sales\n- Payouts',
      // Without this the answer is a fresh turn and the question stays
      // unanswered for ever — the flag is what the agent is waiting on.
      answers_to_message_id: askId
    })
  })

  it('finds an ask behind a hundred earlier messages', async () => {
    const { server, adapter, binding } = await bound()
    const askId = server.plantAsk(binding.id)
    // `GET /sessions/{id}/messages` is `limit=100, offset=0`, ordered oldest
    // first, and an unanswered ask is always the newest message. Reading only
    // the first page means the badge lights and the inbox row is empty — or
    // `answerAsk` reports "already answered" while the agent stays parked.
    server.padSession(askId, 250)

    const asks = await adapter.listOpenAsks(USER, binding)
    expect(asks.map((a) => a.id)).toEqual([askId])
    expect(await adapter.answerAsk(USER, binding, askId, { kind: 'rejected' })).toEqual({
      delivered: true
    })
  })

  it('says an ask it cannot find is not delivered, rather than failing', async () => {
    const { adapter, binding } = await bound()
    // Two surfaces, one registry: answering something that is already gone is
    // the commonest thing that happens to an ask, and it is an answer.
    expect(await adapter.answerAsk(USER, binding, 'msg-nothing', { kind: 'rejected' })).toEqual({
      delivered: false
    })
  })

  it('releases the agent when the user declines, instead of leaving it parked', async () => {
    const { server, adapter, binding } = await bound()
    const askId = server.plantAsk(binding.id)
    await adapter.answerAsk(USER, binding, askId, { kind: 'rejected' })
    const post = server.calls().find((c) => c.path.endsWith('/messages/stream'))
    // cinna has no "reject" for a tool question. Saying so in the answer is
    // what flips the flag and lets the session continue — the same reasoning
    // the local runner uses when an expiry posts a real deny.
    expect((post?.body as { content: string }).content).toContain('declined')
    expect(await adapter.listOpenAsks(USER, binding)).toEqual([])
  })

  it('refuses a permission answer, which a cinna ask never is', async () => {
    const { adapter, binding } = await bound()
    await expect(
      adapter.answerAsk(USER, binding, 'msg-1', { kind: 'permission', reply: 'once' })
    ).rejects.toMatchObject({ code: 'invalid_request' })
  })


})

describe('cinnaTaskAdapter — an unlinked profile', () => {
  it('says so in a sentence, without touching the network', async () => {
    const server = createFakeCinnaServer({ ready: false })
    const adapter = createCinnaTaskAdapter(server.world)
    const availability = await adapter.availability(USER)
    expect(availability.ready).toBe(false)
    expect(availability.reason ?? '').not.toBe('')
    expect(server.requests()).toBe(0)
  })

  it('fails a call as unavailable rather than as a task that is not ours', async () => {
    const server = createFakeCinnaServer({ ready: false })
    const adapter = createCinnaTaskAdapter(server.world)
    await expect(adapter.create(USER, makeTask(), null)).rejects.toMatchObject({
      code: 'unavailable'
    })
  })

  it('offers no deep link it cannot open', async () => {
    const server = createFakeCinnaServer({ ready: false })
    const adapter = createCinnaTaskAdapter(server.world)
    expect(
      adapter.deepLink({ adapter: 'cinna', id: 'ct-1', key: 'TASK-1', url: null, state: {} })
    ).toBeNull()
  })
})
