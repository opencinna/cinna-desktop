import { useMemo } from 'react'
import { Play, Loader2, Pencil, Bot, Plug, Flag, AlertTriangle, ArrowRight } from 'lucide-react'
import { useUIStore } from '../../stores/ui.store'
import {
  useJob,
  useJobRuns,
  useExecuteJob,
  useJobDependencyStatus
} from '../../hooks/useJobs'
import { useCinnaRunPoll } from '../../hooks/useCinnaRunPoll'
import { useAgents } from '../../hooks/useAgents'
import { useChatModes } from '../../hooks/useChatModes'
import { useMcpProviders } from '../../hooks/useMcp'
import { useCinnaAgents } from '../../hooks/useCinna'
import { getPreset } from '../../constants/chatModeColors'
import { derivePattern } from '../../../../shared/commPattern'
import { CommPatternBadge } from '../chat/CommPatternBadge'
import { JobRunRow } from './JobRunRow'
import type { JobDetailData } from '../../../../shared/jobs'
import type { JobDependencyStatus as JobDependencyStatusDto } from '../../../../shared/sync'
import { isFolderAgentId } from '../../../../shared/localAgents'
import { unwrapIpcError } from '../../utils/ipcError'

const CINNA_DEFAULT_PRIORITY = 'normal'

/**
 * Read-only "view" screen for a job. Shows the prompt, non-default
 * configuration, Run/Edit actions, and run history. Editing happens on the
 * separate JobEditPage (activeView === 'job-edit').
 */
