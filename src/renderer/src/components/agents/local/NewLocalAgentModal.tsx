import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Bot, ChevronDown, ChevronRight, Code2, FolderOpen, TerminalSquare, X } from 'lucide-react'
import { useUIStore } from '../../../stores/ui.store'
import { useAgentRoots, useCreateLocalAgent } from '../../../hooks/useLocalAgents'
import { useDefaultTool, useOpenIn, useSetDefaultTool } from '../../../hooks/useLocalTools'
import { useSetAppSetting } from '../../../hooks/useAppSettings'
import { describeAgentSlug, type LocalAgentDto } from '../../../../../shared/localAgents'
import { actionForTool, type DetectedTool } from '../../../../../shared/localTools'
import { unwrapIpcError } from '../../../utils/ipcError'

interface NewLocalAgentModalProps {
  onClose: () => void
}

const INPUT =
  'w-full bg-[var(--color-bg)] text-[var(--color-text)] px-2.5 py-1.5 rounded-md text-xs ' +
  'border border-[var(--color-border)] focus:border-[var(--color-accent)] focus:outline-none ' +
  'placeholder:text-[var(--color-text-muted)]'
const LABEL = 'block text-xs font-medium text-[var(--color-text)]'
const CHOICE =
  'flex w-full items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left text-xs ' +
  'transition-colors hover:bg-[var(--color-bg-hover)] disabled:cursor-not-allowed disabled:opacity-40'

type Step = { kind: 'name' } | { kind: 'tool'; agent: LocalAgentDto }

/**
 * A name in, a folder out, and then the tool the user builds agents with.
 *
 * The name is the only thing the form asks for. The description, the folder
 * name and which agents folder to use are all real choices — but they are
 * choices almost nobody makes at creation time, because the agent is about to
 * be built in Claude Code or Codex or OpenCode and *that* is where its
 * description gets written. They sit under "More options". A description given
 * here is still what the AI draft is fed; without one there is nothing to
 * draft from, so the draft simply does not run.
 *
 * Creating is two steps on purpose. The folder appears the instant Create is
 * pressed; the second step — "build it with…" — launches the user's tool at
 * that folder and remembers it as the default. With the default already set
 * and "open automatically" on, the second step is skipped entirely: one name,
 * one Enter, and the assistant is running in the new folder.
 */
