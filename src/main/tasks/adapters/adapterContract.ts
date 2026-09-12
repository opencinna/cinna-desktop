/**
 * The remote-task adapter contract — what every `RemoteTaskAdapter` promises
 * its callers, asserted the same way for each implementation.
 *
 * Modelled on `agents/drivers/__golden__/driverContract.ts`, which does the
 * same job one layer down, and written for the same reason phase 0 wrote that
 * one: **the suite exists before the first real implementation**. `cinna` is
 * the only adapter this phase ships, and an interface shaped by one remote
 * acquires that remote's field names and then breaks on the second. So the
 * subjects here are four fakes standing for the four worked examples in §5.6 of
 * the phase plan, and `cinnaTaskAdapter` joins them in step 9 as one more row.
 *
 * The suite owns the assertions. A world only says how to build the adapter and
 * how to make its far side misbehave — so an adapter cannot pass by describing
 * its own behaviour back to the suite.
 *
 * What is asserted, for every implementation:
 *
 * - `id` is a non-empty string and the same on every read (`id.stable`).
 * - `capabilities()` is the same answer every call, and a caller that edits
 *   what it was handed cannot change the next answer (`capabilities.stable`).
 * - `availability()` resolves — never rejects — and a `ready: false` always
 *   carries a sentence a person can act on (`availability.answers`).
 * - `create` returns a binding naming this adapter, with a non-empty id
 *   (`create.binds`); an adapter that is not ready refuses it as
 *   `unsupported` or `unavailable` rather than inventing one.
 * - **Only `create` invents a binding**: every other call given one returns the
 *   same `adapter` and `id` — *including* the bindings nested inside snapshots,
 *   which is where a `fetch` that silently re-creates the task would hide. A
 *   call that legitimately describes other tasks (`list`, `listSubtasks`) may
 *   carry other ids but never another adapter's name, and every binding's `url`
 *   is null or `http(s)` (`create.only_inventor`, `create.binds`).
 * - An operation the capabilities deny throws `UnsupportedRemoteOperation`, and
 *   does so **without touching the far side** (`unsupported.refused`). That
 *   includes the two capabilities that are *lists* rather than flags: a field
 *   outside `writeFields` and an artifact kind outside `writeArtifactKinds`.
 * - An operation the capabilities allow resolves against a healthy far side
 *   (`supported.works`).
 * - A status outside `REMOTE_WRITABLE_STATUSES` never leaves the process
 *   (`status.narrow`) — §5.12 rule 1. `archived` is in that refused set and
 *   stays there: filing a task away is `archive()`, a different route on the
 *   remote and a different method here, so an adapter that does the right thing
 *   passes this clause instead of needing to be excused from it.
 * - An adapter with `subtasks` creates a child that the remote then **reports
 *   under that parent**, and one without refuses rather than creating an orphan
 *   at top level; a child offered with no parent binding is `invalid_request`
 *   and never reaches the remote (`subtasks.no_orphan`).
 * - Every open ask carries an `InputRequest` from the run vocabulary, and
 *   answering one that is gone is `{ delivered: false }`, not a throw
 *   (`asks.run_vocabulary`).
 * - With the far side failing, every operation **rejects with a
 *   `RemoteTaskError`** — never a raw `TypeError`, never a quiet success
 *   (`failure.is_domain`).
 * - A far side that denies ownership answers `not_ours` from a **single**
 *   request: unbind, never retried (`not_ours.no_retry`).
 * - A far side that **refuses a write** answers `rejected` and the **binding
 *   survives** (`rejected.keeps_binding`). This clause exists because of what
 *   its absence would have done: cinna-core raises 400 for an illegal
 *   transition as well as for a non-owner, so an adapter that read the status
 *   code alone would unbind a task whose only crime was §5.12 rule 2 — the
 *   most predicted bug in the phase — and no retry could ever re-link it.
 * - `deepLink` is null or an `http(s)` URL — `app:open-external` refuses every
 *   other scheme, so anything else is a control that does nothing
 *   (`deepLink.openable`).
 * - `actionRequiredCount` is a non-negative integer (`count.counts`).
 */

