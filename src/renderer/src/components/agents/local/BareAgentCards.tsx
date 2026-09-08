import { useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  useLocalAgentDoc,
  useOpenAgentPath,
  useRenameLocalAgent
} from '../../../hooks/useLocalAgents'
import {
  BARE_AGENT_PROMPT_FILE,
  BARE_AGENT_README_FILE,
  type LocalAgentDto
} from '../../../../../shared/localAgents'
import {
  documentMarkdownComponents,
  remarkStripHtml
} from '../../../utils/markdownComponents'
import { unwrapIpcError } from '../../../utils/ipcError'
import { AgentCard } from './AgentCard'

/**
 * The name of a bare agent.
 *
 * Every other editable card on this page is a viewer over a file in the folder
 * and says which file it reads. This one deliberately is not, and says so: a
 * bare folder is the user's own — very often a repository they share with other
 * people — and the desktop writes nothing into it, so a name given here is held
 * on this machine beside the rest of that agent's local state.
 *
 * Not the inline-file-editor pattern, because there is no file, no stamp and
 * therefore no conflict to resolve: nothing else on the machine writes this
 * value. It saves on blur and on Enter rather than on a pause, so a rename is a
 * decision the user finishes rather than one that lands mid-word.
 */
export function BareNameCard({ agent }: { agent: LocalAgentDto }): React.JSX.Element {
  const rename = useRenameLocalAgent()
  const [value, setValue] = useState(agent.name)
  const [error, setError] = useState<string | null>(null)
  // The name can change from outside this card — a rescan after the folder's
  // `AGENT.md` heading was rewritten. Adopt it unless the user is mid-edit.
  const dirty = useRef(false)
  useEffect(() => {
    if (!dirty.current) setValue(agent.name)
  }, [agent.name])

  const commit = (): void => {
    const next = value.trim()
    dirty.current = false
    if (next === agent.name) {
      setValue(agent.name)
      setError(null)
      return
    }
    setError(null)
    // An empty field **clears** the name rather than reverting it, which is
    // what the hint below promises and the only way back to a name that follows
    // `AGENT.md`. Reverting silently — as this did — left the user deleting the
    // field, watching it spring back with no message, and concluding they had
    // mistyped; the second attempt behaved identically, and the rename was
    // permanent for the life of the folder.
    rename.mutate(
      { agentId: agent.id, name: next === '' ? null : next },
      { onError: (err) => setError(unwrapIpcError(err, 'That name could not be saved.')) }
    )
  }

  return (
    <AgentCard
      title="Name"
      actions={
        rename.isPending ? (
          <span className="text-[10px] text-[var(--color-text-muted)]">Saving…</span>
        ) : null
      }
    >
      <input
        type="text"
        value={value}
        disabled={rename.isPending}
        onChange={(e) => {
          dirty.current = true
          setValue(e.target.value)
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            dirty.current = false
            setValue(agent.name)
            e.currentTarget.blur()
          }
        }}
        className="w-full border-none bg-transparent text-xs text-[var(--color-text)] outline-none
          placeholder:text-[var(--color-text-muted)] disabled:opacity-60"
        placeholder="What this agent is called"
      />
      {/* Reserved, so a refusal does not resize the card (UX rule 1). */}
      <div role="alert" className="min-h-4 text-[10px] text-[var(--color-danger)]">
        {error}
      </div>
      <div className="text-[10px] text-[var(--color-text-muted)]">
        Kept on this machine, not in the folder — it may be a repository you share with other
        people. Cleared, the name falls back to the heading in {BARE_AGENT_PROMPT_FILE}.
      </div>
    </AgentCard>
  )
}

/**
 * A bare folder's `README.md`, rendered.
 *
 * On Overview and not on Prompts, because it is not a prompt: the README is
 * what the folder tells a *person* — or an assistant opening it to work on the
 * agent — and no part of it reaches the agent, whose whole system prompt is
 * {@link BARE_AGENT_PROMPT_FILE}. Prompts showing both invited exactly that
 * confusion, and put the folder's longest document on the tab where the one
 * that matters is edited.
 *
 * Read-only, and absent entirely where the folder has no README: a card whose
 * only possible content is "there is no README here" states a finding, and the
 * Folder tab already carries that one with the explanation attached.
 */
export function BareReadmeCard({ agent }: { agent: LocalAgentDto }): React.JSX.Element | null {
  const { data: doc } = useLocalAgentDoc(agent.id, 'bare_readme')
  const openPath = useOpenAgentPath()

  // `stamp === null` is main's "this file is not there" — distinct from a
  // README that exists and is empty, which is just as little use here.
  if (!doc || doc.stamp === null || doc.text.trim() === '') return null

  return (
    <AgentCard
      title="Readme"
      file={BARE_AGENT_README_FILE}
      onReveal={() => openPath.mutate({ agentId: agent.id, relPath: BARE_AGENT_README_FILE })}
    >
      {/*
        The whole file, always. A clamp with a "Show more" was tried and
        removed: the card is a viewer over a document, the page it sits on
        already scrolls, and a fade over half a paragraph asks the reader to
        press something before they can read what they came to read.
      */}
      <div className="markdown-body text-xs leading-relaxed text-[var(--color-text)]">
        <Markdown
          remarkPlugins={[remarkGfm, remarkStripHtml]}
          components={documentMarkdownComponents}
        >
          {doc.text}
        </Markdown>
      </div>
      <div className="mt-3 text-[10px] text-[var(--color-text-muted)]">
        Read here, edited in the folder. This is what an assistant opening the folder is briefed
        from; the agent itself is told only {BARE_AGENT_PROMPT_FILE}.
      </div>
    </AgentCard>
  )
}
