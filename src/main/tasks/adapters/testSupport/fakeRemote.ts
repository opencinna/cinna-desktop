/**
 * A remote task system in memory, and a correct adapter over it.
 *
 * Two jobs, and the second is the one that matters.
 *
 * It is the subject the contract suite runs against before any real adapter
 * exists — `adapterContract.test.ts` has to be able to fail before there is
 * anything to fail it.
 *
 * And it is **four remotes, not one**. `cinna` is the only implementation this
 * phase ships, and an interface shaped by a single implementation acquires that
 * implementation's field names and then breaks on the second one. So the fake
 * is parametrised by its capability set, and the suite runs it as each of the
 * four worked examples in §5.6 — a full service, Linear (status yes, asks no,
 * execute no, subtasks no), GitHub Issues (no agent assignee, no subtasks) and
 * Claude Managed Agents (asks yes, comments no). If one of them cannot be
 * expressed without a new field, the shape is wrong and this file is where that
 * shows up.
 *
 * The fake **enforces the seam's rules itself** rather than being permissive:
 * it refuses an operation its capabilities deny, refuses a status the remote
 * would not take, and never invents a second binding. A lenient fake would pass
 * a contract suite that a real adapter fails.
 */

import { nanoid } from 'nanoid'
import { REMOTE_WRITABLE_STATUSES, type TaskStatus } from '../../../../shared/taskStatus'
import type { RequestResolution } from '../../../../shared/localAgentRequests'
import type { TaskArtifact, TaskDto, TaskPriority } from '../../../../shared/tasks'
import {
  RemoteTaskError,
  UnsupportedRemoteOperation,
  type RemoteAnswerOutcome,
  type RemoteAsk,
  type RemoteAssignee,
  type RemoteBinding,
  type RemoteComment,
  type RemoteCommentDraft,
  type RemoteTaskAdapter,
  type RemoteTaskCapabilities,
  type RemoteTaskFields,
  type RemoteTaskSnapshot
} from '../adapter'

/** How the far side is behaving. `null` is a healthy service. */
export type FarSideMode = null | 'transport' | 'not_ours' | 'rejected'

export interface FakeRemoteOptions {
  id?: string
  capabilities?: Partial<RemoteTaskCapabilities>
  /** A profile that is not linked to this service. */
  ready?: boolean
}

interface StoredTask {
  id: string
  key: string
  title: string
  description: string | null
  goal: string
  errorMessage: string | null
  status: TaskStatus
  priority: TaskPriority
  assignee: RemoteAssignee | null
  parentId: string | null
  updatedAt: Date
  executed: boolean
  handoffNote: string | null
  comments: RemoteComment[]
  artifacts: TaskArtifact[]
  asks: RemoteAsk[]
}

export interface FakeRemote {
  adapter: RemoteTaskAdapter
  /**
   * Put a task on the far side without going through `create`, and hand back
   * its binding — how a **pull-only** remote comes to have one at all. Counts
   * as no request: nobody asked this process to do it.
   */
  seed(task: TaskDto): RemoteBinding
  /** Far-side calls made so far. A refusal that never left the process adds none. */
  requests(): number
  /** Make every far-side call fail this way from now on. */
  behave(mode: FarSideMode): void
  /** Put an open ask on a task the far side already knows about. */
  plantAsk(remoteId: string, ask: Omit<RemoteAsk, 'createdAt'>): void
  /** The far side's copy, for a test that wants to see what a push actually did. */
  stored(remoteId: string): StoredTask | undefined
  /** Pretend somebody else edited the task on the far side. */
  touch(remoteId: string, patch: Partial<StoredTask>): void
}

const FULL: RemoteTaskCapabilities = {
  create: true,
  writeStatus: true,
  handoffNote: true,
  archive: true,
  writeFields: ['title', 'description', 'priority', 'assignee'],
  comments: true,
  writeArtifactKinds: ['file', 'link'],
  subtasks: true,
  execute: true,
  asks: true,
  actionRequiredCount: true
}

/** The four worked examples from §5.6, as capability sets. */
export const CAPABILITY_SHAPES: Record<string, Partial<RemoteTaskCapabilities>> = {
  full: {},
  // Status yes, and nothing that needs an agent behind the task.
  // And its attachments are URLs with a title, never uploaded bytes — the
  // mirror image of cinna, which is the pair that makes `writeArtifactKinds` a list
  // rather than a flag.
  linear: { execute: false, asks: false, subtasks: false, writeArtifactKinds: ['link'] },
  // No agent assignee to write, and issues do not nest. Closing an issue is a
  // status, not a filing cabinet.
  github: {
    archive: false,
    writeArtifactKinds: ['link'],
    writeFields: ['title', 'description'],
    subtasks: false,
    execute: false,
    asks: false,
    actionRequiredCount: false
  },
  // Sessions that park, and an append-only log rather than comments.
  // Comments are an append-only session log, not a thread — but the handoff
  // note still has somewhere to go, which is the point of it being its own
  // capability rather than a comment with a magic type.
  managed: { comments: false, subtasks: false, writeArtifactKinds: [] },
  /**
   * A remote the desktop may **read and never edit** — a shared board, a feed,
   * an account whose token is scoped to reads.
   *
   * Here because `writeFields: []` is expressible in the type and the suite
   * used to fail it: `pushFields` sat in the ungated list and always pushed a
   * title, so an adapter doing exactly what its capabilities said was in
   * violation. It is the shape that keeps the gating honest.
   */
  readOnly: {
    create: false,
    handoffNote: false,
    writeStatus: false,
    archive: false,
    writeFields: [],
    comments: false,
    writeArtifactKinds: [],
    subtasks: false,
    execute: false,
    asks: false
  }
}