import { describe, expect, it, type TestFunction } from 'vitest'
import { REMOTE_WRITABLE_STATUSES, TASK_STATUSES } from '../../../shared/taskStatus'
import type { TaskArtifact, TaskDto } from '../../../shared/tasks'
import {
  RemoteTaskError,
  UnsupportedRemoteOperation,
  type RemoteBinding,
  type RemoteTaskAdapter,
  type RemoteTaskCapabilities,
  type RemoteTaskFields,
  type RemoteTaskSnapshot,
  type RemoteWritableField
} from './adapter'

export type AdapterContractClause =
  | 'id.stable'
  | 'capabilities.stable'
  | 'availability.answers'
  | 'create.binds'
  | 'handoffNote.lands'
  | 'create.only_inventor'
  | 'unsupported.refused'
  | 'supported.works'
  | 'status.narrow'
  | 'subtasks.no_orphan'
  | 'asks.run_vocabulary'
  | 'failure.is_domain'
  | 'not_ours.no_retry'
  | 'rejected.keeps_binding'
  | 'deepLink.openable'
  | 'count.counts'

/** The four kinds of `InputRequest` a run can emit. A remote ask is one of these. */
const INPUT_REQUEST_KINDS = ['permission', 'question', 'auth', 'elicitation']

function artifactOfKind(kind: 'file' | 'link'): TaskArtifact {
  return kind === 'file'
    ? { kind: 'file', name: 'report.md', ref: 'app-data/storage/report.md' }
    : { kind: 'link', name: 'The pull request', ref: 'https://example.test/pr/1' }
}

export interface AdapterWorld {
  adapter: RemoteTaskAdapter
  userId: string
  /** Whether this profile is linked to the service. Told, not probed: the suite
   *  cannot branch on an async answer at collection time — and it asserts that
   *  `availability()` agrees. */
  ready: boolean
  /** A local task to put on the remote. */
  task: TaskDto
  /** The same task with a parent, for the orphan clause. */
  subtask: TaskDto
  /** Far-side calls made so far. A refusal that never left the process adds none. */
  requests(): number
  /** Every far-side call fails with a transport error from now on. */
  failTransport(): void
  /** The far side says the task is not this account's, or is gone. */
  denyOwnership(): void
  /**
   * The far side understands the request and refuses it — an illegal
   * transition, a field it will not take. **Not** the same as denying
   * ownership, and on cinna-core not even distinguishable by status code.
   */
  refuseWrite(): void
  /** Put an open ask on a bound task; returns its id. Only called when `asks`. */
  plantAsk(binding: RemoteBinding): string
  /**
   * A task already on the far side, bound — **without** going through `create`.
   *
   * A pull-only remote has no other way to have a binding at all, and every
   * clause below one needs one. Creating is `create.binds`'s business and
   * nobody else's.
   */
  bind(): Promise<RemoteBinding>
}

export interface AdapterContractOptions {
  /**
   * Clauses this adapter is known not to satisfy, with the reason. A recorded
   * violation that starts passing **fails** — the record is the thing that has
   * to be deleted in the commit that fixes it, or it rots into a ceiling.
   */
  knownViolations?: Partial<Record<AdapterContractClause, string>>
}

/**
 * Does this capability allow anything at all?
 *
 * Two of them are **lists**, not flags (`writeFields`, `writeArtifactKinds`), and an
 * empty array is truthy — so a plain `caps[capability]` would read "this
 * adapter stores no artifact kind whatsoever" as permission to try.
 */
function allows(caps: RemoteTaskCapabilities, capability: keyof RemoteTaskCapabilities): boolean {
  const value = caps[capability]
  return Array.isArray(value) ? value.length > 0 : Boolean(value)
}

