import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Play,
  Loader2,
  Pencil,
  Bot,
  Plug,
  AlertTriangle,
  ArrowRight,
  MoreHorizontal,
  Trash2
} from 'lucide-react'
import { useUIStore } from '../../stores/ui.store'
import {
  useJob,
  useJobRuns,
  useExecuteJob,
  useDeleteJob,
  useJobDependencyStatus
} from '../../hooks/useJobs'
import { useCinnaRunPoll } from '../../hooks/useCinnaRunPoll'
import { useAgents } from '../../hooks/useAgents'
import { useChatModes } from '../../hooks/useChatModes'
import { useMcpProviders } from '../../hooks/useMcp'
import { useCinnaAgents } from '../../hooks/useCinna'
import { getPreset } from '../../constants/chatModeColors'
import { newChatRouter } from '../../../../shared/chatRouting'
import { RouterBadge } from '../chat/RouterBadge'
import { usePopover } from '../ui/usePopover'
import { MENU_ITEM, MENU_SURFACE } from '../agents/local/OpenInMenu'
import { JobRunRow } from './JobRunRow'
import { Detail, DETAIL_LINK, HEADER_BUTTON, Prose, Section } from '../tasks/DetailParts'
import { hasAgentPage, useOpenAgentPage } from '../../hooks/useOpenAgentPage'
import { DeleteJobConfirm } from './JobItem'
import { useTaskRowsInPlace } from '../tasks/useTaskRowsInPlace'
import type { JobDetailData, JobRunData } from '../../../../shared/jobs'
import type { JobDependencyStatus as JobDependencyStatusDto } from '../../../../shared/sync'
import { isFolderAgentId } from '../../../../shared/localAgents'
import { unwrapIpcError } from '../../utils/ipcError'

const CINNA_DEFAULT_PRIORITY = 'normal'


/**
 * Read-only "view" screen for a job. Built like the local agent page and the
 * task page: the title row with the actions level with it, a one-line error
 * slot, then the job's prompt and configuration, then the tasks its runs
 * produced. Editing happens on the separate JobEditPage
 * (activeView === 'job-edit').
 */
