import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Bot, ChevronDown, Plug, Plus, X } from 'lucide-react'
import type { JobDetailData, JobPatchDto } from '../../../../shared/jobs'
import { newChatRouter } from '../../../../shared/chatRouting'
import { useAgents } from '../../hooks/useAgents'
import { useChatModes } from '../../hooks/useChatModes'
import { useMcpProviders } from '../../hooks/useMcp'
import { useUpdateJob, useSetJobMcps, useSetJobAgents } from '../../hooks/useJobs'
import { useCinnaAgents } from '../../hooks/useCinna'
import { AgentPickerModal, type AgentPickerItem } from '../agents/AgentPickerModal'
import { RouterBadge } from '../chat/RouterBadge'
import { useAgentColor } from '../../utils/agentColors'
import { getPreset, type ColorPreset } from '../../constants/chatModeColors'
import { unwrapIpcError } from '../../utils/ipcError'
import { ASSISTANT_JOB_MODE, ASSISTANT_JOB_MODE_LABEL } from '../../../../shared/jobMode'

interface JobEditFormProps {
  job: JobDetailData
}

export type JobEditFormFlushResult =
  | { ok: true }
  | { ok: false; error: string }
  /** The user cancelled a confirm the save needed; nothing was saved, nothing to show. */
  | { ok: false; cancelled: true }

export interface JobEditFormHandle {
  /**
   * Apply any pending local changes synchronously (bypassing the debounce) and
   * resolve once the server roundtrip completes. Used by the "Save" button in
   * `JobEditPage` so navigation only happens after the patch is persisted.
   *
   * A held change away from the Assistant opens a confirm first and resolves
   * when the user answers it; `onConfirmOpen` fires as it opens, so the caller
   * can drop its own busy state while the question waits for the user.
   */
  flush: (options?: { onConfirmOpen?: () => void }) => Promise<JobEditFormFlushResult>
}

const DEBOUNCE_MS = 600

const inputClass =
  'w-full bg-[var(--color-bg)] text-[var(--color-text)] px-2.5 py-1.5 rounded-md text-xs border border-[var(--color-border)] focus:border-[var(--color-accent)] focus:outline-none'

const CINNA_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const
type CinnaPriority = (typeof CINNA_PRIORITIES)[number]

/**
 * The form's mode value: a chat mode id, '' for Default, or — for a job mobile
 * runs as the Assistant, whose stored `modeId` is null — the marker, so the
 * Assistant pill starts selected rather than Default. Choosing Default or a
 * mode is then a change, sent even though Default equals the stored null.
 */
function formModeId(job: Pick<JobDetailData, 'modeId' | 'runsOnMobile'>): string {
  return job.runsOnMobile ? ASSISTANT_JOB_MODE : (job.modeId ?? '')
}

function asPriority(value: string | null): CinnaPriority {
  if (value && (CINNA_PRIORITIES as readonly string[]).includes(value)) {
    return value as CinnaPriority
  }
  return 'normal'
}

