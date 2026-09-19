/**
 * cinna-core in memory, as far as `cinnaTaskAdapter` can tell.
 *
 * The point is what it refuses. A fake that answered 200 to everything would
 * let the adapter pass a contract suite that the real server fails, and the
 * three refusals that matter here are the three the step-8 review predicted the
 * adapter would get wrong:
 *
 *  - **an illegal transition is a 400**, with a body that says so — the same
 *    status code a non-owner gets, which is the whole reason `not_ours` is
 *    identified by the body and not the status line;
 *  - **a non-owner is a 400 whose body is exactly `Not enough permissions`**,
 *    and a caller that cannot use an *agent* gets a 400 saying `Not enough
 *    permissions for this agent` — a different refusal one word longer;
 *  - **`POST /tasks/{id}/execute` answers 200 with `{success: false}`** when it
 *    cannot start, because on cinna a failure to start is not an HTTP error.
 *
 * Field names are cinna's (`original_message`, `current_description`,
 * `selected_agent_id`, `short_code`, `comment_type`, `tool_questions_status`),
 * transcribed from `backend/app/models/tasks/input_task.py` and
 * `backend/app/models/sessions/session.py` at `793782a3`. Where this file and
 * the server disagree, the server is right and this is a bug.
 *
 * What it does **not** model, deliberately: refinement, teams, workspaces,
 * attachments as a readable list (the seam has no read half for artifacts),
 * `compute_status_from_sessions` recomputing a status behind the desktop's
 * back, and the streaming half of `messages/stream` — the adapter posts and
 * reads the flag, and never subscribes.
 */

import { nanoid } from 'nanoid'
import { VALID_TRANSITIONS, REMOTE_WRITABLE_STATUSES, type TaskStatus } from '../../../../shared/taskStatus'
import { CinnaApiError } from '../../../errors'
import { RemoteTaskError } from '../adapter'
import type { InputQuestion } from '../../../../shared/runEvents'
import type { CinnaWorld } from '../cinnaTaskAdapter'

/** How the far side is behaving. `null` is a healthy server. */
export type CinnaFarSide = null | 'transport' | 'not_ours' | 'rejected'

interface FakeTask {
  delegation_metadata?: Record<string, unknown>
  delegation_result?: Record<string, unknown>
  id: string
  /**
   * Creation order, and the reason it is modelled at all.
   *
   * `GET /tasks/` with no cursor orders by **`created_at DESC`**
   * (`input_task_service.list_tasks`), i.e. newest first — so a subtask is
   * returned *before* its parent. A fake that handed rows back in insertion
   * order would be the exact opposite, and a caller that resolves a parent by
   * looking it up locally would pass here and put every pulled subtask at top
   * level against the real server.
   */
  seq: number
  short_code: string
  title: string
  original_message: string
  current_description: string
  status: TaskStatus
  priority: string
  error_message: string | null
  selected_agent_id: string | null
  agent_name: string | null
  parent_task_id: string | null
  external_ref: string | null
  updated_at: Date
  comments: { id: string; comment_type: string; content: string; author_name: string; created_at: Date }[]
  files: string[]
}

interface FakeMessage {
  id: string
  tool_questions_status: string | null
  timestamp: Date
  questions: InputQuestion[]
  answered_with: string | null
}

interface FakeSession {
  id: string
  taskId: string
  interaction_status: string
  status: string
  messages: FakeMessage[]
}

