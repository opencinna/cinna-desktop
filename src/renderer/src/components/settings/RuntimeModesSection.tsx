import { Loader2 } from 'lucide-react'
import type { MouseEvent } from 'react'
import { ChatModeCard } from './ChatModeCard'
import { SettingsInfoTip, SettingsSection } from './SettingsLayout'
import type { RuntimeChip } from './RuntimeChoiceButtons'
import { useAppSettings } from '../../hooks/useAppSettings'
import { useAntigravityBinary, useClaudeBinary, useCodexBinary } from '../../hooks/useEngine'
import { percentOf, useRuntimeSetup, type RuntimeSetupControl } from '../../hooks/useRuntimeSetup'
import { useUIStore } from '../../stores/ui.store'
import type { ChatModeData } from '../../constants/chatModeColors'
import { RUNTIME_MODE_ENGINES, type RuntimeModeAvailability } from '../../../../shared/chatModeRuntime'
import { isEngineLoginId, type AgentEngine, type EngineBinaryState, type EngineLoginId } from '../../../../shared/engine'

/** The one line a collapsed runtime card says about whether it can start a chat. */
const STATUS_TEXT: Record<RuntimeModeAvailability, string> = {
  ready: 'Ready',
  needs_install: 'Not installed',
  installing: 'Installing…',
  install_failed: 'Install failed',
  needs_login: 'Not logged in',
  needs_credential: 'Needs an AI credential'
}

/**
 * The chip a not-ready runtime card offers: the same next step, and the same
 * setup run, as the Agents tab's runtime cards (`useRuntimeCardSetup`). What
 * main reports (`availability`) decides it, and a run this window can see
 * (installing, signing in) takes over while it lasts. Nothing here asks for a
 * login: a probe is never fired for a runtime that is merely listed.
 */
export function runtimeModeChip({
  availability,
  phase,
  binary,
  pathSet
}: {
  availability: RuntimeModeAvailability
  phase: ReturnType<RuntimeSetupControl['phase']>
  binary: EngineBinaryState | undefined
  /** A configured path: what runs is the user's file, not something Cinna installs. */
  pathSet: boolean
}): RuntimeChip | null {
  if (phase === 'signing_in') return { kind: 'logging_in' }
  if (phase === 'installing' || availability === 'installing' || binary?.state === 'resolving') {
    return pathSet ? null : { kind: 'installing', percent: percentOf(binary) }
  }
  if (phase !== null) return null
  if (availability === 'needs_install') return pathSet ? null : { kind: 'install' }
  if (availability === 'install_failed') return pathSet ? null : { kind: 'retry' }
  if (availability === 'needs_login') return { kind: 'log_in' }
  if (availability === 'needs_credential') return { kind: 'add_credential' }
  return null
}

const CHIP_LABEL: Partial<Record<RuntimeChip['kind'], string>> = {
  install: 'Install',
  retry: 'Retry',
  log_in: 'Log in',
  add_credential: 'Add credential'
}

/**
 * Status line and chip, in a slot of fixed height: the header never changes
 * size as a runtime goes from Install to Installing to Ready (ux_rules rule 1).
 */
