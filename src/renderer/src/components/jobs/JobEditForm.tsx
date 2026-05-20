import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { Bot, Check, ChevronDown } from 'lucide-react'
import type { JobDetailData, JobPatchDto } from '../../../../shared/jobs'
import { useAgents } from '../../hooks/useAgents'
import { useChatModes } from '../../hooks/useChatModes'
import { useMcpProviders } from '../../hooks/useMcp'
import { useUpdateJob, useSetJobMcps } from '../../hooks/useJobs'
import { useCinnaAgents } from '../../hooks/useCinna'
import { AgentPickerModal, type AgentPickerItem } from '../agents/AgentPickerModal'

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

  // Type is set once at creation (via the JobsList type-picker) and is
  // read-only afterwards — render-time branching keys off `job.type` directly.
  const type = job.type
  const [title, setTitle] = useState(job.title)
  const [description, setDescription] = useState(job.description ?? '')
  const [prompt, setPrompt] = useState(job.prompt)
  const [agentId, setAgentId] = useState<string>(job.agentId ?? '')
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
    setAgentId(job.agentId ?? '')
    setModeId(job.modeId ?? '')
    setMcpIds(new Set(job.mcpProviderIds))
    setCinnaAgentId(job.cinnaAgentId ?? '')
    setCinnaPriority(asPriority(job.cinnaPriority))
  }, [job.id, job])

  // Snapshot of last-persisted values so we only PATCH what changed.
  const snapshotRef = useRef({
    title: job.title,
    description: job.description ?? '',
    prompt: job.prompt,
    agentId: job.agentId ?? '',
    modeId: job.modeId ?? '',
    cinnaAgentId: job.cinnaAgentId ?? '',
    cinnaPriority: asPriority(job.cinnaPriority)
  })

  useEffect(() => {
    snapshotRef.current = {
      title: job.title,
      description: job.description ?? '',
      prompt: job.prompt,
      agentId: job.agentId ?? '',
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
    if (agentId !== snap.agentId) patch.agentId = agentId || null
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
    agentId,
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
      agentId,
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

  const [agentPickerOpen, setAgentPickerOpen] = useState(false)
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

  const selectedAgent = enabledAgents.find((a) => a.id === agentId)
  const selectedCinnaAgent = (cinnaAgents ?? []).find((a) => a.id === cinnaAgentId)

  const toggleMcp = (id: string): void => {
    setMcpIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      setJobMcps.mutate({ jobId: job.id, mcpProviderIds: Array.from(next) })
      return next
    })
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
          {/* Agent */}
          <div>
            <label className="block text-[10px] text-[var(--color-text-muted)] mb-0.5">
              Agent <span className="text-[var(--color-text-muted)]">(optional)</span>
            </label>
            <button
              type="button"
              onClick={() => setAgentPickerOpen(true)}
              className={`${inputClass} cursor-pointer flex items-center gap-2 text-left`}
            >
              <Bot
                size={13}
                className={
                  selectedAgent ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)]'
                }
              />
              <span
                className={`flex-1 truncate ${
                  selectedAgent ? 'text-[var(--color-text)]' : 'text-[var(--color-text-muted)]'
                }`}
              >
                {selectedAgent ? selectedAgent.name : 'No agent (send to LLM)'}
              </span>
              <ChevronDown size={13} className="text-[var(--color-text-muted)] shrink-0" />
            </button>
            <AgentPickerModal
              open={agentPickerOpen}
              title="Select Agent"
              items={localAgentItems}
              selectedId={agentId || null}
              onSelect={(id) => setAgentId(id ?? '')}
              onClose={() => setAgentPickerOpen(false)}
              allowNone
              noneLabel="No agent"
              noneDescription="Send the prompt straight to the LLM."
              searchPlaceholder="Search agents…"
            />
          </div>

          {/* Chat mode */}
          <div>
            <label className="block text-[10px] text-[var(--color-text-muted)] mb-0.5">
              Chat Mode <span className="text-[var(--color-text-muted)]">(optional)</span>
            </label>
            <select
              value={modeId}
              onChange={(e) => setModeId(e.target.value)}
              className={`${inputClass} cursor-pointer`}
            >
              <option value="">Use default chat mode</option>
              {(chatModes ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>

          {/* MCPs */}
          {(mcpProviders ?? []).length > 0 && (
            <div>
              <label className="block text-[10px] text-[var(--color-text-muted)] mb-1">
                MCP Providers
              </label>
              <div className="space-y-1">
                {(mcpProviders ?? []).map((mcp) => (
                  <button
                    key={mcp.id}
                    type="button"
                    onClick={() => toggleMcp(mcp.id)}
                    className="w-full text-left px-2.5 py-1.5 rounded-md text-xs
                      hover:bg-[var(--color-bg-hover)] transition-colors flex items-center gap-2"
                  >
                    <div
                      className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 ${
                        mcpIds.has(mcp.id)
                          ? 'bg-[var(--color-accent)] border-[var(--color-accent)]'
                          : 'border-[var(--color-border)]'
                      }`}
                    >
                      {mcpIds.has(mcp.id) && <Check size={9} className="text-white" />}
                    </div>
                    <span className="text-[var(--color-text)]">{mcp.name}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
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
    </div>
  )
})