export interface FakeCinnaServer {
  world: CinnaWorld
  /** Far-side calls made so far. A refusal that never left the process adds none. */
  requests(): number
  behave(mode: CinnaFarSide): void
  /** A session with one unanswered tool question; returns the message id. */
  plantAsk(taskId: string, questions?: InputQuestion[]): string
  /** Put `n` answered messages ahead of a session's ask, so it falls off the first page. */
  padSession(messageId: string, n: number): void
  /** Put a session on a task without an ask — how `liveSession` becomes true. */
  startSession(taskId: string, interaction: 'running' | ''): string
  /** The server's copy, for a test that wants to see what a push actually did. */
  task(taskId: string): FakeTask | undefined
  /** Pretend somebody else changed it on the web. An explicit `updated_at` is honoured. */
  touch(taskId: string, patch: Partial<FakeTask>): void
  /** Every request path this server has been asked for, in order. */
  calls(): { method: string; path: string; body?: unknown }[]
  /** Make `execute` report the 200-shaped failure cinna answers with. */
  refuseExecute(): void
  /** Put a task on the far side without going through the create route. */
  seed(patch?: Partial<FakeTask>): FakeTask
  /** Take a task off the far side, as a delete on the web does. It answers 404 after this. */
  forget(taskId: string): void
}

export interface FakeCinnaOptions {
  delegations?: boolean
  /** A profile that is not linked to a Cinna account. */
  ready?: boolean
  baseUrl?: string
}

const ALLOWED_USER_STATUSES = new Set<string>(REMOTE_WRITABLE_STATUSES)

