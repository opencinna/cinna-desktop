import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { JobCreateInputDto, JobPatchDto } from '../../../shared/jobs'
import { useUIStore } from '../stores/ui.store'
import { useChatStore } from '../stores/chat.store'
import { useChatStream } from './useChatStream'
import { useChatModes } from './useChatModes'
import { useProviders } from './useProviders'
import { useModels } from './useModels'
import { resolveModel } from './useNewChatFlow'

export function useJobList() {
  return useQuery({
    queryKey: ['jobs'],
    queryFn: () => window.api.jobs.list()
  })
}

export function useJob(jobId: string | null) {
  return useQuery({
    queryKey: ['jobs', jobId],
    queryFn: () => (jobId ? window.api.jobs.get(jobId) : null),
    enabled: !!jobId
  })
}

export function useJobRuns(jobId: string | null) {
  return useQuery({
    queryKey: ['jobs', jobId, 'runs'],
    queryFn: () => (jobId ? window.api.jobs.listRuns(jobId) : []),
    enabled: !!jobId
  })
}

export function useCreateJob() {
  const queryClient = useQueryClient()
  const setActiveJobId = useUIStore((s) => s.setActiveJobId)
  const setActiveView = useUIStore((s) => s.setActiveView)
  return useMutation({
    mutationFn: (input?: Partial<JobCreateInputDto>) =>
      window.api.jobs.create({
        type: input?.type ?? 'local',
        title: input?.title ?? 'New Job',
        description: input?.description ?? null,
        prompt: input?.prompt ?? 'Describe the task here…',
        agentId: input?.agentId ?? null,
        modeId: input?.modeId ?? null,
        cinnaAgentId: input?.cinnaAgentId ?? null,
        cinnaPriority: input?.cinnaPriority ?? null,
        colorPreset: input?.colorPreset ?? null,
        iconName: input?.iconName ?? null
      }),
    onSuccess: (job) => {
      queryClient.invalidateQueries({ queryKey: ['jobs'] })
      setActiveJobId(job.id)
      // New jobs land on the edit form; the user fills it in and clicks
      // "Save" to land on the read-only job-detail view.
      setActiveView('job-edit')
    }
  })
}

export function useUpdateJob() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ jobId, patch }: { jobId: string; patch: JobPatchDto }) =>
      window.api.jobs.update(jobId, patch),
    onSuccess: (_data, { jobId }) => {
      queryClient.invalidateQueries({ queryKey: ['jobs'] })
      queryClient.invalidateQueries({ queryKey: ['jobs', jobId] })
    }
  })
}

export function useDeleteJob() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (jobId: string) => window.api.jobs.delete(jobId),
    onSuccess: (_data, jobId) => {
      queryClient.invalidateQueries({ queryKey: ['jobs'] })
      // Read fresh store state at completion — the activeJobId at hook-call
      // time can be stale if the user navigated between firing the mutation
      // and the server roundtrip resolving.
      const ui = useUIStore.getState()
      if (ui.activeJobId === jobId) {
        ui.setActiveJobId(null)
        if (ui.activeView === 'job-detail' || ui.activeView === 'job-edit') {
          ui.setActiveView('chat')
        }
      }
    }
  })
}

/**
 * Permanently delete a single job run. For local runs the originating chat
 * is hard-deleted alongside the run (cascade), so after success:
 *   - the job's run list is invalidated (the row disappears)
 *   - the chat list + trash list are invalidated (the chat is gone everywhere)
 *   - if the deleted chat was the active one, reset activeChatId so the main
 *     area doesn't try to render a detail view for a vanished id
 */
export function useDeleteJobRun() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ runId }: { jobId: string; runId: string }) =>
      window.api.jobs.deleteRun(runId),
    onSuccess: (result, { jobId }) => {
      queryClient.invalidateQueries({ queryKey: ['jobs', jobId, 'runs'] })
      if (result.chatDeleted) {
        queryClient.invalidateQueries({ queryKey: ['chats'] })
        queryClient.invalidateQueries({ queryKey: ['trash'] })
        if (result.chatId) {
          queryClient.removeQueries({ queryKey: ['chat', result.chatId] })
          const chatStore = useChatStore.getState()
          if (chatStore.activeChatId === result.chatId) {
            chatStore.setActiveChatId(null)
          }
        }
      }
    }
  })
}

export function useSetJobMcps() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      jobId,
      mcpProviderIds
    }: {
      jobId: string
      mcpProviderIds: string[]
    }) => window.api.jobs.setMcpProviders(jobId, mcpProviderIds),
    onSuccess: (_data, { jobId }) => {
      queryClient.invalidateQueries({ queryKey: ['jobs', jobId] })
    }
  })
}

