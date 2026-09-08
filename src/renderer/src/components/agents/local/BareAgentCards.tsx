import { useEffect, useRef, useState } from 'react'
import { useRenameLocalAgent } from '../../../hooks/useLocalAgents'
import { BARE_AGENT_PROMPT_FILE, type LocalAgentDto } from '../../../../../shared/localAgents'
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
