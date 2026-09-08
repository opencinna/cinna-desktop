import { useCallback, useMemo } from 'react'
import {
  useAgentFileEditor,
  useLocalAgentDoc,
  useOpenAgentPath
} from '../../../hooks/useLocalAgents'
import {
  LOCAL_AGENT_DOC_PATHS,
  type LocalAgentDocKind,
  type LocalAgentFieldUpdate
} from '../../../../../shared/localAgents'
import { AgentCard } from './AgentCard'
import { InlineFileEditor } from './InlineFileEditor'

interface PromptDocCardProps {
  agentId: string
  prompt: LocalAgentDocKind
  title: string
  /** One line saying what this document is for, above the editor. */
  hint: string
  placeholder: string
  /**
   * Show the file but refuse edits. Used for a bare agent's `README.md`: it is
   * the *builder's* document — what an assistant opening the folder is briefed
   * from — so editing it from the agent's own page would be the agent editing
   * its own briefing, which is the thing the assembled prompt tells it not to
   * do. It is one click away in the user's editor.
   */
  readOnly?: boolean
  /** What to say when the file is not in the folder. See `InlineFileEditor`. */
  missingNote?: string
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
  placeholder,
  readOnly = false,
  missingNote
}: PromptDocCardProps): React.JSX.Element {
  const { data: doc, isLoading } = useLocalAgentDoc(agentId, prompt)
  const openPath = useOpenAgentPath()
  const relPath = LOCAL_AGENT_DOC_PATHS[prompt]

  const snapshot = useMemo(
    () => (doc ? { text: doc.text, stamp: doc.stamp } : undefined),
    [doc]
  )
  const toUpdate = useCallback(
    (text: string): LocalAgentFieldUpdate => {
      if (prompt === 'bare_prompt') return { field: 'bare_prompt', value: text }
      if (prompt === 'bare_readme') {
        // Unreachable: this card is only ever rendered `readOnly`, so no
        // textarea exists and nothing calls this. It throws rather than falling
        // through to `bare_prompt`, which is what a plausible edit here would
        // do — and that would write the README's text over `AGENT.md`, which is
        // the agent's whole system prompt. (Main would refuse it on the stamp,
        // since the two files' stamps differ, but "your save was refused" is
        // not the message this deserves.)
        throw new Error('README.md is read-only here — open the folder to edit it.')
      }
      return { field: 'prompt', prompt, value: text }
    },
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
        <InlineFileEditor
          editor={editor}
          markdown={false}
          placeholder={placeholder}
          readOnly={readOnly}
          missingNote={missingNote}
        />
      )}
    </AgentCard>
  )
}
