import { AlertTriangle, Loader2, Play } from 'lucide-react'
import { useOpenTask } from '../../../hooks/useTasks'
import {
  DISPATCH_MAX_RUNS_CHOICES,
  DISPATCH_MODE_LABELS,
  dispatchModeLabel,
  dispatchPausedParts,
  dispatchStatusParts,
  useAgentDispatch,
  useDispatchControls
} from '../../../hooks/useTaskDispatch'
import { unwrapIpcError } from '../../../utils/ipcError'
import {
  TASK_DISPATCH_MAX_RUNS,
  TASK_DISPATCH_MODES,
  type AgentDispatchState,
  type TaskDispatchMode
} from '../../../../../shared/taskDispatch'
import {
  SettingsButton,
  SettingsCard,
  SettingsInfoTip,
  SettingsLabel,
  SettingsSection,
  settingsDropdownRowClass,
  settingsInputClass
} from '../../settings/SettingsLayout'

/** A task named in a status line: a link to its page, in the accent colour (§11). */
const TASK_LINK =
  'min-w-0 truncate font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] transition-colors'

/**
 * The Run mode select's choices: Manual, One at a time, then Up to N spelled
 * out for every N ("Up to 2" … "Up to 8"), so the mode and its N are one pick.
 */
const RUN_MODE_CHOICES: readonly { value: string; label: string }[] = TASK_DISPATCH_MODES.flatMap((mode) =>
  mode === 'up_to'
    ? DISPATCH_MAX_RUNS_CHOICES.map((n) => ({ value: `up_to:${n}`, label: dispatchModeLabel('up_to', n) }))
    : [{ value: mode, label: DISPATCH_MODE_LABELS[mode] }]
)

function runModeValue(mode: TaskDispatchMode, maxRuns: number): string {
  return mode === 'up_to' ? `up_to:${maxRuns}` : mode
}

function parseRunModeValue(value: string): { mode: TaskDispatchMode; maxRuns?: number } | null {
  if (value === 'manual' || value === 'one') return { mode: value }
  const n = /^up_to:(\d+)$/.exec(value)
  return n && DISPATCH_MAX_RUNS_CHOICES.includes(Number(n[1])) ? { mode: 'up_to', maxRuns: Number(n[1]) } : null
}

/**
 * The Tasks tab's badge: a queue that paused needs the user, and the tab is
 * hidden content, so it is announced by a badge rather than a banner
 * (`ux_rules.md` §2). Shares the tab's query, so it costs no extra IPC.
 */
export function useTasksTabBadge(agentId: string | null): { paused: boolean } {
  const { data } = useAgentDispatch(agentId)
  return { paused: !!data?.paused }
}

/**
 * A folder agent's task queue: how it runs (Manual / One at a time), Run next
 * beside the section title, one status line that is true in every state, and
 * — only while the queue is paused — the line that says why, with Resume.
 *
 * Built like the tabs beside it (Schedules, Credentials): one titled
 * `SettingsSection`, the explanation behind the (?), the 14/13/12 scale
 * (`ux_rules.md` §12). The actions are owned here, not by the controls, so a
 * result is never lost with a control that re-rendered away.
 */
export function AgentTasksTab({ agent }: { agent: { id: string; name: string } }): React.JSX.Element {
  const query = useAgentDispatch(agent.id)
  const controls = useDispatchControls(agent.id)
  const state = query.data
  const runPending = controls.pending === 'run'

  return (
    <SettingsSection
      title="Task queue"
      info={
        <SettingsInfoTip label="About the task queue">
          Cinna works this agent’s Ready tasks, highest priority first, then oldest. A task
          blocked by another starts only once that one is done. Run next starts the next one now, in any mode.
        </SettingsInfoTip>
      }
      action={
        <SettingsButton
          onClick={() => void controls.runNext()}
          disabled={!state}
          aria-busy={runPending}
          aria-disabled={runPending}
          title={`Start ${agent.name}’s next Ready task now`}
        >
          {runPending ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Play size={13} aria-hidden="true" />}
          Run next
        </SettingsButton>
      }
    >
      <SettingsCard>
        {query.isPending ? (
          <p className="text-[13px] text-[var(--color-text-muted)]">Loading…</p>
        ) : query.isError && !state ? (
          <p role="alert" className="text-[13px] text-[var(--color-danger)]">
            {unwrapIpcError(query.error, 'The task queue could not be read.')}
          </p>
        ) : !state ? (
          <p className="text-[13px] text-[var(--color-text-muted)]">
            This agent is disabled, so it has no task queue. Enable it to run its tasks.
          </p>
        ) : (
          <QueueBody agentId={agent.id} state={state} controls={controls} />
        )}
      </SettingsCard>
    </SettingsSection>
  )
}

