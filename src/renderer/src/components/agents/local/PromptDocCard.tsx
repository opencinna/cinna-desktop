import { useCallback, useMemo, useState } from 'react'
import {
  useAgentFileEditor,
  useLocalAgentDoc,
  useOpenAgentPath
} from '../../../hooks/useLocalAgents'
import {
  BARE_AGENT_INSTRUCTION_FILES,
  LOCAL_AGENT_DOC_PATHS,
  type BareInstructionsFile,
  type LocalAgentDocKind,
  type LocalAgentPromptKind,
  type LocalAgentFieldUpdate
} from '../../../../../shared/localAgents'
import { AgentCard } from './AgentCard'
import { InlineFileEditor } from './InlineFileEditor'

/** A kit agent's three prompt cards on Overview, in order: one list for the folder and the vault Overview. */
export const KIT_PROMPT_CARDS: { prompt: LocalAgentPromptKind; title: string; hint: string; placeholder: string }[] = [
  {
    prompt: 'workflow',
    title: 'Workflow prompt',
    hint: 'This document is the agent: it is loaded as the system prompt for every conversation.',
    placeholder: 'Describe what this agent does, step by step, addressed to the agent.'
  },
  {
    prompt: 'entrypoint',
    title: 'Entrypoint prompt',
    hint: 'The first message of an unattended run, with nobody there to answer a question.',
    placeholder: 'One or two self-contained sentences telling the agent what to do.'
  },
  {
    prompt: 'refiner',
    title: 'Refiner prompt',
    hint: 'Defaults and required inputs — what to assume when a request does not say.',
    placeholder: 'List the mandatory inputs and the defaults to fill in.'
  }
]

interface PromptDocCardProps {
  agentId: string
  prompt: LocalAgentDocKind
  title: string
  /** One line saying what this document is for, above the editor. */
  hint: string
  placeholder: string
  /**
   * What to say when the file is not in the folder.
   *
   * The default names the scaffolder, which is right for a kit prompt and
   * nonsense for a bare folder — nothing scaffolded it, so "run the agent's
   * scaffold again" is an instruction its owner cannot follow (rule 7).
   */
  missingNote?: string
  /**
   * The file a `bare_prompt` card reads: the agent's own
   * `LocalAgentDto.instructionsFile`, which only main can resolve. Null when
   * the folder has none of them, and the card then names no file (ux_rules
   * rule 9). Ignored for every other kind, whose path is fixed.
   */
  instructionsFile?: BareInstructionsFile | null
  /**
   * The document as read from inside a vault agent's vault (null: the folder
   * there has none). Given, the card shows it read-only: no folder read, no
   * editing, no reveal. Absent for every other agent.
   */
  readOnlyDoc?: { relPath: string; text: string } | null
}

/**
 * One prompt document, edited in place, on the agent's Overview.
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
  missingNote,
  instructionsFile = null,
  readOnlyDoc
}: PromptDocCardProps): React.JSX.Element {
  const readOnly = readOnlyDoc !== undefined
  // A vault agent's folder is not on this Mac: its text comes from the vault, never from a folder read.
  const { data: folderDoc, isLoading } = useLocalAgentDoc(readOnly ? null : agentId, prompt)
  // Memoised on the text: a new snapshot each render would re-seed the editor each render.
  const vaultText = readOnlyDoc?.text
  const vaultDoc = useMemo(() => (vaultText === undefined ? undefined : { text: vaultText, stamp: null }), [vaultText])
  const doc = readOnly ? vaultDoc : folderDoc
  // Collapsed by default: these sit on Overview under the cards that say what
  // the agent is, and a workflow prompt runs to hundreds of lines. Per card and
  // per visit — opening one prompt says nothing about wanting the next one.
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)
  const openPath = useOpenAgentPath()
  // With no instructions file the editor still needs a key for its stamp
  // lookup; `AGENT.md` holds no stamp in that folder, so nothing can be saved
  // against it, and the card below does not name it.
  const relPath =
    prompt === 'bare_prompt'
      ? (instructionsFile ?? BARE_AGENT_INSTRUCTION_FILES[0])
      : LOCAL_AGENT_DOC_PATHS[prompt]
  const namesFile = prompt !== 'bare_prompt' || instructionsFile !== null

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
        // README's text over the instructions file, which is the agent's whole
        // system prompt. (Main would refuse it on the stamp, since the two
        // files' stamps differ, but "your save was refused" is not the message
        // this deserves.)
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
      file={namesFile ? relPath : undefined}
      onReveal={namesFile && !readOnly ? () => openPath.mutate({ agentId, relPath }) : undefined}
      actions={
        <>
          {editor.isSaving && (
            <span className="text-[10px] text-[var(--color-text-muted)]">Saving…</span>
          )}
          {overflows && (
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              aria-expanded={expanded}
              aria-label={expanded ? `Collapse ${title}` : `Show all of ${title}`}
              className="text-[10px] font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] transition-colors"
            >
              {expanded ? 'Show less' : 'Show all'}
            </button>
          )}
        </>
      }
    >
      <div className="mb-2 text-[10px] text-[var(--color-text-muted)]">{hint}</div>
      {isLoading ? (
        <div className="text-[10px] text-[var(--color-text-muted)]">Loading…</div>
      ) : (
        // Rendered as markdown, with the scaffold's HTML comments kept as
        // muted author notes rather than dropped the way a README viewer drops
        // them: the comment telling the author what to write is the line they
        // most need. The click that starts editing puts the file's own bytes in
        // the textarea; rendering changes how it reads, never what is saved.
        <InlineFileEditor
          editor={editor}
          markdown
          commentNotes
          clipped={!expanded}
          onOverflowChange={setOverflows}
          onEditStart={() => setExpanded(true)}
          cardTitle={title}
          placeholder={placeholder}
          missingNote={readOnly ? 'The agent’s folder in the vault has no such file.' : missingNote}
          readOnly={readOnly}
        />
      )}
    </AgentCard>
  )
}