export const JobEditForm = forwardRef<JobEditFormHandle, JobEditFormProps>(function JobEditForm(
  { job },
  ref
): React.JSX.Element {
  const { data: agents } = useAgents()
  const { data: chatModes } = useChatModes()
  const { data: mcpProviders } = useMcpProviders()
  const { data: cinnaAgents } = useCinnaAgents()
  const updateJob = useUpdateJob()
  const setJobMcps = useSetJobMcps()
  const setJobAgents = useSetJobAgents()
  const colorOf = useAgentColor()

  // Type is set once at creation (via the JobsList type-picker) and is
  // read-only afterwards — render-time branching keys off `job.type` directly.
  const type = job.type
  const [title, setTitle] = useState(job.title)
  const [description, setDescription] = useState(job.description ?? '')
  const [prompt, setPrompt] = useState(job.prompt)
  const [agentIds, setAgentIds] = useState<Set<string>>(new Set(job.agentIds))
  const [modeId, setModeId] = useState<string>(formModeId(job))
  const [mcpIds, setMcpIds] = useState<Set<string>>(new Set(job.mcpProviderIds))
  const [cinnaAgentId, setCinnaAgentId] = useState<string>(job.cinnaAgentId ?? '')
  const [cinnaPriority, setCinnaPriority] = useState<CinnaPriority>(asPriority(job.cinnaPriority))

  // Reset local state when switching jobs
  const lastJobIdRef = useRef(job.id)
  useEffect(() => {
    if (lastJobIdRef.current === job.id) return
    lastJobIdRef.current = job.id
    setTitle(job.title)
    setDescription(job.description ?? '')
    setPrompt(job.prompt)
    setAgentIds(new Set(job.agentIds))
    setModeId(formModeId(job))
    setMcpIds(new Set(job.mcpProviderIds))
    setCinnaAgentId(job.cinnaAgentId ?? '')
    setCinnaPriority(asPriority(job.cinnaPriority))
  }, [job.id, job])

  // Snapshot of last-persisted values so we only PATCH what changed. Agents
  // and MCPs are not here — they persist immediately on toggle via their own
  // mutations (setJobAgents / setJobMcps), like the chat composer's chips.
  const snapshotRef = useRef({
    title: job.title,
    description: job.description ?? '',
    prompt: job.prompt,
    modeId: formModeId(job),
    cinnaAgentId: job.cinnaAgentId ?? '',
    cinnaPriority: asPriority(job.cinnaPriority)
  })

  useEffect(() => {
    snapshotRef.current = {
      title: job.title,
      description: job.description ?? '',
      prompt: job.prompt,
      modeId: formModeId(job),
      cinnaAgentId: job.cinnaAgentId ?? '',
      cinnaPriority: asPriority(job.cinnaPriority)
    }
  }, [job])

  // Leaving the Assistant waits for a confirm on Save (`flush`), so the
  // debounced auto-save holds the mode back meanwhile.
  const [confirmingMode, setConfirmingMode] = useState(false)
  const [confirmPending, setConfirmPending] = useState(false)
  const [confirmError, setConfirmError] = useState<string | null>(null)
  const confirmResolveRef = useRef<((result: JobEditFormFlushResult) => void) | null>(null)
  const leavesAssistant = (patch: JobPatchDto): boolean =>
    job.runsOnMobile && patch.modeId !== undefined

  const buildPatch = (): JobPatchDto => {
    const snap = snapshotRef.current
    const patch: JobPatchDto = {}
    if (title !== snap.title) patch.title = title
    if (description !== snap.description) patch.description = description || null
    if (prompt !== snap.prompt) patch.prompt = prompt
    // The marker is never written back: it is not a mode id.
    if (modeId !== snap.modeId && modeId !== ASSISTANT_JOB_MODE) patch.modeId = modeId || null
    if (cinnaAgentId !== snap.cinnaAgentId) patch.cinnaAgentId = cinnaAgentId || null
    if (cinnaPriority !== snap.cinnaPriority) patch.cinnaPriority = cinnaPriority
    return patch
  }

  useEffect(() => {
    const patch = buildPatch()
    if (leavesAssistant(patch)) delete patch.modeId
    if (Object.keys(patch).length === 0) return

    const handle = setTimeout(() => {
      if (!title.trim() || !prompt.trim()) return
      updateJob.mutate({ jobId: job.id, patch })
    }, DEBOUNCE_MS)
    return () => clearTimeout(handle)
  }, [
    title,
    description,
    prompt,
    modeId,
    cinnaAgentId,
    cinnaPriority,
    job.id
  ])

  useImperativeHandle(
    ref,
    () => ({
      flush: async (options) => {
        if (!title.trim()) return { ok: false, error: 'Title is required' }
        if (!prompt.trim()) return { ok: false, error: 'Prompt is required' }
        const patch = buildPatch()
        if (Object.keys(patch).length === 0) return { ok: true }
        if (leavesAssistant(patch)) {
          // Settled by the confirm's own buttons (`confirmMode` / `cancelMode`).
          setConfirmError(null)
          setConfirmingMode(true)
          options?.onConfirmOpen?.()
          return new Promise<JobEditFormFlushResult>((resolve) => {
            confirmResolveRef.current = resolve
          })
        }
        try {
          await updateJob.mutateAsync({ jobId: job.id, patch })
          return { ok: true }
        } catch (err) {
          // Unwrapped at the catch, rendered one level up: `JobEditPage`
          // does `setError(result.error)`. `job:update` throws, so without
          // this a failed save shows the user the channel name first.
          return { ok: false, error: unwrapIpcError(err, 'Could not save the job.') }
        }
      }
    }),
    [
      title,
      description,
      prompt,
      modeId,
      cinnaAgentId,
      cinnaPriority,
      job.id,
      job.runsOnMobile,
      updateJob
    ]
  )

  const confirmMode = async (): Promise<void> => {
    setConfirmPending(true)
    setConfirmError(null)
    try {
      await updateJob.mutateAsync({ jobId: job.id, patch: buildPatch() })
      setConfirmingMode(false)
      confirmResolveRef.current?.({ ok: true })
      confirmResolveRef.current = null
    } catch (err) {
      // The confirm stays open with the reason in it (ux_rules §6).
      setConfirmError(unwrapIpcError(err, 'Could not save the job.'))
    } finally {
      setConfirmPending(false)
    }
  }

  // Left by other navigation (the sidebar) with the confirm open: the held
  // pick is discarded, and whoever awaits `flush` hears so.
  useEffect(
    () => () => {
      confirmResolveRef.current?.({ ok: false, cancelled: true })
      confirmResolveRef.current = null
    },
    []
  )

  const cancelMode = (): void => {
    setConfirmingMode(false)
    confirmResolveRef.current?.({ ok: false, cancelled: true })
    confirmResolveRef.current = null
  }

  const enabledAgents = useMemo(
    // `enabled` and nothing else: it is the user's own toggle for this agent.
    // The folder-agent exclusion that used to sit beside it was a capability
    // gap — no local runner — and it is gone with the runner that closed it.
    // An agent in an Agent Vault runs no jobs (main refuses it too).
    () => (agents ?? []).filter((a) => a.enabled && !a.conductor && a.source !== 'vault'),
    [agents]
  )

  const [pickerOpen, setPickerOpen] = useState(false)
  const [cinnaAgentPickerOpen, setCinnaAgentPickerOpen] = useState(false)

  const localAgentItems = useMemo<AgentPickerItem[]>(() => {
    const sectionOrder: Record<string, { label: string; rank: number }> = {
      agent: { label: 'My Agents', rank: 0 },
      app_mcp_route: { label: 'Shared with Me', rank: 1 },
      identity: { label: 'People', rank: 2 },
      local: { label: 'Local', rank: 3 }
    }
    const withGroup = enabledAgents.map((a) => {
      const key = a.source === 'remote' ? (a.remoteTargetType ?? 'agent') : 'local'
      const group = sectionOrder[key] ?? { label: 'Other', rank: 99 }
      return {
        item: {
          id: a.id,
          name: a.name,
          description: a.description,
          meta: a.protocol ? a.protocol.toUpperCase() : null,
          group: group.label
        } as AgentPickerItem,
        rank: group.rank
      }
    })
    withGroup.sort((a, b) => a.rank - b.rank)
    return withGroup.map((g) => g.item)
  }, [enabledAgents])

  const cinnaAgentItems = useMemo<AgentPickerItem[]>(
    () =>
      (cinnaAgents ?? []).map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description,
        meta: 'Cinna',
        group: null
      })),
    [cinnaAgents]
  )

  // MCP providers as picker cards in their own "Connectors" section, unioned
  // with the agent cards in the single Agents & Connectors modal.
  const mcpItems = useMemo<AgentPickerItem[]>(
    () =>
      (mcpProviders ?? []).map((m) => ({
        id: m.id,
        name: m.name,
        description: null,
        meta: 'MCP',
        group: 'Connectors',
        iconKind: 'connector' as const
      })),
    [mcpProviders]
  )
  const capabilityItems = useMemo(
    () => [...localAgentItems, ...mcpItems],
    [localAgentItems, mcpItems]
  )
  // Membership set the modal reads to draw checkmarks across both kinds. Agent
  // and MCP ids share no namespace, so a single set is unambiguous.
  const selectedCapabilityIds = useMemo(
    () => new Set<string>([...agentIds, ...mcpIds]),
    [agentIds, mcpIds]
  )
  const mcpIdSet = useMemo(
    () => new Set((mcpProviders ?? []).map((m) => m.id)),
    [mcpProviders]
  )

  // Routing preview — the same call the new-chat composer and `executeLocal`
  // make: one agent alone answers directly, several agents are a chat the user
  // routes, and agents mixed with MCP servers need the model to coordinate.
  const router = useMemo(
    () => newChatRouter({ agentIds: Array.from(agentIds), mcpIds: Array.from(mcpIds) }),
    [agentIds, mcpIds]
  )
  const directAgent = router === 'direct'
    ? (agents ?? []).find((a) => agentIds.has(a.id)) ?? null
    : null

  const selectedCinnaAgent = (cinnaAgents ?? []).find((a) => a.id === cinnaAgentId)

  const persistAgents = (next: Set<string>): void => {
    setAgentIds(next)
    setJobAgents.mutate({ jobId: job.id, agentIds: Array.from(next) })
  }
  const toggleAgent = (id: string): void => {
    const next = new Set(agentIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    persistAgents(next)
  }
  const removeAgent = (id: string): void => {
    const next = new Set(agentIds)
    next.delete(id)
    persistAgents(next)
  }

  const toggleMcp = (id: string): void => {
    setMcpIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      setJobMcps.mutate({ jobId: job.id, mcpProviderIds: Array.from(next) })
      return next
    })
  }

  // The modal toggles by id; route to the right setter by id namespace.
  const toggleCapability = (id: string): void => {
    if (mcpIdSet.has(id)) toggleMcp(id)
    else toggleAgent(id)
  }

  return (
    <div className="space-y-3">
      {/* Title */}
      <div>
        <label className="block text-[10px] text-[var(--color-text-muted)] mb-0.5">Title</label>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className={inputClass}
          placeholder="What does this job do?"
        />
      </div>

      {/* Description */}
      <div>
        <label className="block text-[10px] text-[var(--color-text-muted)] mb-0.5">
          Description <span className="text-[var(--color-text-muted)]">(optional)</span>
        </label>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className={inputClass}
          placeholder="Short summary shown next to the job title"
        />
      </div>

      {/* Prompt */}
      <div>
        <label className="block text-[10px] text-[var(--color-text-muted)] mb-0.5">Prompt</label>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={6}
          className={`${inputClass} font-mono`}
          placeholder="The message that will be sent at the start of each run"
        />
      </div>

      {type === 'local' ? (
        <>
          {/* Agents & Connectors + routing preview */}
          <div>
            <label className="block text-[10px] text-[var(--color-text-muted)] mb-1">
              Agents &amp; Connectors{' '}
              <span className="text-[var(--color-text-muted)]">(optional)</span>
            </label>
            <div className="flex flex-wrap items-center gap-1.5">
              {Array.from(agentIds).map((id) => {
                const name = (agents ?? []).find((a) => a.id === id)?.name ?? 'Unknown agent'
                const color = colorOf(id)
                return (
                  <div
                    key={id}
                    className="flex items-center gap-1 pl-1.5 pr-1 py-1 rounded-lg border"
                    style={{ color: color.border, borderColor: color.border, backgroundColor: color.bg }}
                  >
                    <Bot size={12} className="shrink-0" />
                    <span className="text-[11px] font-medium whitespace-nowrap">{name}</span>
                    <button
                      type="button"
                      onClick={() => removeAgent(id)}
                      className="ml-0.5 p-0.5 rounded hover:bg-black/10 [[data-theme=light]_&]:hover:bg-black/5 transition-colors"
                      aria-label={`Remove agent ${name}`}
                    >
                      <X size={11} />
                    </button>
                  </div>
                )
              })}
              {Array.from(mcpIds).map((id) => {
                const name = (mcpProviders ?? []).find((m) => m.id === id)?.name ?? 'Unknown connector'
                return (
                  <div
                    key={id}
                    className="flex items-center gap-1 pl-1.5 pr-1 py-1 rounded-lg border
                      border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text-secondary)]"
                  >
                    <Plug size={12} className="shrink-0" />
                    <span className="text-[11px] font-medium whitespace-nowrap">{name}</span>
                    <button
                      type="button"
                      onClick={() => toggleMcp(id)}
                      className="ml-0.5 p-0.5 rounded hover:bg-[var(--color-bg-hover)] transition-colors"
                      aria-label={`Remove connector ${name}`}
                    >
                      <X size={11} />
                    </button>
                  </div>
                )
              })}
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-dashed
                  border-[var(--color-border)] text-[11px] text-[var(--color-text-muted)]
                  hover:text-[var(--color-text)] hover:border-[var(--color-accent)]/50 transition-colors"
              >
                <Plus size={12} /> Add
              </button>
            </div>
            <p className="mt-1 text-[10px] text-[var(--color-text-muted)]">
              {agentIds.size === 0
                ? 'No agent — the run is a chat with the chat-mode model, which calls any connectors you attach.'
                : router === 'direct'
                  ? 'One agent, no connectors — the run talks directly to the agent.'
                  : router === 'human'
                    ? 'Several agents, no connectors — the run addresses the first one, and the chat lets you route the rest.'
                    : 'The chat-mode model coordinates the selected agents and connectors as it runs.'}
            </p>
            <AgentPickerModal
              open={pickerOpen}
              title="Agents & Connectors"
              multiSelect
              items={capabilityItems}
              selectedIds={selectedCapabilityIds}
              onToggle={toggleCapability}
              onClose={() => setPickerOpen(false)}
              searchPlaceholder="Search agents and connectors…"
              emptyLabel="Nothing to add"
            />
          </div>

          {/* Chat mode (color pills) */}
          <div>
            <label className="block text-[10px] text-[var(--color-text-muted)] mb-1">
              Chat Mode <span className="text-[var(--color-text-muted)]">(optional)</span>
            </label>
            <div className="flex flex-wrap gap-1.5">
              {/*
                Shown for as long as the job is an Assistant job, so leaving it
                moves no pill. Until Save confirms, it can be picked again.
              */}
              {job.runsOnMobile && (
                <ModePill
                  label={ASSISTANT_JOB_MODE_LABEL}
                  color={null}
                  selected={modeId === ASSISTANT_JOB_MODE}
                  title="Set on mobile. Picking another mode makes this a desktop job."
                  // Re-picking it before Save drops the held change.
                  onClick={() => setModeId(ASSISTANT_JOB_MODE)}
                />
              )}
              <ModePill
                label="Default"
                color={null}
                selected={modeId === ''}
                onClick={() => setModeId('')}
              />
              {(chatModes ?? []).map((m) => (
                <ModePill
                  key={m.id}
                  label={m.name}
                  color={getPreset(m.colorPreset ?? 'slate')}
                  selected={modeId === m.id}
                  onClick={() => setModeId(m.id)}
                />
              ))}
            </div>
          </div>
        </>
      ) : (
        <>
          {/* Cinna agent */}
          <div>
            <label className="block text-[10px] text-[var(--color-text-muted)] mb-0.5">
              Cinna Agent
            </label>
            <button
              type="button"
              onClick={() => setCinnaAgentPickerOpen(true)}
              className={`${inputClass} cursor-pointer flex items-center gap-2 text-left`}
            >
              <Bot
                size={13}
                className={
                  selectedCinnaAgent
                    ? 'text-[var(--color-accent)]'
                    : 'text-[var(--color-text-muted)]'
                }
              />
              <span
                className={`flex-1 truncate ${
                  selectedCinnaAgent
                    ? 'text-[var(--color-text)]'
                    : 'text-[var(--color-text-muted)]'
                }`}
              >
                {selectedCinnaAgent ? selectedCinnaAgent.name : 'Select an agent…'}
              </span>
              <ChevronDown size={13} className="text-[var(--color-text-muted)] shrink-0" />
            </button>
            <AgentPickerModal
              open={cinnaAgentPickerOpen}
              title="Select Cinna Agent"
              items={cinnaAgentItems}
              selectedId={cinnaAgentId || null}
              onSelect={(id) => setCinnaAgentId(id ?? '')}
              onClose={() => setCinnaAgentPickerOpen(false)}
              searchPlaceholder="Search Cinna agents…"
              emptyLabel="No Cinna agents available"
            />
          </div>

          {/* Priority */}
          <div>
            <label className="block text-[10px] text-[var(--color-text-muted)] mb-0.5">
              Priority
            </label>
            <select
              value={cinnaPriority}
              onChange={(e) => setCinnaPriority(asPriority(e.target.value))}
              className={`${inputClass} cursor-pointer`}
            >
              {CINNA_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p.charAt(0).toUpperCase() + p.slice(1)}
                </option>
              ))}
            </select>
          </div>
        </>
      )}

      {/* Routing badge pinned to the form's bottom-right corner. Default
          tooltip placement (opens upward) keeps it clear of the form edge. */}
      {/* Named for where a direct job's one agent runs, as the new-chat
          composer does — and not shown for a direct job with no agent. */}
      {type === 'local' && (router !== 'direct' || directAgent) && (
        <div className="flex justify-end pt-1">
          <RouterBadge router={router} connectionAgent={directAgent} agentName={directAgent?.name} />
        </div>
      )}

      {confirmingMode && (
        <LeaveAssistantConfirm
          jobTitle={title.trim() || job.title}
          pending={confirmPending}
          error={confirmError}
          onCancel={cancelMode}
          onConfirm={() => void confirmMode()}
        />
      )}
    </div>
  )
})