function RuntimeModeStatus({
  engine,
  availability,
  chip,
  phase,
  onChip
}: {
  engine: AgentEngine
  availability: RuntimeModeAvailability
  chip: RuntimeChip | null
  phase: ReturnType<RuntimeSetupControl['phase']>
  onChip: (chip: RuntimeChip) => void
}): React.JSX.Element {
  const text = phase === 'checking' ? 'Checking login…' : STATUS_TEXT[availability]
  const danger = availability === 'install_failed' || availability === 'needs_login'
  const press = (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation()
    if (chip) onChip(chip)
  }
  return (
    <div className="flex h-6 shrink-0 items-center gap-2" data-runtime-status={engine}>
      {!(chip?.kind === 'installing' || chip?.kind === 'logging_in') && (
        <span className={`whitespace-nowrap text-[13px] ${danger ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-muted)]'}`}>
          {availability === 'ready' && phase === null && <span aria-hidden="true" className="mr-1.5 inline-block h-2 w-2 rounded-full bg-[var(--color-success)]" />}
          {text}
        </span>
      )}
      {(chip?.kind === 'installing' || chip?.kind === 'logging_in') && (
        <span role="status" className="inline-flex items-center gap-1.5 whitespace-nowrap text-[13px] text-[var(--color-text-muted)]">
          <Loader2 size={13} className="shrink-0 animate-spin" aria-hidden="true" />
          {chip.kind === 'logging_in' ? 'Logging in…' : chip.percent === null ? 'Installing…' : `Installing ${chip.percent}%`}
        </span>
      )}
      {/* Bordered secondary, as `SettingsButton`, at the slot's height: a
          list of not-ready runtimes is a column of next steps, and four filled
          accent buttons would outshout the one action the tab is for (rules 2, 13). */}
      {chip && CHIP_LABEL[chip.kind] && (
        <button
          type="button"
          onClick={press}
          className="ambient-button inline-flex h-6 items-center whitespace-nowrap rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2.5 text-[12px] font-medium text-[var(--color-text)] transition-colors hover:bg-[var(--color-bg-hover)]"
        >
          {CHIP_LABEL[chip.kind]}
        </button>
      )}
    </div>
  )
}

/**
 * **Runtimes** (runtime modes): one card per agent runtime, in the Agents tab's order,
 * made by main for every runtime whether or not it is set up here. A card
 * edits like a saved mode, without Name or Runtime, and resets instead of
 * deleting. Not ready is a status on the card, never a banner.
 */
export function RuntimeModesSection({ modes }: { modes: ChatModeData[] }): React.JSX.Element | null {
  // Owned here, not by the chip it draws: pressing a chip changes it (ux_rules rule 5).
  const control = useRuntimeSetup()
  const { data: settings } = useAppSettings()
  const { data: claude } = useClaudeBinary()
  const { data: codex } = useCodexBinary()
  const { data: antigravity } = useAntigravityBinary()
  const binaries: Record<EngineLoginId, EngineBinaryState | undefined> = { claude, codex, antigravity }
  const pathSet: Record<EngineLoginId, boolean> = {
    claude: (settings?.localAgentsClaudePath ?? '').trim() !== '',
    codex: (settings?.localAgentsCodexPath ?? '').trim() !== '',
    antigravity: (settings?.localAgentsAntigravityPath ?? '').trim() !== ''
  }
  const ordered = RUNTIME_MODE_ENGINES.flatMap((engine) => {
    const mode = modes.find((candidate) => candidate.builtinEngine === engine && !candidate.managed)
    return mode ? [{ engine, mode }] : []
  })
  if (ordered.length === 0) return null

  const onChip = (engine: AgentEngine, chip: RuntimeChip): void => {
    if (chip.kind === 'add_credential') {
      useUIStore.getState().setSettingsMenu('llm')
      useUIStore.getState().setActiveView('settings')
      return
    }
    if (!isEngineLoginId(engine)) return
    if (chip.kind === 'install' || chip.kind === 'retry') control.setup(engine, { install: true })
    else if (chip.kind === 'log_in') control.setup(engine, { install: false, login: 'force' })
  }

  return (
    <SettingsSection title="Runtimes"
      info={<SettingsInfoTip label="Runtimes">Each agent runtime as a chat mode: talk to Claude Agent, Codex, Antigravity or OpenCode without making an agent. Ready runtimes are offered in the composer&apos;s Chat mode menu; star one to start new chats on it.</SettingsInfoTip>}>
      {ordered.map(({ engine, mode }) => {
        const availability = mode.runtime?.availability ?? 'ready'
        const login = isEngineLoginId(engine) ? engine : null
        const phase = login ? control.phase(login) : null
        const chip = runtimeModeChip({ availability, phase, binary: login ? binaries[login] : undefined, pathSet: login ? pathSet[login] : false })
        return (
          <ChatModeCard key={mode.id} mode={mode}
            runtimeStatus={mode.runtime ? <RuntimeModeStatus engine={engine} availability={availability} chip={chip} phase={phase} onChip={(next) => onChip(engine, next)} /> : null} />
        )
      })}
    </SettingsSection>
  )
}
