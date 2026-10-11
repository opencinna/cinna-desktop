/**
 * The Inbox — one list of everything waiting on a human.
 *
 * A local driver parking a run (an ACP permission ask, a question) and — from
 * step 9 of the phase — a bound remote system reporting a session that went
 * `blocked` arrive here as the **same** entry, because both carry an
 * `InputRequest` from `shared/runEvents.ts`. That is plan rule 1 applied one
 * level up: the transcript renders an ask with one component, and so does the
 * inbox, because there is only ever one type to render.
 *
 * Pure type module: imported from main, preload and the renderer alike.
 */
import type { PermissionReply } from './localAgentRequests'
import type { InputRequest, InputResumeMode } from './runEvents'
import type { TaskDispatchMode, TaskDispatchPauseReason } from './taskDispatch'

/**
 * Where an entry came from.
 *
 *  - `local` — a run parked on this machine. Answered through the driver that
 *    parked it, by request id.
 *  - `remote` — an open ask on a bound remote system. Answered through its
 *    adapter. Its address includes the local task and remote binding so IDs
 *    from two services cannot collide.
 */
export type InboxSource = 'local' | 'remote'

/** One thing waiting for the user. */
export interface InboxEntry {
  /** The address an answer is posted to. Unique across the inbox. */
  requestId: string
  source: InboxSource
  /**
   * Local runner gates — and handover gates — survive closing a turn and
   * restarting the app. A `handover` entry is a question about work that has
   * not started; it renders as any other question card.
   */
  deliveryOwner?: 'driver' | 'runner' | 'handover'
  taskId: string
  /** The task's title, so a row reads as a sentence without a second query. */
  taskTitle: string
  /**
   * The chat the ask came from. Present for a local entry — it is what "open
   * the conversation" links to — and null for a remote one, whose thread lives
   * on the other side.
   */
  chatId: string | null
  /** Who is asking. A display hint: the renderer resolves the name from its own agent list. */
  agentId: string | null
  request: InputRequest
  resume: InputResumeMode
  createdAt: Date
  /**
   * The answer the user gave, stored until the task's queue sends it — an ask
   * on a task the task dispatcher owns is answered as a dispatched run, when
   * the agent's folder and a runner slot are free. Absent when nothing waits.
   */
  queuedAnswer?: string
  queuedAt?: Date
  /** The agent folder's name, for "Sends when <folder> is free."; absent when unknown. */
  queuedFolder?: string
  /** Why the last stored answer could not be sent; the ask can be answered again. */
  queuedError?: string
}

/**
 * A source the list could not be read from, named by the adapter id.
 *
 * `RemoteTaskAdapter` has an id and no display name, so the id is what travels;
 * nothing invents a friendlier one, and no user-facing copy names a service.
 */
export interface InboxUnreadableSource {
  adapter: string
  reason: string
}

/**
 * The inbox as one read answered it: what is waiting, and what could not be
 * asked.
 *
 * **One bound service going quiet must not delete the local asks.** Until this
 * type existed, `list` rejected whole whenever any adapter read failed, so an
 * agent parked on this machine disappeared from the one list it was in for as
 * long as a remote outage lasted.
 *
 * `unreadable` empty means the list is the whole truth — which is why there is
 * no `complete` boolean beside it. Two fields that both claim to answer the same
 * question can disagree, and the derivable one is the one that would be wrong.
 *
 * Named for `TaskListSnapshot`, its sibling: a list plus what the read could not
 * cover.
 */
export interface InboxSnapshot {
  entries: InboxEntry[]
  unreadable: InboxUnreadableSource[]
  /**
   * What the task dispatcher needs the user for: approvals of outside content
   * before a task runs, and queues paused on a flagged task. Always filled by
   * main; optional only so surfaces built before the dispatcher still type.
   */
  dispatch?: TaskDispatchInboxItem[]
  /**
   * Agents with a newer version waiting, one card type across kinds: shared
   * desktop agents on this machine the team has moved past (derived on every
   * read from the cached catalog listing and the folders' own heads), cloud
   * agents whose install is behind its catalog item and is not updated by the
   * server on its own, and catalog skills a kit agent pins at an older
   * version than the listing's, where the person may change that agent. No
   * table: an Update — or the agent catching up any other way — clears it.
   * Optional for the same reason as `dispatch`.
   */
  updates?: UpdateAvailableInboxItem[]
  /**
   * Catalog skills an agent on this machine pins that the catalog no longer
   * gives this person: the copy on this computer is now a local version. One
   * per agent and pin, minus the ones dismissed in that state. Derived on
   * every read; leaves by itself when access returns or the pin goes.
   * Optional for the same reason as `dispatch`.
   */
  disconnected?: SkillDisconnectedInboxItem[]
}