export function JobDetail(): React.JSX.Element {
  const activeJobId = useUIStore((s) => s.activeJobId)
  const setActiveView = useUIStore((s) => s.setActiveView)
  const { data: job, isLoading } = useJob(activeJobId)
  const { data: runs } = useJobRuns(activeJobId)
  const executeJob = useExecuteJob()
  /*
    Owned by the page, not the dialog. `useDeleteJob`'s own success handler
    leaves the page (it clears `activeJobId`), and a mutate-level callback would
    be dropped with a dialog that unmounted first.
  */
  const deleteJob = useDeleteJob()
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  useCinnaRunPoll(runs)

  if (!activeJobId) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-[var(--color-text-muted)]">
        Select a job to view.
      </div>
    )
  }

  if (isLoading || !job) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-[var(--color-text-muted)]">
        Loading…
      </div>
    )
  }

  const running = executeJob.isPending
  /*
    Unwrapped, not raw. The refusal is authored in `jobService.executeLocal` as
    a sentence for the user, but it reaches here through `ipcMain.handle`, which
    rewrites a rejection's message to `Error invoking remote method
    '<channel>': …`, and through `_wrap.ts`, which sets `outbound.name` — so the
    alert box was opening with `Error invoking remote method 'job:execute':
    JobError:` before it got to the part addressed to the reader. The panel
    below is careful about every word it says; this is the same sentence
    arriving with the plumbing still attached.
  */
  const runError = executeJob.error
    ? unwrapIpcError(executeJob.error, 'The run could not be started.')
    : null

  const handleRun = (): void => {
    if (running) return
    executeJob.mutate({ jobId: job.id, navigate: true })
  }

  const handleEdit = (): void => {
    setActiveView('job-edit')
  }

  return (
    <div data-job-scroll className="@container flex-1 overflow-y-auto pt-[var(--topbar-h)] [scrollbar-gutter:stable]">
      <div className="max-w-4xl mx-auto px-6 py-6 space-y-3">
        {/*
          The title and the actions share a top edge, as on the local agent
          page and the task page, so moving between them moves nothing. One
          line, with the whole title in the tooltip.
        */}
        <header className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            {/* The type is a row in Details, so the title stands alone (§7). */}
            <h1
              title={job.title}
              className="min-w-0 truncate text-xl font-semibold text-[var(--color-text)]"
            >
              {job.title}
            </h1>
            {job.description && (
              <p
                // Clamped to two lines; the rest is in the tooltip (§7).
                title={job.description}
                className="mt-0.5 line-clamp-2 text-xs text-[var(--color-text-secondary)]"
              >
                {job.description}
              </p>
            )}
          </div>
          {/* Run first, then Edit; the occasional ones in ⋯. */}
          <div className="flex shrink-0 items-center gap-1.5">
            {/*
              A disabled button swallows its own mouse events in Chromium, so
              the tooltip has to hang on a wrapper — otherwise the one control
              that needs to explain itself is the one that cannot.
            */}
            <span
              className="flex"
              title={
                job.incompleteSetup
                  ? "This job can't run on this device — incomplete setup"
                  : undefined
              }
            >
              <button
                type="button"
                onClick={handleRun}
                disabled={running || job.incompleteSetup}
                className={`${HEADER_BUTTON} border-[var(--color-success)] px-3
                  bg-[var(--color-success)] hover:brightness-110 text-white
                  disabled:opacity-30 disabled:cursor-not-allowed transition-all`}
              >
                {running ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                Run
              </button>
            </span>
            <button
              type="button"
              onClick={handleEdit}
              title="Edit this job"
              className={`ambient-button ${HEADER_BUTTON} border-[var(--color-border)] px-3
                text-[var(--color-text)] transition-colors hover:bg-[var(--color-bg-hover)]`}
            >
              <Pencil size={12} />
              Edit
            </button>
            <JobActionsMenu
              onDelete={() => {
                setDeleteError(null)
                setConfirmingDelete(true)
              }}
            />
          </div>
        </header>
        {/*
          Always rendered, exactly one line: a refused run must not push the
          page down under the pointer (§1). The full text is in `title`.
        */}
        <div
          role="alert"
          title={runError ?? undefined}
          className="h-4 truncate text-right text-[11px] leading-4 text-[var(--color-danger)]"
        >
          {runError}
        </div>

        {/*
          The task page's body: the work on the left, the facts about what the
          job runs with in a panel beside it — below it when the page is
          narrower than `@2xl`, where it comes straight after the work and
          before the history. Wide, it spans both rows of column 2; the
          history row is the `1fr` one, so a tall panel lengthens that row
          rather than opening a gap between the prompt and the history.
        */}
        <div className="grid gap-6 @2xl:grid-cols-[minmax(0,1fr)_13rem] @2xl:grid-rows-[auto_1fr]">
          <div className="min-w-0 space-y-6">
            {/*
              Above the per-dependency list, not inside it: that list is the amber
              "finish setup" surface, and its rows already name which dependency is
              unavailable. This panel answers the different question the user has
              when the Run button is greyed out — whether the job is broken (it is
              not) and what would fix it (something outside the app).
            */}
            {job.incompleteSetup && (
              <section
                role="alert"
                className="rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/5
                  px-4 py-3 space-y-1.5"
              >
                <div className="flex items-center gap-1.5 text-xs font-semibold text-[var(--color-danger)]">
                  <AlertTriangle size={13} />
                  Incomplete setup
                </div>
                {/*
                  Two sentences this panel deliberately does not contain.

                  It does not tell the user to copy the agent's folder here. Local
                  agents are not synced and the cross-machine matching semantics are
                  undesigned, so a hand-copy instruction would promise a workflow
                  that does not exist — it happens to work today, which is what
                  makes promising it dangerous.

                  And it no longer says "It will run on a device where that agent is
                  set up." That named a device the app cannot know exists. This
                  state is reachable by one user on one machine who has never
                  enabled sync: `rebuildJobManifest` runs unconditionally on every
                  local edit, so every job carries a manifest, and attaching a
                  folder agent then moving or deleting its directory blocks the job
                  right here. For that user the sentence was not merely unverifiable
                  — it was false, and it sent them looking for a second machine.
                  Making it conditional would need a sync-origin flag on the DTO for
                  a copy nicety. The dependency rows below already name the agent and
                  mark it unavailable, which is the part that is always true.

                  If you are here to put that sentence back with a hedge — "it may
                  run on a device where that agent is set up" — that does not fix
                  it. A hedge on a claim that is false for a whole class of users
                  who reach this panel by their own local action is still a claim
                  about a device that does not exist. The charge was never that we
                  lacked certainty and should soften; it is that the sentence
                  asserted something often untrue. Softening an untrue claim leaves
                  it untrue and makes it harder to notice.
                */}
                <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed">
                  This job needs an agent that isn't available on this device, so it can't
                  run here.
                </p>
              </section>
            )}

            <Section title="Prompt">
              <Prose>{job.prompt}</Prose>
            </Section>

            <JobDependencyStatus jobId={job.id} />

          </div>

          <JobDetailsPanel job={job} />

          {/* Keyed: the hook holds its row order for the life of the mount. */}
          <TasksHistory key={job.id} runs={runs ?? []} />
        </div>
      </div>

      {confirmingDelete && (
        <DeleteJobConfirm
          jobTitle={job.title}
          pending={deleteJob.isPending}
          error={deleteError}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => {
            setDeleteError(null)
            // `useDeleteJob`'s own onSuccess leaves this page; a failure keeps
            // the dialog open with the reason in it (§6).
            deleteJob.mutate(job.id, {
              onError: (err) => setDeleteError(unwrapIpcError(err, 'The job could not be deleted.'))
            })
          }}
        />
      )}
    </div>
  )
}

