/**
 * cinna-core as a {@link RemoteTaskAdapter} — the seam's first real
 * implementation, and therefore the first evidence that the seam survives a
 * mapping it did not design.
 *
 * Everything cinna-specific in this phase is in this file: its field names
 * (`original_message`, `current_description`, `selected_agent_id`), its routes,
 * its status vocabulary, its idea of an ask. Nothing outside
 * `src/main/tasks/adapters/` names it, which is the phase's own exit criterion
 * and what the kind-branch ratchet's `remoteAdapter` category counts.
 *
 * ## Four things about cinna-core that a reasonable adapter gets wrong
 *
 * Each is a real server behaviour with a real cost, and each has a test.
 *
 * **1. A 400 is not "not yours".** `InputTaskError` defaults to
 * `status_code=400`, and `PermissionDeniedError` *and* `ValidationError` are
 * both 400, surfaced through one handler (`input_tasks.py:_handle_service_error`).
 * An illegal transition — the single most predicted failure in this phase — is
 * a `ValidationError`. Reading the status code alone would unbind a task whose
 * only problem was that the push skipped a step, and no retry could ever
 * re-link it. So `not_ours` is answered only for a **404**, or for a 400 whose
 * body says *exactly* `Not enough permissions`, which is what
 * `PermissionDeniedError()` raises with no argument. Exactly, not by prefix:
 * `verify_agent_access` raises `PermissionDeniedError("Not enough permissions
 * for this agent")` — a 400 about an *agent* the caller cannot use, on a route
 * that patches a task the caller owns perfectly well. Unbinding on that would
 * be a data loss caused by picking the wrong assignee.
 *
 * **2. `archived` is a different route.** `allowed_user_statuses` on
 * `POST /tasks/{id}/status` is `{open, in_progress, blocked, completed, error,
 * cancelled}`; filing a task away is `POST /tasks/{id}/archive`, which owns
 * `archived_at`. {@link RemoteTaskAdapter.archive} maps to it and `pushStatus`
 * refuses `archived` before the transport.
 *
 * **3. `POST /tasks/{id}/execute` answers 200 with `{success: false}`.** A
 * failure to start — no agent selected, no active environment — is not an HTTP
 * error. An adapter that only checked the status line would report a handover
 * as successful and leave the task sitting on a remote that never picked it up.
 *
 * **4. `list(userId, null)` is not everything.** It asks for `status=active`,
 * which on cinna excludes `completed`, `cancelled` and `archived`
 * (`parse_status_filter`). This is the seam's documented meaning for a null
 * cursor — "the adapter's own active set" — and it is why
 * `taskSyncService.reconcile` confirms each missing replica with a `fetch`
 * instead of deleting whatever the list omits. Deleting the omissions would
 * remove every completed task the user still has on screen.
 *
 * ## Two costs this mapping pays, deliberately
 *
 * `liveSession` is **its own request** (`/sessions`), asked once by a person
 * about to press Take over, and `fetch` is the single `/detail` call it looks
 * like. Until step 11 the two were one: the snapshot carried a `liveSession`
 * field, so every `fetch` — one per watched replica per pull pass — paid for
 * `/sessions` as well, and the pull dropped the answer on the floor because a
 * `TaskPatch` has nowhere to put it. The reason the question needs asking at
 * all is unchanged: the task's own `status` is not the answer, because cinna
 * recomputes status *from* its sessions, so a task can sit `in_progress` with
 * nothing live and can be live before the recompute lands.
 *
 * `answerAsk` **reads before it writes**. cinna's answer path is
 * `POST /sessions/{id}/messages/stream` with `answers_to_message_id`, and
 * `create_message` flips the referenced message to `answered` without reporting
 * what it was before — so the only way to return `{delivered: false}` for an ask
 * somebody already answered is to look first. The read also supplies the session
 * id, which the ask id alone does not carry. It is a race: an answer that lands
 * between the read and the post is reported as delivered by both surfaces. That
 * is the cheaper wrong answer — the alternative is claiming delivery for an ask
 * that was gone, over a question the user thinks they just decided.
 */

import { REMOTE_WRITABLE_STATUSES, parseTaskStatus, type TaskStatus } from '../../../shared/taskStatus'
import { parseTaskPriority, type TaskArtifact, type TaskDto } from '../../../shared/tasks'
import type { InputQuestion, InputRequest } from '../../../shared/runEvents'
import type { RequestResolution } from '../../../shared/localAgentRequests'
import { CinnaApiError } from '../../errors'
import { createLogger } from '../../logger/logger'
import {
  RemoteTaskError,
  UnsupportedRemoteOperation,
  type RemoteAnswerOutcome,
  type RemoteAsk,
  type RemoteAssignee,
  type RemoteAvailability,
  type RemoteBinding,
  type RemoteComment,
  type RemoteCommentDraft,
  type RemoteTaskAdapter,
  type RemoteTaskCapabilities,
  type RemoteTaskFields,
  type RemoteTaskSnapshot
} from './adapter'

