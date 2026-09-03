import { useCallback, useMemo } from 'react'
import {
  useAgentFileEditor,
  useLocalAgentDoc,
  useOpenAgentPath
} from '../../../hooks/useLocalAgents'
import {
  LOCAL_AGENT_PROMPT_PATHS,
  type LocalAgentPromptKind
} from '../../../../../shared/localAgents'
import { AgentCard } from './AgentCard'
import { InlineFileEditor } from './InlineFileEditor'

interface PromptDocCardProps {
  agentId: string
  prompt: LocalAgentPromptKind
  title: string
  /** One line saying what this document is for, above the editor. */
  hint: string
  placeholder: string
}

/**
 * One of the three prompt documents, edited in place.
 *
 * The text is read on its own rather than carried in the agent DTO, so that the
 * fingerprint the editor saves against comes from the same read as the text it
 * shows — see `localAgentService.readDoc`. The list would otherwise haul three
 * markdown files per agent around to render a one-line sub-heading.
 */
export function PromptDocCard({
  agentId,
  prompt,
  title,
  hint,
  placeholder
}: PromptDocCardProps): React.JSX.Element {
  const { data: doc, isLoading } = useLocalAgentDoc(agentId, prompt)
  const openPath = useOpenAgentPath()
  const relPath = LOCAL_AGENT_PROMPT_PATHS[prompt]

  const snapshot = useMemo(
    () => (doc ? { text: doc.text, stamp: doc.stamp } : undefined),
    [doc]
  )
  const toUpdate = useCallback(
    (text: string) => ({ field: 'prompt' as const, prompt, value: text }),
    [prompt]
  )

  const editor = useAgentFileEditor({
    agentId,
    relPath,
    snapshot,
    toUpdate,
    docPrompt: prompt
  })

  return (
    <AgentCard
      title={title}
      file={relPath}
      onReveal={() => openPath.mutate({ agentId, relPath })}
      actions={
        editor.isSaving ? (
          <span className="text-[10px] text-[var(--color-text-muted)]">Saving…</span>
        ) : null
      }
    >
      <div className="mb-2 text-[10px] text-[var(--color-text-muted)]">{hint}</div>
      {isLoading ? (
        <div className="text-[10px] text-[var(--color-text-muted)]">Loading…</div>
      ) : (
        // Plain text, not rendered markdown: this is a document written for a
        // model, and the scaffold template leads with an HTML comment. Rendering
        // it would either show that comment as prose or hide part of a file the
        // page claims to be a viewer over.
        <InlineFileEditor editor={editor} markdown={false} placeholder={placeholder} />
      )}
    </AgentCard>
  )
}