/**
 * Saving a mode choice on a job mobile runs as the Assistant turns it into a
 * desktop job, and mobile stops running it as the Assistant — the desktop
 * cannot set the marker back. Built like `DeleteJobConfirm`: anchored at a
 * fixed top, undismissable while the save runs, and a failure keeps it open
 * with the reason last (ux_rules §5, §6).
 */
function LeaveAssistantConfirm({
  jobTitle,
  pending,
  error,
  onCancel,
  onConfirm
}: {
  jobTitle: string
  pending: boolean
  error: string | null
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  const modalRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const pendingRef = useRef(pending)
  pendingRef.current = pending
  useEffect(() => cancelRef.current?.focus(), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !pendingRef.current) onCancel()
    }
    const onClick = (e: MouseEvent): void => {
      if (pendingRef.current) return
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) onCancel()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onClick)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onClick)
    }
  }, [onCancel])

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/25 pt-[20vh]">
      <div
        ref={modalRef}
        role="dialog"
        aria-label="Make this a desktop job"
        className="app-popover-surface w-96 rounded-lg border border-[var(--color-border)] shadow-xl p-5 space-y-4"
      >
        <div className="flex items-center gap-2 text-sm font-medium text-[var(--color-danger)]">
          <AlertTriangle size={16} />
          Make this a desktop job
        </div>
        <p className="text-xs text-[var(--color-text-secondary)] leading-relaxed">
          <strong className="text-[var(--color-text)]">{jobTitle}</strong> keeps its prompt and
          history and becomes a normal desktop job. Mobile will no longer run it as the
          Assistant, and it can't be switched back from the desktop.
        </p>
        <div className="flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="px-3 py-1.5 rounded-md text-xs font-medium border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-[var(--color-danger)] hover:brightness-110 text-white transition-colors disabled:opacity-50"
          >
            {pending ? 'Saving…' : 'Make desktop job'}
          </button>
        </div>
        {error && (
          <div role="alert" className="text-[11px] leading-relaxed text-[var(--color-danger)]">
            {error}
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}

/**
 * Chat-mode selector pill. Selected pills adopt the mode's color preset
 * (border + tinted bg + dot); the "Default" pill (no preset) uses the accent.
 * Unselected pills are muted but keep a color dot so the mode's scheme reads
 * at a glance.
 */
function ModePill({
  label,
  color,
  selected,
  onClick,
  title
}: {
  label: string
  color: ColorPreset | null
  selected: boolean
  onClick: () => void
  title?: string
}): React.JSX.Element {
  const base =
    'flex items-center gap-1.5 pl-1.5 pr-2.5 py-1 rounded-lg border text-[11px] font-medium transition-colors'
  if (selected) {
    return (
      <button
        type="button"
        onClick={onClick}
        title={title}
        className={`${base} ${
          color ? '' : 'border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-accent)]'
        }`}
        style={color ? { borderColor: color.border, backgroundColor: color.bg, color: color.border } : undefined}
      >
        <span
          className="w-2.5 h-2.5 rounded-full shrink-0"
          style={{ backgroundColor: color ? color.border : 'var(--color-accent)' }}
        />
        {label}
      </button>
    )
  }
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`${base} border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:border-[var(--color-accent)]/40`}
    >
      <span
        className="w-2.5 h-2.5 rounded-full shrink-0"
        style={{ backgroundColor: color ? color.border : 'var(--color-text-muted)' }}
      />
      {label}
    </button>
  )
}
