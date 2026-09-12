import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  DetectedTool,
  LocalToolId,
  LocalToolKind,
  OpenInRequest,
  RuntimeToolId,
  ToolInstallPlan,
  ToolInstallProgress
} from '../../../shared/localTools'
import { DEFAULT_RUNTIME_KEY } from './useEngine'
import { useAppSettings, useSetAppSetting } from './useAppSettings'
import { launchableTools, resolveDefaultTool } from '../utils/localAgents'

export const LOCAL_TOOLS_KEY = ['local-tools'] as const
/**
 * A sibling of {@link LOCAL_TOOLS_KEY}, not a child of it.
 *
 * `['local-tools', 'claude-auth']` would be matched by any
 * `invalidateQueries({ queryKey: ['local-tools'] })`. Nothing does that today,
 * but detection is `staleTime: Infinity` while this one spawns a process, so
 * the first person to add an invalidation for detection would silently start
 * re-spawning `claude` with it.
 */
export const CLAUDE_AUTH_KEY = ['claude-auth'] as const

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

/**
 * Whether the user's own `claude` install is logged in.
 *
 * The sibling of {@link useLocalTools}, and deliberately **not** folded into
 * it: detection is one filesystem pass cached for the app's lifetime, while
 * this spawns a process and is cached behind a 30-second window, because it is
 * the answer that changes while the app is open — the user reads "log in with
 * `claude` in a terminal", goes and does it, and comes back.
 *
 * `staleTime` matches that window rather than `Infinity`. Undefined while it is
 * in flight, which the panel renders as *not knowing*, never as *no*.
 *
 * **It polls, but only while the answer is one the user is being asked to
 * change.** The panel's logged-out line says *"run `claude` in a terminal"*, so
 * the user leaves, does it, and comes back to a red alarm about a machine that
 * is now fine — and nothing re-asks while the agent page stays mounted. It
 * clears only on a remount.
 *
 * Focus is the obvious trigger and **it does not work here**, which is worth
 * writing down because the option that looks like it does is a trap:
 * `refetchOnWindowFocus` is driven by `focusManager`, and
 * `@tanstack/query-core@5.99.0` (`focusManager.js`) registers exactly one
 * listener — `visibilitychange`. That fires when the page is hidden, occluded
 * or minimized; it does **not** fire when another application takes the
 * foreground over a still-visible Electron window, which is precisely the
 * ⌘-Tab-to-Terminal-and-back this exists for. Driven through the built app, the
 * line was unchanged after `blur/focus`, `hide/show` and `minimize/restore`
 * alike, with `document.visibilityState` never leaving `"visible"`.
 *
 * So the trigger is an interval, gated on the state that needs one. It is
 * `false` in every other state — no poll while logged in, none while the answer
 * is unknown, none before the first answer — so the cost exists only on a
 * machine displaying an alarm, and stops the moment the alarm is right to go.
 * One `claude auth status` is a bounded child process of about a quarter of a
 * second that runs no turn and bills nothing.
 *
 * `refetchOnWindowFocus: 'always'` is kept for the cases `visibilitychange`
 * genuinely does cover — minimize, occlude, switch Space — where it is a
 * faster answer than waiting out the interval. `'always'` and not `true`,
 * because `true` defers to `staleTime` and would hold the stale alarm for the
 * rest of the window.
 */
export const CLAUDE_AUTH_POLL_MS = 10_000

export function useClaudeAuth() {
  return useQuery({
    queryKey: CLAUDE_AUTH_KEY,
    queryFn: () => window.api.localTools.claudeAuth(),
    staleTime: 30_000,
    refetchOnWindowFocus: 'always',
    refetchInterval: (query) =>
      query.state.data?.state === 'logged_out' ? CLAUDE_AUTH_POLL_MS : false
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
      // The main process re-asks the login on this same call, so the cached
      // answer here is stale the moment detection comes back.
      void queryClient.invalidateQueries({ queryKey: CLAUDE_AUTH_KEY })
      // Detection is half of what the Default Runtime is derived from: on
      // Automatic, finding a `claude` that was not there a moment ago *is* the
      // change of runtime. Left stale, Settings would report the new install in
      // one card and the old default in the one above it.
      void queryClient.invalidateQueries({ queryKey: DEFAULT_RUNTIME_KEY })
    }
  })
}

export const TOOL_INSTALL_PLANS_KEY = ['tool-install-plans'] as const

/**
 * What this machine would run to install each runtime.
 *
 * Fetched rather than written in the renderer, because the command the confirm
 * dialog shows has to be the command that will actually run: main owns the
 * table, resolves it for this platform, and the dialog quotes what came back.
 * A copy here would be a second version of a string whose whole job is to be
 * exactly what happens next.
 */
export function useToolInstallPlans() {
  return useQuery({
    queryKey: TOOL_INSTALL_PLANS_KEY,
    queryFn: () => window.api.localTools.installPlans(),
    staleTime: Infinity
  })
}

/**
 * Run a vendor's installer for one runtime.
 *
 * **Owned above the dialog that triggers it** (ux_rules rule 5): the dialog
 * closes on success, and a `mutate`-level `onSuccess` would be dropped by that
 * unmount. The caller passes what closing means.
 *
 * It resolves for a *failed* install too — main returns the outcome rather than
 * rejecting, so the sentence survives the bridge — which is why `onDone` is
 * handed the outcome instead of being treated as a success callback.
 */
export function useInstallRuntimeTool(options: { onDone?: (result: ToolInstallProgress) => void } = {}) {
  const queryClient = useQueryClient()
  return useMutation<ToolInstallProgress, Error, RuntimeToolId>({
    mutationFn: (toolId) => window.api.localTools.install(toolId),
    onSuccess: (result) => {
      if (result.state === 'done') {
        // Main has already re-detected by the time this resolves, so these are
        // reads of a fresh answer rather than a second detection pass.
        void queryClient.invalidateQueries({ queryKey: LOCAL_TOOLS_KEY })
        void queryClient.invalidateQueries({ queryKey: CLAUDE_AUTH_KEY })
        void queryClient.invalidateQueries({ queryKey: DEFAULT_RUNTIME_KEY })
      }
      options.onDone?.(result)
    }
  })
}

/**
 * The installer's last output line, while it runs.
 *
 * A subscription rather than a query: there is nothing to fetch, and the line
 * changes several times a second. Scoped to one tool so a dialog cannot show
 * another install's output, and dropped when the subscriber unmounts.
 */
export function useToolInstallProgress(toolId: RuntimeToolId | null): ToolInstallProgress | null {
  const [progress, setProgress] = useState<ToolInstallProgress | null>(null)
  useEffect(() => {
    setProgress(null)
    if (!toolId) return
    return window.api.localTools.onInstallProgress((next) => {
      if (next.id === toolId) setProgress(next)
    })
  }, [toolId])
  return progress
}

/** The install plan for one runtime, or null when this build has none for it. */
export function useToolInstallPlan(toolId: RuntimeToolId | null): ToolInstallPlan | null {
  const { data } = useToolInstallPlans()
  return toolId ? ((data ?? []).find((plan) => plan.id === toolId) ?? null) : null
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
