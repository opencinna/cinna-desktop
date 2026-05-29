import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { Bot, ChevronDown, Plug, Plus, X } from 'lucide-react'
import type { JobDetailData, JobPatchDto } from '../../../../shared/jobs'
import { derivePattern } from '../../../../shared/commPattern'
import { useAgents } from '../../hooks/useAgents'
import { useChatModes } from '../../hooks/useChatModes'
import { useMcpProviders } from '../../hooks/useMcp'
import { useUpdateJob, useSetJobMcps, useSetJobAgents } from '../../hooks/useJobs'
import { useCinnaAgents } from '../../hooks/useCinna'
import { AgentPickerModal, type AgentPickerItem } from '../agents/AgentPickerModal'
import { CommPatternBadge } from '../chat/CommPatternBadge'
import { presetForAgentId } from '../../utils/agentColors'
import { getPreset, type ColorPreset } from '../../constants/chatModeColors'

interface JobEditFormProps {
  job: JobDetailData
}

export type JobEditFormFlushResult =
  | { ok: true }
  | { ok: false; error: string }

export interface JobEditFormHandle {
  /**
   * Apply any pending local changes synchronously (bypassing the debounce) and
   * resolve once the server roundtrip completes. Used by the "Save" button in
   * `JobEditPage` so navigation only happens after the patch is persisted.
   */
  flush: () => Promise<JobEditFormFlushResult>
}

const DEBOUNCE_MS = 600

const inputClass =
  'w-full bg-[var(--color-bg)] text-[var(--color-text)] px-2.5 py-1.5 rounded-md text-xs border border-[var(--color-border)] focus:border-[var(--color-accent)] focus:outline-none'

const CINNA_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const
type CinnaPriority = (typeof CINNA_PRIORITIES)[number]

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

  // Type is set once at creation (via the JobsList type-picker) and is
  // read-only afterwards — render-time branching keys off `job.type` directly.
  const type = job.type
  const [title, setTitle] = useState(job.title)
  const [description, setDescription] = useState(job.description ?? '')
  const [prompt, setPrompt] = useState(job.prompt)
  const [agentIds, setAgentIds] = useState<Set<string>>(new Set(job.agentIds))
  const [modeId, setModeId] = useState<string>(job.modeId ?? '')
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
    setModeId(job.modeId ?? '')
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
    modeId: job.modeId ?? '',
    cinnaAgentId: job.cinnaAgentId ?? '',
    cinnaPriority: asPriority(job.cinnaPriority)
  })

  useEffect(() => {
    snapshotRef.current = {
      title: job.title,
      description: job.description ?? '',
      prompt: job.prompt,
      modeId: job.modeId ?? '',
      cinnaAgentId: job.cinnaAgentId ?? '',
      cinnaPriority: asPriority(job.cinnaPriority)
    }
  }, [job])

  const buildPatch = (): JobPatchDto => {
    const snap = snapshotRef.current
    const patch: JobPatchDto = {}
    if (title !== snap.title) patch.title = title
    if (description !== snap.description) patch.description = description || null
    if (prompt !== snap.prompt) patch.prompt = prompt
    if (modeId !== snap.modeId) patch.modeId = modeId || null
    if (cinnaAgentId !== snap.cinnaAgentId) patch.cinnaAgentId = cinnaAgentId || null
    if (cinnaPriority !== snap.cinnaPriority) patch.cinnaPriority = cinnaPriority
    return patch
  }

  useEffect(() => {
    const patch = buildPatch()
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
      flush: async () => {
        if (!title.trim()) return { ok: false, error: 'Title is required' }
        if (!prompt.trim()) return { ok: false, error: 'Prompt is required' }
        const patch = buildPatch()
        if (Object.keys(patch).length === 0) return { ok: true }
        try {
          await updateJob.mutateAsync({ jobId: job.id, patch })
          return { ok: true }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return { ok: false, error: msg }
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
      updateJob
    ]
  )

  const enabledAgents = useMemo(
    () => (agents ?? []).filter((a) => a.enabled),
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

  // Routing preview: one agent + no MCPs runs direct A2A; anything else is
  // orchestrated by the chat-mode model — same rule the new-chat composer uses.
  const pattern = useMemo(
    () => derivePattern(Array.from(agentIds), Array.from(mcpIds)),
    [agentIds, mcpIds]
  )

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
                const color = presetForAgentId(id)
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
              {pattern === 'A2A'
                ? 'One agent, no connectors — the run talks directly to the agent.'
                : 'The chat-mode model orchestrates the selected agents and connectors as it runs.'}
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
      {type === 'local' && (
        <div className="flex justify-end pt-1">
          <CommPatternBadge pattern={pattern} />
        </div>
      )}
    </div>
  )
})

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
  onClick
}: {
  label: string
  color: ColorPreset | null
  selected: boolean
  onClick: () => void
}): React.JSX.Element {
  const base =
    'flex items-center gap-1.5 pl-1.5 pr-2.5 py-1 rounded-lg border text-[11px] font-medium transition-colors'
  if (selected) {
    return (
      <button
        type="button"
        onClick={onClick}
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
