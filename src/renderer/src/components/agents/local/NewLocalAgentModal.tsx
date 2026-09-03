import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Bot, Pencil, X } from 'lucide-react'
import { useUIStore } from '../../../stores/ui.store'
import { useAgentRoots, useCreateLocalAgent } from '../../../hooks/useLocalAgents'
import { describeAgentSlug } from '../../../../../shared/localAgents'
import { suggestAgentName } from '../../../utils/localAgents'

interface NewLocalAgentModalProps {
  onClose: () => void
}

/**
 * One sentence in, a folder out.
 *
 * The sentence is the only thing the user must write: it becomes the manifest
 * `description`, it is where the suggested name comes from, and it is what the
 * AI draft is given. The name and the folder slug are both shown before
 * anything is written — the slug is a real directory that an assistant will
 * `cd` into and a Cinna instance will import by, so it is confirmed here rather
 * than discovered later.
 *
 * The scaffold and the draft are two steps on purpose. The folder appears
 * immediately; the drafting is an AI call that may take half a minute, may be
 * skipped entirely on a machine with no credential configured, and must never
 * stand between the user and their agent.
 */
export function NewLocalAgentModal({ onClose }: NewLocalAgentModalProps): React.JSX.Element {
  const { data: roots } = useAgentRoots()
  const createAgent = useCreateLocalAgent()
  const setActiveLocalAgentId = useUIStore((s) => s.setActiveLocalAgentId)
  const setPendingDraftAgentId = useUIStore((s) => s.setPendingDraftAgentId)
  const setActiveView = useUIStore((s) => s.setActiveView)
  const cardRef = useRef<HTMLDivElement>(null)
  const sentenceRef = useRef<HTMLTextAreaElement>(null)

  const [sentence, setSentence] = useState('')
  // `null` means "still following the sentence"; a string is the user's own.
  const [nameOverride, setNameOverride] = useState<string | null>(null)
  const [slugOverride, setSlugOverride] = useState<string | null>(null)
  const [editingSlug, setEditingSlug] = useState(false)
  const [rootId, setRootId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const name = nameOverride ?? suggestAgentName(sentence)
  // `slugOverride` holds what the user is typing, not the finished slug:
  // normalising on every keystroke makes a hyphen impossible to type, since
  // the rule strips a trailing one. The finished value is derived here and
  // written back on blur.
  // Not just the slug: *why* there isn't one, and what to offer instead. A
  // name in a non-Latin script produces no slug, and the old single message
  // ("no letters or digits") was both false and a dead end for that user — the
  // folder field is the way through and nothing said so.
  const slugCheck = describeAgentSlug(slugOverride ?? name)
  const slug = slugCheck.slug
  const targetRoot = useMemo(
    () => (roots ?? []).find((root) => root.id === (rootId ?? '')) ?? (roots ?? [])[0] ?? null,
    [roots, rootId]
  )

  useEffect(() => {
    sentenceRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    const onClick = (e: MouseEvent): void => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onClick)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onClick)
    }
  }, [onClose])

  const canCreate =
    sentence.trim() !== '' && name.trim() !== '' && slug !== '' && !createAgent.isPending

  const handleCreate = (): void => {
    if (!canCreate) return
    setError(null)
    createAgent.mutate(
      {
        name: name.trim(),
        description: sentence.trim(),
        slug,
        rootId: targetRoot?.id
      },
      {
        onSuccess: (agent) => {
          // Land on the page first, and hand the drafting request over with
          // it: the page runs the AI call and shows its progress, so closing
          // this form never cancels or hides it.
          setActiveLocalAgentId(agent.id)
          setPendingDraftAgentId(agent.id)
          setActiveView('local-agent')
          onClose()
        },
        onError: (err) => {
          setError(err instanceof Error ? err.message : 'Could not create that agent.')
        }
      }
    )
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 px-4">
      <div
        ref={cardRef}
        className="w-full max-w-[30rem] rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-lg p-6"
      >
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
            title="Cancel"
            aria-label="Cancel"
          >
            <X size={14} />
          </button>
        </div>

        <div className="text-center space-y-2 -mt-2">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-[var(--color-accent)]/10">
            <Bot size={28} className="text-[var(--color-accent)]" />
          </div>
          <div className="text-lg font-semibold text-[var(--color-text)]">New agent</div>
        </div>

        <div className="mt-5 space-y-4">
          <div className="space-y-1.5">
            <label
              htmlFor="new-agent-sentence"
              className="block text-xs font-medium text-[var(--color-text)]"
            >
              What should this agent do?
            </label>
            <textarea
              id="new-agent-sentence"
              ref={sentenceRef}
              value={sentence}
              onChange={(e) => setSentence(e.target.value)}
              rows={3}
              placeholder="Watch the invoice inbox and flag anything without a purchase-order number."
              className="w-full bg-[var(--color-bg)] text-[var(--color-text)] px-2.5 py-1.5 rounded-md text-xs
                border border-[var(--color-border)] focus:border-[var(--color-accent)] focus:outline-none
                resize-none placeholder:text-[var(--color-text-muted)]"
            />
            <div className="text-[10px] text-[var(--color-text-muted)]">
              One sentence. It becomes the agent&apos;s description in{' '}
              <code>cinna-agent.json</code>.
            </div>
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="new-agent-name"
              className="block text-xs font-medium text-[var(--color-text)]"
            >
              Name
            </label>
            <input
              id="new-agent-name"
              type="text"
              value={name}
              onChange={(e) => {
                setNameOverride(e.target.value)
                // A name the user typed re-derives the slug, unless they have
                // already taken that over too.
                if (!editingSlug) setSlugOverride(null)
              }}
              placeholder="Suggested from your sentence"
              className="w-full bg-[var(--color-bg)] text-[var(--color-text)] px-2.5 py-1.5 rounded-md text-xs
                border border-[var(--color-border)] focus:border-[var(--color-accent)] focus:outline-none
                placeholder:text-[var(--color-text-muted)]"
            />
          </div>

          <div className="space-y-1.5">
            <div className="text-xs font-medium text-[var(--color-text)]">Folder</div>
            {editingSlug ? (
              <input
                type="text"
                autoFocus
                value={slugOverride ?? slug}
                onChange={(e) => setSlugOverride(e.target.value)}
                onBlur={() => {
                  setSlugOverride(slug)
                  setEditingSlug(false)
                }}
                aria-label="Folder name"
                className="w-full bg-[var(--color-bg)] text-[var(--color-text)] px-2.5 py-1.5 rounded-md text-xs font-mono
                  border border-[var(--color-border)] focus:border-[var(--color-accent)] focus:outline-none"
              />
            ) : (
              <button
                type="button"
                onClick={() => {
                  setSlugOverride(slug)
                  setEditingSlug(true)
                }}
                className="w-full flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-mono text-left
                  border border-[var(--color-border)] text-[var(--color-text-secondary)]
                  hover:bg-[var(--color-bg-hover)] transition-colors"
                title="Rename the folder"
              >
                <span className="flex-1 truncate">
                  {targetRoot ? `${targetRoot.label}/Local/` : 'Local/'}
                  <span className="text-[var(--color-text)]">{slug || '…'}</span>
                </span>
                <Pencil size={11} className="shrink-0 text-[var(--color-text-muted)]" />
              </button>
            )}
            {slugCheck.message && (
              // A hint, not an error: a folder name has been chosen and Create
              // is enabled. The user can take it or edit it.
              <div className="text-[10px] text-[var(--color-text-muted)]">
                {slugCheck.message}
              </div>
            )}
          </div>

          {(roots ?? []).length > 1 && (
            <div className="space-y-1.5">
              <label
                htmlFor="new-agent-root"
                className="block text-xs font-medium text-[var(--color-text)]"
              >
                Agents folder
              </label>
              <select
                id="new-agent-root"
                value={targetRoot?.id ?? ''}
                onChange={(e) => setRootId(e.target.value)}
                className="w-full bg-[var(--color-bg)] text-[var(--color-text)] px-2.5 py-1.5 rounded-md text-xs
                  border border-[var(--color-border)] focus:border-[var(--color-accent)] focus:outline-none"
              >
                {(roots ?? []).map((root) => (
                  <option key={root.id} value={root.id}>
                    {root.label} — {root.path}
                  </option>
                ))}
              </select>
            </div>
          )}

          {error && <div className="text-[10px] text-[var(--color-danger)]">{error}</div>}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-xs font-medium text-[var(--color-text-muted)]
              hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleCreate}
            disabled={!canCreate}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-[var(--color-accent)] text-[var(--color-on-accent)]
              hover:bg-[var(--color-accent-hover)] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            {createAgent.isPending ? 'Creating…' : 'Create agent'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