export interface ExecuteJobInput {
  jobId: string
  /**
   * When true (default), opens the spawned chat in the main area after the
   * run starts. The sidebar still stays on the Jobs tab — `activeJobId` is
   * preserved so the user is "in the job's chat". Pass `false` from the
   * sidebar "run now" button to fire-and-forget without leaving the jobs
   * list, so the user can kick off multiple jobs in a row.
   */
  navigate?: boolean
}

/**
 * Run a job. For local jobs: creates a seeded chat on the main side, resolves
 * provider/model the same way the new-chat flow does, then optionally
 * navigates into the chat and always fires the existing send pipeline.
 * Returns a `useMutation` result so consumers get loading/error state for
 * free. Multiple concurrent invocations are supported — TanStack Query
 * tracks each mutation independently; the per-job spinner in the sidebar
 * reads `JobData.inProgressRunsCount` (server-side count of non-terminal
 * runs) instead of the mutation's transient `isPending`.
 */
export function useExecuteJob() {
  const queryClient = useQueryClient()
  const setActiveChatId = useChatStore((s) => s.setActiveChatId)
  const setActiveView = useUIStore((s) => s.setActiveView)
  const { startLlm, startAgent } = useChatStream()
  const { data: chatModes } = useChatModes()
  const { data: providers } = useProviders()
  const { data: allModels } = useModels()

  return useMutation({
    mutationFn: (input: ExecuteJobInput) => window.api.jobs.execute(input.jobId),
    onSuccess: async (result, { jobId, navigate = true }) => {
      queryClient.invalidateQueries({ queryKey: ['jobs', jobId, 'runs'] })
      // Refresh the job list so `inProgressRunsCount` ticks up and the
      // sidebar spinner appears immediately on the row.
      queryClient.invalidateQueries({ queryKey: ['jobs'] })

      if (result.type === 'cinna_task') {
        // No local chat — the user stays on the Jobs tab and polls.
        return
      }

      const { chatId, prompt, agentId, modeId } = result

      // Resolve provider/model the way the new-chat screen does — the main
      // process couldn't fall back to provider.defaultModelId / first
      // provider model without duplicating that logic, so we patch it here.
      // When the job left modeId null ("Use default chat mode"), fall back to
      // the workspace's default chat mode like the new-chat screen does;
      // otherwise the spawned chat starts with no provider/model and the
      // stream layer rejects it with "Chat has no model/provider configured".
      if (!agentId) {
        const explicitMode = modeId
          ? (chatModes ?? []).find((m) => m.id === modeId) ?? null
          : null
        const defaultMode = (chatModes ?? []).find((m) => m.isDefault) ?? null
        const mode = explicitMode ?? defaultMode
        const providerId = mode?.providerId ?? null
        const resolvedModelId = resolveModel(mode, providerId, providers, allModels)
        if (providerId && resolvedModelId) {
          await window.api.chat.update(chatId, {
            providerId,
            modelId: resolvedModelId,
            // Bind the chat to the default mode if the job didn't pin one, so
            // the chat UI reflects the same mode the user is actually using.
            ...(mode && !modeId ? { modeId: mode.id } : {})
          })
        }
      }

      queryClient.invalidateQueries({ queryKey: ['chats'] })

      // Open the spawned chat but stay in the jobs context — the sidebar
      // stays on the Jobs tab with the originating job still highlighted
      // (activeJobId is intentionally preserved). Skipped when `navigate`
      // is false (sidebar "run now" flow), so the user can kick off
      // multiple jobs without losing their place.
      if (navigate) {
        setActiveChatId(chatId)
        setActiveView('chat')
      }

      // Always fire the stream — the run is meaningless otherwise, even
      // when we're not navigating to the chat. The chat-stream `done` hook
      // invalidates `['jobs']` so the spinner clears when the run finishes.
      if (agentId) {
        startAgent(agentId, chatId, prompt)
      } else {
        startLlm(chatId, prompt)
      }
    }
  })
}

/**
 * Helper for the "open chat from job run" link — exported here so the run
 * row component doesn't reach into the chat store directly.
 *
 * Stays inside the jobs context: the chat view renders in the main area but
 * the sidebar remains on the Jobs tab with the originating job still
 * highlighted, so the user can step back to the job detail with one click.
 * `activeJobId` is intentionally preserved.
 */
export function useOpenChatFromRun() {
  const setActiveChatId = useChatStore((s) => s.setActiveChatId)
  const setActiveView = useUIStore((s) => s.setActiveView)
  return (chatId: string): void => {
    setActiveChatId(chatId)
    setActiveView('chat')
  }
}
