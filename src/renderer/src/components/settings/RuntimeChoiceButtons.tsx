import { Check, Download, Loader2 } from 'lucide-react'
import { useRef, type MouseEvent } from 'react'
import type { DetectedTool, RuntimeToolId } from '../../../../shared/localTools'
import {
  PINNED_ANTIGRAVITY_VERSION,
  PINNED_CLAUDE_VERSION,
  PINNED_CODEX_VERSION,
  type AgentEngine,
  type EngineBinaryState
} from '../../../../shared/engine'
import { codexVersionLabel } from './codexStatus'
import { claudeVersionLabel } from './claudeStatus'
import { antigravityVersionLabel } from './antigravityStatus'
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
export type RuntimeChoiceId = RuntimeToolId | 'antigravity' | 'opencode'

/**
 * What a **selected** card shows over itself.
 *
 * Something missing: a normal-size primary button centred over the card on a
 * translucent scrim (Install, Retry, Log in, Add credential) — clicking a card
 * only selects it, and anything that downloads or logs in is this button,
 * pressed on purpose. `installing` / `logging_in`: the same spot, as status.
 * `ready`: all set — no scrim, a green dot in the corner. Unselected cards
 * show nothing over themselves.
 */
export type RuntimeChip =
  | { kind: 'ready' }
  | { kind: 'install' }
  | { kind: 'installing'; percent: number | null }
  | { kind: 'retry' }
  | { kind: 'log_in' }
  | { kind: 'logging_in' }
  | { kind: 'add_credential' }