function QueueBody({
  agentId,
  state,
  controls
}: {
  agentId: string
  state: AgentDispatchState
  controls: ReturnType<typeof useDispatchControls>
}): React.JSX.Element {
  const openTask = useOpenTask()
  const selectId = `task-queue-mode-${agentId}`
  const mode = controls.pendingMode ?? state.mode
  const maxRuns = controls.pendingMaxRuns ?? state.maxRuns ?? TASK_DISPATCH_MAX_RUNS.default
  const status = dispatchStatusParts(state)
  const paused = state.paused ? dispatchPausedParts(state.paused) : null

  return (
    <>
      <div className={settingsDropdownRowClass}>
        <SettingsLabel
          htmlFor={selectId}
          info={
            <>
              <p>Manual — nothing starts on its own; Run next starts the next Ready task.</p>
              <p className="mt-1.5">
                One at a time — Cinna starts the next Ready task whenever the agent and its folder are free. Only
                while Cinna is open.
              </p>
              <p className="mt-1.5">
                Up to N — Cinna keeps up to N of this agent’s tasks running at once, in the same folder, without
                waiting for it to be free. Only for an agent whose tasks do not get in each other’s way.
              </p>
            </>
          }
          infoLabel="About Run mode"
        >
          Run mode
        </SettingsLabel>
        {/* One select for mode and N together: "Up to 3" is a choice of its own,
            so nothing appears beside the select when it is picked (§1). */}
        <select
          id={selectId}
          className={settingsInputClass}
          value={runModeValue(mode, maxRuns)}
          disabled={controls.pending === 'mode'}
          onChange={(event) => {
            const next = parseRunModeValue(event.target.value)
            if (!next) return
            void (next.mode === 'up_to' ? controls.setMode('up_to', next.maxRuns) : controls.setMode(next.mode))
          }}
        >
          {RUN_MODE_CHOICES.map((choice) => (
            <option key={choice.value} value={choice.value}>{choice.label}</option>
          ))}
        </select>
      </div>
      {/* One line, filled in every state (§1, §12). */}
      <p data-queue-status className="mt-3 flex min-h-[1lh] min-w-0 items-baseline text-[13px] text-[var(--color-text-muted)]">
        <span className="shrink-0 whitespace-pre">{status.text}</span>
        {status.task && (
          <button type="button" className={TASK_LINK} title={status.task.title} onClick={() => openTask(status.task!.id)}>
            {status.task.title}
          </button>
        )}
        {status.tail && <span className="shrink-0 whitespace-pre">{status.tail}</span>}
      </p>
      {paused && (
        <div data-queue-paused className="mt-3 flex items-center gap-2.5">
          <AlertTriangle size={15} className="shrink-0 text-[var(--color-warning)]" aria-hidden="true" />
          <p className="flex min-w-0 flex-1 items-baseline text-[13px] text-[var(--color-text)]">
            <span className="shrink-0 whitespace-pre">{paused.lead}</span>
            {paused.taskId ? (
              <button type="button" className={TASK_LINK} title={paused.title} onClick={() => openTask(paused.taskId!)}>
                {paused.title}
              </button>
            ) : (
              <span className="min-w-0 truncate">{paused.title}</span>
            )}
            <span className="shrink-0 whitespace-pre">{paused.tail}</span>
          </p>
          <SettingsButton
            onClick={() => void controls.resume()}
            aria-busy={controls.pending === 'resume'}
            aria-disabled={controls.pending === 'resume'}
            title="Let the queue start tasks on its own again. The flagged task stays where it is."
          >
            {controls.pending === 'resume' && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
            Resume
          </SettingsButton>
        </div>
      )}
      {/* Last in the card, only when there is one: it moves nothing above it (§1, §6). */}
      {controls.error && (
        <p role="alert" className="mt-2 text-[13px] text-[var(--color-danger)]">{controls.error.message}</p>
      )}
    </>
  )
}