export function JobDetail(): React.JSX.Element {
  const activeJobId = useUIStore((s) => s.activeJobId)
  const setActiveView = useUIStore((s) => s.setActiveView)
  const { data: job, isLoading } = useJob(activeJobId)
  const { data: runs } = useJobRuns(activeJobId)
  const executeJob = useExecuteJob()
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
    above is careful about every word it says; this is the same sentence
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
    <div className="flex-1 overflow-y-auto pt-[var(--topbar-h)]">
      <div className="max-w-2xl mx-auto px-6 py-6 space-y-6">
        <header className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-base font-semibold text-[var(--color-text)] truncate">
                {job.title}
              </h1>
              <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide
                bg-[var(--color-bg-hover)] text-[var(--color-text-muted)]">
                {job.type === 'cinna_task' ? 'Cinna Task' : 'Local'}
              </span>
            </div>
            {job.description && (
              <p className="mt-1 text-xs text-[var(--color-text-muted)]">{job.description}</p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={handleEdit}
              className="inline-flex items-center justify-center p-1.5 rounded-md
                border border-[var(--color-border)] text-[var(--color-text-secondary)]
                hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] transition-colors"
              title="Edit job"
              aria-label="Edit job"
            >
              <Pencil size={12} />
            </button>
            {/*
              A disabled button swallows its own mouse events in Chromium, so
              the tooltip has to hang on a wrapper — otherwise the one control
              that needs to explain itself is the one that cannot.
            */}
            <span
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
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium
                  bg-[var(--color-success)] hover:brightness-110 text-white
                  disabled:opacity-30 disabled:cursor-not-allowed transition-all"
              >
                {running ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                Run
              </button>
            </span>
          </div>
        </header>

        {runError && (
          <div
            role="alert"
            className="text-xs text-[var(--color-danger)] bg-[var(--color-danger)]/10
              border border-[var(--color-danger)]/30 rounded-md px-3 py-2"
          >
            {runError}
          </div>
        )}

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
              a copy nicety; softening it says less without being truer. The
              dependency rows below already name the agent and mark it
              unavailable, which is the part that is always true.
            */}
            <p className="text-[11px] text-[var(--color-text-muted)] leading-relaxed">
              This job needs an agent that isn't available on this device, so it can't
              run here.
            </p>
          </section>
        )}

        <JobSummary job={job} />

        <JobDependencyStatus jobId={job.id} />

        <section>
          <h2 className="text-xs font-semibold text-[var(--color-text-secondary)] mb-2">
            Run history
          </h2>
          {!runs || runs.length === 0 ? (
            <div className="text-xs text-[var(--color-text-muted)] italic">No runs yet</div>
          ) : (
            <div className="space-y-1.5">
              {runs.map((run) => (
                <JobRunRow key={run.id} run={run} />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function JobSummary({ job }: { job: JobDetailData }): React.JSX.Element {
  const { data: agents } = useAgents()
  const { data: chatModes } = useChatModes()
  const { data: mcpProviders } = useMcpProviders()
  const { data: cinnaAgents } = useCinnaAgents()

  const agentNames = useMemo(
    () =>
      job.agentIds.map(
        (id) => (agents ?? []).find((a) => a.id === id)?.name ?? 'Unknown agent'
      ),
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

  const localPattern = derivePattern(job.agentIds, job.mcpProviderIds)

  const chips: React.ReactNode[] = []

  if (job.type === 'local') {
    agentNames.forEach((name, idx) => {
      chips.push(<AgentChip key={`agent-${idx}`} name={name} />)
    })
    /*
      `agentNames` comes from `job.agentIds` — the join rows — and the one
      dependency that failed to resolve is precisely the one with no join row.
      So on a blocked job this list is silently short, and with a single
      unresolved agent it is empty: the summary rendered no agent chip at all,
      directly under a panel saying the job needs an agent.

      This chip does not name the agent. Naming it would need the sync manifest
      plumbed into a component that has never seen it, and the dependency rows
      below already name it and mark it unavailable. What the chip is here to
      prevent is the *absence* — a summary that quietly reads as "this job uses
      no agents" is a wrong answer, not a missing one.
    */
    if (job.incompleteSetup) {
      chips.push(<MissingChip key="unavailable-agent" label="Agent unavailable" />)
    }
    if (mode) {
      chips.push(<ModeChip key="mode" name={mode.name} colorPreset={mode.colorPreset} />)
    }
    mcpNames.forEach((name, idx) => {
      chips.push(<McpChip key={`mcp-${idx}`} name={name} />)
    })
  } else {
    chips.push(
      cinnaAgentName ? (
        <AgentChip key="cinna-agent" name={cinnaAgentName} />
      ) : (
        <MissingChip key="cinna-agent" label="No Cinna agent" />
      )
    )
    if (job.cinnaPriority && job.cinnaPriority !== CINNA_DEFAULT_PRIORITY) {
      chips.push(<PriorityChip key="priority" priority={job.cinnaPriority} />)
    }
  }

  return (
    <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-4 py-3 space-y-3">
      <div>
        <div className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)] mb-1">
          Prompt
        </div>
        <div className="text-xs text-[var(--color-text)] whitespace-pre-wrap font-mono leading-relaxed">
          {job.prompt}
        </div>
      </div>

      {(chips.length > 0 || job.type === 'local') && (
        <div className="border-t border-[var(--color-border)] pt-3 flex flex-wrap items-center gap-1.5">
          {chips}
          {/*
            No badge on a blocked job. `derivePattern` reads the same join rows,
            so for a job whose only agent could not resolve it is called as
            `derivePattern([], [])` and returns `'AI'` — badging the job as a
            plain local-LLM chat with no agents. That is the identical wrong
            answer, from the identical function, on the identical empty array,
            that `executeLocal` now refuses to *record*; it was still being
            *displayed*. The honest pattern is unknowable here until the
            dependency resolves, so nothing is claimed.
          */}
          {job.type === 'local' && !job.incompleteSetup && (
            <div className="ml-auto">
              <CommPatternBadge pattern={localPattern} />
            </div>
          )}
        </div>
      )}
    </section>
  )
}

/** Compact chip — matches the chat composer's badge styling. */
function Chip({
  icon,
  label,
  tone = 'neutral',
  style,
  title
}: {
  icon: React.ReactNode
  label: string
  tone?: 'neutral' | 'accent' | 'danger'
  style?: React.CSSProperties
  title?: string
}): React.JSX.Element {
  const toneClass =
    tone === 'accent'
      ? 'text-[var(--color-accent)] border-[var(--color-accent)] bg-[var(--color-accent)]/10'
      : tone === 'danger'
        ? 'text-[var(--color-danger)] border-[var(--color-danger)]/50 bg-[var(--color-danger)]/10'
        : 'text-[var(--color-text-secondary)] border-[var(--color-border)] bg-[var(--color-bg)]'
  return (
    <div
      className={`flex items-center gap-1.5 pl-1.5 pr-2.5 py-1 rounded-lg border ${toneClass}`}
      style={style}
      title={title}
    >
      <span className="shrink-0">{icon}</span>
      <span className="text-[11px] font-medium whitespace-nowrap">{label}</span>
    </div>
  )
}

function AgentChip({ name }: { name: string }): React.JSX.Element {
  return <Chip icon={<Bot size={12} />} label={name} tone="accent" title={`Agent: ${name}`} />
}

function ModeChip({
  name,
  colorPreset
}: {
  name: string
  colorPreset: string | null
}): React.JSX.Element {
  const preset = getPreset(colorPreset ?? 'slate')
  return (
    <div
      className="flex items-center gap-1.5 pl-1.5 pr-2.5 py-1 rounded-lg border bg-[var(--color-bg)]"
      style={{ borderColor: preset.border, color: preset.border }}
      title={`Chat mode: ${name}`}
    >
      <span
        className="w-2.5 h-2.5 rounded-full shrink-0"
        style={{ backgroundColor: preset.border }}
      />
      <span className="text-[11px] font-medium whitespace-nowrap">{name}</span>
    </div>
  )
}

function McpChip({ name }: { name: string }): React.JSX.Element {
  return <Chip icon={<Plug size={12} />} label={name} title={`MCP: ${name}`} />
}

function PriorityChip({ priority }: { priority: string }): React.JSX.Element {
  const label = priority.charAt(0).toUpperCase() + priority.slice(1)
  return <Chip icon={<Flag size={12} />} label={label} title={`Priority: ${label}`} />
}

function MissingChip({ label }: { label: string }): React.JSX.Element {
  return <Chip icon={<Bot size={12} />} label={label} tone="danger" />
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
  const setSettingsMenu = useUIStore((s) => s.setSettingsMenu)

  const pending = useMemo(
    () => (deps ?? []).filter((d) => d.state !== 'resolved'),
    [deps]
  )
  const hasNeedsSetup = pending.some((d) => d.state === 'needs-setup')
  const hasUnavailable = pending.some((d) => d.state === 'unavailable')
  if (pending.length === 0) return null

  /**
   * Where "Set up" goes, decided by the dependency's **resolved local id**
   * rather than by its `kind`.
   *
   * `kind` is `'agent'` for three different sources that live on three
   * different settings pages. Settings → Agents renders only
   * `source === 'local' && protocol === 'a2a'`, which is exactly what the
   * auto-created shells from `resolveLocalAgent` are — so that route stays
   * right for them. A folder agent is `source: 'folder'`, appears there under
   * no circumstances, and belongs on Settings → Local Agents. Its row id is
   * `folder:<manifest id>`, which is the one thing here that can tell them
   * apart, and it is already on the DTO.
   */
  const openSetup = (dep: JobDependencyStatusDto): void => {
    setActiveView('settings')
    if (dep.kind === 'mcp') {
      setSettingsMenu('mcp')
      return
    }
    setSettingsMenu(isFolderAgentId(dep.localId ?? '') ? 'local-agents' : 'agents')
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
