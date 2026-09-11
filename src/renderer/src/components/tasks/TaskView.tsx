import { useMemo, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import {
  AlertTriangle,
  ArrowLeft,
  ExternalLink,
  FileText,
  Laptop,
  Link as LinkIcon,
  Loader2,
  MessageSquare,
  RotateCcw,
  Server
} from 'lucide-react'
import { useAgents } from '../../hooks/useAgents'
import { useInboxList } from '../../hooks/useInbox'
import { useJob, useOpenChatFromRun } from '../../hooks/useJobs'
import { useRelativeNow } from '../../hooks/useRelativeNow'
import { useOpenExternal } from '../../hooks/useSystem'
import {
  useRemoteLiveSession,
  useRerunTask,
  useTakeOverTask,
  useTask
} from '../../hooks/useTasks'
import { useUIStore } from '../../stores/ui.store'
import { formatRelativeFromDate } from '../../utils/cinnaTime'
import { unwrapIpcError } from '../../utils/ipcError'
import { markdownComponents } from '../../utils/markdownComponents'
import { TaskStatusPill } from './TaskStatusPill'
import type { TaskArtifact, TaskDto } from '../../../../shared/tasks'
import type { TaskStatus } from '../../../../shared/taskStatus'

/**
 * One task: what the work is, where it stands, and the way back into it.
 *
 * ## Why a task needs a page of its own
 *
 * A task outlives everything around it. Its chat can be closed, hidden from the
 * Chats list (every job-spawned one is), or deleted; the run row that produced
 * it is the record of the *job's attempt*, not of the work. The task is what is
 * left, and this is the only screen that can still say what it was.
 *
 * ## One component, a local task and a remote replica
 *
 * The page renders a {@link TaskDto} and nothing else, which is what lets the
 * same component show a task running here and a replica of one running in a
 * bound service. The `executor === 'remote'` arm is written and tested although
 * **nothing produces one yet** — the adapters land in steps 8–9 — for the same
 * reason `InboxSource` already has a `remote` arm: the shape a surface binds to
 * must not change when the thing that fills it arrives.
 *
 * The third arm arrived with the tasks the `task` app-sync collection brings in
 * (step 10). A task claimed by another of the user's devices is read-only here
 * too, and telling that apart from one this device owns needs this device's
 * sync id — which the renderer has no way to ask for, so main answers it as
 * `runsHere` on the DTO (`taskRunsHere` in `shared/tasks.ts` is the rule, and
 * it is shared so the two sides cannot drift about it).
 *
 * The banner for that arm does **not** name the device. Nothing on this machine
 * can: `executorDevice` is a sync device id, and the names behind those ids
 * live in the account's device list on the server, which this page has no read
 * of and which can fail. A sentence that said "MacBook Pro" only after a second
 * network round trip would also change width under the pointer (`ux_rules.md`
 * §1), so the honest generic sentence is the one that is always right.
 *
 * ## Blocked with nothing waiting is a real state, and it has one way out
 *
 * An ask whose driver process died — the app restarted, the ACP child was
 * reaped — is expired by the boot sweep, which settles the inbox row and
 * deliberately does not touch the task. So a task can sit `blocked` with an
 * empty inbox: nobody is waiting for an answer, nothing is running, and no
 * other surface in the app can move it. That is what "Re-run from the last
 * message" is for (§5.9 of the phase plan), and it is why this page reads the
 * inbox rather than only the task — `blocked` alone cannot tell the two apart.
 *
 * The inbox's own list is the source, filtered to this task, so the page and
 * the sidebar badge cannot disagree about what is waiting. Answering happens
 * *there*: an ask has one set of controls, and a second copy of them here would
 * be a second place for "Always allow" to mean something slightly different.
 */
export function TaskView(): React.JSX.Element {
  const activeTaskId = useUIStore((s) => s.activeTaskId)
  const task = useTask(activeTaskId)

  if (!activeTaskId) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-[var(--color-text-muted)]">
        No task selected.
      </div>
    )
  }

  if (task.isLoading && !task.data) {
    return (
      <div className="flex-1 flex items-center justify-center pt-[var(--topbar-h)] text-xs text-[var(--color-text-muted)]">
        <Loader2 size={14} className="animate-spin mr-2" />
        Loading task…
      </div>
    )
  }

  if (!task.data) {
    /*
      A failed read and a deleted task are the same shape here — no data — and
      they are not the same thing, so the page says which it has (`ux_rules.md`
      §6: silent failure, or the wrong explanation, is the worst outcome).
    */
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 pt-[var(--topbar-h)] text-center">
        <AlertTriangle size={24} className="text-[var(--color-warning)] opacity-70" />
        <div className="text-sm text-[var(--color-text-secondary)]">
          This task could not be opened.
        </div>
        <div className="text-xs text-[var(--color-text-muted)] max-w-sm">
          {task.error
            ? unwrapIpcError(task.error, 'The task could not be read.')
            : 'It may have been deleted.'}
        </div>
        {task.error && (
          <button
            type="button"
            onClick={() => void task.refetch()}
            className="text-[11px] font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] transition-colors"
          >
            Try again
          </button>
        )}
      </div>
    )
  }

  return <TaskPage task={task.data} isStale={task.isError || !!task.data.remote?.refreshError} />
}

