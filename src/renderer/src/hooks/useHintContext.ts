import { useEffect, useMemo } from 'react'
import { useNoteList } from './useNotes'
import { useAgents } from './useAgents'
import { useMcpProviders } from './useMcp'
import { useChatModes } from './useChatModes'
import { useCliCommands } from './useCliCommands'
import { useHasAttachDestination } from './useAttachDestination'
import { useHintsStore } from '../stores/hints.store'
import { extractExamplePrompts } from '../utils/examplePrompts'
import type { HintContext } from '../constants/hints'

type AgentData = Awaited<ReturnType<typeof window.api.agents.list>>[number]

/**
 * Assembles the eligibility snapshot the hint scheduler gates on, and emits the
 * hint events that are derived from state rather than from a user gesture.
 *
 * Every query here is one the new-chat screen already has in cache, so mounting
 * the hint bar costs no extra IPC — but keeping this out of the component means
 * the rules that decide *which* hints are actionable can be reasoned about (and
 * tested) without a React Query provider, and a second surface (active chat)
 * can reuse them.
 *
 * @param selectedAgent      Primary agent picked on the new-chat screen — the source of the `#` / `/` gates.
 * @param pendingAgentCount  Agents currently selected; gates the double-ESC hint.
 */
export function useHintContext(
  selectedAgent: AgentData | null,
  pendingAgentCount: number
): HintContext {
  const { data: notes } = useNoteList()
  const { data: agents } = useAgents()
  const { data: mcps } = useMcpProviders()
  const { data: chatModes } = useChatModes()
  const { data: cliCommands } = useCliCommands(selectedAgent?.id)
  const canAttachFiles = useHasAttachDestination()
  const observe = useHintsStore((s) => s.observe)

  const examplePrompts = useMemo(
    () => extractExamplePrompts(selectedAgent),
    [selectedAgent]
  )
  const promptCount = examplePrompts.length
  const commandCount = (cliCommands ?? []).length

  // Picking an agent that brings prompts or commands is the moment to mention
  // the triggers that surface them — the user has just created the
  // precondition. The store caps these at one fire per session.
  useEffect(() => {
    if (selectedAgent && promptCount > 0) observe('agent-with-prompts-selected')
  }, [selectedAgent?.id, promptCount, observe]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (selectedAgent && commandCount > 0) observe('agent-with-commands-selected')
  }, [selectedAgent?.id, commandCount, observe]) // eslint-disable-line react-hooks/exhaustive-deps

  return useMemo<HintContext>(
    () => ({
      hasNotes: (notes ?? []).length > 0,
      hasExamplePrompts: promptCount > 0,
      hasCliCommands: commandCount > 0,
      hasChatModes: (chatModes ?? []).some((m) => m.enabled !== false),
      hasAgentsOrMcps:
        (agents ?? []).some((a) => a.enabled) || (mcps ?? []).some((m) => m.enabled),
      hasPendingAgents: pendingAgentCount > 0,
      canAttachFiles
    }),
    [notes, promptCount, commandCount, chatModes, agents, mcps, pendingAgentCount, canAttachFiles]
  )
}