/** What the Update on an "Update available" card acts on. */
export type UpdateAvailableTarget = 'desktop_agent' | 'cloud_agent' | 'skill'

interface UpdateAvailableBase {
  kind: 'update_available'
  /** The agent's row: a folder agent's id, or a synced cloud agent's. */
  agentId: string
  agentName: string
  /** The newest catalog version (`Version N`), when known. */
  version: number | null
  /**
   * The publisher's own label for that version (`1.2.0`), shown beside it as
   * `Version N (1.2.0)`; null when it has none.
   */
  versionLabel: string | null
  /** Who shared or published that version, when the listing says. */
  changedBy: string | null
  /** When that version was shared or published, when the listing says. */
  changedAt: Date | null
}

/**
 * "Update available" for one agent, with an Update action — `sharing:update`
 * for a desktop agent, `agent:apply-bundle-update` for a cloud agent,
 * `catalog-skills:update` for one catalog skill a kit agent pins (one item per
 * agent and skill).
 */
export type UpdateAvailableInboxItem =
  | (UpdateAvailableBase & {
      target: 'desktop_agent'
      /** The team's repository the folder follows. */
      repoId: string
    })
  | (UpdateAvailableBase & {
      target: 'cloud_agent'
      /** The install on Cinna (the agent row's `remoteTargetId`) the update applies to. */
      installId: string
    })
  | (UpdateAvailableBase & {
      target: 'skill'
      /** The pin's `name` in the agent's `catalog_skills[]` — what the update names. */
      skillName: string
      /** The skill as the catalog names it (`display_name`), else the pin's name. */
      skillTitle: string
      /** The pinned revision the agent has now. */
      pinnedRevision: number | null
    })

/**
 * "Disconnected: *skill* in *agent*": a catalog skill one of the person's
 * agents pins that the catalog no longer gives them (their access was taken
 * away, or it was made private or removed). A copy on this computer keeps
 * working as a local version that no longer syncs (`cached`); without one,
 * the agent cannot download it. Remove takes the pin out
 * (`catalog-skills:remove`), Dismiss (`inbox:dismiss-disconnected`) hides the
 * card until the pin is connected again.
 */
export interface SkillDisconnectedInboxItem {
  kind: 'skill_disconnected'
  /** The folder agent's id. */
  agentId: string
  agentName: string
  /** The pin's `name` in the agent's `catalog_skills[]` — what Remove names. */
  skillName: string
  /** The skill's catalog title when known, else the pin's name. */
  skillTitle: string
  /** The pin's `package_uuid`, lowercase. */
  packageUuid: string
  /** The pinned revision; null when the pin's is not a whole number. */
  revision: number | null
  /** Whether this person may change the agent's pins, so Remove is offered. */
  removable: boolean
  /**
   * Whether the pinned revision is on this computer: the copy keeps working
   * as a local version. False when there is no copy and its download was
   * refused as not available — the agent cannot get the skill at all.
   */
  cached: boolean
}

/** The key a Disconnected card — and its dismissal — is known by: the agent, the package, the pinned revision. */
export function disconnectedKey(agentId: string, packageUuid: string, revision: number | null): string {
  return `${agentId}\n${packageUuid.trim().toLowerCase()}\n${revision ?? ''}`
}

/** `inbox:dismiss-disconnected` — the card a Dismiss names. */
export interface SkillDisconnectedDismissal {
  agentId: string
  packageUuid: string
  revision: number | null
}

/**
 * An approval the dispatcher asks for before it runs a task whose file was
 * written outside Cinna (`fromOutside`). One per task and content version:
 * the file changing again replaces it. Answered through
 * `inbox:dispatch-gate` with `approve` (trust this content and run it) or
 * `skip` (leave it untrusted; no card for the same content again).
 */
export interface TaskDispatchGateItem {
  kind: 'dispatch_gate'
  gateId: string
  taskId: string
  taskTitle: string
  agentId: string
  /** Absolute path of the task file. */
  filePath: string | null
  /** The prompt exactly as the agent will receive it. */
  body: string
  createdAt: Date
}

/**
 * An agent's queue paused on a task, so the flagged task has a card naming
 * the queue. Resolved by `taskDispatch:resume` (or the task moving on).
 */
export interface TaskDispatchPausedItem {
  kind: 'dispatch_paused'
  agentId: string
  reason: TaskDispatchPauseReason
  taskId: string | null
  taskTitle: string | null
  /** The task's dispatch note, when it has one. */
  note: string | null
  pausedAt: Date
}