export function createFakeRemote(options: FakeRemoteOptions = {}): FakeRemote {
  const id = options.id ?? 'fake'
  const capabilities: RemoteTaskCapabilities = { ...FULL, ...options.capabilities }
  const ready = options.ready ?? true

  const store = new Map<string, StoredTask>()
  let mode: FarSideMode = null
  let requests = 0
  let nextKey = 1

  /** Every far-side call goes through here, so a refusal above it costs nothing. */
  function call(): void {
    // An unlinked profile has no far side to reach. A real adapter either has
    // no credential to send or gets a 401; either way the call fails, and a
    // fake that quietly succeeded would let the contract suite pass an adapter
    // that invents a binding against a service it has never talked to.
    if (!ready) {
      throw new RemoteTaskError(
        'unavailable',
        'This profile is not connected to the fake service.'
      )
    }
    requests += 1
    if (mode === 'transport') {
      throw new RemoteTaskError('unavailable', 'The service did not answer.', 'fake: offline')
    }
    if (mode === 'not_ours') {
      throw new RemoteTaskError(
        'not_ours',
        'That task is not on this account any more.',
        'fake: the far side does not recognise this account'
      )
    }
    if (mode === 'rejected') {
      // A real adapter reaches this from a **400**, the same status code a
      // non-owner refusal carries on cinna-core. Telling the two apart is the
      // adapter's job and it cannot be done from the status line alone.
      throw new RemoteTaskError(
        'rejected',
        'The service would not accept that change.',
        'fake: 400, cannot transition from x to y'
      )
    }
  }

  function require(flag: keyof RemoteTaskCapabilities, operation: string): void {
    if (!capabilities[flag]) throw new UnsupportedRemoteOperation(id, operation)
  }

  function load(binding: RemoteBinding): StoredTask {
    const stored = store.get(binding.id)
    if (!stored) {
      throw new RemoteTaskError('not_ours', 'That task is not on this account any more.')
    }
    return stored
  }

  /**
   * The far side's row for a task. Shared by `create` and by `seed`, so a
   * pull-only remote's tasks are the same shape as a created one's — if they
   * drifted, the read-only subject would be testing a different service.
   */
  function storedFor(task: TaskDto, parent: RemoteBinding | null): StoredTask {
    return {
      id: `r-${nanoid(8)}`,
      key: `FAKE-${nextKey++}`,
      title: task.title,
      description: task.description,
      goal: task.goal,
      errorMessage: null,
      // The remote's own create state. Not the task's: a desktop task that is
      // already `completed` still arrives on the remote as new work, and the
      // status path pushes it forward from there (§5.12 rule 2).
      status: 'open',
      priority: task.priority,
      assignee: task.assignee.agentId
        ? { ref: task.assignee.agentId, name: task.assignee.name, kind: task.assignee.kind }
        : null,
      parentId: parent?.id ?? null,
      updatedAt: new Date(),
      executed: false,
      handoffNote: null,
      comments: [],
      artifacts: [],
      asks: []
    }
  }

  function bindingOf(stored: StoredTask): RemoteBinding {
    return {
      adapter: id,
      id: stored.id,
      key: stored.key,
      url: `https://fake.test/tasks/${stored.key}`,
      // Opaque outside the adapter. A real one keeps the session currently
      // answering here; this keeps the last thing it saw, for the same reason.
      state: { seenAt: stored.updatedAt.toISOString() }
    }
  }

  function snapshotOf(stored: StoredTask): RemoteTaskSnapshot {
    const children = [...store.values()].filter((t) => t.parentId === stored.id)
    return {
      binding: bindingOf(stored),
      title: stored.title,
      description: stored.description,
      goal: stored.goal,
      status: stored.status,
      priority: stored.priority,
      errorMessage: stored.errorMessage,
      assignee: stored.assignee,
      parentId: stored.parentId,
      subtaskCount: children.length,
      subtaskCompletedCount: children.filter((c) => c.status === 'completed').length,
      // `executed` stands in for a live session the way cinna's sessions do;
      // an adapter that cannot tell reports null here and the UI asks.
      liveSession: stored.executed && stored.status === 'in_progress',
      updatedAt: stored.updatedAt
    }
  }

  const adapter: RemoteTaskAdapter = {
    id,

    // A fresh object every call, so a caller that edits what it was handed
    // cannot change what the next caller sees. The contract suite checks this.
    capabilities: () => ({
      ...capabilities,
      writeFields: [...capabilities.writeFields],
      writeArtifactKinds: [...capabilities.writeArtifactKinds]
    }),

    availability: async () =>
      ready
        ? { ready: true }
        : { ready: false, reason: 'This profile is not connected to the fake service.' },

    async create(_userId, task: TaskDto, parent) {
      require('create', 'create')
      if (parent) require('subtasks', 'create a subtask')
      if (task.parentTaskId && !parent) {
        // Never reaches the far side: a subtask with no parent binding would
        // become a top-level task that looks created.
        throw new RemoteTaskError(
          'invalid_request',
          'That task belongs under another one, which is not on the service yet.',
          'fake: create() got a task with a parentTaskId and no parent binding'
        )
      }
      call()
      const stored = storedFor(task, parent)
      store.set(stored.id, stored)
      return bindingOf(stored)
    },

    async putHandoffNote(_userId, binding, note) {
      require('handoffNote', 'putHandoffNote')
      call()
      load(binding).handoffNote = note
    },

    async pushFields(_userId, binding, fields: Partial<RemoteTaskFields>) {
      for (const field of Object.keys(fields) as (keyof RemoteTaskFields)[]) {
        if (!capabilities.writeFields.includes(field)) {
          throw new UnsupportedRemoteOperation(id, `write ${field}`)
        }
      }
      call()
      const stored = load(binding)
      Object.assign(stored, fields, { updatedAt: new Date() })
      return bindingOf(stored)
    },

    async pushStatus(_userId, binding, status, _reason) {
      require('writeStatus', 'pushStatus')
      // Refused **before** the transport: a status the remote's route does not
      // accept must never leave the process, so the assertion that nothing was
      // sent is the one worth making.
      if (!REMOTE_WRITABLE_STATUSES.includes(status)) {
        throw new RemoteTaskError(
          'rejected',
          'That status cannot be set on the service.',
          `\`${status}\` is not one the remote accepts`
        )
      }
      call()
      const stored = load(binding)
      stored.status = status
      stored.updatedAt = new Date()
      return bindingOf(stored)
    },

    async archive(_userId, binding) {
      require('archive', 'archive')
      call()
      const stored = load(binding)
      stored.status = 'archived'
      stored.updatedAt = new Date()
      return bindingOf(stored)
    },

    async fetch(_userId, binding) {
      call()
      return snapshotOf(load(binding))
    },

    async list(_userId, since) {
      call()
      return [...store.values()]
        .filter((t) => !since || t.updatedAt > since)
        .map((t) => snapshotOf(t))
    },

    async listSubtasks(_userId, binding) {
      require('subtasks', 'listSubtasks')
      call()
      const parent = load(binding)
      return [...store.values()].filter((t) => t.parentId === parent.id).map((t) => snapshotOf(t))
    },

    async execute(_userId, binding) {
      require('execute', 'execute')
      call()
      const stored = load(binding)
      stored.executed = true
      stored.status = 'in_progress'
      stored.updatedAt = new Date()
      return bindingOf(stored)
    },

    async addComment(_userId, binding, comment: RemoteCommentDraft) {
      require('comments', 'addComment')
      call()
      load(binding).comments.push({
        id: `c-${nanoid(6)}`,
        type: comment.type,
        body: comment.body,
        author: 'the desktop',
        createdAt: new Date()
      })
    },

    async listComments(_userId, binding) {
      require('comments', 'listComments')
      call()
      return [...load(binding).comments]
    },

    async putArtifact(_userId, binding, artifact) {
      if (!capabilities.writeArtifactKinds.includes(artifact.kind)) {
        throw new UnsupportedRemoteOperation(id, `store a ${artifact.kind} artifact`)
      }
      call()
      load(binding).artifacts.push(artifact)
    },

    async listOpenAsks(_userId, binding) {
      require('asks', 'listOpenAsks')
      call()
      return [...load(binding).asks]
    },

    async answerAsk(_userId, binding, askId, _resolution: RequestResolution) {
      require('asks', 'answerAsk')
      call()
      const stored = load(binding)
      const before = stored.asks.length
      stored.asks = stored.asks.filter((ask) => ask.id !== askId)
      // An ask that is no longer open is the commonest thing that happens to
      // one, and not a failure. Same answer a driver gives a local park.
      return { delivered: stored.asks.length < before } satisfies RemoteAnswerOutcome
    },

    async actionRequiredCount(_userId) {
      require('actionRequiredCount', 'actionRequiredCount')
      call()
      return [...store.values()].reduce((n, t) => n + t.asks.length, 0)
    },

    deepLink: (binding) => (binding.key ? `https://fake.test/tasks/${binding.key}` : null)
  }

  return {
    adapter,
    seed: (task: TaskDto) => {
      const stored = storedFor(task, null)
      store.set(stored.id, stored)
      return bindingOf(stored)
    },
    requests: () => requests,
    behave: (next) => {
      mode = next
    },
    plantAsk: (remoteId, ask) => {
      store.get(remoteId)?.asks.push({ ...ask, createdAt: new Date() })
    },
    stored: (remoteId) => store.get(remoteId),
    touch: (remoteId, patch) => {
      const stored = store.get(remoteId)
      if (stored) Object.assign(stored, patch, { updatedAt: new Date() })
    }
  }
}