const HISTORY_PAGE = 10

/**
 * The tasks the job's runs produced, as the Inbox lists tasks: one line each,
 * no gap, the hover fill separating them — at the width of the work column,
 * not the page. Built from the runs, so a run from before tasks existed still
 * shows. Pages like the Inbox's Recent tasks, through the same hook: ten rows,
 * newest first — a run that starts while the page is open goes on top —
 * an in-place "Show more tasks" that keeps its place under the pointer, then
 * "All N shown" in its slot.
 */
function TasksHistory({ runs }: { runs: JobRunData[] }): React.JSX.Element {
  const { ordered, visible, expanded, showMore, sectionRef } = useTaskRowsInPlace(
    runs,
    HISTORY_PAGE,
    '[data-job-scroll]',
    // A run started from this page's Run button lands on top, not behind Show more.
    'prepend'
  )
  return (
    <div
      ref={sectionRef as React.RefObject<HTMLDivElement | null>}
      role="region"
      aria-label="Tasks history"
      className="min-w-0 @2xl:col-start-1 @2xl:row-start-2"
    >
      <Section title="Tasks history">
        {ordered.length === 0 ? (
          // Flush with the heading, as the Inbox's empty Recent tasks is.
          <p className="text-[13px] text-[var(--color-text-muted)]">No tasks yet</p>
        ) : (
          <div className="space-y-3">
            <ul className="list-none m-0 p-0">
              {ordered.slice(0, visible).map((run) => (
                <li key={run.id}>
                  <JobRunRow run={run} />
                </li>
              ))}
            </ul>
            {ordered.length > visible ? (
              <button
                type="button"
                onClick={showMore}
                className="px-2 text-[13px] font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] transition-colors"
              >
                Show more tasks
              </button>
            ) : expanded && (
              <p className="px-2 text-[13px] text-[var(--color-text-muted)]">All {ordered.length} shown</p>
            )}
          </div>
        )}
      </Section>
    </div>
  )
}

