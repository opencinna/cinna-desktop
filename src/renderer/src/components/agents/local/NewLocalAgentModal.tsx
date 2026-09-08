import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertTriangle,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  FolderInput,
  FolderOpen,
  Sparkles,
  TerminalSquare,
  X
} from 'lucide-react'
import { useUIStore } from '../../../stores/ui.store'
import {
  useAddAgentFolder,
  useAgentRoots,
  useCreateLocalAgent,
  usePickAgentFolder
} from '../../../hooks/useLocalAgents'
import { useDefaultTool, useOpenIn, useSetDefaultTool } from '../../../hooks/useLocalTools'
import { useSetAppSetting } from '../../../hooks/useAppSettings'
import {
  describeAgentSlug,
  BARE_AGENT_PROMPT_FILE,
  type DiscoveredBareAgent,
  type LocalAgentDto
} from '../../../../../shared/localAgents'
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

/** Dialog `aria-label` and heading per step. Tests and E2E find it by this. */
const DIALOG_LABEL: Record<Step['kind'], string> = {
  choose: 'Add an agent',
  name: 'New agent',
  folder: 'Add a folder',
  tool: 'Build it with'
}

/**
 * `choose` → (`name` | `folder`) → `tool`.
 *
 * The fork at the front exists because the two ways to get an agent have
 * nothing in common: one **writes** a kit folder into the agents home and hands
 * it to an assistant to build; the other **reads** a folder the user already
 * owns and changes nothing in it. Putting an "or point at an existing folder"
 * link under a name field would have made the second one look like an option on
 * the first, which it is not.
 */
type Step =
  | { kind: 'choose' }
  | { kind: 'name' }
  | { kind: 'folder'; pick: PickedFolder }
  | { kind: 'tool'; agent: LocalAgentDto }