export function NewLocalAgentModal({ onClose }: NewLocalAgentModalProps): React.JSX.Element {
  const { data: roots } = useAgentRoots()
  const createAgent = useCreateLocalAgent()
  const openIn = useOpenIn()
  const { tool: defaultTool, launchable, autoOpen } = useDefaultTool()
  const setDefaultTool = useSetDefaultTool()
  const setSetting = useSetAppSetting()
  const setActiveLocalAgentId = useUIStore((s) => s.setActiveLocalAgentId)
  const setPendingDraftAgentId = useUIStore((s) => s.setPendingDraftAgentId)
  const setActiveView = useUIStore((s) => s.setActiveView)
  const cardRef = useRef<HTMLDivElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  const [step, setStep] = useState<Step>({ kind: 'name' })
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [moreOpen, setMoreOpen] = useState(false)
  // `null` means "still following the name"; a string is the user's own.
  const [slugOverride, setSlugOverride] = useState<string | null>(null)
  const [rootId, setRootId] = useState<string | null>(null)
  // `null` until touched: the box mirrors the current setting, so arriving on
  // this step after a failed automatic open shows it checked, and unticking it
  // turns auto-open off.
  const [rememberAuto, setRememberAuto] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)

  // `slugOverride` holds what the user is typing, not the finished slug:
  // normalising on every keystroke makes a hyphen impossible to type, since
  // the rule strips a trailing one. The finished value is derived here and
  // written back on blur.
  const slug = describeAgentSlug(slugOverride ?? name).slug
  const targetRoot = useMemo(
    () => (roots ?? []).find((root) => root.id === (rootId ?? '')) ?? (roots ?? [])[0] ?? null,
    [roots, rootId]
  )

  useEffect(() => {
    nameRef.current?.focus()
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

  const canCreate = name.trim() !== '' && slug !== '' && !createAgent.isPending

  /** Land on the new agent's page. The modal may stay open on top of it. */
  const landOn = (agent: LocalAgentDto, drafted: boolean): void => {
    setActiveLocalAgentId(agent.id)
    // The page runs the AI call and shows its progress, so closing this form
    // never cancels or hides it. Only with a description: the draft's whole
    // input is that sentence, and the name alone would draft fiction.
    if (drafted) setPendingDraftAgentId(agent.id)
    setActiveView('local-agent')
  }

  /**
   * Hand the folder to a tool, and close only once it has actually opened.
   *
   * `local-tools:open-in` rejects for a tool uninstalled since detection, a
   * folder outside the registered roots, and — on macOS, the first time — a
   * refused Terminal automation prompt. Closing on the click would make every
   * one of those a folder created and nothing opened, with no message anywhere;
   * with auto-open on, that would be the default path. So the modal stays on
   * the tool step and shows the refusal, and the user can pick something else.
   */
  const launchTool = (agent: LocalAgentDto, tool: DetectedTool): void => {
    setError(null)
    openIn.mutate(
      { folder: agent.path, toolId: tool.id, action: actionForTool(tool) },
      {
        onSuccess: onClose,
        onError: (err) => {
          setStep({ kind: 'tool', agent })
          setError(unwrapIpcError(err, `Could not open ${tool.label}.`))
        }
      }
    )
  }

  const handleCreate = (): void => {
    if (!canCreate) return
    setError(null)
    const trimmedDescription = description.trim()
    createAgent.mutate(
      {
        name: name.trim(),
        // Absent, not empty: main writes the name in its place, and the
        // contract is "optional", not "may be blank".
        ...(trimmedDescription === '' ? {} : { description: trimmedDescription }),
        slug,
        rootId: targetRoot?.id
      },
      {
        onSuccess: (agent) => {
          landOn(agent, trimmedDescription !== '')
          if (autoOpen && defaultTool) {
            launchTool(agent, defaultTool)
            return
          }
          setStep({ kind: 'tool', agent })
        },
        onError: (err) => {
          setError(unwrapIpcError(err, 'Could not create that agent.'))
        }
      }
    )
  }

  /** Step two's pick: remember the tool, maybe remember to stop asking, launch. */
  const pickTool = (agent: LocalAgentDto, tool: DetectedTool): void => {
    if (tool.id !== defaultTool?.id) setDefaultTool(tool.id)
    const wantAuto = rememberAuto ?? autoOpen
    if (wantAuto !== autoOpen) setSetting.mutate({ key: 'localAgentsAutoOpen', value: wantAuto })
    launchTool(agent, tool)
  }

  const pickAction = (agent: LocalAgentDto, action: 'terminal' | 'reveal'): void => {
    setError(null)
    openIn.mutate(
      { folder: agent.path, action },
      {
        onSuccess: onClose,
        onError: (err) => setError(unwrapIpcError(err, 'Could not open that.'))
      }
    )
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 px-4">
      <div
        ref={cardRef}
        role="dialog"
        aria-label={step.kind === 'name' ? 'New agent' : 'Build it with'}
        className="w-full max-w-[30rem] rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-lg p-6"
      >
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
            title={step.kind === 'name' ? 'Cancel' : 'Close'}
            aria-label={step.kind === 'name' ? 'Cancel' : 'Close'}
          >
            <X size={14} />
          </button>
        </div>

        <div className="text-center space-y-2 -mt-2">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-[var(--color-accent)]/10">
            <Bot size={28} className="text-[var(--color-accent)]" />
          </div>
          <div className="text-lg font-semibold text-[var(--color-text)]">
            {step.kind === 'name' ? 'New agent' : `Build ${step.agent.name} with…`}
          </div>
          {step.kind === 'tool' && (
            <div className="text-[11px] text-[var(--color-text-muted)]">
              The folder is ready. Open it in the tool you build agents with — your choice becomes
              the default.
            </div>
          )}
        </div>

        {step.kind === 'name' ? (
          <form
            className="mt-5 space-y-4"
            onSubmit={(event) => {
              event.preventDefault()
              handleCreate()
            }}
          >
            <div className="space-y-1.5">
              <label htmlFor="new-agent-name" className={LABEL}>
                Name
              </label>
              <input
                id="new-agent-name"
                ref={nameRef}
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Invoice watcher"
                className={INPUT}
              />
              {/*
                The folder name, live, and nothing else. `describeAgentSlug` also
                returns a sentence explaining an adjusted slug ("needs at least
                two letters, so this becomes 1-agent"); it used to render here
                and appeared on the first keystroke and vanished on the second,
                resizing the dialog twice. The slug is never blocking — it always
                resolves to something — so the sentence taught nothing the
                preview does not already show. See docs/development/ui_guidelines/ux_rules.md.
              */}
              <div className="truncate font-mono text-[10px] text-[var(--color-text-muted)]">
                {targetRoot ? `${targetRoot.label}/Local/` : 'Local/'}
                <span className="text-[var(--color-text-secondary)]">{slug || '…'}</span>
              </div>
            </div>

            <div>
              <button
                type="button"
                onClick={() => setMoreOpen((open) => !open)}
                aria-expanded={moreOpen}
                className="flex items-center gap-1 text-[11px] text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)]"
              >
                {moreOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                More options
              </button>
              {moreOpen && (
                <div className="mt-3 space-y-3 border-l-2 border-[var(--color-border)] pl-3">
                  <div className="space-y-1.5">
                    <label htmlFor="new-agent-description" className={LABEL}>
                      What should it do?{' '}
                      <span className="font-normal text-[var(--color-text-muted)]">optional</span>
                    </label>
                    <textarea
                      id="new-agent-description"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      rows={2}
                      placeholder="Watch the invoice inbox and flag anything without a purchase-order number."
                      className={`${INPUT} resize-none`}
                    />
                    <div className="text-[10px] text-[var(--color-text-muted)]">
                      One sentence. With it, the prompts are drafted for you; without it, the
                      folder starts empty for your tool to fill in.
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <label htmlFor="new-agent-slug" className={LABEL}>
                      Folder name
                    </label>
                    <input
                      id="new-agent-slug"
                      type="text"
                      value={slugOverride ?? slug}
                      onChange={(e) => setSlugOverride(e.target.value)}
                      onBlur={() => setSlugOverride((current) => (current === null ? null : slug))}
                      spellCheck={false}
                      className={`${INPUT} font-mono`}
                    />
                  </div>
                  {(roots ?? []).length > 1 && (
                    <div className="space-y-1.5">
                      <label htmlFor="new-agent-root" className={LABEL}>
                        Agents folder
                      </label>
                      <select
                        id="new-agent-root"
                        value={targetRoot?.id ?? ''}
                        onChange={(e) => setRootId(e.target.value)}
                        className={INPUT}
                      >
                        {(roots ?? []).map((root) => (
                          <option key={root.id} value={root.id}>
                            {root.label} — {root.path}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Reserved: a create error must not push Cancel / Create down (UX rule 1). */}
            <div role="alert" className="min-h-8 text-[10px] text-[var(--color-danger)]">
              {error}
            </div>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1.5 rounded-md text-xs font-medium text-[var(--color-text-muted)]
                  hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!canCreate}
                className="px-3 py-1.5 rounded-md text-xs font-medium bg-[var(--color-accent)] text-white
                  hover:bg-[var(--color-accent-hover)] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              >
                {createAgent.isPending
                  ? 'Creating…'
                  : autoOpen && defaultTool
                    ? `Create and open in ${defaultTool.label}`
                    : 'Create'}
              </button>
            </div>
          </form>
        ) : (
          <div className="mt-5 space-y-3">
            <div className="space-y-1.5">
              {launchable.map((tool) => {
                const isDefault = tool.id === defaultTool?.id
                return (
                  <button
                    key={tool.id}
                    type="button"
                    autoFocus={isDefault}
                    disabled={openIn.isPending}
                    onClick={() => pickTool(step.agent, tool)}
                    className={`${CHOICE} ${
                      isDefault
                        ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/5'
                        : 'border-[var(--color-border)]'
                    }`}
                  >
                    {tool.kind === 'editor' ? <Code2 size={14} /> : <TerminalSquare size={14} />}
                    <span className="flex-1 text-[var(--color-text)]">{tool.label}</span>
                    {isDefault && (
                      <span className="text-[10px] text-[var(--color-text-muted)]">Default</span>
                    )}
                  </button>
                )
              })}
              {launchable.length === 0 && (
                <div className="rounded-lg border border-dashed border-[var(--color-border)] px-3 py-2.5 text-[11px] text-[var(--color-text-muted)]">
                  No coding assistant or editor was found on this machine. Install Claude Code,
                  Codex, OpenCode, VS Code or Cursor, then Refresh in Settings → Local Agents.
                </div>
              )}
              <div className="flex gap-1.5">
                <button
                  type="button"
                  disabled={openIn.isPending}
                  onClick={() => pickAction(step.agent, 'terminal')}
                  className={`${CHOICE} border-[var(--color-border)] py-2`}
                >
                  <TerminalSquare size={12} className="text-[var(--color-text-muted)]" />
                  <span className="text-[var(--color-text-secondary)]">Terminal</span>
                </button>
                <button
                  type="button"
                  disabled={openIn.isPending}
                  onClick={() => pickAction(step.agent, 'reveal')}
                  className={`${CHOICE} border-[var(--color-border)] py-2`}
                >
                  <FolderOpen size={12} className="text-[var(--color-text-muted)]" />
                  <span className="text-[var(--color-text-secondary)]">Reveal folder</span>
                </button>
              </div>
            </div>

            {/* Reserved: a launch refusal must not move the checkbox or Not now (UX rule 1). */}
            <div role="alert" className="min-h-8 text-[10px] text-[var(--color-danger)]">
              {error}
            </div>

            {launchable.length > 0 && (
              <label className="flex cursor-pointer items-center gap-2 text-[11px] text-[var(--color-text-secondary)]">
                <input
                  type="checkbox"
                  checked={rememberAuto ?? autoOpen}
                  onChange={(e) => setRememberAuto(e.target.checked)}
                  className="accent-[var(--color-accent)]"
                />
                Open new agents this way without asking
              </label>
            )}

            <div className="flex justify-end pt-1">
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1.5 rounded-md text-xs font-medium text-[var(--color-text-muted)]
                  hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] transition-colors"
              >
                Not now
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}
