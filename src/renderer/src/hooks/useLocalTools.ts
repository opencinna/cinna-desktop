import { useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  DetectedTool,
  LocalToolId,
  LocalToolKind,
  OpenInRequest
} from '../../../shared/localTools'
import { useAppSettings, useSetAppSetting } from './useAppSettings'
import { launchableTools, resolveDefaultTool } from '../utils/localAgents'

export const LOCAL_TOOLS_KEY = ['local-tools'] as const

/**
 * The developer tools detected on this machine. Detection is cached in the
 * main process for the app's lifetime, so this query is cheap after the first
 * call — `staleTime: Infinity` keeps the renderer from re-asking on every mount
 * of the agent page. {@link useRefreshLocalTools} is the only invalidation.
 */
export function useLocalTools() {
  return useQuery({
    queryKey: LOCAL_TOOLS_KEY,
    queryFn: () => window.api.localTools.list(),
    staleTime: Infinity
  })
}

/** Only the installed tools of a given kind — what the Open-in row renders. */
export function useAvailableTools(kind: LocalToolKind): DetectedTool[] {
  const { data } = useLocalTools()
  return (data ?? []).filter((tool) => tool.available && tool.kind === kind)
}

/** Settings → Local Agents "Refresh" — re-detects after the user installs something. */
export function useRefreshLocalTools() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => window.api.localTools.refresh(),
    onSuccess: (tools) => {
      queryClient.setQueryData<DetectedTool[]>(LOCAL_TOOLS_KEY, tools)
    }
  })
}

/**
 * Launch a tool against an agent folder. The main process re-validates the
 * folder against the registered agents roots, so a rejection here is expected
 * and must be surfaced, not swallowed.
 */
export function useOpenIn() {
  return useMutation({
    mutationFn: (request: OpenInRequest) => window.api.localTools.openIn(request)
  })
}

/**
 * The tool a folder opens in by default, resolved against what is installed.
 *
 * `tool` is null both when nothing is set and when the set tool is no longer
 * detected — either way the page has to ask. `launchable` is every installed
 * assistant and editor, in the order the Open-in menu lists them.
 */
export function useDefaultTool(): {
  tool: DetectedTool | null
  launchable: DetectedTool[]
  /** True when a new agent should open in `tool` without asking. */
  autoOpen: boolean
} {
  const { data: tools } = useLocalTools()
  const { data: settings } = useAppSettings()
  return useMemo(() => {
    const launchable = launchableTools(tools ?? [])
    const tool = resolveDefaultTool(launchable, settings?.localAgentsDefaultTool ?? '')
    return { tool, launchable, autoOpen: tool !== null && settings?.localAgentsAutoOpen === true }
  }, [tools, settings?.localAgentsDefaultTool, settings?.localAgentsAutoOpen])
}

/**
 * Remember a tool as the default. Called from the Open-in menu and the
 * new-agent flow on every pick — the last choice is the default — and from
 * Settings, where `null` clears it back to "ask".
 */
export function useSetDefaultTool(): (toolId: LocalToolId | null) => void {
  const setSetting = useSetAppSetting()
  return (toolId) => {
    setSetting.mutate({ key: 'localAgentsDefaultTool', value: toolId ?? '' })
    // "Ask each time" and "open automatically" contradict each other; a
    // cleared default that left auto-open armed would silently re-arm it the
    // next time any tool was picked from the page menu.
    if (toolId === null) setSetting.mutate({ key: 'localAgentsAutoOpen', value: false })
  }
}
