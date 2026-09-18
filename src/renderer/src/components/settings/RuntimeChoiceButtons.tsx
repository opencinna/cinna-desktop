import { Check, Download, Loader2 } from 'lucide-react'
import type { DetectedTool, RuntimeToolId } from '../../../../shared/localTools'
import { PINNED_CLAUDE_VERSION, PINNED_CODEX_VERSION, type AgentEngine, type EngineBinaryState } from '../../../../shared/engine'
import { codexVersionLabel } from './codexStatus'
import { claudeVersionLabel } from './claudeStatus'
import { SettingsBadge } from './SettingsLayout'

/**
 * One runtime the user can put their agents on.
 *
 * A table, not three blocks of JSX, because every button has to answer the same
 * three questions — is it here, is it selected, can it run an agent at all —
 * and three hand-written blocks is how one of them quietly stops answering one.
 *
 * `engine` is what selecting it writes. All listed runtimes have ACP launchers;
 * CLI runtimes offer installation when their executable is missing.
 */
export interface RuntimeChoice {
  /** Stable key for React and for the install dialog. */
  id: RuntimeToolId | 'opencode'
  label: string
  /** The detected tool this button reports, or null for the built-in runner. */
  tool: RuntimeToolId | null
  /** What selecting it writes, or null when this build cannot run agents on it. */
  engine: AgentEngine | null
  /**
   * The pinned version Cinna installs for itself, when it does. Such a runtime
   * is **always available** — detection is not consulted, nothing is offered
   * for install — and the sub-line names this version rather than whatever is
   * on the user's PATH, because the PATH copy is not what its sessions run on.
   */
  managedVersion?: string
}

export const RUNTIME_CHOICES: readonly RuntimeChoice[] = [
  // Both CLIs are managed like OpenCode below: Cinna verifies the pinned version
  // for itself on first use (its own download, or the user's install when that
  // is exactly the pin). `tool` stays, since the install dialog still knows each
  // as a tool the user can add for the terminal and "Open in…" — this picker
  // just never asks for it, and never waits on PATH detection.
  { id: 'claude', label: 'Claude Agent', tool: 'claude', engine: 'claude', managedVersion: PINNED_CLAUDE_VERSION },
  { id: 'codex', label: 'Codex', tool: 'codex', engine: 'codex', managedVersion: PINNED_CODEX_VERSION },
  // **Always available, and that is why it is the fallback.** Cinna downloads
  // and verifies its own `opencode` the first time an agent needs one, so this
  // is the only choice that is true on a machine with no developer tooling at
  // all. "Custom" because what it runs on is the credential named below it.
  { id: 'opencode', label: 'Custom OpenCode', tool: null, engine: 'opencode' }
]

/**
 * The Default runtime picker: one button per runtime, each reporting **two**
 * independent things — whether this machine has it, and whether agents are set
 * to use it.
 *
 * A button group rather than a `<select>`, because those two facts cannot be
 * expressed in an option label without it becoming a sentence, and because the
 * primary action for a runtime the user does not have is *install it*, which a
 * select cannot offer at all. Clicking a missing one installs it and then
 * selects it — one gesture for "I want to use this", whichever state it starts
 * in.
 *
 * Selection is `aria-pressed`, and the accessible name is the visible text by
 * construction — no `aria-label` — so the name a screen reader announces
 * branches with the sub-line exactly as the visible one does (ux_rules rule 10).
 */