/** Every operation, paired with the capability that gates it. */
const GATED: {
  capability: keyof RemoteTaskCapabilities
  name: string
  sameTask: boolean
  run: (a: RemoteTaskAdapter, userId: string, b: RemoteBinding) => Promise<unknown>
}[] = [
  {
    // **Gated, not ungated.** `writeFields: []` is expressible in the type — a
    // remote the desktop may read and never edit — and the first version of
    // this list pushed `title` unconditionally, so such an adapter failed the
    // suite for doing exactly what its capabilities said.
    capability: 'writeFields',
    name: 'pushFields',
    sameTask: true,
    // `?? 'title'` so the *denied* case still sends something: an adapter with
    // an empty `writeFields` has no field to name, and the clause that runs
    // this one expects a refusal, not a crash inside the suite.
    run: (a, u, b) => a.pushFields(u, b, patchFor(a.capabilities().writeFields[0] ?? 'title'))
  },
  {
    capability: 'writeStatus',
    name: 'pushStatus',
    sameTask: true,
    run: (a, u, b) => a.pushStatus(u, b, 'in_progress')
  },
  { capability: 'archive', name: 'archive', sameTask: true, run: (a, u, b) => a.archive(u, b) },
  {
    capability: 'subtasks',
    name: 'listSubtasks',
    sameTask: false,
    run: (a, u, b) => a.listSubtasks(u, b)
  },
  { capability: 'execute', name: 'execute', sameTask: true, run: (a, u, b) => a.execute(u, b) },
  {
    capability: 'comments',
    name: 'addComment',
    sameTask: true,
    run: (a, u, b) => a.addComment(u, b, { type: 'result', body: 'the note' })
  },
  {
    capability: 'comments',
    name: 'listComments',
    sameTask: true,
    run: (a, u, b) => a.listComments(u, b)
  },
  {
    capability: 'writeArtifactKinds',
    name: 'putArtifact',
    sameTask: true,
    // **The kind the adapter says it takes**, not a hard-coded `link`. Driving
    // this with a link was the bug: cinna stores files and only files, so the
    // one remote this phase ships would have been handed the one artifact it
    // cannot represent, and could only pass by rejecting — failing two clauses
    // — or by quietly posting it as a comment.
    run: (a, u, b) =>
      a.putArtifact(u, b, artifactOfKind(a.capabilities().writeArtifactKinds[0] ?? 'link'))
  },
  {
    capability: 'asks',
    name: 'listOpenAsks',
    sameTask: true,
    run: (a, u, b) => a.listOpenAsks(u, b)
  },
  {
    capability: 'asks',
    name: 'answerAsk',
    sameTask: true,
    run: (a, u, b) => a.answerAsk(u, b, 'nothing', { kind: 'rejected' })
  },
  {
    capability: 'actionRequiredCount',
    name: 'actionRequiredCount',
    sameTask: true,
    run: (a, u) => a.actionRequiredCount(u)
  },
  {
    capability: 'assigneeDirectory',
    name: 'listAssignees',
    sameTask: false,
    run: (a, u) => a.listAssignees(u)
  }
]

/**
 * Operations gated by nothing — every adapter has to answer these.
 *
 * `sameTask` is false for the two that legitimately answer about **other**
 * tasks: `list` returns the account's set and `listSubtasks` returns children,
 * so their bindings carry other ids. Everything else must come back describing
 * the task it was handed.
 */
const UNGATED: {
  name: string
  sameTask: boolean
  run: (a: RemoteTaskAdapter, userId: string, b: RemoteBinding) => Promise<unknown>
}[] = [
  { name: 'fetch', sameTask: true, run: (a, u, b) => a.fetch(u, b) },
  { name: 'list', sameTask: false, run: (a, u) => a.list(u, null) }
]

/**
 * The cheapest write this adapter admits to, or null when it admits to none.
 *
 * Used by the clause about a *refused* write, which needs an operation the
 * capabilities allow — otherwise it measures `unsupported` and calls it
 * `rejected`.
 */
function firstWrite(
  caps: RemoteTaskCapabilities
): ((a: RemoteTaskAdapter, u: string, b: RemoteBinding) => Promise<unknown>) | null {
  if (caps.writeFields.length > 0) {
    return (a, u, b) => a.pushFields(u, b, patchFor(caps.writeFields[0]))
  }
  if (caps.writeStatus) return (a, u, b) => a.pushStatus(u, b, 'in_progress')
  if (caps.comments) return (a, u, b) => a.addComment(u, b, { type: 'result', body: 'note' })
  return null
}

/** A patch touching one field, for an adapter that lists it. */
function patchFor(field: RemoteWritableField): Partial<RemoteTaskFields> {
  switch (field) {
    case 'title':
      return { title: 'Renamed' }
    case 'description':
      return { description: 'A different description.' }
    case 'priority':
      return { priority: 'high' }
    case 'assignee':
      return { assignee: { ref: 'agt-remote-1', name: 'Someone else', kind: 'remote_agent' } }
  }
}