function TaskPage({
  task,
  /**
   * The poll behind this page has started failing, and everything above is the
   * last read that worked. A task the page cannot re-read is not a task that
   * stopped — it may have been deleted, or the read may simply be broken — and
   * showing a stale status as if it were current is the silent failure
   * `ux_rules.md` §6 calls the worst outcome.
   */
  isStale
}: {
  task: TaskDto
  isStale: boolean
}): React.JSX.Element {
  const { data: job } = useJob(task.jobId)
  const { data: agents, isPending: agentsPending } = useAgents()
  const inbox = useInboxList()
  const openChat = useOpenChatFromRun()
  const openExternal = useOpenExternal()
  const setActiveView = useUIStore((s) => s.setActiveView)
  const setActiveJobId = useUIStore((s) => s.setActiveJobId)
  const now = useRelativeNow()
  /**
   * Why a link did not open — the one failure this page can produce that has
   * nowhere else to go. `system.openExternal` refuses anything that is not
   * `http:`/`https:`, and a task's artifacts are strings an agent wrote, so a
   * click here can land on a refusal that would otherwise be silent
   * (`ux_rules.md` §6). It is reported in the slot below the header, which is
   * always there whether or not there is anything in it (§1) — and which
   * reserves **one** line, so the sentence that goes in it has to be one line
   * at every supported width. `describeOpenExternalFailure` owns that
   * constraint; the slot clamps as a guarantee rather than as a fallback.
   */
  const [openError, setOpenError] = useState<string | null>(null)

  const openUrl = async (url: string): Promise<void> => {
    setOpenError(null)
    const result = await openExternal(url)
    if (!result.success) setOpenError(result.error)
  }

  /**
   * What is waiting on **this** task, and whether that is known at all.
   *
   * `known` is the load-bearing half, and it is `isSuccess` rather than
   * "`data` is there". A failed read is not an empty one — and here that is not
   * merely a wrong sentence but a wrong *offer*: the re-run below would send a
   * second message into a conversation whose turn is parked and waiting for an
   * answer. TanStack **keeps the last good `data` across a failed refetch**,
   * and `InboxButton` shares this key and keeps it primed, so on a warm app
   * `data` is almost never undefined and a test for it would have caught almost
   * nothing. The shape that actually happens is: a read that succeeded at
   * 10:00:00 with no row for this task, an ask that parks at 10:00:02, and a
   * poll that starts failing — stale data saying "empty" while an agent waits.
   */
  const asks = useMemo(
    () => ({
      count: (inbox.data ?? []).filter((entry) => entry.taskId === task.id).length,
      known: inbox.isSuccess,
      failed: inbox.isError,
      retry: () => void inbox.refetch()
    }),
    [inbox.data, inbox.isError, inbox.isSuccess, inbox.refetch, task.id]
  )

  /**
   * Who the task is assigned to, or nothing at all.
   *
   * **"An agent" means the agent is gone, so it must not also mean "the list
   * has not loaded yet".** The same trap the inbox fell into: falling back to
   * that phrase while `useAgents()` is in flight puts the sentence reserved for
   * a deleted agent on every cold open. While the list is pending the row shows
   * the name the task recorded when it was assigned, which is a hint rather
   * than an identity and is exactly what it is worth here.
   */
  const assignee = ((): string | null => {
    if (task.assignee.kind === 'model') return 'The local model'
    if (task.assignee.agentId && !agentsPending) {
      const found = (agents ?? []).find((a) => a.id === task.assignee.agentId)
      if (found) return found.name
      return task.assignee.name ?? 'An agent that is no longer here'
    }
    return task.assignee.name
  })()

  const handleBackToJob = (): void => {
    if (!task.jobId) return
    setActiveJobId(task.jobId)
    setActiveView('job-detail')
  }

  /**
   * **Step 11's answer to "a task with no job has no way out of its own page"
   * turned out to be that it already had one.**
   *
   * Step 6 recorded that gap against the step that could first produce such a
   * task, and step 11 is that step — a chat's first ask now mints one. The
   * obvious fix was a second back link pointing at the chat, and the UX review
   * measured what that actually produced: *Back to the conversation* and the
   * header's own **Open the conversation** (rendered for any task with a
   * `chatId`, ~400 px away on the same header row) — two controls, one
   * destination, one noun (`ux_rules.md` §2, §7).
   *
   * So the labelled header control stays and the link is not added. The gap
   * step 6 described was real for a task with **neither** a job nor a chat, and
   * that is a peer copy whose chat did not travel — there is genuinely nowhere
   * on this machine to go back to, so nothing is the right answer.
   */

  return (
    <div className="flex-1 overflow-y-auto pt-[var(--topbar-h)]">
      <div className="max-w-2xl mx-auto px-6 py-6 space-y-6">
        <div>
          <header className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              {/*
                **The slot is there before the job's name is.** `useJob` cannot
                start until the task read returns, so the link used to be
                *inserted* above the title a moment later and pushed the whole
                page down by its height — 28 px, measured, and everything below
                it with it (`ux_rules.md` §1). The space is reserved for any
                task that has a job; only the sentence in it arrives late.

                A task with no job gets no slot, and it needs none: the header's
                own **Open the conversation** is the way out for one that has a
                chat, and a task with neither is a peer copy whose chat did not
                travel — there is nowhere on this machine to go back to. See the
                note on `back` above.
              */}
              {task.jobId && (
                <div className="min-h-[1.125rem] mb-1.5">
                  {job && (
                    <button
                      type="button"
                      onClick={handleBackToJob}
                      className="inline-flex items-center gap-1 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
                    >
                      <ArrowLeft size={11} />
                      Back to {job.title}
                    </button>
                  )}
                </div>
              )}
              {/*
                **The title wraps; it does not truncate.** A task's title is a
                sentence an agent or a job wrote, not a label — at `truncate` it
                was cut at around sixty characters even on a wide window, and
                the page's subject is the one thing on it that has to be
                readable (`ux_rules.md` §7). Wrapping changes this block's
                height between one task and the next, which is not a jump: it
                never changes while the user is looking at one.
              */}
              <div className="flex items-center gap-2">
                <h1 className="text-base font-semibold text-[var(--color-text)] min-w-0">
                  {task.title}
                </h1>
                <TaskStatusPill status={task.status} />
              </div>
              {task.remote?.key && (
                <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5 font-mono">
                  {task.remote.key}
                </div>
              )}
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {task.chatId && (
                <button
                  type="button"
                  onClick={() => openChat(task.chatId as string)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium
                    border border-[var(--color-border)] text-[var(--color-text-secondary)]
                    hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors"
                >
                  <MessageSquare size={12} />
                  Open the conversation
                </button>
              )}
              {task.remote?.url && (
                <button
                  type="button"
                  onClick={() => void openUrl(task.remote?.url as string)}
                  className="p-1.5 rounded-md border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors"
                  // The tooltip and the announced name are one sentence
                  // (`ux_rules.md` §10): an icon-only control has no visible
                  // text to fall back on, so a hover that said one thing and a
                  // screen reader that said another would be two controls.
                  title="Open this task in the service it is connected to"
                  aria-label="Open this task in the service it is connected to"
                >
                  <ExternalLink size={12} />
                </button>
              )}
            </div>
          </header>
          {/*
            Always present, so a refused link cannot move the page it was
            clicked on. One line of the app-chrome scale's leading, written as
            such, and inside the header block so an empty slot does not open a
            second gap above what follows.
          */}
          <div
            role="alert"
            title={openError ?? undefined}
            className="min-h-[1.125rem] truncate text-[11px] text-[var(--color-danger)]"
          >
            {openError}
          </div>
        </div>

        {/*
          Directly under the header and above everything else, which is where a
          status that changes on its own is allowed to appear: the controls are
          in the header above it, so a block arriving on a poll pushes prose
          down and never a button the user was reaching for (`ux_rules.md` §1).
          The action the block is about lives *inside* it, for the same reason.
        */}
        <Attention task={task} asks={asks} />

        <Section title="Goal">
          <Prose>{task.goal}</Prose>
        </Section>

        {task.description && (
          <Section title="Description">
            <Prose>{task.description}</Prose>
          </Section>
        )}

        {task.handoffNote && (
          <Section title="Handoff note">
            <Prose>{task.handoffNote}</Prose>
          </Section>
        )}

        {task.artifacts.length > 0 && (
          <Section title="Artifacts">
            <ul className="space-y-1 list-none m-0 p-0">
              {task.artifacts.map((artifact, i) => (
                <ArtifactRow key={`${artifact.ref}-${i}`} artifact={artifact} onOpen={openUrl} />
              ))}
            </ul>
          </Section>
        )}

        <Section title="Details">
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 m-0">
            <Detail label="Assignee" value={assignee} />
            <Detail label="Priority" value={capitalize(task.priority)} />
            {task.executor === 'remote' && (
              <Detail label="Running" value="in the connected service" />
            )}
            <Detail
              label="Created"
              value={formatRelativeFromDate(task.createdAt, now)}
              title={task.createdAt.toLocaleString()}
            />
            <Detail
              label="Started"
              value={task.startedAt ? formatRelativeFromDate(task.startedAt, now) : null}
              title={task.startedAt?.toLocaleString()}
            />
            <Detail
              label="Finished"
              value={task.finishedAt ? formatRelativeFromDate(task.finishedAt, now) : null}
              title={task.finishedAt?.toLocaleString()}
            />
            {task.subtaskCount > 0 && (
              <Detail
                label="Subtasks"
                value={`${task.subtaskCompletedCount} of ${task.subtaskCount} done`}
              />
            )}
          </dl>
        </Section>

        {/*
          Under everything, never over it: a poll can fail at any moment,
          including while the pointer is on the re-run button, and a line that
          appeared above it would move it (`ux_rules.md` §1). What is above is
          the last good read — this line says only that it may have stopped
          being current.
        */}
        {isStale && (
          <div className="flex items-center gap-2 pt-1 text-[11px] text-[var(--color-text-muted)]">
            <AlertTriangle size={12} className="text-[var(--color-warning)] shrink-0" />
            <span>Showing the last read — this task could not be refreshed.</span>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * The one block that is allowed to be a banner, because it only appears when
 * something needs attention (`ux_rules.md` §2/§4 — a healthy task shows nothing
 * here at all).
 *
 * Four states, and the difference between the first two is the whole reason
 * this page reads the inbox:
 *
 *  - **blocked, something waiting** — the answer is in the inbox, and the block
 *    points there rather than growing a second copy of the controls.
 *  - **blocked in a connected service** — the ask is over there, and so is the
 *    answer. This device has nothing to re-run and says so rather than offering
 *    a button that would send a message into a conversation it does not hold.
 *  - **blocked, nothing waiting, running here** — the ask died with the process
 *    that raised it. Nothing in the app will move this task; the re-run is the
 *    way out. This arm needs the inbox to have actually *answered*: an unread
 *    inbox and an empty one look the same, and offering a re-run on the first
 *    would send a second message into a turn that is parked and waiting.
 *  - **error** — what went wrong, in the words the run reported, over the same
 *    re-run the blocked arm offers: `error → in_progress` is the retry the
 *    transition table exists for, and a refused re-run now lands here.
 */
interface AskState {
  count: number
  /**
   * The inbox read **succeeded**. False while it has never been read, and false
   * for as long as the current read is failing — even when a previous one left
   * rows behind, which is the usual shape of a failure here.
   */
  known: boolean
  failed: boolean
  retry: () => void
}

/**
 * The only three statuses on which another device's claim is worth saying
 * anything about.
 *
 * Written as the set that *does* speak rather than the set that stays quiet,
 * because the rule is about what the page would otherwise do: on `blocked` and
 * `error` it would offer a control this device cannot use, and on `in_progress`
 * work is genuinely happening somewhere else. Everywhere else a peer's claim
 * changes nothing the user can see or act on — `new` and `open` offer nothing
 * to begin with, and the three terminal statuses are over — so a banner would
 * be noise (`ux_rules.md` §2).
 *
 * `new` and `open` are the ones worth naming: **every** task a peer created
 * carries that peer's `executor_device` from the moment it was created, so a
 * set defined by exclusion put a banner on every task the user had ever made on
 * their other machine.
 */
const CLAIM_MATTERS: readonly TaskStatus[] = ['in_progress', 'blocked', 'error']

function Attention({ task, asks }: { task: TaskDto; asks: AskState }): React.JSX.Element | null {
  const setActiveView = useUIStore((s) => s.setActiveView)

  /*
    First, before every arm below, and that order is the whole point: each of
    them offers something this device cannot do to a task another one holds.
    The re-run would be refused by `requireRunsHere` in main, and "Open the
    Inbox" would point at a list that cannot contain the ask — a `reply`
    address dies with the driver process holding it, so `task_input_requests`
    never syncs and the ask is only ever in the inbox of the device that raised
    it. Offering either would be a control that cannot work.
  */
  if (task.executor === 'desktop' && !task.runsHere && CLAIM_MATTERS.includes(task.status)) {
    return <ElsewhereBanner task={task} />
  }

  /*
    And a task a *service* is running, for the same reason in the same place:
    every arm below offers something this device cannot do to work it does not
    hold. The re-run has no chat to send into — a remote task never had one —
    but the Inbox can now contain its asks, read through the adapter. The
    remote banner keeps that action separate from taking over execution.
  */
  if (task.executor === 'remote' && CLAIM_MATTERS.includes(task.status)) {
    return <RemoteBanner task={task} asks={asks} />
  }

  if (task.status === 'blocked' && asks.count > 0) {
    return (
      <Banner tone="warning" icon={<AlertTriangle size={13} className="shrink-0" />}>
        {/*
          **The action is on the right, and the re-run's is on the left, and
          that is the whole reason they are laid out differently.**

          These two arms swap on a five-second poll — an ask expiring turns the
          first into the second with nobody touching anything — and they were
          laid out the same way, so *Open the Inbox* and *Re-run from the last
          message* shared 102 px at an identical y. A user reaching for the
          first at the moment it expired pressed the second, which sends a
          message (`ux_rules.md` §1). Two actions that can replace each other
          without a gesture must not occupy each other's pixels.
        */}
        <span className="flex-1">
          {asks.count === 1
            ? 'This task is waiting on an answer from you.'
            : `This task is waiting on ${asks.count} answers from you.`}
        </span>
        <button
          type="button"
          onClick={() => setActiveView('inbox')}
          className="shrink-0 px-2.5 py-1 rounded-md text-[11px] font-medium
            bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white transition-colors"
        >
          Open the Inbox
        </button>
      </Banner>
    )
  }

  // **`error` offers the re-run too**, and that is not a convenience. A turn
  // refused before any streaming service owned it now reports itself as an
  // ending (`run.ipc.ts`'s `reportRefusal`), so a re-run whose agent has gone
  // missing lands the task here rather than leaving it claimed for ever — and
  // `error → in_progress` is exactly the retry the transition table allows.
  // Without it, the one press that can fail would have no second press.
  if (task.status === 'error') {
    return (
      <RerunBanner
        task={task}
        tone="danger"
        reason={task.errorMessage ?? 'This task ended with an error.'}
      />
    )
  }

  if (task.status === 'blocked' && !asks.known) {
    return (
      <Banner tone="warning" icon={<AlertTriangle size={13} className="shrink-0" />}>
        <span className="flex-1">
          This task is blocked.
          {asks.failed ? ' What it is waiting on could not be read.' : ''}
        </span>
        {asks.failed && (
          <button
            type="button"
            onClick={asks.retry}
            className="shrink-0 text-[11px] font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] transition-colors"
          >
            Try again
          </button>
        )}
      </Banner>
    )
  }

  if (task.status === 'blocked') return <RerunBanner task={task} />

  return null
}

/**
 * The task is claimed by another of the user's devices.
 *
 * **Two shapes, and which one you get turns on whether a run is live over
 * there** — because that is what decides whether claiming it is safe.
 *
 * `in_progress` gets a sentence and **no control**, and that is the finding the
 * UX review turned up by pressing the button: taking over a live run does not
 * stop it. The other device keeps streaming, and when its turn ends
 * `reportRunCompletion` → `applyRunState` → `setStatus` hits `requireRunsHere`,
 * throws, and is swallowed by the best-effort catch step 3 put there — so the
 * task sits `in_progress` for ever. The other order is no better: app-sync is
 * whole-record last-writer-wins, so a run that finishes before the claim is
 * pulled writes its own row back and silently undoes the claim. A button whose
 * two possible outcomes are "stuck for ever" and "nothing happened" is not a
 * button. (§5.10 already refuses a mid-run take-over on the *remote* side for
 * the same reason; this is the device-to-device twin of that refusal.)
 *
 * `blocked` and `error` get the control, because nothing is streaming there —
 * the run that raised the ask, or failed, is over.
 *
 * **The button is on the right of its own row**, which is neither edge the two
 * arms it can be replaced by use. Measured by the UX review: left-aligned, it
 * overlapped *Re-run from the last message* by 5.66 px at an identical x, and
 * that button **sends a message**. The waiting arm's *Open the Inbox* already
 * owns the right of the **first** row. Different row from one, different edge
 * from the other, so a swap can only ever land on empty space — the rule
 * `RerunBanner`'s own comment states.
 */
function ElsewhereBanner({ task }: { task: TaskDto }): React.JSX.Element {
  const { takeOver, isPending } = useTakeOverTask()
  const [error, setError] = useState<string | null>(null)

  const live = task.status === 'in_progress'

  const onTakeOver = async (): Promise<void> => {
    setError(null)
    try {
      // Never forced. There is nothing to confirm: a device claim asks nothing
      // of a network, so "could not tell" is not one of its answers.
      await takeOver(task.id, false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'This task could not be taken over.')
    }
  }

  return (
    <Banner
      tone={live ? 'neutral' : task.status === 'error' ? 'danger' : 'warning'}
      icon={<Laptop size={13} className="shrink-0 mt-0.5" />}
    >
      <div className="flex-1 min-w-0 space-y-1.5">
        <div className="break-words">
          {live
            ? 'This task is running on another of your devices.'
            : 'This task stopped on another of your devices. Take it over to pick it up here.'}
        </div>
        {/*
          "Pick it up", not "carry on with it": the claim is one gesture and
          working on it is the next. Taking over a blocked task reveals the
          re-run; it does not press it (`ux_rules.md` §7 — say what the control
          does, not what the user wants).
        */}
        {!live && (
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => void onTakeOver()}
              disabled={isPending}
              title="Continue this task on this device"
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium
                bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white transition-colors
                disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {/* The spinner replaces the icon rather than the label: "Taking
                  over…" grew the button by 19 px under the pointer, measured. */}
              {isPending ? (
                <Loader2 size={11} className="animate-spin" />
              ) : (
                <Laptop size={11} />
              )}
              Take over
            </button>
          </div>
        )}
        {/*
          **Both of these are below the button, and the error message is the
          one that matters.** It arrives on a *poll* — the peer reports a
          failure and this arm changes shape under a pointer that is already
          over the control — so above the button it moved it by 7.83 px with no
          gesture at all (`ux_rules.md` §1, measured). The refusal below it is
          the ordinary §6 shape: beside the control that produced it, and the
          control stays.
        */}
        {!live && task.status === 'error' && task.errorMessage && (
          <div className="break-words text-[11px] text-[var(--color-text-secondary)]">
            {task.errorMessage}
          </div>
        )}
        {error && <div className="text-[11px] text-[var(--color-danger)]">{error}</div>}
      </div>
    </Banner>
  )
}

/**
 * The task is running in a service this desktop is bound to — §5.10's remote →
 * desktop direction, and the twin of {@link ElsewhereBanner} on the other side
 * of the seam.
 *
 * **The same three shapes, decided by the same question**, and it is asked
 * rather than inferred. Whether work is live over there is `liveSession` on the
 * adapter, one request, because the task's own status cannot answer it: cinna
 * recomputes status *from* its sessions, so a task can sit `in_progress` with
 * nothing live and can be live before the recompute lands. Inferring from
 * `status === 'in_progress'` is wrong in both directions — it hides a
 * take-over that was safe and offers one into a working agent.
 *
 *  - **live** — the sentence, and **no control**. Claiming does not stop the
 *    agent, so the two outcomes of the press are two runners on one task, or a
 *    claim the service's next status recompute silently undoes. Exactly
 *    decision 8's reasoning for another *device*, which is where that refusal
 *    was shaped first; §5.10 specified this one and step 10 built its twin.
 *  - **not live** — Take over.
 *  - **nobody can tell** — an unreachable service, or one this build has no
 *    adapter for. §5.10 asks for a confirmation here rather than a refusal,
 *    because refusing would strand the task on a service that cannot answer for
 *    it. **The confirmation is the sentence and the label, not a second
 *    press** — a deviation, and the reason is what the gesture actually does:
 *    taking over *claims* and does not run. Nothing starts here and nothing
 *    stops there, the flip is visible on this page the moment it lands, and the
 *    worst outcome of a mistaken press is a claim that can be given back. A
 *    modal in front of a reversible claim is a dialog about a risk the line
 *    above the button has already stated.
 *
 * **The sentence never changes after it appears.** It is chosen from `status`,
 * which the page already has, so the probe arriving late fills the control's
 * reserved box and rewrites nothing the user may already be reading
 * (`ux_rules.md` §1). The box is reserved for every shape including the live
 * one, because `liveSession` is the thing that arrives late and it is the thing
 * that decides whether there is a control at all.
 *
 * **The button is on the right of its own row**, the rule `ElsewhereBanner` and
 * `RerunBanner` both follow: these arms replace each other on a poll, and two
 * controls that can swap without a gesture must not share pixels.
 */
function RemoteBanner({ task, asks }: { task: TaskDto; asks: AskState }): React.JSX.Element {
  const setActiveView = useUIStore((s) => s.setActiveView)
  const { takeOver, isPending } = useTakeOverTask()
  const { data: live, isPending: livePending, refetch } = useRemoteLiveSession(task)
  const [error, setError] = useState<string | null>(null)

  /*
    **`live !== false` — every answer that is not a definite "no agent is
    working on it" is the cautious one.** Three values reach here as "cannot
    tell": the adapter's own `null`, the deadline's `null`, and `undefined` from
    a query that rejected. The last was read as *not live* — the least cautious
    of the three — which put the plain **Take over** label on it, sent
    `force: false`, and made main refuse with `remote_unknown`. The label never
    changed, so the next press produced the identical refusal for ever. Both
    reviews found this line from opposite ends; the UX one drove it and captured
    two byte-identical frames.

    **Written as two exclusions rather than as `!== false`**, which is how the
    first version of this fix was written and what it broke: `live !== false` is
    also true for `true`, so the *live* arm rendered the "could not say" line
    under a sentence saying an agent was working on it — two statements that
    contradict each other one line apart, and the second is the one that decides
    whether the control appears. Caught on a re-measure, not by the fix's own
    test, because the test asked what the button said and this changed a
    sentence beside it.
  */
  const unknown = !livePending && live !== false && live !== true
  const offered = !livePending && live !== true

  const onTakeOver = async (): Promise<void> => {
    setError(null)
    try {
      await takeOver(task.id, unknown)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'This task could not be taken over.')
      // **Ask again, because a refusal means this answer is out of date.** The
      // probe is cached for a minute, so a `false` that has gone stale gets the
      // same dead end with no error anywhere: main says "cannot tell", the
      // label stays *Take over*, and pressing it again refuses identically. A
      // re-read turns the next press into the one that works — or, if an agent
      // really did start, takes the control away, which is the honest outcome.
      void refetch()
    }
  }

  return (
    <Banner
      tone={task.status === 'error' ? 'danger' : task.status === 'blocked' ? 'warning' : 'neutral'}
      icon={<Server size={13} className="shrink-0 mt-0.5" />}
    >
      {/*
        **The whole block is reserved, not just the control's box.**

        Reserving the button's row was not enough, and the UX review measured
        exactly how much: the "could not say" line was inserted *above* it when
        the probe resolved, moving the control, the error line and the `Goal`
        heading below — 25.125 px, with no gesture, a second after the page
        opened (`ux_rules.md` §1). Anything that can arrive late has to land
        inside a box that was already the height of the tallest arm, which is
        what `InboxRow` does for the same reason: the held space reads as bottom
        padding rather than as a hole.

        **Reserved by line count, not by a pixel total**, and the difference is
        what the first version got wrong. A block-level `min-h` sized for
        "sentence + sub-line + control" is only enough for the arms whose own
        content does not already fill it — an `error` task always carries its
        `errorMessage` in the same block, so the late sub-line was pure growth
        and moved the Goal heading 24.25 px with no gesture. And a pixel total
        cannot hold at every width: one wrap and it is wrong again.

        So every arm renders the same three rows — sentence, liveness sub-line,
        control row — and the sub-line's slot is there whether or not it has
        anything in it. In flight and resolved then have identical line counts
        in every arm and at every width, which is the property that actually
        stops the page moving.

        The control row is sized from the **button** (26.375 px measured, so
        1.75 rem) rather than from a round 1.5 rem, which was 2.4 px short and
        moved the heading by 0.875 px when the control arrived.
      */}
      <div className="flex-1 min-w-0 space-y-1.5">
        <div className="break-words">
          {task.status === 'blocked'
            ? 'This task is waiting on something in the service that is running it.'
            : task.status === 'error'
              ? 'This task ended with an error in the service running it.'
              : live === false
                ? // **Not "Nothing is working on this task…", and not the
                  // longer sentence either.** The header's status pill still
                  // says IN PROGRESS, and a banner that only says nothing is
                  // working leaves the two unreconciled; "listed as running"
                  // is what ties them together. The first attempt at that was
                  // 89 characters, which at 800 px — the app's `minWidth` — is
                  // 535 px against a 410 px text column, so it wrapped to two
                  // lines and moved the page by a line height at exactly the
                  // width nobody looks at. This one is 54.
                  'Listed as running, but nothing is working on it there.'
                : 'This task is running in the service that holds it.'}
        </div>
        {/*
          **One line, always present, three possible contents.** It carries
          whatever the probe turned out to say — and carrying nothing is one of
          the three, which is why the slot is here rather than the line.

          It also stops the reserved space reading as a control that failed to
          render: the live arm is the one that will never grow a button, and
          before this it was a sentence over a dead strip. The peer twin has no
          such strip because its liveness is known synchronously and this one
          arrives over a network, so collapsing when the probe resolves would be
          the jump the reservation exists to prevent. Saying the thing the strip
          was failing to say costs nothing and answers the question the missing
          button raises.

          **The fourth content is the wait**, and it exists because reserving
          did not shrink the in-flight frame the way this comment first claimed
          it would: two rows are held, not one, so the wait was still a sentence
          over ~62 px of blank — measured at 2.65 px *taller* than the hole it
          replaced, and holdable for the full five seconds of the deadline. A
          line saying what is being waited for costs no layout, because the slot
          is already there, and turns a box that looks broken into one that is
          working.
        */}
        <div className="min-h-[1.0625rem] break-words text-[11px] text-[var(--color-text-secondary)]">
          {livePending
            ? 'Checking whether an agent is working on it…'
            : live === true
              ? 'An agent is working on it there now, so it cannot be taken over yet.'
              : unknown
                ? 'That service could not say whether anything is working on it right now.'
                : ''}
        </div>
        {/*
          The control's own row, inside the reserved block. `min-h` rather than
          a rendered placeholder: an empty row is what a live task keeps for
          good, and it should read as spacing rather than as something missing.
        */}
        <div className="flex justify-between gap-2 min-h-[1.75rem] items-center">
          <div>
            {task.status === 'blocked' && asks.count > 0 && (
              <button type="button" onClick={() => setActiveView('inbox')}
                className="px-2.5 py-1 rounded-md text-[11px] font-medium text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]">
                Open the Inbox
              </button>
            )}
          </div>
          {offered && (
            <button
              type="button"
              onClick={() => void onTakeOver()}
              disabled={isPending}
              title="Continue this task on this device"
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium
                bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white transition-colors
                disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {/* The spinner replaces the icon, never the label: a label that
                  changes width moves the button under the pointer. */}
              {isPending ? (
                <Loader2 size={11} className="animate-spin" />
              ) : (
                <Laptop size={11} />
              )}
              {unknown ? 'Take over anyway' : 'Take over'}
            </button>
          )}
        </div>
        {/*
          An `errorMessage` arrives on a poll, so it sits **below** the control,
          which is `ElsewhereBanner`'s rule: above the button it would move the
          button with no gesture at all. The liveness sub-line is above the
          control instead, because unlike this one it has a slot held for it.
        */}
        {task.status === 'error' && task.errorMessage && (
          <div className="break-words text-[11px] text-[var(--color-text-secondary)]">
            {task.errorMessage}
          </div>
        )}
        {error && <div className="text-[11px] text-[var(--color-danger)]">{error}</div>}
      </div>
    </Banner>
  )
}

/**
 * Blocked, and nothing is waiting — the ask expired with the process holding
 * it.
 *
 * The refusal lands **beside the button and keeps it** (`ux_rules.md` §6).
 * Every way this can be refused — the chat is gone, there is no message in it,
 * the task will not re-open — is a sentence the user reads and then does
 * something else about; none of them are improved by a control that disappears
 * under the click that produced them.
 */
function RerunBanner({
  task,
  /**
   * What to say above the button. A failed task says what went wrong in the
   * words the run reported — a run that failed without recording why still has
   * to say that it failed, because the pill alone is a colour.
   */
  reason,
  tone = 'warning'
}: {
  task: TaskDto
  reason?: string
  tone?: 'warning' | 'danger'
}): React.JSX.Element {
  const { rerun, isPending } = useRerunTask()
  const [error, setError] = useState<string | null>(null)

  const onRerun = async (): Promise<void> => {
    setError(null)
    try {
      await rerun(task)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'This task could not be re-run.')
    }
  }

  return (
    <Banner tone={tone} icon={<AlertTriangle size={13} className="shrink-0 mt-0.5" />}>
      <div className="flex-1 min-w-0 space-y-1.5">
        <div className="break-words">
          {reason ??
            'This task is blocked, but nothing is waiting for an answer — the request it stopped on expired when the process holding it ended.'}
        </div>
        {/*
          Below the sentence and below the button, never between them: this line
          arrives after a click, and anywhere above the control would move the
          control the user has just pressed (`ux_rules.md` §1).
        */}
        {/*
          **Below the sentence and left-aligned, not beside it on the right.**
          The waiting arm above puts its action on the right of its own
          sentence, and the two arms replace each other on a poll — so sharing
          that footprint would drop this button, which *sends a message*, under
          a pointer that was reaching for *Open the Inbox* (`ux_rules.md` §1).
          Different row, different edge: a swap can now only ever land on empty
          space.
        */}
        {/*
          **No conversation, no button** — a sentence instead. A disabled
          control whose only account of itself is a `title` tooltip tells a
          keyboard or touch user nothing at all, and a task whose chat was
          deleted with its run is not a task that is temporarily unable to
          re-run: it is one that never can.
        */}
        {task.chatId ? (
          <button
            type="button"
            onClick={() => void onRerun()}
            disabled={isPending}
            title="Send the last message in this conversation again"
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium
              bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white transition-colors
              disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {/* The spinner replaces the icon inside the button rather than
                adding a row — `ux_rules.md` §1's "async state is inline". */}
            {isPending ? <Loader2 size={11} className="animate-spin" /> : <RotateCcw size={11} />}
            Re-run from the last message
          </button>
        ) : (
          <div className="text-[11px] text-[var(--color-text-muted)]">
            The conversation it ran in is gone, so there is nothing left to send again.
          </div>
        )}
        {/*
          Under the control that produced it, never above (`ux_rules.md` §1/§6).
          A refusal grows the card downwards, which pushes the sections below —
          not the button the user just pressed.
        */}
        {error && <div className="text-[11px] text-[var(--color-danger)]">{error}</div>}
      </div>
    </Banner>
  )
}

function Banner({
  tone,
  icon,
  children
}: {
  /**
   * `neutral` is not a third colour for the sake of it. `ux_rules.md` §2 is
   * that a banner appears when something needs attention, and amber says
   * something is wrong — a task another of the user's devices is working on
   * perfectly well is neither. It is reporting, not warning.
   */
  tone: 'neutral' | 'warning' | 'danger'
  icon: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  const skin =
    tone === 'danger'
      ? 'text-[var(--color-danger)] bg-[var(--color-danger)]/10 border-[var(--color-danger)]/30'
      : tone === 'neutral'
        ? 'text-[var(--color-text-secondary)] bg-[var(--color-bg-secondary)] border-[var(--color-border)]'
        : 'text-[var(--color-text-secondary)] bg-[var(--color-warning)]/10 border-[var(--color-warning)]/30'
  return (
    <div
      role="status"
      className={`flex items-start gap-2 rounded-md border px-3 py-2 text-xs leading-relaxed ${skin}`}
    >
      {icon}
      {children}
    </div>
  )
}

/** `normal` is a column value; Normal is what the user reads. */
function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function Section({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section>
      <h2 className="text-xs font-semibold text-[var(--color-text-secondary)] mb-2">{title}</h2>
      {children}
    </section>
  )
}

function Prose({ children }: { children: string }): React.JSX.Element {
  return (
    <div className="text-xs text-[var(--color-text)] leading-relaxed markdown-body">
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={markdownComponents}
      >
        {children}
      </Markdown>
    </div>
  )
}

/**
 * One fact. A row with nothing to say is **not rendered** rather than rendered
 * with a dash: "Finished —" on a task that is still running is a sentence that
 * reads as an error where the absence of the row reads as what it is.
 */
function Detail({
  label,
  value,
  title
}: {
  label: string
  value: string | null | undefined
  title?: string
}): React.JSX.Element | null {
  if (!value) return null
  return (
    <>
      <dt className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)] pt-0.5">
        {label}
      </dt>
      <dd className="text-xs text-[var(--color-text-secondary)] m-0 min-w-0 truncate" title={title}>
        {value}
      </dd>
    </>
  )
}

/**
 * An artifact is a claim that something exists outside the transcript
 * (`ux_rules.md` §9), so the row says which kind of thing it is and shows the
 * reference it would open rather than implying a click this phase does not
 * wire up.
 */
function ArtifactRow({
  artifact,
  onOpen
}: {
  artifact: TaskArtifact
  onOpen: (url: string) => Promise<void>
}): React.JSX.Element {
  const Icon = artifact.kind === 'link' ? LinkIcon : FileText
  const open = artifact.kind === 'link'
  return (
    <li className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)] py-0.5 min-w-0">
      <Icon size={11} className="shrink-0 text-[var(--color-text-muted)]" />
      {open ? (
        <button
          type="button"
          onClick={() => void onOpen(artifact.ref)}
          className="min-w-0 truncate text-left font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] transition-colors"
          title={artifact.ref}
        >
          {artifact.name}
        </button>
      ) : (
        <span className="min-w-0 truncate" title={artifact.ref}>
          {artifact.name}
        </span>
      )}
    </li>
  )
}
