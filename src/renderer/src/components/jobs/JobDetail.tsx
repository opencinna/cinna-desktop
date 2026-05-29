import { useMemo } from 'react'
import { Play, Loader2, Pencil, Bot, Plug, Flag } from 'lucide-react'
import { useUIStore } from '../../stores/ui.store'
import { useJob, useJobRuns, useExecuteJob } from '../../hooks/useJobs'
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
  const runError = executeJob.error
    ? executeJob.error instanceof Error
      ? executeJob.error.message
      : String(executeJob.error)
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
            <button
              type="button"
              onClick={handleRun}
              disabled={running}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium
                bg-[var(--color-success)] hover:brightness-110 text-white
                disabled:opacity-30 disabled:cursor-not-allowed transition-all"
            >
              {running ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
              Run
            </button>
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

        <JobSummary job={job} />

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
          {job.type === 'local' && (
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