export function describeAdapterContract(
  name: string,
  makeWorld: () => AdapterWorld,
  options: AdapterContractOptions = {}
): void {
  const clause = (key: AdapterContractClause, title: string, fn: TestFunction): void => {
    const known = options.knownViolations?.[key]
    if (!known) {
      it(title, fn)
      return
    }
    it(`${title} — known violation: ${known}`, async (ctx) => {
      let failure: unknown
      try {
        await fn(ctx)
      } catch (err) {
        failure = err
      }
      if (failure === undefined) {
        throw new Error(
          `"${key}" now holds for ${name}: delete its knownViolations entry in the same commit`
        )
      }
    })
  }

  /** Decided at collection, so a clause can be shaped by what the adapter is. */
  const sample = makeWorld()
  const ready = sample.ready
  const caps = sample.adapter.capabilities()

  /** However this world comes by a bound task — created, or already there. */
  async function bound(world: AdapterWorld): Promise<RemoteBinding> {
    return world.bind()
  }

  describe(`remote task adapter contract: ${name}`, () => {
    clause('id.stable', 'has a non-empty id that does not change', () => {
      const { adapter } = makeWorld()
      expect(adapter.id).toBeTypeOf('string')
      expect(adapter.id.length).toBeGreaterThan(0)
      // Two *instances*, which is what "does not change" means. Reading the
      // same object's property twice could only fail for a getter that mints a
      // value per read, and said nothing about the adapter.
      expect(makeWorld().adapter.id).toBe(adapter.id)
    })

    clause('capabilities.stable', 'answers the same capabilities however they are handled', () => {
      const { adapter } = makeWorld()
      const pristine = structuredClone(adapter.capabilities())
      expect(adapter.capabilities()).toEqual(pristine)

      // A caller that edits what it was handed must not change what the next
      // one sees. The driver seam learned this in phase 2; the same mistake is
      // available here and costs the same to make — and the way it is *made*
      // is returning one shared literal, which is also the cheapest thing to
      // write. Copying and freezing both pass; handing out the original does
      // not, which is the whole distinction.
      const handed = adapter.capabilities()
      try {
        ;(handed as { execute: boolean }).execute = !handed.execute
        ;(handed.writeFields as string[]).push('nonsense')
      } catch {
        /* a frozen answer throws here in strict mode, which is also correct */
      }
      expect(adapter.capabilities()).toEqual(pristine)
    })

    clause('availability.answers', 'says whether it is usable, and why not', async () => {
      const { adapter, userId, ready: expected } = makeWorld()
      const availability = await adapter.availability(userId)
      expect(availability.ready).toBe(expected)
      if (!availability.ready) {
        expect(availability.reason ?? '').not.toBe('')
      }
    })

    clause('deepLink.openable', 'links somewhere the app can actually open, or nowhere', () => {
      const { adapter } = makeWorld()
      const link = adapter.deepLink({
        adapter: adapter.id,
        id: 'r-1',
        key: 'KEY-1',
        url: null,
        state: {}
      })
      if (link === null) return
      expect(link).toMatch(/^https?:\/\//)
    })

    if (!ready) {
      clause('create.binds', 'refuses to bind a task while it is not usable', async () => {
        const world = makeWorld()
        await expect(
          world.adapter.create(world.userId, world.task, null)
        ).rejects.toBeInstanceOf(RemoteTaskError)
      })
      return
    }

    if (!caps.create) {
      // A remote work cannot be *put* on. It still has tasks — pulled, not
      // created — so every other clause runs against `world.bind()`.
      clause('create.binds', 'refuses to have work put on it', async () => {
        const world = makeWorld()
        await expect(
          world.adapter.create(world.userId, world.task, null)
        ).rejects.toBeInstanceOf(UnsupportedRemoteOperation)
      })
    }

    clause('create.binds', 'binds a task to itself, and names itself in the binding', async () => {
      if (!caps.create) return
      const world = makeWorld()
      const binding = await world.adapter.create(world.userId, world.task, null)
      expect(binding.adapter).toBe(world.adapter.id)
      expect(binding.id).toBeTypeOf('string')
      expect(binding.id.length).toBeGreaterThan(0)
      // The url on the *binding*, which is what `TaskView` opens — `deepLink()`
      // has the same guarantee asserted on it and no caller in `src/` at all.
      if (binding.url !== null) expect(binding.url).toMatch(/^https?:\/\//)
    })

    clause('create.only_inventor', 'never re-identifies a task it was handed', async () => {
      const world = makeWorld()
      const binding = await bound(world)

      const sameTask: RemoteBinding[] = []
      const anyBinding: RemoteBinding[] = []
      const ops = [...UNGATED, ...GATED.filter((op) => allows(caps, op.capability))]
      for (const op of ops) {
        const found = bindingsIn(await op.run(world.adapter, world.userId, binding))
        anyBinding.push(...found)
        if (op.sameTask) sameTask.push(...found)
      }

      // **Including the ones inside snapshots**, which is where this clause was
      // blind: a `RemoteTaskSnapshot` has no top-level `adapter`/`id`, so a
      // plain `isBinding(result)` was false for `fetch`, `list` and
      // `listSubtasks` and silently dropped three of the six results. The
      // adapter it could not see is the one `adapter.ts` warns about by name —
      // a `fetch` that re-creates the task on a 404 and hands back the new id.
      // `taskSyncService` writes that binding, the task points at a duplicate,
      // and the original is abandoned with the user's comments on it.
      expect(sameTask.length).toBeGreaterThan(0)
      for (const b of sameTask) {
        expect(b.adapter).toBe(binding.adapter)
        expect(b.id).toBe(binding.id)
      }

      // `list` and `listSubtasks` legitimately describe other tasks — but never
      // another *service*. A snapshot naming a different adapter would be
      // written into `remote_adapter` unchecked, and the next `adapterFor`
      // would route that task somewhere else entirely.
      for (const b of anyBinding) {
        expect(b.adapter).toBe(world.adapter.id)
        // F8: the renderer opens `task.remote.url`, not `deepLink()`, and
        // `app:open-external` refuses every scheme but these two.
        if (b.url !== null) expect(b.url).toMatch(/^https?:\/\//)
      }
    })

    clause('unsupported.refused', 'refuses what it cannot do, without asking the service', async () => {
      const world = makeWorld()
      const binding = await bound(world)
      const before = world.requests()

      const denied = GATED.filter((op) => !allows(caps, op.capability))
      for (const op of denied) {
        await expect(
          op.run(world.adapter, world.userId, binding),
          `${op.name} is gated by \`${op.capability}\`, which is false`
        ).rejects.toBeInstanceOf(UnsupportedRemoteOperation)
      }
      // The refusal is a decision, not a round trip: nothing left the process.
      expect(world.requests()).toBe(before)

      // A `writeFields` entry the adapter does not list is the same refusal.
      const missing = (['title', 'description', 'priority', 'assignee'] as const).find(
        (f) => !caps.writeFields.includes(f)
      )
      if (missing) {
        await expect(
          world.adapter.pushFields(world.userId, binding, { [missing]: null } as never)
        ).rejects.toBeInstanceOf(UnsupportedRemoteOperation)
      }

      // And so is an artifact kind it does not store. This is the clause that
      // keeps `writeArtifactKinds` a list: with a boolean, an adapter that can only
      // hold files would have had to accept a link or lie about the flag.
      const unstorable = (['file', 'link'] as const).find(
        (k) => !caps.writeArtifactKinds.includes(k)
      )
      if (unstorable) {
        await expect(
          world.adapter.putArtifact(world.userId, binding, artifactOfKind(unstorable)),
          `\`${unstorable}\` is not in writeArtifactKinds`
        ).rejects.toBeInstanceOf(UnsupportedRemoteOperation)
      }
    })

    clause('supported.works', 'does everything it says it can', async () => {
      const world = makeWorld()
      const binding = await bound(world)
      for (const op of UNGATED) {
        await expect(op.run(world.adapter, world.userId, binding), op.name).resolves.toBeDefined()
      }
      for (const op of GATED) {
        if (!allows(caps, op.capability)) continue
        // Spelled out rather than `resolves.not.toThrow()`: several of these
        // answer with `void`, so there is nothing to assert about the value,
        // and a matcher whose name says "throw" about a resolved `undefined`
        // reads as a check on something it is not checking.
        let failure: unknown
        try {
          await op.run(world.adapter, world.userId, binding)
        } catch (err) {
          failure = err
        }
        expect(
          failure,
          `${op.name} is allowed by \`${op.capability}\` and failed anyway`
        ).toBeUndefined()
      }
    })

    clause('status.narrow', 'never sends a status the service would refuse', async () => {
      if (!caps.writeStatus) return
      const world = makeWorld()
      const binding = await bound(world)
      const refused = TASK_STATUSES.filter((s) => !REMOTE_WRITABLE_STATUSES.includes(s))
      expect(refused.length).toBeGreaterThan(0)
      // Named, not incidental: `archived` being here is the reason `archive()`
      // exists. If a future edit lets it through `pushStatus`, this is the line
      // that should be argued with first.
      expect(refused).toContain('archived')

      for (const status of refused) {
        const before = world.requests()
        await expect(
          world.adapter.pushStatus(world.userId, binding, status),
          `${status} is outside REMOTE_WRITABLE_STATUSES`
        ).rejects.toBeInstanceOf(RemoteTaskError)
        expect(world.requests(), `${status} reached the service`).toBe(before)
      }
    })

    clause('subtasks.no_orphan', 'creates a subtask as one, or not at all', async () => {
      if (!caps.create) return
      const world = makeWorld()
      const parent = await bound(world)

      if (!caps.subtasks) {
        // A flat remote losing the parent would put the child at top level,
        // where it reads as unrelated work nobody asked for.
        await expect(
          world.adapter.create(world.userId, world.subtask, parent)
        ).rejects.toBeInstanceOf(UnsupportedRemoteOperation)
        return
      }

      const child = await world.adapter.create(world.userId, world.subtask, parent)
      // **Resolving is not the claim.** An adapter that dropped the parent and
      // created a top-level task would resolve perfectly happily — which is
      // what the first version of this clause accepted. The claim is that the
      // remote now says the child is under that parent.
      const children = await world.adapter.listSubtasks(world.userId, parent)
      expect(children.map((c) => c.binding.id)).toContain(child.id)
      expect(children.find((c) => c.binding.id === child.id)?.parentId).toBe(parent.id)
    })

    clause('subtasks.no_orphan', 'refuses a subtask whose parent it was not given', async () => {
      if (!caps.subtasks || !caps.create) return
      const world = makeWorld()
      // The caller resolves the parent binding; `parentTaskId` is a *local* id
      // and means nothing to the remote. Offering the child without it would
      // create a top-level task that looks like success, so it is caught here
      // and the remote is never asked.
      let thrown: unknown
      const before = world.requests()
      try {
        await world.adapter.create(world.userId, world.subtask, null)
      } catch (err) {
        thrown = err
      }
      expect(thrown).toBeInstanceOf(RemoteTaskError)
      expect((thrown as RemoteTaskError).code).toBe('invalid_request')
      expect(world.requests()).toBe(before)
    })

    clause('asks.run_vocabulary', 'returns asks in the run vocabulary and answers them once', async () => {
      if (!caps.asks) return
      const world = makeWorld()
      const binding = await bound(world)
      const askId = world.plantAsk(binding)

      const asks = await world.adapter.listOpenAsks(world.userId, binding)
      expect(asks.length).toBeGreaterThan(0)
      for (const ask of asks) {
        expect(ask.id).not.toBe('')
        expect(INPUT_REQUEST_KINDS).toContain(ask.request.kind)
        expect(ask.createdAt).toBeInstanceOf(Date)
      }

      expect(await world.adapter.answerAsk(world.userId, binding, askId, { kind: 'rejected' })).toEqual({
        delivered: true
      })
      // Answering it again is the commonest thing that happens to an ask — two
      // surfaces, one registry — and it is an answer, not a failure.
      expect(await world.adapter.answerAsk(world.userId, binding, askId, { kind: 'rejected' })).toEqual({
        delivered: false
      })
    })

    clause('supported.works', 'says whether work is live on the remote, or says it cannot tell', async () => {
      const world = makeWorld()
      const binding = await bound(world)
      const live = await world.adapter.liveSession(world.userId, binding)
      // Three states, and `null` is one of them. §5.10 turns each into a
      // different Take over control; an adapter that answered `false` when it
      // meant "no idea" would offer a take-over into a live agent.
      expect([true, false, null]).toContain(live)

      // **It is not a second copy of the snapshot's status**, and this is what
      // makes the split worth having rather than a rename. A `fetch` costs the
      // pull one call per watched replica per pass; this costs one call, once,
      // when somebody is about to take the task over. An adapter that answered
      // it out of the snapshot it had already fetched would be free to skip the
      // question entirely — and cinna is the worked example of why that is
      // wrong in both directions, since it recomputes status *from* the
      // sessions this asks about.
      const snapshot = await world.adapter.fetch(world.userId, binding)
      expect(snapshot).not.toHaveProperty('liveSession')
    })

    clause('handoffNote.lands', 'has somewhere to leave the handoff note', async () => {
      const world = makeWorld()
      const binding = await bound(world)
      if (!caps.handoffNote) {
        await expect(
          world.adapter.putHandoffNote(world.userId, binding, 'Half done.')
        ).rejects.toBeInstanceOf(UnsupportedRemoteOperation)
        return
      }
      // A method of its own, and not `addComment({ type: 'result' })` — which
      // would put a cinna literal in `taskService` and leave an adapter with no
      // comments unable to receive a handover at all.
      await expect(
        world.adapter.putHandoffNote(world.userId, binding, 'Half done.')
      ).resolves.not.toThrow()
    })

    clause('count.counts', 'counts what is waiting, and never counts backwards', async () => {
      if (!caps.actionRequiredCount) return
      const world = makeWorld()
      const count = await world.adapter.actionRequiredCount(world.userId)
      expect(Number.isInteger(count)).toBe(true)
      expect(count).toBeGreaterThanOrEqual(0)
    })

    clause('failure.is_domain', 'reports a failing service as a failure, in this app’s words', async () => {
      const world = makeWorld()
      const binding = await bound(world)
      world.failTransport()

      const ops = [
        ...UNGATED,
        ...GATED.filter((op) => allows(caps, op.capability))
      ]
      for (const op of ops) {
        let thrown: unknown
        try {
          await op.run(world.adapter, world.userId, binding)
        } catch (err) {
          thrown = err
        }
        expect(thrown, `${op.name} resolved while the service was down`).toBeDefined()
        expect(thrown, `${op.name} threw a raw error`).toBeInstanceOf(RemoteTaskError)
      }
      if (caps.create) {
        await expect(world.adapter.create(world.userId, world.task, null)).rejects.toBeInstanceOf(
          RemoteTaskError
        )
      }
    })

    clause('rejected.keeps_binding', 'keeps the binding when a write is refused', async () => {
      // Whatever write this adapter actually has. A read-only remote has none,
      // and then there is no refusal to classify — asking it to `pushFields`
      // would be testing `unsupported`, which is a different clause.
      const write = firstWrite(caps)
      if (!write) return

      const world = makeWorld()
      const binding = await bound(world)
      world.refuseWrite()

      let thrown: unknown
      try {
        await write(world.adapter, world.userId, binding)
      } catch (err) {
        thrown = err
      }
      expect(thrown).toBeInstanceOf(RemoteTaskError)
      // The distinction the whole taxonomy turns on. `not_ours` unbinds and is
      // never retried; a refused write is a task that is still there.
      expect((thrown as RemoteTaskError).code).toBe('rejected')
      expect((thrown as RemoteTaskError).code).not.toBe('not_ours')
    })

    clause('not_ours.no_retry', 'unbinds on a denial instead of retrying it', async () => {
      const world = makeWorld()
      const binding = await bound(world)
      world.denyOwnership()

      const before = world.requests()
      let thrown: unknown
      try {
        await world.adapter.fetch(world.userId, binding)
      } catch (err) {
        thrown = err
      }
      expect(thrown).toBeInstanceOf(RemoteTaskError)
      expect((thrown as RemoteTaskError).code).toBe('not_ours')
      // One request. A denial is not a transient condition, and retrying it is
      // how a 400 comes to look like a network fault for a week.
      expect(world.requests() - before).toBe(1)
    })
  })
}

/**
 * Every binding reachable in a result: the value itself, the one nested in a
 * snapshot, and either of those inside an array.
 *
 * The nested case is the whole point. Three of the six binding-returning
 * operations answer with a `RemoteTaskSnapshot`, whose identity lives one level
 * down — and a check that only looked at the top level saw nothing and said so
 * by passing.
 */
function bindingsIn(value: unknown): RemoteBinding[] {
  if (Array.isArray(value)) return value.flatMap(bindingsIn)
  if (isBinding(value)) return [value]
  const nested = (value as RemoteTaskSnapshot | null)?.binding
  return isBinding(nested) ? [nested] : []
}

function isBinding(value: unknown): value is RemoteBinding {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as RemoteBinding).adapter === 'string' &&
    typeof (value as RemoteBinding).id === 'string'
  )
}