export interface RuntimeChoice {
  /** Stable key for React and for the install dialog. */
  id: RuntimeChoiceId
  label: string
  /** The detected tool this button reports, or null for the built-in runner. */
  tool: RuntimeToolId | null
  /** What selecting it writes, or null when this build cannot run agents on it. */
  engine: AgentEngine | null
  /**
   * The pinned version Cinna installs for itself, when it does. Such a runtime
   * is **always selectable** — detection is not consulted, and selecting it
   * downloads nothing — and the sub-line names this version rather than
   * whatever is on the user's PATH, because the PATH copy is not what its
   * sessions run on. "Not installed" when its binary is not on disk; the
   * selected card's Install chip is then the one way to fetch it.
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
  // Managed the same way, and no `tool`: Google ships no CLI for it to detect or
  // install — the ACP server Cinna downloads is the only copy there is.
  { id: 'antigravity', label: 'Antigravity', tool: null, engine: 'antigravity', managedVersion: PINNED_ANTIGRAVITY_VERSION },
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
 * selected runtime's next step (install it, sign in, add a credential) is a
 * chip on its card, which a select cannot offer at all.
 *
 * **Clicking a card only selects it.** Clicking through four cards must not
 * start four downloads of 100–300 MB; the Install chip on the selected card is
 * the explicit gesture for that.
 *
 * **A card is a positioned box holding the select button and, over it, the
 * overlay** — a button cannot nest in a button. The overlay is absolutely
 * positioned over the whole card, so neither it nor the dot ever changes the
 * card's size or touches its label (ux_rules rule 1). The select button stays
 * in the tab order underneath; a selected card is already pressed, so a click
 * on the scrim around the overlay's button has nothing to do.
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
  antigravityBinary,
  codexPathSet = false,
  claudePathSet = false,
  antigravityPathSet = false,
  chips,
  onChip
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
  /** The same, for the Antigravity server. */
  antigravityBinary?: EngineBinaryState
  /**
   * Whether an explicit path is saved for each CLI. With one saved the managed
   * pin is not what runs, so the sub-line must not claim it in *any* state —
   * least of all after that path failed.
   */
  codexPathSet?: boolean
  claudePathSet?: boolean
  antigravityPathSet?: boolean
  /** The chip on each card, by choice id — only the selected card's is drawn. */
  chips?: Partial<Record<RuntimeChoiceId, RuntimeChip>>
  onChip?: (id: RuntimeChoiceId) => void
}): React.JSX.Element {
  /**
   * When the selection last moved, and to what. A chip appears under the
   * pointer on the card just clicked, so the second click of a double-click
   * would land on Install and start a 100–300 MB download nobody asked for
   * (ux_rules rule 1): presses that soon after a selection are ignored. A
   * selection already there when the picker mounts is not a fresh one.
   */
  const selectedAt = useRef<{ value: AgentEngine | null; at: number }>({ value: selected, at: 0 })
  if (selectedAt.current.value !== selected) selectedAt.current = { value: selected, at: Date.now() }
  const pressChip = (id: RuntimeChoiceId, event: MouseEvent<HTMLButtonElement>): void => {
    if (event.detail > 1 || Date.now() - selectedAt.current.at < CHIP_SETTLE_MS) return
    onChip?.(id)
  }
  return (
    /*
      A grid of equal columns, not a wrapping flex row: four buttons wrapped as
      three plus one stretched across the whole second row, and five the same,
      so one choice looked unlike its siblings (ux_rules rule 12). Two columns
      where they do not fit one row, every button in one row once the container
      is wide enough — a container query, since the picker's width is its
      card's, not the window's. Wraps rather than scrolls: a horizontal scroller
      would hide a choice behind a gesture nobody makes on a settings screen.
    */
    <div className="@container">
    <div className={`grid grid-cols-2 gap-2 ${defaultChoice ? '@xl:grid-cols-3 @4xl:grid-cols-5' : '@2xl:grid-cols-4'}`}>
      {defaultChoice && <button
        type="button" aria-pressed={selected === null} disabled={disabled}
        onClick={defaultChoice.onSelect}
        className={`min-w-0 rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-50 ${selected === null ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10' : 'border-[var(--color-border)] bg-[var(--color-bg-secondary)] hover:enabled:bg-[var(--color-bg-hover)]'}`}
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
                : choice.id === 'antigravity'
                  ? antigravityVersionLabel(antigravityBinary, antigravityPathSet)
                  : `${choice.managedVersion} managed`)
          : choice.tool === null
            ? null
            : ((tools ?? []).find((tool) => tool.id === choice.tool)?.version ?? null)
        const isSelected = choice.engine !== null && choice.engine === selected
        const busy = installing !== null && installing === choice.id
        /** Nothing to do: it is here, and this build cannot run agents on it. */
        const inert = choice.engine === null && detected === true
        /**
         * A managed binary that is not on disk (`unresolved` after main's look)
         * — or being fetched now. Not with a path saved: that file is what
         * runs, and its state is the status line's to explain.
         */
        const managedBinary =
          choice.id === 'codex' ? codexBinary : choice.id === 'claude' ? claudeBinary : choice.id === 'antigravity' ? antigravityBinary : undefined
        const managedPathSet =
          choice.id === 'codex' ? codexPathSet : choice.id === 'claude' ? claudePathSet : choice.id === 'antigravity' ? antigravityPathSet : false
        const chip = isSelected ? chips?.[choice.id] : undefined
        // The words the progress chips leave out (they are a spinner).
        const managedSub =
          chip?.kind === 'logging_in'
            ? 'Logging in…'
            : managed && !managedPathSet
              ? chip?.kind === 'installing' || managedBinary?.state === 'resolving'
                ? 'Installing…'
                : managedBinary?.state === 'unresolved'
                  ? 'Not installed'
                  : null
              : null
        const sub =
          detected === undefined
            ? 'Checking…'
            : detected
              ? (managedSub ?? version ?? (choice.tool === null ? 'Built in' : 'Installed'))
              : busy
                ? 'Installing…'
                : 'Not installed'

        return (
          <div key={choice.id} className="relative min-w-0">
          <button
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
            className={`h-full w-full min-w-0 rounded-lg border px-3 py-2 text-left transition-colors
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
              <span className={`truncate ${defaultChoice ? 'text-[13px]' : 'text-[14px]'} font-medium text-[var(--color-text)]`} title={choice.label}>
                {choice.label}
              </span>
              {/* The one thing the sub-line cannot carry: *why* a detected
                  runtime is not selectable. */}
              {choice.engine === null && <SettingsBadge>Soon</SettingsBadge>}
            </span>
            <span className="mt-0.5 block truncate pl-[1.375rem] font-mono text-[12px] text-[var(--color-text-muted)]" title={sub}>
              {sub}
            </span>
          </button>
          {chip && <RuntimeChipControl chip={chip} disabled={disabled} onPress={(event) => pressChip(choice.id, event)} />}
          </div>
        )
      })}
    </div>
    </div>
  )
}

/** How long after a card becomes selected its overlay button ignores presses. */
const CHIP_SETTLE_MS = 400

/**
 * A selected card's overlay. The actions are the app's primary button, centred
 * on a scrim over the whole card; their visible text is their accessible name
 * (rule 10). Progress sits in the same spot as status text with a spinner. All
 * set is a green dot in the corner instead, and no scrim at all.
 */
function RuntimeChipControl({
  chip,
  disabled,
  onPress
}: {
  chip: RuntimeChip
  disabled: boolean
  onPress: (event: MouseEvent<HTMLButtonElement>) => void
}): React.JSX.Element {
  if (chip.kind === 'ready') {
    return (
      <span
        role="img"
        aria-label="Ready"
        title="Ready"
        className="pointer-events-none absolute right-2 top-2 h-2 w-2 rounded-full bg-[var(--color-success)]"
      />
    )
  }
  const scrim = 'runtime-card-scrim absolute inset-0 flex items-center justify-center rounded-lg'
  if (chip.kind === 'installing' || chip.kind === 'logging_in') {
    const text =
      chip.kind === 'logging_in' ? 'Logging in…' : chip.percent === null ? 'Installing…' : `Installing ${chip.percent}%`
    return (
      <div className={scrim}>
        <span role="status" className="inline-flex items-center gap-1.5 whitespace-nowrap text-[13px] font-medium text-[var(--color-text)]">
          <Loader2 size={14} className="shrink-0 animate-spin" aria-hidden="true" />
          {text}
        </span>
      </div>
    )
  }
  const label =
    chip.kind === 'install' ? 'Install' : chip.kind === 'retry' ? 'Retry' : chip.kind === 'log_in' ? 'Log in' : 'Add credential'
  return (
    <div className={scrim}>
      <button
        type="button"
        disabled={disabled}
        onClick={onPress}
        className="whitespace-nowrap rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:enabled:bg-[var(--color-accent-hover)] disabled:opacity-50"
      >
        {label}
      </button>
    </div>
  )
}