const logger = createLogger('cinna-adapter')

/**
 * The id, and the one place the string exists.
 *
 * Read by `index.ts` to register it and by nothing else. A comparison against
 * it anywhere outside this folder is what the ratchet counts.
 */
export const CINNA_ADAPTER_ID = 'cinna'

/**
 * The sentence `PermissionDeniedError()` raises with no argument, and the only
 * 400 body this adapter will treat as "not this account's".
 *
 * Matched **exactly**. `PermissionDeniedError("Not enough permissions for this
 * agent")` is a different refusal on the same status code — the assignee is an
 * agent the caller cannot use — and a prefix match would unbind the task over
 * a mis-chosen assignee.
 */
const OWNERSHIP_REFUSAL = 'Not enough permissions'

/** How many rows a list page asks for. cinna's own default is 100. */
const PAGE_SIZE = 100

/**
 * How many messages of a session to read at a time, and why the adapter pages
 * at all.
 *
 * `GET /sessions/{id}/messages` defaults to `limit=100, offset=0` and orders
 * **ascending by `sequence_number`** — oldest first. An unanswered ask is
 * always the *newest* message, so an agent that works a task past a hundred
 * messages and then asks a question produces an ask this adapter cannot see:
 * the badge lights (it is computed server-side from activities) and the inbox
 * row is empty, or worse, `answerAsk` finds no target, reports
 * `{ delivered: false }` — which a surface renders as "already answered" — and
 * the agent stays parked for ever.
 *
 * `MessagesPublic.count` is `len(messages)`, the length of the *page* rather
 * than a total, so there is no jumping to the end. Page forward until a short
 * one.
 */
const MESSAGE_PAGE_SIZE = 100

/**
 * A ceiling on message paging. A session long enough to hit it has a bigger
 * problem than a missed ask, and an unbounded loop over somebody else's data is
 * not a thing to ship.
 */
const MAX_MESSAGE_PAGES = 50

/**
 * A ceiling on pagination, so a profile with an unreasonable number of tasks
 * costs a bounded number of requests rather than an unbounded one. Passing it
 * is logged: the caller cannot tell a truncated list from a complete one, which
 * is the other half of why `taskSyncService` confirms a delete rather than
 * inferring it from an absence.
 */
const MAX_PAGES = 50

/** Everything this adapter needs from the world, injected so it can be faked. */
export interface CinnaWorld {
  /**
   * An authenticated JSON request against the profile's cinna server. Rejects
   * with {@link CinnaApiError}; its `status` is what the classifier reads.
   */
  request<T>(
    userId: string,
    path: string,
    opts?: { method?: string; body?: unknown }
  ): Promise<T>
  /** The profile's server base URL, with no trailing slash. Throws when there is none. */
  serverUrl(userId: string): string
  /** Is this profile linked to a cinna server at all? Must never throw. */
  linked(userId: string): RemoteAvailability
  /**
   * Upload a local file and return cinna's id for it.
   *
   * **Rejects with a {@link RemoteTaskError}**, unlike the other three, which
   * reject with a {@link CinnaApiError} this file classifies. Uploading does
   * not go through `cinnaApiFetch` at all — it is multipart, through
   * `cinnaFileService`, whose failures are a different error type with
   * different codes — so the translation happens where that dependency already
   * lives (`cinnaTaskAdapter.wiring.ts`) rather than being imported in here.
   * Left untranslated, an unreadable path and a rejected file type both arrive
   * as "the service did not answer" and are retried for ever.
   */
  uploadFile(userId: string, path: string): Promise<string>
}

/**
 * Everything cinna can do, which is everything the seam describes but one:
 * a task attachment is a **file** (`file_name` / `content_type`, uploaded
 * bytes) and a link has no representation there at all.
 */
const CINNA_CAPABILITIES: RemoteTaskCapabilities = {
  create: true,
  writeStatus: true,
  archive: true,
  writeFields: ['title', 'description', 'priority', 'assignee'],
  comments: true,
  handoffNote: true,
  writeArtifactKinds: ['file'],
  subtasks: true,
  execute: true,
  asks: true,
  actionRequiredCount: true
}

/** A cinna task row, as much of it as this adapter reads. */
interface CinnaTaskRow {
  id?: unknown
  short_code?: unknown
  title?: unknown
  original_message?: unknown
  current_description?: unknown
  status?: unknown
  priority?: unknown
  error_message?: unknown
  selected_agent_id?: unknown
  agent_name?: unknown
  parent_task_id?: unknown
  subtask_count?: unknown
  subtask_completed_count?: unknown
  updated_at?: unknown
  external_ref?: unknown
}

interface CinnaPage<T> {
  data?: T[]
  count?: unknown
}