/**
 * The job page's ⋯ menu. One item today — Delete is occasional and
 * destructive, so it is not a header button beside Run (`ux_rules.md` §2).
 */
function JobActionsMenu({ onDelete }: { onDelete: () => void }): React.JSX.Element {
  const menu = usePopover<HTMLButtonElement>('below-right')
  return (
    <div className="flex">
      <button
        ref={menu.triggerRef}
        type="button"
        onClick={() => menu.setOpen(!menu.open)}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        aria-label="More actions"
        title="More actions"
        className={`${HEADER_BUTTON} border-[var(--color-border)] px-2
          text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]`}
      >
        <MoreHorizontal size={14} />
      </button>
      {menu.open &&
        menu.style &&
        createPortal(
          <div
            ref={menu.popoverRef}
            role="menu"
            aria-label="Job actions"
            style={menu.style}
            className={MENU_SURFACE}
          >
            <button
              type="button"
              role="menuitem"
              // `!`: in the built CSS the plain danger class loses to
              // MENU_ITEM's own text colour.
              className={`${MENU_ITEM} !text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10`}
              onClick={() => {
                menu.setOpen(false)
                onDelete()
              }}
            >
              <Trash2 size={12} />
              Delete job…
            </button>
          </div>,
          document.body
        )}
    </div>
  )
}

/**
 * What the job runs with, as the task page's Details panel: label left, value
 * right, one fact per row. A row with nothing to say is left out, except the
 * two absences that are themselves the fact — an agent that did not resolve on
 * this device, and a Cinna Task job with no Cinna agent.
 */