export function RuntimeChoiceButtons({
  selected,
  tools,
  installing,
  onSelect,
  onInstall,
  disabled = false,
  defaultChoice,
  codexBinary,
  claudeBinary,
  codexPathSet = false,
  claudePathSet = false
}: {
  /** The stored pin. Nothing is selected while it is still being decided. */
  selected: AgentEngine | null
  /** Detection, or undefined while it is in flight — *not knowing* is a state. */
  tools: DetectedTool[] | undefined
  /** The runtime whose install is running, if any. */
  installing: RuntimeToolId | null
  onSelect: (engine: AgentEngine) => void
  onInstall: (tool: RuntimeToolId) => void
  disabled?: boolean
  defaultChoice?: { description: string; onSelect: () => void }
  /**
   * The Codex binary as resolved. With an explicit Codex Path in use the button
   * must not go on reading `<pin> managed` above a status line that says
   * "Unverified Codex … — your configured path". Same width either way: the
   * sub-line truncates inside a button whose width the label sets.
   */
  codexBinary?: EngineBinaryState
  /** The same, for Claude Code. */
  claudeBinary?: EngineBinaryState
  /**
   * Whether an explicit path is saved for each CLI. With one saved the managed
   * pin is not what runs, so the sub-line must not claim it in *any* state —
   * least of all after that path failed.
   */
  codexPathSet?: boolean
  claudePathSet?: boolean
}): React.JSX.Element {
  return (
    /*
      Wraps rather than scrolls: at the 800px minimum the three buttons and their
      sub-lines do not fit one row, and a horizontal scroller would hide the
      third choice behind a gesture nobody makes on a settings screen.
    */
    <div className="flex flex-wrap gap-2">
      {defaultChoice && <button
        type="button" aria-pressed={selected === null} disabled={disabled}
        onClick={defaultChoice.onSelect}
        className={`min-w-[8rem] flex-1 rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-50 ${selected === null ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10' : 'border-[var(--color-border)] bg-[var(--color-bg-secondary)] hover:enabled:bg-[var(--color-bg-hover)]'}`}
      >
        <span className="flex items-center gap-1.5 text-[13px] font-medium text-[var(--color-text)]"><span className="h-[14px] w-[14px] shrink-0">{selected === null && <Check size={14} className="text-[var(--color-accent)]" />}</span>Default Runtime</span>
        <span className="mt-0.5 block truncate pl-[1.375rem] text-[12px] text-[var(--color-text-muted)]" title={defaultChoice.description}>{defaultChoice.description}</span>
      </button>}
      {RUNTIME_CHOICES.map((choice) => {
        /**
         * Three states, and `undefined` is one of them: detection in flight is
         * not the same as "not installed", and rendering it as the latter puts
         * a Download icon on a runtime the machine has — then takes it away
         * (ux_rules rule 1).
         */
        const managed = choice.managedVersion !== undefined
        const detected =
          choice.tool === null || managed
            ? true
            : tools === undefined
              ? undefined
              : tools.some((tool) => tool.id === choice.tool && tool.available)
        const version = managed
          ? (choice.id === 'codex'
              ? codexVersionLabel(codexBinary, codexPathSet)
              : choice.id === 'claude'
                ? claudeVersionLabel(claudeBinary, claudePathSet)
                : `${choice.managedVersion} managed`)
          : choice.tool === null
            ? null
            : ((tools ?? []).find((tool) => tool.id === choice.tool)?.version ?? null)
        const isSelected = choice.engine !== null && choice.engine === selected
        const busy = installing !== null && installing === choice.id
        /** Nothing to do: it is here, and this build cannot run agents on it. */
        const inert = choice.engine === null && detected === true
        const sub =
          detected === undefined
            ? 'Checking…'
            : detected
              ? (version ?? (choice.tool === null ? 'Built in' : 'Installed'))
              : busy
                ? 'Installing…'
                : 'Not installed'

        return (
          <button
            key={choice.id}
            type="button"
            aria-pressed={isSelected}
            disabled={disabled || busy || inert || detected === undefined}
            onClick={() => {
              if (isSelected) return
              if (detected === false && choice.tool) {
                onInstall(choice.tool)
                return
              }
              if (choice.engine) onSelect(choice.engine)
            }}
            title={
              choice.engine === null
                ? `${choice.label} is detected and installable, but Cinna cannot run agents on it yet.`
                : detected === false
                  ? `Install ${choice.label} and run agents on it`
                  : `Run agents on ${choice.label}`
            }
            className={`${defaultChoice ? 'min-w-[8rem]' : 'min-w-[9.5rem]'} flex-1 rounded-lg border px-3 py-2 text-left transition-colors
              disabled:cursor-not-allowed ${
                isSelected
                  ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10'
                  : 'border-[var(--color-border)] bg-[var(--color-bg-secondary)] hover:enabled:bg-[var(--color-bg-hover)]'
              } ${inert ? 'opacity-60' : ''}`}
          >
            <span className="flex items-center gap-1.5">
              {/*
                One glyph slot, always occupied by something the same size, so a
                button does not change width when it becomes the selected one
                and shove the two beside it (ux_rules rule 1).
              */}
              <span className="flex h-[14px] w-[14px] shrink-0 items-center justify-center">
                {busy ? (
                  <Loader2 size={13} className="animate-spin text-[var(--color-text-muted)]" />
                ) : isSelected ? (
                  <Check size={14} className="text-[var(--color-accent)]" />
                ) : detected === false ? (
                  <Download size={13} className="text-[var(--color-text-muted)]" />
                ) : null}
              </span>
              <span className={`${defaultChoice ? 'min-w-0 text-[13px]' : 'truncate text-[14px]'} font-medium text-[var(--color-text)]`}>
                {choice.label}
              </span>
              {/* The one thing the sub-line cannot carry: *why* a detected
                  runtime is not selectable. */}
              {choice.engine === null && <SettingsBadge>Soon</SettingsBadge>}
            </span>
            <span className="mt-0.5 block truncate pl-[1.375rem] font-mono text-[12px] text-[var(--color-text-muted)]">
              {sub}
            </span>
          </button>
        )
      })}
    </div>
  )
}