/** The folder the user picked, and what is in it. Never a path they typed. */
interface PickedFolder {
  path: string
  folderName: string
  found: DiscoveredBareAgent[]
  /** The walk hit its cap, so `found` is the first N by path, not all of them. */
  truncated: boolean
  /**
   * The folder is already registered, so this pick **re-selects** which of its
   * agents are in the app rather than adopting it. Rows already added are then
   * ticked and editable — unticking one takes it out of the list — instead of
   * ticked and disabled.
   */
  reselecting: { rootId: string; label: string } | null
}

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

  const pickFolder = usePickAgentFolder()
  const addFolder = useAddAgentFolder()

  const [step, setStep] = useState<Step>({ kind: 'choose' })
  /** Root-relative paths ticked in the folder step. */
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  /** The name for a single adopted folder. Ignored when several are ticked. */
  const [folderAgentName, setFolderAgentName] = useState('')
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
    if (step.kind === 'name') nameRef.current?.focus()
  }, [step.kind])

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

  /**
   * Open the OS picker, then show what was found.
   *
   * A refusal — no `AGENT.md` anywhere, everything already added, a folder that
   * overlaps a registered root — keeps the dialog on the choice step and says
   * why, rather than closing (UX rule 6). Cancelling the picker is not a
   * refusal and says nothing at all.
   */
  const handlePickFolder = (): void => {
    setError(null)
    pickFolder.mutate(undefined, {
      onSuccess: (result) => {
        if (result.cancelled) return
        if (result.refusal !== null) {
          setError(result.refusal)
          return
        }
        /**
         * What starts ticked, and the two answers are different questions.
         *
         * A **first** adopt ticks everything: the user pointed at the folder to
         * get its agents, and opting one out is the rarer half.
         *
         * A **re-selection** opens on the state the app is actually in — the
         * agents that are in the list, ticked; the ones that are not, not. So
         * confirming without touching anything changes nothing, and an agent
         * the user removed earlier is not silently put back by a dialog they
         * opened to add a different one.
         *
         * There is no single-agent exception: a re-selection shows the checkbox
         * list however many agents the folder holds, because the one thing it
         * must be able to do is untick.
         */
        const reselecting = result.reselecting
        const preticked = result.found.filter((f) =>
          reselecting ? f.alreadyAdded : !f.alreadyAdded
        )
        setChosen(new Set(preticked.map((f) => f.relPath)))
        setFolderAgentName(result.found.length === 1 ? result.found[0].name : '')
        setStep({
          kind: 'folder',
          pick: {
            path: result.path,
            folderName: result.folderName,
            found: result.found,
            truncated: result.truncated,
            reselecting
          }
        })
      },
      onError: (err) => setError(unwrapIpcError(err, 'Could not open that folder.'))
    })
  }

  /** Adopt what was ticked, then land on the first of them. */
  const handleAddFolder = (pick: PickedFolder): void => {
    // Empty is a real answer when re-selecting — "take them all out of the
    // list" — and nothing to do on a first adopt.
    if ((chosen.size === 0 && pick.reselecting === null) || addFolder.isPending) return
    setError(null)
    /**
     * The name field belongs to a first adopt, and only there.
     *
     * It is prefilled from the folder, so sending it on a re-selection wrote
     * that value over an agent already in the list — renaming it silently, from
     * a dialog that says nothing about names. Main refuses it for an agent it is
     * not adding; this is the same rule on the side that composes the payload.
     */
    const single = pick.reselecting === null && pick.found.length === 1 && chosen.size === 1
    /** Agents this save puts into the list — what there is to land on. */
    const adding = pick.found.filter(
      (entry) => !entry.alreadyAdded && chosen.has(entry.relPath)
    ).length
    addFolder.mutate(
      {
        path: pick.path,
        relPaths: [...chosen],
        ...(single && folderAgentName.trim() !== '' ? { name: folderAgentName.trim() } : {})
      },
      {
        // Nothing was scaffolded and nothing needs opening in a tool, so there
        // is no second step here — but the user is still landed on what they
        // just added (ux_rules rule 3), the way the New agent branch is. Closing
        // straight to the empty pane left them reading "Select an agent from the
        // sidebar, or create one with +" with the agent they had just added
        // sitting unselected behind it. With several, the first: the sidebar
        // shows the rest under the new root either way.
        onSuccess: (result) => {
          // Newly added first, so this is the agent they came for. A
          // re-selection that only *removed* agents returns none, and lands the
          // user nowhere rather than on somebody else's page.
          const first = result.agentIds[0]
          if (first !== undefined && adding > 0) {
            setActiveLocalAgentId(first)
            setActiveView('local-agent')
          }
          onClose()
        },
        onError: (err) => setError(unwrapIpcError(err, 'Could not add that folder.'))
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
        aria-label={DIALOG_LABEL[step.kind]}
        className="w-full max-w-[30rem] rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-lg p-6"
      >
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
            title={step.kind === 'tool' ? 'Close' : 'Cancel'}
            aria-label={step.kind === 'tool' ? 'Close' : 'Cancel'}
          >
            <X size={14} />
          </button>
        </div>

        <div className="text-center space-y-2 -mt-2">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-[var(--color-accent)]/10">
            <Bot size={28} className="text-[var(--color-accent)]" />
          </div>
          <div className="text-lg font-semibold text-[var(--color-text)]">
            {step.kind === 'tool' ? `Build ${step.agent.name} with…` : DIALOG_LABEL[step.kind]}
          </div>
          {step.kind === 'tool' && (
            <div className="text-[11px] text-[var(--color-text-muted)]">
              The folder is ready. Open it in the tool you build agents with — your choice becomes
              the default.
            </div>
          )}
          {step.kind === 'folder' && <PickedPath path={step.pick.path} />}
        </div>

        {step.kind === 'choose' ? (
          <div className="mt-5 space-y-3">
            <button
              type="button"
              autoFocus
              onClick={() => {
                setError(null)
                setStep({ kind: 'name' })
              }}
              className={`${CHOICE} items-start border-[var(--color-border)]`}
            >
              <Sparkles size={16} className="mt-0.5 shrink-0 text-[var(--color-accent)]" />
              <span className="min-w-0">
                <span className="block font-medium text-[var(--color-text)]">New agent</span>
                <span className="block text-[11px] leading-relaxed text-[var(--color-text-muted)]">
                  Creates a folder in your agents folder, ready to build in Claude Code, Codex or
                  your editor.
                </span>
              </span>
            </button>
            <button
              type="button"
              disabled={pickFolder.isPending}
              onClick={handlePickFolder}
              className={`${CHOICE} items-start border-[var(--color-border)]`}
            >
              <FolderInput size={16} className="mt-0.5 shrink-0 text-[var(--color-accent)]" />
              <span className="min-w-0">
                <span className="block font-medium text-[var(--color-text)]">
                  {pickFolder.isPending ? 'Choosing…' : 'Add a folder'}
                </span>
                <span className="block text-[11px] leading-relaxed text-[var(--color-text-muted)]">
                  Any folder with an {BARE_AGENT_PROMPT_FILE}, or a folder holding several of
                  them. Adding it changes nothing inside it.
                </span>
              </span>
            </button>
            {/* Reserved: a refusal must not push the cards around (UX rule 1). */}
            <div role="alert" className="min-h-8 text-[10px] text-[var(--color-danger)]">
              {error}
            </div>
          </div>
        ) : step.kind === 'folder' ? (
          <FolderStep
            pick={step.pick}
            chosen={chosen}
            setChosen={setChosen}
            name={folderAgentName}
            setName={setFolderAgentName}
            error={error}
            isPending={addFolder.isPending}
            onBack={() => {
              setError(null)
              setStep({ kind: 'choose' })
            }}
            onAdd={() => handleAddFolder(step.pick)}
          />
        ) : step.kind === 'name' ? (
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

interface FolderStepProps {
  pick: PickedFolder
  chosen: Set<string>
  setChosen: (next: Set<string>) => void
  name: string
  setName: (next: string) => void
  error: string | null
  isPending: boolean
  onBack: () => void
  onAdd: () => void
}

/**
 * What was found in the picked folder, and what to do with it.
 *
 * Two shapes, one component, because they are the same question asked of one
 * folder or of fifteen:
 *
 * - **One agent** — the folder the user picked *is* the agent. The only thing
 *   left to decide is its name, which is prefilled from the `AGENT.md` heading
 *   or the folder name, so Enter is a complete answer (UX rule 3).
 * - **Several** — a repository of agents. Names come from each folder's own
 *   `AGENT.md`; naming fifteen of them at adoption time is work nobody asked
 *   for, and renaming one afterwards is a single action on its page.
 *
 * An agent already added **under another root** is shown, ticked and disabled,
 * rather than filtered out: a list that silently loses the row the user came to
 * add reads as the folder having been scanned wrong.
 *
 * Picking a folder that is **already registered** is not a clash but a
 * re-selection — the only surface that lists a repository's agents one by one,
 * and so the only place a sixteenth can be added after fifteen were. Its own
 * agents are then ticked and editable, and unticking one takes it out of the
 * list exactly as ⋯ → Remove from the list would. The folder on disk is
 * untouched in every direction.
 */
function FolderStep({
  pick,
  chosen,
  setChosen,
  name,
  setName,
  error,
  isPending,
  onBack,
  onAdd
}: FolderStepProps): React.JSX.Element {
  /**
   * The name step belongs to a first adopt of a one-agent folder.
   *
   * A re-selection always gets the checkbox list, however many agents the folder
   * holds: the one thing it must be able to do is untick, and a step with a text
   * field and no checkbox cannot. It also must not offer a name field at all —
   * the field is prefilled from the folder, and sending it back renamed an agent
   * the user had named themselves.
   */
  const single = pick.found.length === 1 && pick.reselecting === null
  /**
   * A row the user cannot touch: already an agent under a **different** root.
   * This pick speaks for one folder's contents, and that agent belongs to
   * another — so it stays ticked and disabled, and is shown rather than filtered
   * out, because a list that silently loses the row the user came for reads as a
   * bad scan.
   *
   * Outside a re-selection every added row is somebody else's by definition:
   * the folder being picked is not registered, so nothing in it can be its own.
   */
  const locked = (entry: DiscoveredBareAgent): boolean =>
    entry.addedElsewhere || (entry.alreadyAdded && pick.reselecting === null)
  const addable = pick.found.filter((entry) => !locked(entry))
  const allChosen = addable.length > 0 && addable.every((entry) => chosen.has(entry.relPath))
  /** What pressing the button will do, for a folder that is already registered. */
  const adding = pick.found.filter((entry) => !entry.alreadyAdded && chosen.has(entry.relPath))
  const leaving = pick.found.filter(
    (entry) => entry.alreadyAdded && !locked(entry) && !chosen.has(entry.relPath)
  )
  /**
   * Removing agents from the list is a destructive action, so it confirms —
   * named, recoverable half first, and the half that is not recoverable stated
   * (ux_rules rule 5). It is a step inside this dialog rather than a second
   * dialog over it: the list the user just edited is the context for the
   * question, and it stays on screen behind the confirmation.
   */
  const [confirming, setConfirming] = useState(false)
  const named = (entries: DiscoveredBareAgent[]): string => {
    const names = entries.map((entry) => entry.name)
    if (names.length <= 3) return names.join(', ')
    return `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`
  }
  const summary =
    adding.length > 0 && leaving.length > 0
      ? `${adding.length} to add, ${leaving.length} to remove from the list.`
      : adding.length > 0
        ? `${adding.length} to add.`
        : leaving.length > 0
          ? `${leaving.length} to remove from the list.`
          : ''

  const toggle = (relPath: string): void => {
    const next = new Set(chosen)
    if (next.has(relPath)) next.delete(relPath)
    else next.add(relPath)
    setChosen(next)
  }

  return (
    <form
      className="mt-5 space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        // The confirmation is the second press, never a dialog that appears
        // under the pointer of the first one.
        if (leaving.length > 0 && !confirming) {
          setConfirming(true)
          return
        }
        onAdd()
      }}
    >
      {single ? (
        <div className="space-y-1.5">
          <label htmlFor="folder-agent-name" className={LABEL}>
            Name
          </label>
          <input
            id="folder-agent-name"
            autoFocus
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={pick.found[0]?.name ?? pick.folderName}
            className={INPUT}
          />
          <div className="text-[10px] text-[var(--color-text-muted)]">
            {pick.found[0]?.hasReadme
              ? `${BARE_AGENT_PROMPT_FILE} is its instructions. README.md briefs an assistant that opens the folder to work on it.`
              : `${BARE_AGENT_PROMPT_FILE} is its instructions. Add a README.md to brief an assistant that opens the folder.`}
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className={LABEL}>
              {pick.found.length} agents in {pick.folderName}
            </span>
            <button
              type="button"
              disabled={addable.length === 0}
              onClick={() =>
                setChosen(allChosen ? new Set() : new Set(addable.map((entry) => entry.relPath)))
              }
              // Sized to the wider of the two labels, so the control does not
              // move under the pointer that just hit it — "Select all" is 48px
              // and "Clear all" 43px, and right-aligned that is a 5.5px jump on
              // the click (ux_rules rule 1). Same trick as the primary button's
              // `min-w`, which is why ticking fifteen boxes barely moves Back.
              className="min-w-[3.5rem] text-right text-[11px] text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)] disabled:opacity-40"
            >
              {allChosen ? 'Clear all' : 'Select all'}
            </button>
          </div>
          {/*
            The cap, said out loud. `discoverBareAgents` stops at 200 and the
            header above would otherwise read "200 agents in <folder>" over a
            list that is the first 200 by path — every count in it true, and all
            of them true of the wrong set. A user who ticks Select all and finds
            the agents they came for missing reads that as the scanner having
            failed to see those folders, which is the exact diagnosis the cap
            exists to prevent.
          */}
          {pick.truncated && (
            <div className="text-[10px] text-[var(--color-warning)]">
              This is the first {pick.found.length} folders found. Pick a folder closer to the
              agents to see the rest.
            </div>
          )}
          {/* Fifteen rows is the shape this was built against, so the list
              scrolls inside a fixed box rather than growing the dialog past
              the window (UX rule 1). */}
          <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border border-[var(--color-border)] p-1">
            {pick.found.map((entry) => (
              <label
                key={entry.relPath}
                title={locked(entry) ? 'Already added in another agents folder' : entry.path}
                className={`flex items-start gap-2 rounded px-2 py-1.5 text-xs ${
                  locked(entry)
                    ? 'cursor-default opacity-50'
                    : 'cursor-pointer hover:bg-[var(--color-bg-hover)]'
                }`}
              >
                <input
                  type="checkbox"
                  className="mt-0.5 accent-[var(--color-accent)]"
                  // Frozen while the confirmation is up: the question names
                  // agents, and a list that can still change under it would ask
                  // about one set and act on another.
                  disabled={locked(entry) || isPending || confirming}
                  checked={locked(entry) || chosen.has(entry.relPath)}
                  onChange={() => toggle(entry.relPath)}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[var(--color-text)]">{entry.name}</span>
                  <span className="block truncate font-mono text-[10px] text-[var(--color-text-muted)]">
                    {entry.relPath}
                  </span>
                </span>
                {locked(entry) && (
                  <Check size={12} className="mt-0.5 shrink-0 text-[var(--color-text-muted)]" />
                )}
              </label>
            ))}
          </div>
        </div>
      )}

      {/*
        What this list *is*, for a folder that is already registered — and what
        the button is about to do to it. One line of each, both always rendered
        so ticking a box cannot move the buttons under the pointer (UX rule 1).
        Removal is the half that needs saying: it is the same act as ⋯ → Remove
        from the list, and a job that used the agent has to be pointed at it
        again even if it comes back.
      */}
      {pick.reselecting !== null && !confirming && (
        <div className="space-y-0.5">
          <div className="text-[10px] text-[var(--color-text-muted)]">
            Already in the app as “{pick.reselecting.label}”. This is the whole list — the folder on
            disk is never touched either way.
          </div>
          {/* Reserved and single-line: what the button is about to do changes
              with every tick, and a line that wraps would move the buttons under
              the pointer that is ticking (UX rule 1). The consequence itself is
              the confirmation's job, not this line's. */}
          <div className="h-4 truncate text-[10px] text-[var(--color-warning)]" title={summary}>
            {summary}
          </div>
        </div>
      )}

      {confirming && (
        <div className="space-y-1.5 rounded-md border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/5 p-2.5">
          <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--color-danger)]">
            <AlertTriangle size={13} />
            Remove {leaving.length === 1 ? 'an agent' : `${leaving.length} agents`} from the list
          </div>
          {/*
            The same copy the ⋯ → Remove dialog owns, for the same act. The
            recoverable half first — the folders are not touched and this dialog
            puts them back — then the half that is not: `job_agents` cascades
            with the row and does not come back with it (ux_rules rule 5).
          */}
          {/*
            Two whole sentences rather than eight interleaved ternaries. The
            singular branch of the woven version read "The folder stay exactly
            where it is" — a form of bug that only shows up on screen, in the
            branch a reader of the code is least likely to render in their head.
          */}
          <p className="text-[11px] leading-relaxed text-[var(--color-text-secondary)]">
            <strong className="font-medium text-[var(--color-text)]">{named(leaving)}</strong>{' '}
            {leaving.length === 1
              ? 'leaves the list. Its folder stays exactly where it is, and ticking it here again puts it back. Existing chats stay but can no longer reach this agent, and any job that uses one will refuse to run — and will need it selected again even if you add it back.'
              : 'leave the list. Their folders stay exactly where they are, and ticking them here again puts them back. Existing chats stay but can no longer reach these agents, and any job that uses one will refuse to run — and will need it selected again even if you add it back.'}
          </p>
        </div>
      )}

      {/* Reserved: a refusal must not push the buttons down (UX rule 1). */}
      <div role="alert" className="min-h-8 text-[10px] text-[var(--color-danger)]">
        {error}
      </div>

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => (confirming ? setConfirming(false) : onBack())}
          disabled={isPending}
          className="px-3 py-1.5 rounded-md text-xs font-medium text-[var(--color-text-muted)]
            hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] transition-colors disabled:opacity-50"
        >
          {confirming ? 'Back to the list' : 'Back'}
        </button>
        <button
          type="submit"
          // Nothing ticked is nothing to adopt on a first pick, and a real
          // answer on a re-selection — "take them all out of the list" — which
          // this dialog now performs. Disabling it there would promise a
          // removal in one line and refuse it silently in the next.
          disabled={(chosen.size === 0 && pick.reselecting === null) || isPending}
          className={`min-w-[6.5rem] px-3 py-1.5 rounded-md text-xs font-medium text-white transition-colors
            disabled:opacity-30 disabled:cursor-not-allowed ${
              confirming
                ? 'bg-[var(--color-danger)] hover:opacity-90'
                : 'bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)]'
            }`}
        >
          {isPending
            ? pick.reselecting !== null
              ? 'Saving…'
              : 'Adding…'
            : confirming
              ? `Remove and save`
              : pick.reselecting !== null
                ? 'Save selection'
                : chosen.size > 1
                  ? `Add ${chosen.size} agents`
                  : 'Add agent'}
        </button>
      </div>
    </form>
  )
}

/**
 * The picked folder's path, with the **end** guaranteed to survive.
 *
 * An ordinary `truncate` cuts from the right, which on a path removes the only
 * part that identifies it: `/Users/me/Documents/work/clients/acme/support-agent`
 * becomes `/Users/me/Documents/work/clients/…`, and every folder the user might
 * have picked looks the same. This is the confirm step for adopting a folder,
 * so "which folder" is the one question it has to answer.
 *
 * Two spans rather than a bidi trick: the parent directory shrinks and
 * ellipsises, the basename never shrinks. No `direction: rtl`, so a leading `/`
 * cannot jump to the far end and no right-to-left locale renders it backwards.
 * The full path stays in `title` for hover — but hover is not confirmation,
 * which is why it is not the fix on its own.
 */
function PickedPath({ path }: { path: string }): React.JSX.Element {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const parent = cut > 0 ? path.slice(0, cut + 1) : ''
  const leaf = cut > 0 ? path.slice(cut + 1) : path

  return (
    <div
      className="flex min-w-0 justify-center font-mono text-[10px] text-[var(--color-text-muted)]"
      title={path}
    >
      <span className="truncate">{parent}</span>
      <span className="shrink-0">{leaf}</span>
    </div>
  )
}