interface CinnaSessionRow {
  id?: unknown
  status?: unknown
  interaction_status?: unknown
  result_state?: unknown
}

interface CinnaMessageRow {
  id?: unknown
  tool_questions_status?: unknown
  timestamp?: unknown
  message_metadata?: unknown
}

export function createCinnaTaskAdapter(world: CinnaWorld): RemoteTaskAdapter {
  const id = CINNA_ADAPTER_ID

  /**
   * Every far-side call goes through here, so there is exactly one place that
   * decides what a failure means. See the module comment's rule 1 — this
   * function is where getting it wrong would have cost the binding.
   */
  async function call<T>(
    userId: string,
    path: string,
    opts?: { method?: string; body?: unknown }
  ): Promise<T> {
    try {
      return await world.request<T>(userId, path, opts)
    } catch (err) {
      throw asRemoteError(err, path)
    }
  }

  function require(
    capability: keyof RemoteTaskCapabilities,
    operation: string
  ): void {
    const value = CINNA_CAPABILITIES[capability]
    const allowed = Array.isArray(value) ? value.length > 0 : Boolean(value)
    if (!allowed) throw new UnsupportedRemoteOperation(id, operation)
  }

  /** The binding for a row, with the deep link baked in so `deepLink` needs no user. */
  function bindingOf(userId: string, row: CinnaTaskRow, previous?: RemoteBinding): RemoteBinding {
    const remoteId = str(row.id) ?? previous?.id ?? ''
    const key = str(row.short_code) ?? previous?.key ?? null
    return {
      adapter: id,
      id: remoteId,
      key,
      url: taskUrl(userId, key, remoteId),
      // Opaque outside this file. The answering sessions live here, so a later
      // `answerAsk` has somewhere to start from — and nothing else may read it,
      // which is why `TaskDto.remote` carries the other four fields and not this.
      state: { ...(previous?.state ?? {}) }
    }
  }

  /**
   * `<server>/tasks/<short_code>`, which is what a person types. Falls back to
   * the uuid route when the server has not minted a code yet; null when the
   * profile has no server at all, because a link the app cannot open is a
   * control that does nothing (`app:open-external` refuses every other scheme).
   */
  function taskUrl(userId: string, key: string | null, remoteId: string): string | null {
    let base: string
    try {
      base = world.serverUrl(userId)
    } catch {
      return null
    }
    if (!/^https?:\/\//i.test(base)) return null
    if (key) return `${base}/tasks/${encodeURIComponent(key)}`
    return remoteId ? `${base}/tasks/${encodeURIComponent(remoteId)}` : null
  }

  function snapshotOf(
    userId: string,
    row: CinnaTaskRow,
    opts: { previous?: RemoteBinding } = {}
  ): RemoteTaskSnapshot {
    const assigneeRef = str(row.selected_agent_id)
    const assignee: RemoteAssignee | null = assigneeRef
      ? {
          ref: assigneeRef,
          name: str(row.agent_name),
          // Always `remote_agent`: an agent that exists on cinna and nowhere
          // here. A desktop `agents` row is a different thing with a different
          // id space, and claiming otherwise would make the task page offer to
          // open an agent that does not exist.
          kind: 'remote_agent'
        }
      : null
    return {
      binding: bindingOf(userId, row, opts.previous),
      title: str(row.title) ?? str(row.original_message)?.slice(0, 120) ?? 'Untitled task',
      description: str(row.current_description),
      // cinna's `original_message`, and the reason the snapshot carries a goal
      // at all: `taskRepo.create` requires one and `TaskPatch` refuses to
      // update it, so a replica that invented one could never be corrected.
      goal: str(row.original_message),
      status: parseTaskStatus(str(row.status)),
      priority: parseTaskPriority(str(row.priority)),
      errorMessage: str(row.error_message),
      assignee,
      parentId: str(row.parent_task_id),
      subtaskCount: num(row.subtask_count) ?? 0,
      subtaskCompletedCount: num(row.subtask_completed_count) ?? 0,
      updatedAt: date(row.updated_at) ?? new Date()
    }
  }

  async function sessionsOf(userId: string, binding: RemoteBinding): Promise<CinnaSessionRow[]> {
    const page = await call<CinnaPage<CinnaSessionRow>>(
      userId,
      `/api/v1/tasks/${encodeURIComponent(binding.id)}/sessions`
    )
    return Array.isArray(page?.data) ? page.data : []
  }

  /** Every unanswered tool-question message on this task, with its session. */
  async function openQuestions(
    userId: string,
    binding: RemoteBinding
  ): Promise<{ sessionId: string; message: CinnaMessageRow }[]> {
    const sessions = await sessionsOf(userId, binding)
    const found: { sessionId: string; message: CinnaMessageRow }[] = []
    for (const session of sessions) {
      const sessionId = str(session.id)
      if (!sessionId) continue
      // Paged to the end, oldest first — see {@link MESSAGE_PAGE_SIZE}. Reading
      // only the default first page finds no ask on any session with a hundred
      // messages behind it, which is every session that has been working a
      // while.
      for (let page = 0; page < MAX_MESSAGE_PAGES; page++) {
        const body = await call<CinnaPage<CinnaMessageRow>>(
          userId,
          `/api/v1/sessions/${encodeURIComponent(sessionId)}/messages` +
            `?limit=${MESSAGE_PAGE_SIZE}&offset=${page * MESSAGE_PAGE_SIZE}`
        )
        const batch = Array.isArray(body?.data) ? body.data : []
        for (const message of batch) {
          if (str(message.tool_questions_status) !== 'unanswered') continue
          found.push({ sessionId, message })
        }
        if (batch.length < MESSAGE_PAGE_SIZE) break
        if (page === MAX_MESSAGE_PAGES - 1) {
          logger.warn('stopped reading a session’s messages at the page ceiling', { sessionId })
        }
      }
    }
    return found
  }

  /**
   * The **active set**, paged by offset.
   *
   * Safe here and only here: with no cursor the server sorts by `created_at`,
   * which never changes, so a row cannot move between pages.
   */
  async function listActive(userId: string): Promise<CinnaTaskRow[]> {
    const rows: CinnaTaskRow[] = []
    let total = Infinity
    for (let page = 0; page < MAX_PAGES && rows.length < total; page++) {
      const body = await call<CinnaPage<CinnaTaskRow>>(
        userId,
        `/api/v1/tasks/?status=active&skip=${page * PAGE_SIZE}&limit=${PAGE_SIZE}`
      )
      const batch = Array.isArray(body?.data) ? body.data : []
      rows.push(...batch)
      total = num(body?.count) ?? rows.length
      // A page shorter than it asked for is the end, whatever `count` claims.
      if (batch.length < PAGE_SIZE) break
    }
    if (rows.length < total) {
      logger.warn('task list truncated', { fetched: rows.length, reported: total })
    }
    return rows
  }

  /**
   * Everything changed since `since`, paged by **advancing the cursor**.
   *
   * `skip` is wrong here and the server says so in its own docstring: with
   * `updated_since` the sort key is `updated_at`, which is **mutable**, so a
   * row touched while the next page is in flight moves to the tail, every row
   * below it shifts up one, and the row that was last on the previous page is
   * never returned by any page. The pass then advances past it and its change
   * is invisible until something touches it again — or for ever, if what it
   * missed was the completion.
   *
   * **Advancing to the last row's timestamp is not enough either.** The only
   * cursor this API accepts is a bare `updated_since`, filtered strictly, and
   * there is no `after_id` — so a composite keyset is not expressible, and
   * moving the cursor to the final row's `updated_at` silently excludes every
   * *other* row sharing that timestamp, including the ones that did not fit on
   * the page. Ties are routine, not exotic: a status change commits the task
   * and posts a `status_change` comment, and both touch `updated_at`.
   *
   * So the cursor advances to the last **complete** tie group: the trailing
   * rows that share the final timestamp are dropped from the page and re-read
   * by the next request, which is cheap and idempotent. What is left is a
   * prefix whose own final timestamp is complete by construction — every row
   * carrying it sorts before the group that was dropped, so all of them were on
   * this page.
   */
  async function listChanged(userId: string, since: Date): Promise<CinnaTaskRow[]> {
    const rows: CinnaTaskRow[] = []
    let cursor = since
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await call<CinnaPage<CinnaTaskRow>>(
        userId,
        `/api/v1/tasks/?updated_since=${encodeURIComponent(cursor.toISOString())}` +
          `&limit=${PAGE_SIZE}`
      )
      const batch = Array.isArray(body?.data) ? body.data : []
      if (batch.length === 0) break
      if (batch.length < PAGE_SIZE) {
        // The end: there is nothing after this page, so no tie group can be
        // cut in half and the whole page is safe to take.
        rows.push(...batch)
        break
      }

      const last = date(batch[batch.length - 1]?.updated_at)
      const kept = last === null ? batch : batch.filter((row) => lessThan(row.updated_at, last))
      if (kept.length === 0 || last === null) {
        // A full page that is one single tie group, or rows with no readable
        // timestamp. Advancing is impossible without dropping something, and
        // not advancing is an infinite loop — so take the page and move past
        // it, loudly. A hundred tasks written in one instant is a bulk import,
        // not a desktop's ordinary day.
        logger.warn('a whole page of tasks shares one timestamp; some changes may be skipped', {
          at: last?.toISOString()
        })
        rows.push(...batch)
        if (last === null) break
        cursor = last
        continue
      }
      rows.push(...kept)
      // The last kept row's timestamp is a *complete* group — every row
      // carrying it sorts before the dropped ones, so all of them were here.
      const next = date(kept[kept.length - 1]?.updated_at)
      if (next === null) break
      cursor = next
    }
    return rows
  }

  return {
    id,

    // A fresh object every call, and fresh arrays inside it: a caller that
    // edits what it was handed must not change what the next one sees.
    capabilities: () => ({
      ...CINNA_CAPABILITIES,
      writeFields: [...CINNA_CAPABILITIES.writeFields],
      writeArtifactKinds: [...CINNA_CAPABILITIES.writeArtifactKinds]
    }),

    async availability(userId) {
      // Never probes the network. "Is this profile linked" is answerable from
      // the local user row, and an unlinked profile is an answer rather than a
      // failure — which is what lets a task bound to cinna still open on a
      // profile that has since been unlinked.
      return world.linked(userId)
    },

    async create(userId, task: TaskDto, parent) {
      require('create', 'create')
      if (parent && parent.adapter !== id) {
        throw new RemoteTaskError(
          'invalid_request',
          'That task belongs under one on a different service.',
          `parent binding names \`${parent.adapter}\``
        )
      }
      if (task.parentTaskId && !parent) {
        // Never reaches cinna: a subtask sent to `POST /tasks/` would be
        // created at top level and look like a success.
        throw new RemoteTaskError(
          'invalid_request',
          'That task belongs under another one, which is not on the service yet.',
          'create() got a task with a parentTaskId and no parent binding'
        )
      }
      const body: Record<string, unknown> = {
        original_message: task.goal,
        title: task.title,
        priority: task.priority,
        // The desktop's own id, so a create retried after a lost response
        // returns the first task rather than making a second one — and so a
        // reinstall can re-bind by ref instead of by matching titles.
        //
        // Ignored by the subtask route, which the server documents and which
        // this adapter cannot work around: a retried *subtask* create makes a
        // second subtask. Recorded rather than papered over.
        external_ref: task.id
      }
      if (task.assignee.kind === 'remote_agent' && task.assignee.agentId) {
        body.selected_agent_id = task.assignee.agentId
      }
      const path = parent
        ? `/api/v1/tasks/${encodeURIComponent(parent.id)}/subtasks/`
        : '/api/v1/tasks/'
      const row = await call<CinnaTaskRow>(userId, path, { method: 'POST', body })
      return bindingOf(userId, row)
    },

    async putHandoffNote(userId, binding, note) {
      require('handoffNote', 'putHandoffNote')
      // A `result` comment: cinna has no handoff-note field, and `result` is
      // the type its own agents read for "what the last one left behind". The
      // note is re-posted rather than edited, because the comment stream is
      // append-only and a note's history is worth keeping.
      await call(userId, `/api/v1/tasks/${encodeURIComponent(binding.id)}/comments/`, {
        method: 'POST',
        body: { content: note, comment_type: 'result' }
      })
    },

    async pushFields(userId, binding, fields: Partial<RemoteTaskFields>) {
      const body: Record<string, unknown> = {}
      // **Dirty-field, never whole-record.** A PATCH carrying a field nobody
      // touched overwrites whatever the web edited since the last pull, and the
      // symptom is a user's own change disappearing minutes later.
      for (const field of Object.keys(fields) as (keyof RemoteTaskFields)[]) {
        if (!CINNA_CAPABILITIES.writeFields.includes(field)) {
          throw new UnsupportedRemoteOperation(id, `write ${field}`)
        }
        if (field === 'title') body.title = fields.title
        if (field === 'description') body.current_description = fields.description
        if (field === 'priority') body.priority = fields.priority
        if (field === 'assignee') {
          const assignee = fields.assignee
          if (assignee && assignee.kind !== 'remote_agent') {
            // cinna's `selected_agent_id` is a cinna agent uuid. A desktop
            // agent's id means nothing there, and sending it would either 400
            // or — worse — match somebody else's agent.
            throw new RemoteTaskError(
              'invalid_request',
              'That assignee only exists on this device.',
              `assignee kind \`${assignee.kind}\` has no representation on the service`
            )
          }
          body.selected_agent_id = assignee?.ref ?? null
        }
      }
      if (Object.keys(body).length === 0) return binding
      const row = await call<CinnaTaskRow>(
        userId,
        `/api/v1/tasks/${encodeURIComponent(binding.id)}`,
        { method: 'PATCH', body }
      )
      return bindingOf(userId, row, binding)
    },

    async pushStatus(userId, binding, status: TaskStatus, reason) {
      require('writeStatus', 'pushStatus')
      if (!REMOTE_WRITABLE_STATUSES.includes(status)) {
        // Refused before the transport. `archived` is the one that matters:
        // it has its own route and its own timestamp, and smuggling it through
        // here would file a task away by a path that records nothing.
        throw new RemoteTaskError(
          'rejected',
          'That status cannot be set on the service.',
          `\`${status}\` is outside the set a user token may write${
            status === 'archived' ? '; archiving is its own operation' : ''
          }`
        )
      }
      const row = await call<CinnaTaskRow>(
        userId,
        `/api/v1/tasks/${encodeURIComponent(binding.id)}/status`,
        { method: 'POST', body: { status, reason: reason ?? null } }
      )
      return bindingOf(userId, row, binding)
    },

    async archive(userId, binding) {
      require('archive', 'archive')
      const row = await call<CinnaTaskRow>(
        userId,
        `/api/v1/tasks/${encodeURIComponent(binding.id)}/archive`,
        { method: 'POST' }
      )
      return bindingOf(userId, row, binding)
    },

    async fetch(userId, binding) {
      const row = await call<CinnaTaskRow>(
        userId,
        `/api/v1/tasks/${encodeURIComponent(binding.id)}/detail`
      )
      return snapshotOf(userId, row, { previous: binding })
    },

    async liveSession(userId, binding) {
      // `interaction_status === 'running'` on any of the task's sessions. The
      // task's own status is not the answer: cinna recomputes it *from* these
      // sessions, so it lags in one direction and leads in the other.
      const sessions = await sessionsOf(userId, binding)
      return sessions.some((s) => str(s.interaction_status) === 'running')
    },

    async list(userId, since) {
      // With a cursor: everything that changed, whatever its status — the
      // cursor is the filter. Without one: the *active* set, which is what the
      // seam's docstring promises and is narrower than "everything".
      const rows = since ? await listChanged(userId, since) : await listActive(userId)
      return rows.map((row) => snapshotOf(userId, row))
    },

    async listSubtasks(userId, binding) {
      require('subtasks', 'listSubtasks')
      const page = await call<CinnaPage<CinnaTaskRow>>(
        userId,
        `/api/v1/tasks/${encodeURIComponent(binding.id)}/subtasks/`
      )
      return (page?.data ?? []).map((row) => snapshotOf(userId, row))
    },

    async execute(userId, binding) {
      require('execute', 'execute')
      const result = await call<{ success?: unknown; error?: unknown }>(
        userId,
        `/api/v1/tasks/${encodeURIComponent(binding.id)}/execute`,
        { method: 'POST', body: { mode: 'conversation' } }
      )
      if (result?.success !== true) {
        // A 200 that is a failure. Reporting a handover as successful here
        // would leave the task sitting on a service that never picked it up.
        throw new RemoteTaskError(
          'rejected',
          'The service would not start work on that task.',
          str(result?.error) ?? 'execute returned success: false'
        )
      }
      // **The session this started is not cached, and step 11 is where that was
      // decided.** `remote_state.sessionIds` used to be written from here and
      // from `fetch`, with two different meanings — "the one I just started"
      // and "every session the server listed" — against the day something read
      // it. Nothing ever did: `listOpenAsks` asks the server every time,
      // because a session that appeared since the last read is exactly the one
      // with a question on it, and {@link RemoteTaskAdapter.liveSession} asks
      // for the same reason. Now that `fetch` no longer lists sessions, the
      // only remaining writer would be this one, and the key would quietly
      // change meaning under any reader that arrived later. `remote_state`
      // travels to the user's other devices (§5.5), so it would change meaning
      // there too. A cache nobody reads is deleted rather than kept warm.
      return binding
    },

    async addComment(userId, binding, comment: RemoteCommentDraft) {
      require('comments', 'addComment')
      await call(userId, `/api/v1/tasks/${encodeURIComponent(binding.id)}/comments/`, {
        method: 'POST',
        body: { content: comment.body, comment_type: commentTypeFor(comment.type) }
      })
    },

    async listComments(userId, binding) {
      require('comments', 'listComments')
      const page = await call<CinnaPage<Record<string, unknown>>>(
        userId,
        `/api/v1/tasks/${encodeURIComponent(binding.id)}/comments/`
      )
      return (page?.data ?? []).map(
        (row): RemoteComment => ({
          id: str(row.id) ?? '',
          // An open string on the way in, deliberately: cinna's `comment_type`
          // is a free field its own agents extend, and refusing a word it
          // chose would be the desktop arguing with the system doing the work.
          type: str(row.comment_type) ?? 'message',
          body: str(row.content) ?? '',
          author: str(row.author_name),
          createdAt: date(row.created_at) ?? new Date()
        })
      )
    },

    async putArtifact(userId, binding, artifact: TaskArtifact) {
      if (!CINNA_CAPABILITIES.writeArtifactKinds.includes(artifact.kind)) {
        // cinna stores uploaded bytes and nothing else. Posting a link as a
        // comment instead would be a different capability wearing this flag.
        throw new UnsupportedRemoteOperation(id, `store a ${artifact.kind} artifact`)
      }
      let fileId: string
      try {
        fileId = await world.uploadFile(userId, artifact.ref)
      } catch (err) {
        throw asRemoteError(err, '/api/v1/files/upload')
      }
      await call(
        userId,
        `/api/v1/tasks/${encodeURIComponent(binding.id)}/files/${encodeURIComponent(fileId)}`,
        { method: 'POST' }
      )
    },

    async listOpenAsks(userId, binding) {
      require('asks', 'listOpenAsks')
      const open = await openQuestions(userId, binding)
      const asks: RemoteAsk[] = []
      for (const { message } of open) {
        const askId = str(message.id)
        if (!askId) continue
        const questions = questionsIn(message.message_metadata)
        if (questions.length === 0) continue
        asks.push({
          id: askId,
          // The run vocabulary, not a second union — so the inbox renders a
          // cinna tool question with the component a parked ACP ask uses.
          request: { kind: 'question', questions } satisfies InputRequest,
          createdAt: date(message.timestamp) ?? new Date()
        })
      }
      return asks
    },

    async answerAsk(userId, binding, askId, resolution: RequestResolution) {
      require('asks', 'answerAsk')
      if (resolution.kind === 'permission') {
        // cinna parks on questions and nothing else. A permission resolution
        // arriving here is a call site that mixed up two asks, not a service
        // that cannot take it.
        throw new RemoteTaskError(
          'invalid_request',
          'That answer does not fit this request.',
          'a cinna ask is always a question; a permission reply has nowhere to go'
        )
      }
      const open = await openQuestions(userId, binding)
      const target = open.find((entry) => str(entry.message.id) === askId)
      // Nothing waiting on that id: answered already, or the session moved on.
      // An answer, not a failure — the same one a driver gives for a local park.
      if (!target) return { delivered: false } satisfies RemoteAnswerOutcome

      const questions = questionsIn(target.message.message_metadata)
      const content =
        resolution.kind === 'question'
          ? formatAnswers(questions, resolution.answers)
          : // A declined question has no representation on cinna at all — there
            // is no "reject" for `tool_questions_status`. Saying so in the
            // answer is what releases the agent, which is the same reasoning
            // the local runner uses when it posts a real `reject` on expiry
            // rather than abandoning the request.
            'The user declined to answer these questions.'
      await call(
        userId,
        `/api/v1/sessions/${encodeURIComponent(target.sessionId)}/messages/stream`,
        { method: 'POST', body: { content, answers_to_message_id: askId } }
      )
      return { delivered: true }
    },

    /**
     * cinna's own "needs a human" number — and **not** the number of open asks.
     *
     * `GET /activities/stats` counts unread, unarchived activities whose
     * `action_required` is set, and three things follow that a caller has to
     * know before it renders the figure:
     *
     *  - it is gated on `is_read`, which only cinna's **web** UI clears, so a
     *    user who lives in the desktop accrues a number nothing here can reset;
     *  - one ask raises **two** rows — `answers_required` from the session and
     *    `task_action_required` from `_TASK_LIFECYCLE_MAP` — so it can say two
     *    where the inbox shows one;
     *  - it is profile-wide, so it will not agree with the sum of
     *    {@link RemoteTaskAdapter.listOpenAsks} in either direction.
     *
     * It is still the right probe for "is anything waiting over there", which
     * is what §5.7 asks of it: it is one cheap call, and it does not have the
     * `updated_since` cursor's blind spot for comment-only changes. What it is
     * not is a count the inbox can print beside its own rows.
     */
    async actionRequiredCount(userId) {
      require('actionRequiredCount', 'actionRequiredCount')
      const stats = await call<{ action_required_count?: unknown }>(
        userId,
        '/api/v1/activities/stats'
      )
      const count = num(stats?.action_required_count) ?? 0
      return count > 0 ? Math.floor(count) : 0
    },

    deepLink: (binding) => (binding.url && /^https?:\/\//i.test(binding.url) ? binding.url : null)
  }
}

/** The three words the seam allows, in cinna's own vocabulary. */
function commentTypeFor(type: RemoteCommentDraft['type']): string {
  switch (type) {
    case 'result':
      return 'result'
    case 'system':
      return 'system'
    case 'note':
      return 'message'
  }
}

/**
 * A failure from the transport, as something the caller can act on.
 *
 * The whole taxonomy turns on one distinction and cinna-core makes it hard:
 * `not_ours` unbinds and is never retried, `rejected` keeps the binding, and
 * both arrive as 400. See the module comment.
 */
function asRemoteError(err: unknown, path: string): RemoteTaskError {
  if (err instanceof RemoteTaskError) return err
  if (err instanceof CinnaApiError) {
    const detail = err.detail?.trim() ?? ''
    if (err.code === 'not_cinna_user' || err.code === 'missing_server_url') {
      return new RemoteTaskError('unavailable', 'This profile is not connected to Cinna.', err.message)
    }
    if (err.code === 'reauth_required') {
      return new RemoteTaskError(
        'unavailable',
        'Sign in to Cinna again to keep this task in step.',
        err.message
      )
    }
    if (err.status === 404) {
      return new RemoteTaskError('not_ours', 'That task is no longer on this account.', err.message)
    }
    if (err.status === 400 && detail === OWNERSHIP_REFUSAL) {
      return new RemoteTaskError('not_ours', 'That task is no longer on this account.', err.message)
    }
    if (err.status !== undefined && err.status >= 400 && err.status < 500) {
      // Understood and refused: an illegal transition, a field it will not
      // take, a body it could not validate. The task is still there.
      return new RemoteTaskError('rejected', 'Cinna would not accept that change.', err.message)
    }
    // A 5xx, or a failure that never became a response at all.
    return new RemoteTaskError('unavailable', 'Cinna did not answer.', err.message)
  }
  const message = err instanceof Error ? err.message : String(err)
  return new RemoteTaskError('unavailable', 'Cinna did not answer.', `${path}: ${message}`)
}

/**
 * The questions inside a message's metadata.
 *
 * cinna does not store them as a field. They are in `message_metadata.
 * streaming_events`, on the `tool` event whose name normalises to
 * `askuserquestion` — the same place the web's own `extractQuestions` reads
 * them from, deduplicated by question text the same way, because two calls in
 * one response really do repeat.
 */
function questionsIn(metadata: unknown): InputQuestion[] {
  const events = (metadata as { streaming_events?: unknown } | null)?.streaming_events
  if (!Array.isArray(events)) return []
  const questions: InputQuestion[] = []
  const seen = new Set<string>()
  for (const raw of events) {
    const event = raw as { type?: unknown; tool_name?: unknown; metadata?: unknown }
    if (str(event.type) !== 'tool') continue
    if (str(event.tool_name)?.toLowerCase() !== 'askuserquestion') continue
    const input = (event.metadata as { tool_input?: unknown } | null)?.tool_input
    const list = (input as { questions?: unknown } | null)?.questions
    if (!Array.isArray(list)) continue
    for (const entry of list) {
      const row = entry as Record<string, unknown>
      const question = str(row.question)
      if (!question || seen.has(question)) continue
      seen.add(question)
      questions.push({
        question,
        header: str(row.header) ?? undefined,
        // Both keys are on the wire: the OpenCode transformer emits `multiple`
        // and mirrors it as `multiSelect` for the web modal, so an older event
        // may carry only the first.
        multiSelect: Boolean(row.multiSelect ?? row.multiple),
        options: optionsIn(row.options)
      })
    }
  }
  return questions
}

/**
 * The answers as cinna's own web modal writes them.
 *
 * Matched to `AnswerQuestionsModal`'s format rather than invented, because the
 * agent on the other side has been reading that shape since before the desktop
 * existed: question, then `Answer:` for one choice or `Answers:` and a dash
 * list for several, with a blank line between questions.
 */
function formatAnswers(questions: InputQuestion[], answers: string[][]): string {
  const blocks: string[] = []
  questions.forEach((question, index) => {
    const chosen = (answers[index] ?? []).filter((a) => a.trim().length > 0)
    if (chosen.length === 0) return
    blocks.push(
      chosen.length === 1
        ? `${question.question}\nAnswer: ${chosen[0]}`
        : `${question.question}\nAnswers:\n${chosen.map((a) => `- ${a}`).join('\n')}`
    )
  })
  // An answer with nothing in it still has to say something: an empty body is
  // a 422 from `MessageCreate`, and the ask would stay open for ever.
  return blocks.length > 0 ? blocks.join('\n\n') : 'The user answered with nothing.'
}

/** An option list off the wire. An entry with no label is dropped, not rendered blank. */
function optionsIn(value: unknown): InputQuestion['options'] {
  if (!Array.isArray(value)) return []
  const options: InputQuestion['options'] = []
  for (const entry of value) {
    const row = entry as Record<string, unknown>
    const label = str(row.label)
    if (!label) continue
    const description = str(row.description)
    options.push(description ? { label, description } : { label })
  }
  return options
}

/** Is this wire timestamp strictly earlier than `limit`? Unreadable sorts first. */
function lessThan(value: unknown, limit: Date): boolean {
  const parsed = date(value)
  return parsed === null || parsed.getTime() < limit.getTime()
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/**
 * A timestamp off the wire.
 *
 * cinna serialises naive UTC datetimes, so a string with no zone is UTC and
 * must be read as such — `new Date('2026-09-11T10:00:00')` is *local* time in
 * JavaScript, which on a machine east of Greenwich makes every pulled task look
 * hours older than it is and, through `updated_since`, hides the change that
 * produced it.
 */
function date(value: unknown): Date | null {
  const raw = str(value)
  if (!raw) return null
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/.test(raw) ? raw : `${raw}Z`
  const parsed = new Date(zoned)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}