export function createFakeCinnaServer(options: FakeCinnaOptions = {}): FakeCinnaServer {
  const ready = options.ready ?? true
  const baseUrl = options.baseUrl ?? 'https://cinna.test'

  const tasks = new Map<string, FakeTask>()
  const sessions = new Map<string, FakeSession>()
  const uploads = new Set<string>()
  const calls: { method: string; path: string; body?: unknown }[] = []
  let mode: CinnaFarSide = null
  let executeFails = false
  let requests = 0
  let nextCode = 1
  let nextSeq = 1

  function fail(status: number, detail: string): never {
    throw new CinnaApiError('request_failed', `Cinna API ${status}: ${detail}`, detail, status)
  }

  function newTask(patch: Partial<FakeTask> = {}): FakeTask {
    const id = `ct-${nanoid(8)}`
    return {
      id,
      seq: nextSeq++,
      short_code: `TASK-${nextCode++}`,
      title: 'Untitled',
      original_message: '',
      current_description: '',
      // cinna's own create state, whatever the desktop task was on. This is
      // why the status push walks a path rather than sending a destination.
      status: 'new',
      priority: 'normal',
      error_message: null,
      selected_agent_id: null,
      agent_name: null,
      parent_task_id: null,
      external_ref: null,
      updated_at: new Date(),
      comments: [],
      files: [],
      ...patch
    }
  }

  function publicTask(task: FakeTask): Record<string, unknown> {
    const children = [...tasks.values()].filter((t) => t.parent_task_id === task.id)
    return {
      id: task.id,
      short_code: task.short_code,
      title: task.title,
      original_message: task.original_message,
      current_description: task.current_description,
      status: task.status,
      priority: task.priority,
      error_message: task.error_message,
      selected_agent_id: task.selected_agent_id,
      agent_name: task.agent_name,
      parent_task_id: task.parent_task_id,
      external_ref: task.external_ref,
      delegation_metadata: task.delegation_metadata,
      delegation_result: task.delegation_result,
      subtask_count: children.length,
      subtask_completed_count: children.filter((c) => c.status === 'completed').length,
      // Naive UTC, no zone marker — exactly what FastAPI serialises, and the
      // reason the adapter appends a `Z` before parsing.
      updated_at: task.updated_at.toISOString().replace('Z', ''),
      created_at: task.updated_at.toISOString().replace('Z', '')
    }
  }

  function load(taskId: string): FakeTask {
    const task = tasks.get(taskId)
    // A genuinely absent task is a 404; a task belonging to someone else is a
    // 400. Both are `not_ours` to the adapter, and only one of them is a 404.
    if (!task) fail(404, 'Task not found')
    return task
  }

  function query(path: string): URLSearchParams {
    const index = path.indexOf('?')
    return new URLSearchParams(index === -1 ? '' : path.slice(index + 1))
  }

  function route(method: string, rawPath: string, body: unknown): unknown {
    const path = rawPath.split('?')[0]
    const parts = path.replace(/^\/api\/v1\//, '').replace(/\/$/, '').split('/')
    if (parts[0] === 'agents' && method === 'GET') {
      return { data: [{ id: 'agt-worker', name: 'Remote worker' }], count: 1 }
    }

    if (parts[0] === 'activities' && parts[1] === 'stats') {
      const waiting = [...sessions.values()].reduce(
        (n, s) => n + s.messages.filter((m) => m.tool_questions_status === 'unanswered').length,
        0
      )
      return { unread_count: waiting, action_required_count: waiting }
    }

    if (parts[0] === 'sessions') {
      const session = sessions.get(decodeURIComponent(parts[1] ?? ''))
      if (!session) fail(404, 'Session not found')
      if (parts[2] === 'messages' && parts[3] === undefined && method === 'GET') {
        // Paged, oldest first, exactly as `get_session_messages` does — and
        // `count` is the length of the **page**, not a total, so a client
        // cannot jump to the end and has to walk forward.
        const params = query(rawPath)
        const limit = Number(params.get('limit') ?? 100)
        const offset = Number(params.get('offset') ?? 0)
        const page = session.messages.slice(offset, offset + limit)
        return {
          data: page.map((m) => ({
            id: m.id,
            session_id: session.id,
            role: 'agent',
            content: '',
            sequence_number: 0,
            timestamp: m.timestamp.toISOString().replace('Z', ''),
            message_metadata: {
              streaming_events: [
                {
                  type: 'tool',
                  tool_name: 'AskUserQuestion',
                  metadata: { tool_input: { questions: m.questions } }
                }
              ]
            },
            tool_questions_status: m.tool_questions_status,
            answers_to_message_id: null,
            status: '',
            status_message: null,
            sent_to_agent_status: 'pending'
          })),
          count: page.length
        }
      }
      if (parts[2] === 'messages' && parts[3] === 'stream' && method === 'POST') {
        const payload = (body ?? {}) as { content?: unknown; answers_to_message_id?: unknown }
        if (typeof payload.content !== 'string' || payload.content.length === 0) {
          // `MessageCreate.content` is required; an empty answer is a 422.
          fail(422, 'content must not be empty')
        }
        const answering = session.messages.find((m) => m.id === payload.answers_to_message_id)
        if (answering) {
          // `create_message` flips the flag and reports nothing about what it
          // was before — which is why the adapter has to read first.
          answering.tool_questions_status = 'answered'
          answering.answered_with = payload.content
        }
        return { id: `msg-${nanoid(6)}`, session_id: session.id }
      }
      fail(404, 'Not Found')
    }

    if (parts[0] !== 'tasks') fail(404, 'Not Found')

    if (parts[1] === 'delegation-capabilities') {
      if (!options.delegations) fail(404, 'Not Found')
      return { version: 1, metadata: true, structured_result: true, reply: true }
    }

    // ── /tasks/ ───────────────────────────────────────────────────────────
    if (parts[1] === undefined) {
      if (method === 'POST') {
        const payload = (body ?? {}) as Record<string, unknown>
        const ref = typeof payload.external_ref === 'string' ? payload.external_ref : null
        if (ref) {
          const existing = [...tasks.values()].find((t) => t.external_ref === ref)
          // Idempotent: a retry is indistinguishable from a first call, which
          // is the whole point of the key.
          if (existing) return publicTask(existing)
        }
        const created = newTask({
          title: String(payload.title ?? 'Untitled'),
          original_message: String(payload.original_message ?? ''),
          current_description: String(payload.original_message ?? ''),
          priority: String(payload.priority ?? 'normal'),
          selected_agent_id:
            typeof payload.selected_agent_id === 'string' ? payload.selected_agent_id : null,
          external_ref: ref,
          ...(options.delegations && payload.delegation_metadata ? { delegation_metadata: payload.delegation_metadata as Record<string, unknown> } : {})
        })
        tasks.set(created.id, created)
        return publicTask(created)
      }
      if (method === 'GET') {
        const params = query(rawPath)
        const since = params.get('updated_since')
        const status = params.get('status')
        let rows = [...tasks.values()]
        if (since) {
          // Sync order: ascending by the cursor column. Strictly greater —
          // which is why the desktop rewinds its cursor rather than trusting
          // the boundary.
          const cursor = new Date(since)
          rows = rows.filter((t) => t.updated_at > cursor)
          rows.sort((a, b) => a.updated_at.getTime() - b.updated_at.getTime())
        } else {
          // List order: `created_at DESC`, newest first. A subtask therefore
          // arrives before the parent it hangs off.
          rows.sort((a, b) => b.seq - a.seq)
        }
        if (!since && status === 'active') {
          // `parse_status_filter`'s own list. Note what is *missing*:
          // `completed`, `cancelled` and `archived`. A reconcile that deleted
          // whatever this omits would delete every finished task.
          const active = new Set(['new', 'refining', 'open', 'in_progress', 'blocked', 'error'])
          rows = rows.filter((t) => active.has(t.status))
        }
        const skip = Number(params.get('skip') ?? 0)
        const limit = Number(params.get('limit') ?? 100)
        return { data: rows.slice(skip, skip + limit).map(publicTask), count: rows.length }
      }
      fail(405, 'Method Not Allowed')
    }

    const taskId = decodeURIComponent(parts[1])
    const task = load(taskId)

    if (parts[2] === undefined) {
      if (method === 'GET') return publicTask(task)
      if (method === 'PATCH') {
        const payload = (body ?? {}) as Record<string, unknown>
        if ('selected_agent_id' in payload && typeof payload.selected_agent_id === 'string') {
          if (!payload.selected_agent_id.startsWith('agt-')) {
            // `verify_agent_access` — a 400 about an agent, one word longer
            // than the ownership refusal and emphatically not the same thing.
            fail(400, 'Not enough permissions for this agent')
          }
          task.selected_agent_id = payload.selected_agent_id
          task.agent_name = 'A cinna agent'
        } else if ('selected_agent_id' in payload) {
          task.selected_agent_id = null
          task.agent_name = null
        }
        if (typeof payload.title === 'string') task.title = payload.title
        if (typeof payload.current_description === 'string') {
          task.current_description = payload.current_description
        }
        if (typeof payload.priority === 'string') task.priority = payload.priority
        task.updated_at = new Date()
        return publicTask(task)
      }
      fail(405, 'Method Not Allowed')
    }

    if (parts[2] === 'detail' && method === 'GET') {
      return {
        ...publicTask(task),
        comments: task.comments.map((c) => ({
          id: c.id,
          comment_type: c.comment_type,
          content: c.content,
          author_name: c.author_name,
          created_at: c.created_at.toISOString().replace('Z', '')
        })),
        attachments: [],
        subtasks: [],
        status_history: []
      }
    }

    if (parts[2] === 'delegation-reply' && method === 'POST' && options.delegations) {
      const input = body as { result_id: string; message: string }
      if (task.delegation_result?.id !== input.result_id || task.delegation_result.status !== 'blocked') return { delivered: false }
      task.delegation_result = { ...task.delegation_result, status: 'in_progress', reply_message: input.message }
      task.status = 'in_progress'
      return { delivered: true }
    }

    if (parts[2] === 'status' && method === 'POST') {
      const payload = (body ?? {}) as { status?: unknown }
      const next = String(payload.status ?? '')
      if (!ALLOWED_USER_STATUSES.has(next)) {
        fail(400, `Status '${next}' is not one a user may set`)
      }
      if (!VALID_TRANSITIONS[task.status].includes(next as TaskStatus)) {
        // The 400 this whole phase is shaped around. It is a `ValidationError`,
        // not a `PermissionDeniedError`, and telling them apart is the
        // adapter's job.
        fail(400, `Cannot transition task from '${task.status}' to '${next}'`)
      }
      task.status = next as TaskStatus
      task.updated_at = new Date()
      return publicTask(task)
    }

    if (parts[2] === 'archive' && method === 'POST') {
      task.status = 'archived'
      task.updated_at = new Date()
      return publicTask(task)
    }

    if (parts[2] === 'execute' && method === 'POST') {
      if (executeFails) {
        // 200, and a failure. The trap.
        return { success: false, error: 'Task has no selected agent' }
      }
      const session: FakeSession = {
        id: `sess-${nanoid(6)}`,
        taskId: task.id,
        interaction_status: 'running',
        status: 'active',
        messages: []
      }
      sessions.set(session.id, session)
      task.status = 'in_progress'
      task.updated_at = new Date()
      return { success: true, session_id: session.id }
    }

    if (parts[2] === 'sessions' && method === 'GET') {
      const rows = [...sessions.values()].filter((s) => s.taskId === task.id)
      return {
        data: rows.map((s) => ({
          id: s.id,
          user_id: 'u-1',
          user_workspace_id: null,
          access_token_id: null,
          source_task_id: s.taskId,
          title: null,
          mode: 'conversation',
          status: s.status,
          interaction_status: s.interaction_status,
          pending_messages_count: 0,
          result_state: null,
          created_at: new Date().toISOString().replace('Z', ''),
          updated_at: new Date().toISOString().replace('Z', ''),
          last_message_at: null
        })),
        count: rows.length
      }
    }

    if (parts[2] === 'comments') {
      if (method === 'GET') {
        const params = query(rawPath)
        const skip = Number(params.get('skip') ?? 0)
        const limit = Number(params.get('limit') ?? 100)
        return {
          data: task.comments.slice(skip, skip + limit).map((c) => ({
            id: c.id,
            comment_type: c.comment_type,
            content: c.content,
            author_name: c.author_name,
            created_at: c.created_at.toISOString().replace('Z', '')
          })),
          count: task.comments.length
        }
      }
      if (method === 'POST') {
        const payload = (body ?? {}) as Record<string, unknown>
        const content = String(payload.content ?? '')
        if (!content) fail(422, 'content must not be empty')
        const comment = {
          id: `cm-${nanoid(6)}`,
          comment_type: String(payload.comment_type ?? 'message'),
          content,
          author_name: 'The desktop',
          created_at: new Date()
        }
        task.comments.push(comment)
        // A comment bumps `updated_at` — the server's own `touch_task`, added
        // so a comment-only change is visible to the `updated_since` cursor.
        task.updated_at = new Date()
        return { ...comment, created_at: comment.created_at.toISOString().replace('Z', '') }
      }
    }

    if (parts[2] === 'subtasks') {
      if (method === 'GET') {
        const children = [...tasks.values()].filter((t) => t.parent_task_id === task.id)
        return { data: children.map(publicTask), count: children.length }
      }
      if (method === 'POST') {
        const payload = (body ?? {}) as Record<string, unknown>
        const child = newTask({
          title: String(payload.title ?? 'Untitled'),
          original_message: String(payload.original_message ?? ''),
          current_description: String(payload.original_message ?? ''),
          priority: String(payload.priority ?? 'normal'),
          parent_task_id: task.id,
          // **Ignored on this route**, and the server says so: an idempotency
          // key matched here would return a task under a different parent.
          external_ref: null
        })
        tasks.set(child.id, child)
        return publicTask(child)
      }
    }

    if (parts[2] === 'files' && method === 'POST') {
      const fileId = decodeURIComponent(parts[3] ?? '')
      if (!uploads.has(fileId)) fail(404, 'File not found')
      task.files.push(fileId)
      task.updated_at = new Date()
      return { id: fileId, filename: 'report.md', file_size: 1, mime_type: 'text/markdown' }
    }

    fail(404, 'Not Found')
  }

  const world: CinnaWorld = {
    async request<T>(
      _userId: string,
      path: string,
      opts?: { method?: string; body?: unknown }
    ): Promise<T> {
      const method = opts?.method ?? 'GET'
      if (!ready) {
        // No credential to send. A real adapter either has no token or gets a
        // 401; either way the call fails, and a fake that quietly succeeded
        // would pass an adapter that invents a binding against a service it has
        // never spoken to.
        throw new CinnaApiError('not_cinna_user', 'Profile is not linked to Cinna')
      }
      requests += 1
      calls.push({ method, path, body: opts?.body })
      if (mode === 'transport') {
        // No status: the request never became a response.
        throw new CinnaApiError('request_failed', 'net::ERR_CONNECTION_REFUSED')
      }
      if (mode === 'not_ours') fail(400, 'Not enough permissions')
      if (mode === 'rejected') fail(400, "Cannot transition task from 'new' to 'completed'")
      return route(method, path, opts?.body) as T
    },

    serverUrl: () => {
      if (!ready) throw new CinnaApiError('not_cinna_user', 'Profile is not linked to Cinna')
      return baseUrl
    },

    linked: () =>
      ready
        ? { ready: true }
        : { ready: false, reason: 'This profile is not linked to a Cinna account.' },

    // An upload does **not** go through `cinnaApiFetch`: it is multipart,
    // through `cinnaFileService`, whose failures are a different error type
    // entirely. The production wiring translates them, so what this world hands
    // back is already a `RemoteTaskError` — a fake that threw `CinnaApiError`
    // here would be testing a path the real one never takes.
    async uploadFile(_userId, path) {
      if (!ready) {
        throw new RemoteTaskError('unavailable', 'This profile is not connected to Cinna.')
      }
      requests += 1
      calls.push({ method: 'POST', path: '/api/v1/files/upload', body: path })
      if (mode === 'transport') {
        throw new RemoteTaskError('unavailable', 'The file could not be uploaded.')
      }
      if (mode === 'not_ours') {
        throw new RemoteTaskError('not_ours', 'That task is not on this account any more.')
      }
      if (mode === 'rejected') {
        throw new RemoteTaskError('invalid_request', 'That file could not be read.')
      }
      const fileId = `file-${nanoid(6)}`
      uploads.add(fileId)
      return fileId
    }
  }

  return {
    world,
    requests: () => requests,
    behave: (next) => {
      mode = next
    },
    refuseExecute: () => {
      executeFails = true
    },
    plantAsk(taskId, questions) {
      const session: FakeSession = {
        id: `sess-${nanoid(6)}`,
        taskId,
        interaction_status: '',
        status: 'active',
        messages: []
      }
      const message: FakeMessage = {
        id: `msg-${nanoid(6)}`,
        tool_questions_status: 'unanswered',
        timestamp: new Date(),
        questions: questions ?? [
          {
            question: 'Which ledger?',
            header: 'Ledger',
            multiSelect: false,
            options: [{ label: 'Sales' }, { label: 'Payouts' }]
          }
        ],
        answered_with: null
      }
      session.messages.push(message)
      sessions.set(session.id, session)
      return message.id
    },
    padSession(messageId, n) {
      for (const session of sessions.values()) {
        const index = session.messages.findIndex((m) => m.id === messageId)
        if (index === -1) continue
        const filler: FakeMessage[] = Array.from({ length: n }, (_, i) => ({
          id: `msg-pad-${i}`,
          tool_questions_status: null,
          timestamp: new Date(),
          questions: [],
          answered_with: null
        }))
        // Ahead of it: the ask is always the newest message, and the page is
        // ordered oldest first.
        session.messages.splice(index, 0, ...filler)
      }
    },
    startSession(taskId, interaction) {
      const session: FakeSession = {
        id: `sess-${nanoid(6)}`,
        taskId,
        interaction_status: interaction,
        status: 'active',
        messages: []
      }
      sessions.set(session.id, session)
      return session.id
    },
    task: (taskId) => tasks.get(taskId),
    touch: (taskId, patch) => {
      const task = tasks.get(taskId)
      // An explicit `updated_at` wins, so a test can build a precise ordering —
      // and in particular a deliberate tie, which is the case the cursor has to
      // survive and which `new Date()` produces only by luck.
      if (task) Object.assign(task, patch, { updated_at: patch?.updated_at ?? new Date() })
    },
    calls: () => [...calls],
    seed(patch) {
      const task = newTask(patch)
      tasks.set(task.id, task)
      return task
    },
    forget: (taskId) => {
      tasks.delete(taskId)
    }
  }
}