export type TaskDispatchInboxItem = TaskDispatchGateItem | TaskDispatchPausedItem

/** `inbox:dispatch-gate` — the user's answer to a {@link TaskDispatchGateItem}. */
export type TaskDispatchGateAction = 'approve' | 'skip'

/**
 * Why an approved task did not start at once. Its content is trusted either
 * way: in `one` mode it starts when its turn comes, in `manual` it waits for
 * Run next.
 *
 *  - `agent_busy` — the agent already has as many dispatched runs as its
 *    mode allows (one, or N in `up_to`).
 *  - `folder_busy` — another agent's dispatched run, or its turn being
 *    settled, works in the folder this agent must have to itself.
 *  - `live_turn` — a conversation is running in the folder, or in the task's
 *    own chat.
 *  - `slot` — every task runner slot is busy.
 *  - `not_eligible` — anything else: the task stopped qualifying, or the
 *    agent cannot work a queue now.
 */
export type TaskDispatchGateDeferral = 'agent_busy' | 'folder_busy' | 'live_turn' | 'slot' | 'not_eligible'

/**
 * What answering a gate produced. Approve starts the task the way Run next
 * does, in any mode and while the queue is paused; `started` names the run
 * when it did, else `reason` says why not. `mode` is the agent's run mode, so
 * the card can say what happens next. `reason` and `mode` are always filled
 * by main on an `ok` answer (`reason` only when Approve started nothing);
 * optional only so older surfaces still type.
 */
export type TaskDispatchGateResult =
  | {
      ok: true
      started: null | { taskId: string; chatId: string }
      reason?: TaskDispatchGateDeferral
      mode?: TaskDispatchMode
      /** N in `up_to`, else null: how many runs `agent_busy` waits on. */
      maxRuns?: number | null
    }
  | { ok: false; code: 'no_longer_waiting' | 'already_answered' | 'changed' | 'unavailable'; reason: string }

/**
 * What a surface sends to answer an ask.
 *
 * Deliberately the engine's own vocabulary rather than a `RequestResolution`:
 * this is what a renderer control produces (one of three permission replies, or
 * a selection per question), and narrowing it happens in one place in the main
 * process (`askDelivery.parseAnswerPayload`). Exactly one of the two fields is
 * set; neither, or both, is a malformed answer.
 */
export interface AskAnswerPayload {
  requestId: string
  reply?: PermissionReply
  answers?: string[][]
}

/**
 * Why an answer did not land.
 *
 * Carried beside the sentence so a surface can branch on intent without
 * matching copy — the same reason `RunErrorEvent` has a `code`. It travels as
 * **data** on the result, not on a thrown error, because a `DomainError`'s code
 * does not survive `ipcMain.handle` + `contextBridge` (see `_wrap.ts`).
 *
 *  - `no_longer_waiting` — the address died: the turn ended, the park timed
 *    out, the app restarted under it. The ask is gone, not refused.
 *  - `already_answered` — somebody got there first (the transcript, another
 *    window, the engine itself).
 *  - `not_here` — the ask is answered by writing in its chat, not from here.
 *  - `not_owned` — the ask belongs to a chat this profile does not own.
 *  - `malformed` — the answer was not a shape the ask accepts.
 */
export type InboxAnswerCode =
  | 'no_longer_waiting'
  | 'already_answered'
  | 'not_here'
  | 'not_owned'
  | 'malformed'
  | 'unavailable'
  | 'uncertain'
  | 'answer_in_progress'

/** An answer to an ask whose turn has since ended — a stale block, not a fault. */
export const ASK_NO_LONGER_WAITING = 'This request is no longer waiting for an answer.'

/**
 * What answering produced.
 *
 * Returned as **data, never thrown**: a `DomainError`'s `code` does not survive
 * `ipcMain.handle` + `contextBridge` (see `src/main/ipc/_wrap.ts`), and every
 * failure here is a thing the user needs to read rather than a fault — the ask
 * timed out, the turn was cancelled, someone else answered it first.
 */
export interface InboxAnswerResult {
  ok: boolean
  /** Why not, in words meant for the user. Present exactly when `ok` is false. */
  reason?: string
  /** The same refusal, for code to read. Present exactly when `ok` is false. */
  code?: InboxAnswerCode
  /**
   * Present only for a permission answered *always*: whether the rule reached
   * disk. False means the action went ahead and will be asked about again.
   */
  remembered?: boolean
  /**
   * True when the answer was stored rather than sent: the task's queue sends
   * it when the agent's folder is free (`InboxEntry.queuedAnswer`).
   */
  queued?: boolean
}