function JobDetailsPanel({ job }: { job: JobDetailData }): React.JSX.Element {
  const { data: agents } = useAgents()
  const { data: chatModes } = useChatModes()
  const { data: mcpProviders } = useMcpProviders()
  const { data: cinnaAgents } = useCinnaAgents()
  const openAgentPage = useOpenAgentPage()

  const jobAgents = useMemo(
    () =>
      job.agentIds.map((id) => {
        const agent = (agents ?? []).find((a) => a.id === id) ?? null
        return { id, agent, name: agent?.name ?? 'Unknown agent' }
      }),
    [agents, job.agentIds]
  )
  const mode = useMemo(
    () => (job.modeId ? (chatModes ?? []).find((m) => m.id === job.modeId) ?? null : null),
    [chatModes, job.modeId]
  )
  const mcpNames = useMemo(
    () =>
      job.mcpProviderIds
        .map((id) => (mcpProviders ?? []).find((p) => p.id === id)?.name)
        .filter((n): n is string => !!n),
    [mcpProviders, job.mcpProviderIds]
  )
  const cinnaAgentName = useMemo(
    () =>
      job.cinnaAgentId
        ? (cinnaAgents ?? []).find((a) => a.id === job.cinnaAgentId)?.name ?? null
        : null,
    [cinnaAgents, job.cinnaAgentId]
  )

  const isLocal = job.type === 'local'
  const localRouter = job.router === 'script' || job.router === 'coordinator' ? job.router
    : newChatRouter({ agentIds: job.agentIds, mcpIds: job.mcpProviderIds })
  /*
    A direct job talks to its one agent, and the badge names where that agent
    runs ("Local", "Remote") the way the new-chat composer does. With no agent
    there is nothing to name, and the composer shows no badge then either.
  */
  const directAgent = localRouter === 'direct' ? jobAgents[0]?.agent ?? null : null
  /*
    No badge on a blocked job either. `newChatRouter` reads the same join rows,
    so for a job whose only agent could not resolve it is called on two empty
    arrays and answers `'direct'` — badging the job as a plain local-LLM chat
    with no agents. That is the identical wrong answer, from the identical
    function, on the identical empty array, that `executeLocal` refuses to
    *record*. The honest router is unknowable here until the dependency
    resolves, so nothing is claimed.
  */
  const showBadge = isLocal && !job.incompleteSetup && (localRouter !== 'direct' || !!directAgent)
  /*
    `job.agentIds` holds the join rows — and the one dependency that failed to
    resolve is precisely the one with no join row. So on a blocked job the list
    is silently short, and with a single unresolved agent it is empty: without
    this entry the panel would read as "this job uses no agents" directly beside
    a panel saying it needs one. It does not name the agent; the dependency rows
    do that.
  */
  const showAgents = isLocal && (jobAgents.length > 0 || job.incompleteSetup)

  return (
    <aside
      aria-label="Details"
      // Takes its turn in the secondary buttons' border glow (useAmbientButtons).
      data-ambient-card
      className="ambient-button self-start rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-3
        @2xl:col-start-2 @2xl:row-start-1 @2xl:row-span-2"
    >
      <dl className="m-0 grid grid-cols-1 gap-x-6 gap-y-2 @md:grid-cols-2 @2xl:grid-cols-1">
        {/*
          Where the job runs, not where its agent lives: "Local" here sat
          beside Routing's "Local" and meant something else (§7).
        */}
        <Detail label="Type">{isLocal ? 'This device' : 'Cinna Task'}</Detail>
        {showAgents && (
          <Detail label={jobAgents.length + (job.incompleteSetup ? 1 : 0) > 1 ? 'Agents' : 'Agent'} wide>
            <ul className="m-0 w-full min-w-0 list-none space-y-1 p-0">
              {jobAgents.map(({ id, agent, name }) => (
                <li key={id} className="min-w-0">
                  {agent && hasAgentPage(agent) ? (
                    <button
                      type="button"
                      onClick={() => openAgentPage(agent)}
                      title={name}
                      className={`${DETAIL_LINK} ml-auto`}
                    >
                      {name}
                    </button>
                  ) : (
                    <span className="block truncate" title={name}>{name}</span>
                  )}
                </li>
              ))}
              {job.incompleteSetup && (
                <li className="text-[var(--color-text-muted)]">Agent unavailable</li>
              )}
            </ul>
          </Detail>
        )}
        {isLocal && mode && (
          <Detail label="Chat mode">
            <span className="inline-flex items-center gap-1.5" title={`Chat mode: ${mode.name}`}>
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: getPreset(mode.colorPreset ?? 'slate').border }}
              />
              {mode.name}
            </span>
          </Detail>
        )}
        {isLocal && mcpNames.length > 0 && <Detail label="Tools">{mcpNames.join(', ')}</Detail>}
        {showBadge && (
          <Detail label="Routing">
            <span className="inline-flex justify-end">
              <RouterBadge
                router={localRouter}
                connectionAgent={directAgent}
                agentName={directAgent?.name}
              />
            </span>
          </Detail>
        )}
        {!isLocal && (
          <Detail label="Cinna agent">
            {cinnaAgentName ?? <span className="text-[var(--color-text-muted)]">None</span>}
          </Detail>
        )}
        {!isLocal && (
          <Detail label="Priority">{capitalize(job.cinnaPriority ?? CINNA_DEFAULT_PRIORITY)}</Detail>
        )}
      </dl>
    </aside>
  )
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

/**
 * Surfaces a job's dependencies that didn't fully resolve here: `needs-setup`
 * (amber — an MCP/agent shell was auto-created but is disabled and missing
 * credentials) and `unavailable` (grey — can't resolve here, e.g. a remote
 * agent from a server this profile isn't on, or a folder agent whose workshop
 * is not on this machine). The seamless path renders nothing.
 *
 * **The chrome is chosen from what the list actually holds.** It used to be
 * fixed: "Finish setup on this device", above "These dependencies need
 * attention on this device before the job can run as configured." That is a
 * promise for `needs-setup` and a falsehood for `unavailable` — a state that by
 * definition cannot be finished here. `jobService.getDependencyStatus` spends
 * twelve lines of comment keeping those two apart, and a fixed heading
 * collapsed them again at the last step.
 *
 * It cannot be a flat swap either. `manifest.ts` builds one flat `deps` array
 * holding agent and MCP descriptors together, and `getDependencyStatus` assigns
 * state per-arm, so **one job can carry an `unavailable` folder agent and a
 * `needs-setup` MCP at the same time** — attach both, then move the workshop
 * directory. The mixed heading has to be true of both at once, which is why it
 * promises nothing and points at the rows, whose per-row labels already say
 * which is which.
 */
