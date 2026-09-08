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
   * Render the file as markdown while it is not being edited.
   *
   * Off for the kit's three prompts. Those are written for a model, and the
   * scaffold template leads with an HTML comment telling their author what to
   * put where — `documentMarkdownComponents` strips raw HTML, as every other
   * viewer of these files does, so rendering them would hide the one line the
   * author most needs to read from a card that claims to be a viewer over the
   * file. On for a bare agent's `AGENT.md`, which is prose its author wrote and
   * reads as markdown everywhere else they open it.
   */
  markdown?: boolean
  /**
   * What to say when the file is not in the folder.
   *
   * The default names the scaffolder, which is right for a kit prompt and
   * nonsense for a bare folder — nothing scaffolded it, so "run the agent's
   * scaffold again" is an instruction its owner cannot follow (rule 7).
   */
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
  markdown = false,
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
        // Unreachable: the README is not one of this card's documents — it is
        // read-only on Overview, in `BareReadmeCard`, with no textarea behind
        // it. It throws rather than falling through to `bare_prompt`, which is
        // what a plausible edit here would do — and that would write the
        // README's text over `AGENT.md`, which is the agent's whole system
        // prompt. (Main would refuse it on the stamp, since the two files'
        // stamps differ, but "your save was refused" is not the message this
        // deserves.)
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
        // Rendered or raw per document — see `markdown` above. Either way the
        // click that starts editing puts the file's own bytes in the textarea;
        // rendering changes how it reads, never what is saved.
        <InlineFileEditor
          editor={editor}
          markdown={markdown}
          placeholder={placeholder}
          missingNote={missingNote}
        />
      )}
    </AgentCard>
  )
}