function JobDependencyStatus({ jobId }: { jobId: string }): React.JSX.Element | null {
  const { data: deps } = useJobDependencyStatus(jobId)
  const setActiveView = useUIStore((s) => s.setActiveView)
  const setAgentPageMode = useUIStore((s) => s.setAgentPageMode)
  const setActiveExternalAgentId = useUIStore((s) => s.setActiveExternalAgentId)
  const setSidebarTab = useUIStore((s) => s.setSidebarTab)
  const setSettingsMenu = useUIStore((s) => s.setSettingsMenu)

  const pending = useMemo(
    () => (deps ?? []).filter((d) => d.state !== 'resolved'),
    [deps]
  )
  const hasNeedsSetup = pending.some((d) => d.state === 'needs-setup')
  const hasUnavailable = pending.some((d) => d.state === 'unavailable')
  if (pending.length === 0) return null

  // Folder runtime setup remains in Settings; A2A connection controls now
  // live on the agent's page, reached through the Agents sidebar.
  const openSetup = (dep: JobDependencyStatusDto): void => {
    if (dep.kind === 'mcp') {
      setActiveView('settings')
      setSettingsMenu('mcp')
    } else if (isFolderAgentId(dep.localId ?? '')) {
      setActiveView('settings')
      setSettingsMenu('local-agents')
    } else {
      setAgentPageMode('settings')
      setActiveExternalAgentId(dep.localId)
      setSidebarTab('agents')
      setActiveView('external-agent')
    }
  }

  return (
    <section
      className="rounded-lg border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/5
        px-4 py-3 space-y-2"
    >
      <div className="flex items-center gap-1.5 text-xs font-semibold text-[var(--color-warning)]">
        <AlertTriangle size={13} />
        {hasNeedsSetup && hasUnavailable
          ? 'Dependencies need attention'
          : hasUnavailable
            ? 'Not available on this device'
            : 'Finish setup on this device'}
      </div>
      <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed">
        {hasNeedsSetup && hasUnavailable
          ? "Some of these can be set up on this device. Others didn't resolve here at all — each row says which."
          : hasUnavailable
            ? "These dependencies didn't resolve on this device, so the job can't run as configured here."
            : 'These dependencies need attention on this device before the job can run as configured.'}
      </p>
      <div className="space-y-1.5 pt-0.5">
        {pending.map((d) => {
          const amber = d.state === 'needs-setup'
          const icon =
            d.kind === 'mcp' ? <Plug size={12} /> : <Bot size={12} />
          return (
            <div
              key={d.key}
              className="flex items-center gap-2 text-[11px]"
            >
              <span
                className="w-1.5 h-1.5 rounded-full shrink-0"
                style={{
                  backgroundColor: amber
                    ? 'var(--color-warning)'
                    : 'var(--color-text-muted)'
                }}
              />
              <span className="shrink-0 text-[var(--color-text-secondary)]">{icon}</span>
              <span className="text-[var(--color-text)] truncate">{d.label}</span>
              <span className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
                {amber ? 'needs setup' : 'unavailable'}
              </span>
              {/*
                No local id, no button. Every settings page this could open
                shows a *row*, so with nothing resolved there is nothing for it
                to land on — which is the missing-folder-agent case, where the
                repair is copying a directory onto this machine and no page in
                the app can do it.
              */}
              {amber && d.kind !== 'mode' && d.localId !== null && (
                <button
                  type="button"
                  onClick={() => openSetup(d)}
                  className="ml-auto inline-flex items-center gap-1 px-1.5 py-0.5 rounded
                    text-[10px] font-medium text-[var(--color-accent)]
                    hover:bg-[var(--color-bg-hover)] transition-colors"
                >
                  Set up
                  <ArrowRight size={10} />
                </button>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
