import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Loader2 } from 'lucide-react'
import type { LocalAgentDto } from '../../../../../../shared/localAgents'
import {
  VAULT_LAUNCH_EFFORTS_BY_ENGINE,
  VAULT_SWITCH_STEPS,
  VAULT_TAMPERED_TEXT,
  type VaultEngine,
  type VaultEngineChoiceDto,
  type VaultMoveProgressEvent,
  type VaultRunsWithOptions,
  type VaultSwitchStep,
  vaultImageDownloadText,
  vaultOtherBuildShortText,
  vaultTamperedText
} from '../../../../../../shared/vault/types'
import {
  VAULT_ENGINE_HOSTS,
  VAULT_ENGINE_LOGIN,
  VAULT_ENGINE_NAMES_MODEL,
  VAULT_ENGINES,
  VAULT_LAUNCH_PROVIDERS,
  VAULT_OPENCODE_DEFAULT_MODEL,
  vaultEngineKeyName,
  type VaultLaunchProvider
} from '../../../../../../shared/vault/protocol'
import {
  ANTIGRAVITY_TIER_MODEL,
  CLAUDE_TIER_ALIAS,
  codexEffortForComplexity,
  ENGINE_LOGIN_NAMES,
  opencodeVersionLabel
} from '../../../../../../shared/engine'
import {
  catalogDefaultModel,
  catalogNeedsRefresh,
  cliModelTier,
  effortsFor,
  type RuntimeModelCatalog
} from '../../../../../../shared/runtimeModelCatalog'
import {
  isWorkComplexity,
  WORK_COMPLEXITIES,
  WORK_COMPLEXITY_HINTS,
  WORK_COMPLEXITY_LABELS,
  type WorkComplexity
} from '../../../../../../shared/modelFamilies'
import {
  useVaultEngineAuth,
  useVaultEngines,
  useVaultSetRunsWith,
  useVaultStatus,
  useVaultSwitchEngine,
  useVaultSwitchingTo,
  useVaultUnlock,
  useVaultUnlocking,
  useVaultUnlockPercent,
  vaultErrorText
} from '../../../../hooks/useVault'
import { useAppSettings, useSetAppSetting } from '../../../../hooks/useAppSettings'
import { useRuntimeModelCatalog, useRuntimeModelCatalogRefresh } from '../../../../hooks/useRuntimeModelCatalog'
import { openAgentTab } from '../../../../utils/agentNavigation'
import { StableLabel } from '../../../chat/ComposerNoticePanel'
import { antigravityDefaultOptionLabel, antigravityRunModelLabel } from '../../../settings/antigravityStatus'
import { FIELD, FIELD_IN_ROW, LABEL, LINE_BUTTON } from '../fieldClasses'
import { ClaudeStatus } from '../EngineCell'
import { CANCEL, DIALOG_LABEL, DIALOG_NOTE, DialogFooter, FIELD_BASE, PRIMARY } from '../sharing/ShareDialogs'
import { VaultDialog } from './VaultDialog'
import { StepIcon, apiKeyPlaceholder, type StepStatus } from './MoveToVaultDialog'
import { VAULT_ENGINE_CHOICE_NAME as VAULT_ENGINE_NAME } from './vaultText'

const PROVIDER_NAME: Record<VaultLaunchProvider, string> = { openai: 'OpenAI', anthropic: 'Anthropic' }
const NOTE = 'text-[10px] text-[var(--color-text-muted)]'
const WARN_NOTE = 'text-[10px] text-[var(--color-warning)]'
const DANGER_NOTE = 'text-[10px] text-[var(--color-danger)]'

type Steps = Record<VaultSwitchStep, StepStatus>

/**
 * The panel's one line: what it says, its tone, and at most one inline action,
 * placed as the Runs-with panel places its own: a sign-in-like step (Unlock,
 * Add key) before the text, as Log in is; a follow-up (Refresh) after it.
 * `title` is the whole sentence when `text` is its short form.
 */
interface Line {
  text: string
  tone: string
  title?: string
  spinner?: boolean
  alert?: boolean
  /** `pendingLabel`: what the button says while pending, swapped in place at a fixed width (rule 1). */
  action?: { label: string; pending?: boolean; pendingLabel?: string; after?: true; onClick: () => void }
}
const emptySteps = (): Steps => Object.fromEntries(VAULT_SWITCH_STEPS.map((step) => [step, 'pending'])) as Steps

/** The vault engines whose model a host CLI catalogue lists (OpenCode names its own, in the switch dialog). */
type CliEngine = 'claude' | 'codex' | 'antigravity'
const CLI_OF: Record<VaultEngine, CliEngine | null> = { claude: 'claude', codex: 'codex', antigravity: 'antigravity', opencode: null }
/** Where the host panel offers an effort beside the model; main refuses one anywhere else. */
const TAKES_EFFORT: Record<VaultEngine, boolean> = { claude: true, codex: true, antigravity: false, opencode: false }
/** What runs inside when the Advanced picker names no model: no floor in a vault, so the CLI's (or server's) own. */
const ADVANCED_UNSET_RUNS: Record<CliEngine, (catalog: RuntimeModelCatalog | undefined, nameOf: (id: string) => string) => string> = {
  claude: () => 'Claude Code default',
  codex: (catalog, nameOf) => {
    const model = catalog?.source === 'session' ? catalogDefaultModel(catalog) : null
    return model ? `${nameOf(model)} (Codex default)` : 'Codex default'
  },
  antigravity: () => antigravityRunModelLabel(null, null)
}
/** The Engine cell's name for what runs inside, as the host panel names the same CLI. */
const STATUS_LABEL: Record<VaultEngine, string> = { claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity', opencode: 'opencode' }
/** Codex's tier is its *default* model at an effort, which only a session's list names (`cliModelTier`). */
const TIER_NEEDS_SESSION_LIST: Record<CliEngine, boolean> = { claude: false, codex: true, antigravity: false }

/**
 * What a tier pins when Advanced is ticked, as the host panel converts it:
 * Claude's alias, Antigravity's Flash level, Codex's default model at the
 * tier's effort (only an effort that model lists). Null: nothing honest to pin.
 */
const TIER_PIN: Record<CliEngine, (tier: WorkComplexity, catalog: RuntimeModelCatalog | undefined) => { model: string; effort: string | null } | null> = {
  claude: (tier) => ({ model: CLAUDE_TIER_ALIAS[tier], effort: null }),
  antigravity: (tier) => ({ model: ANTIGRAVITY_TIER_MODEL[tier], effort: null }),
  codex: (tier, catalog) => {
    const model = catalog?.source === 'session' ? catalogDefaultModel(catalog) : null
    if (!model) return null
    const wanted = codexEffortForComplexity(tier)
    return { model, effort: (effortsFor(catalog, model) ?? []).some((effort) => effort.id === wanted) ? wanted : null }
  }
}

/** The tier select's empty option: what runs inside when nothing is named (no floor in a vault). */
const TIER_UNSET: Record<CliEngine, () => string> = {
  claude: () => 'Not set — Claude Code default',
  codex: () => 'Default (medium effort)',
  antigravity: antigravityDefaultOptionLabel
}

/** What the agent runs on inside, for the healthy line; `nameOf` gives a model the catalogue's name. */
const RUNS_ON_TEXT: Record<CliEngine, (launch: VaultRunsWithOptions, nameOf: (id: string) => string) => string> = {
  claude: ({ model, effort, complexity }, nameOf) =>
    model ? `${nameOf(model)}${effort ? `, ${effort} effort` : ''}`
      : complexity ? nameOf(CLAUDE_TIER_ALIAS[complexity])
        : 'Claude Code’s default model',
  codex: ({ model, effort, complexity }, nameOf) =>
    model ? `${nameOf(model)}, ${effort ?? 'medium'} effort`
      : `Codex’s default model, ${codexEffortForComplexity(complexity)} effort`,
  antigravity: ({ model, complexity }, nameOf) =>
    model ? nameOf(model)
      : complexity ? nameOf(ANTIGRAVITY_TIER_MODEL[complexity])
        : antigravityRunModelLabel(null, null)
}

const capitalised = (id: string): string => id.charAt(0).toUpperCase() + id.slice(1)

/**
 * What a vault agent runs with, laid out as the Runs-with panel lays it out
 * for any other agent (`RuntimePanel`): **Runs on** (the four vault engines),
 * **Model / Work complexity** with Advanced and the effort beside the model,
 * from the host's catalogue for that engine and its tier mapping, and the
 * **Engine** cell (the runtime inside the vault and whether it is signed in).
 * Then one reserved line, the same height in every state (rule 1): locked,
 * it offers Unlock before its sentence, as Log in is offered (kept although
 * Overview, Credentials and Security offer their own: the Interface tab, and
 * Sharing for a shared agent, do not); signed out inside, Add key, which opens
 * the Security tab's Engine login; tampered, why, with nothing to press.
 *
 * A set-up engine (other than OpenCode, which always names a model) switches
 * at once; any other opens the setup dialog. A model, effort or complexity is
 * written into the vault's own launch settings (`vault:set-runs-with`); while
 * the vault is locked the controls show the last values the row recorded,
 * disabled. OpenCode's Model column is a button that opens its switch dialog,
 * where provider and model change together.
 */
export function VaultEnginePanel({ agent }: { agent: LocalAgentDto }): React.JSX.Element | null {
  const vault = agent.vault
  const status = useVaultStatus(agent.id).data
  const state = status?.state ?? vault?.state
  const open = state === 'unlocked'
  const engines = useVaultEngines(agent.id, open)
  const auth = useVaultEngineAuth(agent.id, open)
  const switchEngine = useVaultSwitchEngine(agent.id)
  const switchingTo = useVaultSwitchingTo(agent.id)
  const setRunsWith = useVaultSetRunsWith(agent.id)
  const unlock = useVaultUnlock()
  // From any surface: an unlock the sidebar's menu started shows here too.
  const unlockInFlight = useVaultUnlocking(agent.id)
  const unlockPercent = useVaultUnlockPercent(agent.id)
  const unlockDownload = unlockPercent === null ? null : vaultImageDownloadText(unlockPercent)
  const { data: settings } = useAppSettings()
  const setSetting = useSetAppSetting()
  const current = vault?.engine ?? 'claude'
  const cli = CLI_OF[current]
  const { data: catalog } = useRuntimeModelCatalog(cli)
  const [dialog, setDialog] = useState<VaultEngine | null>(null)
  /** OpenCode's provider and model to open the dialog with (Change model…), else its defaults. */
  const [prefill, setPrefill] = useState<{ provider: VaultLaunchProvider; model: string } | null>(null)
  const [steps, setSteps] = useState<Steps>(emptySteps)
  /** This agent's picker once the user moved it (sticky, as the host panel's): see `RuntimePanel`. */
  const [view, setView] = useState<{ agentId: string; advanced: boolean } | null>(null)
  /** What the last conversion did, said on the line until the next change. */
  const [note, setNote] = useState<{ agentId: string; text: string } | null>(null)

  // While a write is in flight (until the agent is read again) the controls show what it writes.
  const writing = setRunsWith.isPending ? setRunsWith.variables : undefined
  const declaredModel = writing ? writing.model : (vault?.model ?? null)
  const declaredEffort = writing ? writing.effort : declaredModel ? (vault?.effort ?? null) : null
  const rowComplexity = vault?.complexity
  const declaredComplexity = writing ? writing.complexity : !declaredModel && isWorkComplexity(rowComplexity) ? rowComplexity : null
  const declaredView = declaredModel !== null ? true : declaredComplexity !== null ? false : null
  const advanced = view?.agentId === agent.id ? view.advanced : (declaredView ?? settings?.localAgentsModelAdvanced === true)
  /** Which picker is not known until the remembered preference arrives (no swap, rule 1). */
  const pickerUnknown = cli !== null && declaredView === null && view?.agentId !== agent.id && settings === undefined

  /** The host's list is usable: read from a session or a cache, and not empty. */
  const catalogKnown = !!catalog && catalog.source !== 'unavailable' && catalog.models.length > 0
  const codexDefault = catalog?.source === 'session' ? catalogDefaultModel(catalog) : null
  /** Unticking converts by the default model, which only a session's list names: wait until it is known. */
  const conversionPending = cli !== null && TIER_NEEDS_SESSION_LIST[cli] && declaredModel !== null && codexDefault === null
  /**
   * Ask the host's CLI for its list as the host panel does (`RuntimePanel`):
   * while the Advanced picker is on screen and the list is missing or a day
   * old, while a Codex conversion waits for it, and when a model is named and
   * no list is known (so it is shown by name). Nothing is billed.
   */
  const wantRefresh = cli !== null && catalog !== undefined && (conversionPending ||
    (advanced && !pickerUnknown && catalogNeedsRefresh(catalog)) || (declaredModel !== null && !catalogKnown))
  const refresh = useRuntimeModelCatalogRefresh(cli, wantRefresh)
  /**
   * Unticking waits for the list only while it may still come. When the host
   * can't list Codex's models (no host Codex, or not signed in — normal for a
   * vault agent), waiting would block forever: the untick drops the model to
   * Default instead, as it does when no tier fits.
   */
  const conversionBlocked = conversionPending && !refresh.data?.error && catalog?.source !== 'unavailable'

  // A refused write said on the line belongs to the state it was refused in: locking or unlocking clears it.
  const resetSave = setRunsWith.reset
  useEffect(() => { resetSave() }, [open, resetSave])

  if (!vault) return null
  const choices = engines.data ?? null
  const choiceOf = (engine: VaultEngine): VaultEngineChoiceDto | undefined => choices?.find((c) => c.engine === engine)

  const start = (options: Parameters<typeof switchEngine.mutate>[0]['options'], fromDialog: boolean): void => {
    setSteps(emptySteps())
    setNote(null)
    setRunsWith.reset()
    switchEngine.reset()
    switchEngine.mutate(
      {
        options,
        onEvent: (event: VaultMoveProgressEvent) => {
          if ((VAULT_SWITCH_STEPS as readonly string[]).includes(event.step)) {
            setSteps((prev) => ({ ...prev, [event.step as VaultSwitchStep]: event.status }))
          }
        }
      },
      // Success closes the dialog; a failure keeps it open with the step's sentence (rule 6).
      { onSuccess: () => { if (fromDialog) setDialog(null) } }
    )
  }

  const choose = (engine: VaultEngine): void => {
    if (engine === current) return
    setRunsWith.reset()
    // An engine that names its model (OpenCode) always asks for it in the dialog.
    if (!VAULT_ENGINE_NAMES_MODEL[engine] && choiceOf(engine)?.setUp) start({ engine }, false)
    else {
      switchEngine.reset()
      setSteps(emptySteps())
      setPrefill(null)
      setDialog(engine)
    }
  }

  /** OpenCode on another provider or model: the select cannot say it (it is already on OpenCode). */
  const changeOpencodeModel = (): void => {
    switchEngine.reset()
    setSteps(emptySteps())
    const provider = vault.provider ?? 'openai'
    setPrefill({ provider, model: vault.model ?? VAULT_OPENCODE_DEFAULT_MODEL[provider] })
    setDialog('opencode')
  }

  const switching = switchEngine.isPending || switchingTo !== null
  const saving = setRunsWith.isPending
  const editable = open && !switching && !saving
  const cliName = cli ? ENGINE_LOGIN_NAMES[cli] : ''
  const nameOf = (id: string): string => catalog?.models.find((model) => model.id === id)?.name ?? id
  /** Nothing to list yet: the catalogue query, or a refresh of a missing one, is in flight. */
  const catalogLoading = cli !== null && (catalog === undefined || (!catalogKnown && refresh.isFetching))
  const refreshError = refresh.data?.error ?? null
  const refreshing = cli !== null && refresh.isFetching
  /**
   * The tool's own `default` entry (Claude lists one) is an ordinary choice,
   * named as the host panel names it; "Not set — <what runs>" is the empty
   * option, which in a vault is the CLI's own default (no floor).
   */
  const toolDefault = catalog?.models.find((model) => model.id === 'default') ?? null
  const toolDefaultLabel = toolDefault
    ? `${cliName} default${toolDefault.description && toolDefault.description.length <= 24 ? ` (${toolDefault.description})` : ''}`
    : ''
  // Only the efforts this engine takes inside (main refuses any other).
  const takes: readonly string[] = VAULT_LAUNCH_EFFORTS_BY_ENGINE[current]
  const efforts = (effortsFor(catalog, declaredModel) ?? [])
    .filter((effort) => effort.id !== 'default' && takes.includes(effort.id))
  const advancedUnset = cli ? `Not set — ${ADVANCED_UNSET_RUNS[cli](catalog, nameOf)}` : ''

  /** Write model, effort and complexity; `view` is the picker it leaves (and remembers, when toggled). */
  const save = (options: VaultRunsWithOptions, after: { view?: boolean; note?: string } = {}): void => {
    setNote(null)
    const agentId = agent.id
    setRunsWith.mutate(options, {
      onSuccess: () => {
        setView({ agentId, advanced: after.view ?? advanced })
        if (after.view !== undefined) setSetting.mutate({ key: 'localAgentsModelAdvanced', value: after.view })
        if (after.note) setNote({ agentId, text: after.note })
      }
    })
  }

  const changeModel = (model: string | null): void => {
    // The effort follows the model when the new one offers it (or nothing is known); else it goes, said.
    const offered = effortsFor(catalog, model)
    const keeps = declaredEffort !== null && model !== null && (offered === undefined || offered.some((effort) => effort.id === declaredEffort))
    save(
      { model, effort: keeps ? declaredEffort : null, complexity: null },
      declaredEffort && model && !keeps ? { note: `Dropped “${declaredEffort}” effort — ${nameOf(model)} does not offer it.` } : {}
    )
  }

  /** Advanced converts, as on the host panel: a tier becomes the model it runs on, a model the tier it belongs to. */
  const toggleAdvanced = (next: boolean): void => {
    setNote(null)
    if (!cli) return
    if (next && declaredComplexity !== null) {
      const tierLabel = WORK_COMPLEXITY_LABELS[declaredComplexity]
      const pin = TIER_PIN[cli](declaredComplexity, catalog)
      if (!pin) {
        setView({ agentId: agent.id, advanced: true })
        setSetting.mutate({ key: 'localAgentsModelAdvanced', value: true })
        setNote({ agentId: agent.id, text: `Still ${tierLabel} — ${cliName} has not listed its models yet. Pick one to replace it.` })
        return
      }
      save({ model: pin.model, effort: pin.effort, complexity: null }, {
        view: true,
        note: `Pinned “${nameOf(pin.model)}”${pin.effort ? ` at ${pin.effort} effort` : ''} — what ${tierLabel} ran on.`
      })
      return
    }
    if (!next && declaredModel !== null) {
      if (conversionBlocked) return
      const name = nameOf(declaredModel)
      const tier = cliModelTier(cli, declaredModel, declaredEffort, catalog)
      if (tier) {
        save({ model: null, effort: null, complexity: tier.tier }, {
          view: false,
          note: tier.tier
            ? `Switched to ${WORK_COMPLEXITY_LABELS[tier.tier]} — the tier “${name}” belongs to.`
            : `Switched to Default — “${name}” is ${cliName}’s default.`
        })
        return
      }
      // Only the effort has no tier (Opus at high): keep the model's tier and drop the effort.
      const modelTier = declaredEffort ? cliModelTier(cli, declaredModel, null, catalog) : null
      if (modelTier) {
        save({ model: null, effort: null, complexity: modelTier.tier }, {
          view: false,
          note: `Switched to ${modelTier.tier ? WORK_COMPLEXITY_LABELS[modelTier.tier] : 'Default'} — the tier “${name}” belongs to. Dropped “${declaredEffort}” effort.`
        })
        return
      }
      save({ model: null, effort: null, complexity: null }, { view: false, note: `Dropped “${name}” — no complexity fits it, so Default now.` })
      return
    }
    setView({ agentId: agent.id, advanced: next })
    setSetting.mutate({ key: 'localAgentsModelAdvanced', value: next })
  }

  const target = switchingTo ?? (switchEngine.isPending ? switchEngine.variables?.options.engine ?? null : null)
  // The dialog says its own failure; the line says one of a switch started from the select.
  const lineError = !dialog && switchEngine.error ? vaultErrorText(switchEngine.error) : null
  const saveError = setRunsWith.error ? vaultErrorText(setRunsWith.error) : null
  const signedOut = open && auth.data?.loggedIn === false
  const keyName = auth.data?.keyName ?? vaultEngineKeyName(current, vault.provider ?? null)
  const opencodeModel = vault.model && vault.provider ? `${vault.provider}/${vault.model}` : null
  const runsOnText = cli
    ? `on ${RUNS_ON_TEXT[cli]({ model: declaredModel, effort: declaredEffort, complexity: declaredComplexity }, nameOf)}`
    // OpenCode's model is in its column; the line says whose API it signs in to.
    : vault.provider ? `on the ${PROVIDER_NAME[vault.provider]} API` : 'on OpenCode’s default model'
  // Booting is an unlock already under way.
  const unlocking = unlockInFlight || state === 'booting'
  // Another build made it, or it failed its check: nothing here opens it (Delete is on the Security tab).
  const otherBuild = state === 'tampered' ? (status?.otherBuild ?? vault.otherBuild ?? null) : null
  const startUnlock = (): void => {
    setRunsWith.reset()
    unlock.reset()
    unlock.mutate(agent.id)
  }

  /**
   * What the reserved line says about the host's model list, as the host panel
   * says it (`cliCatalogLine`): only in the Advanced view, where the list is
   * the control, and while a Codex conversion waits for it. Short, so it fits
   * at 800px; Refresh asks again past the ten-minute wait.
   */
  const catalogLine = (): Line | null => {
    if (!cli) return null
    const checking: Line = { text: `Checking ${cliName}’s models…`, tone: NOTE }
    const failed: Line = { text: `Couldn’t list ${cliName}’s models.`, title: refreshError ?? undefined, tone: WARN_NOTE, action: { label: 'Refresh', after: true, onClick: () => refresh.retry() } }
    if (advanced && !pickerUnknown && (catalogLoading || (refreshing && !catalogKnown))) return checking
    if (conversionPending) {
      if (refreshError) return failed
      if (refreshing) return checking
    }
    if (advanced && !pickerUnknown && !catalogKnown) {
      return refreshError ? failed : { text: `${cliName} has not listed its models yet.`, tone: WARN_NOTE, action: { label: 'Refresh', after: true, onClick: () => refresh.retry() } }
    }
    return null
  }

  const line = ((): Line => {
    if (state === 'tampered') {
      return {
        text: otherBuild ? `${vaultOtherBuildShortText(otherBuild)} — this version can’t open it.` : VAULT_TAMPERED_TEXT,
        title: vaultTamperedText(otherBuild),
        tone: WARN_NOTE
      }
    }
    if (!open) {
      if (unlocking) {
        return {
          text: unlockDownload ?? (state === 'booting' ? 'Waiting for the vault helper…' : 'Unlocking asks for Touch ID or your password.'),
          tone: NOTE,
          action: { label: 'Unlock', pending: true, pendingLabel: 'Unlocking…', onClick: startUnlock }
        }
      }
      return {
        text: unlock.error ? vaultErrorText(unlock.error, 'Unlock was cancelled at the prompt.') : 'Unlock the vault to change how it runs.',
        tone: unlock.error ? DANGER_NOTE : NOTE,
        alert: !!unlock.error,
        action: { label: 'Unlock', pendingLabel: 'Unlocking…', onClick: startUnlock }
      }
    }
    if (switching) return { text: `Switching to ${VAULT_ENGINE_NAME[target ?? current]}…`, tone: NOTE, spinner: true }
    if (lineError) return { text: lineError, tone: DANGER_NOTE, alert: true }
    if (saveError) return { text: saveError, tone: DANGER_NOTE, alert: true }
    if (engines.isError) {
      return { text: 'Couldn’t read the vault’s engines.', tone: DANGER_NOTE, alert: true, action: { label: 'Refresh', after: true, onClick: () => void engines.refetch() } }
    }
    if (signedOut) {
      // Short enough for 800px; the key itself is added on the Security tab's Engine login.
      const what = VAULT_ENGINE_LOGIN[current]?.what ?? (keyName ? `its ${keyName}` : 'a key')
      return {
        text: 'Not signed in inside the vault.',
        title: `Not signed in inside the vault — add ${what} on the Security tab.`,
        tone: WARN_NOTE,
        action: { label: 'Add key', onClick: () => openAgentTab(agent.id, 'security') }
      }
    }
    if (note && note.agentId === agent.id) return { text: note.text, tone: NOTE }
    return catalogLine() ?? { text: `Runs inside the vault ${runsOnText}.`, tone: NOTE }
  })()

  const version = choiceOf(current)?.version ?? null
  const authState = !open || !auth.data ? undefined : auth.data.loggedIn ? 'logged_in' as const : 'logged_out' as const

  return (
    <section
      aria-label="Runs with"
      className="@container relative rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-4 py-3"
    >
      {/* Out of the flow, as on the host panel: a save indicator that adds a row would move the tabs below. */}
      {saving && (
        <Loader2 size={12} aria-label="Saving" className="absolute right-3 top-3 animate-spin text-[var(--color-text-muted)]" />
      )}
      <div className="grid grid-cols-2 gap-3 @2xl:grid-cols-3">
        <div>
          <label htmlFor="vault-engine" className={LABEL}>
            Runs on
          </label>
          <select
            id="vault-engine"
            className={FIELD}
            value={current}
            disabled={!open || switching || saving || !choices}
            aria-busy={switching || undefined}
            onChange={(event) => choose(event.target.value as VaultEngine)}
          >
            {VAULT_ENGINES.map((engine) => (
              <option key={engine} value={engine}>
                {VAULT_ENGINE_NAME[engine]}
                {choices && engine !== current && !choiceOf(engine)?.setUp ? ' — needs setup' : ''}
              </option>
            ))}
          </select>
        </div>

        <div>
          {/* Label and Advanced share one row in every state, so nothing here changes height (rule 1). */}
          <div className="mb-1 flex h-[15px] items-center justify-between gap-2">
            <label
              htmlFor={cli === null ? 'vault-model' : pickerUnknown ? 'vault-model-pending' : advanced ? 'vault-model' : 'vault-complexity'}
              className={`${LABEL} mb-0`}
            >
              {cli === null ? 'Model' : pickerUnknown ? 'Model choice' : advanced ? 'Model' : 'Work complexity'}
            </label>
            {/* OpenCode has no tier: the checkbox keeps its place, unseen. */}
            <label
              className={`flex shrink-0 cursor-pointer items-center gap-1 text-[10px] text-[var(--color-text-muted)]
                transition-colors hover:text-[var(--color-text)] ${cli === null ? 'invisible' : ''}`}
              aria-hidden={cli === null || undefined}
              title={conversionBlocked ? `${cliName} has not listed its models yet.` : 'Pick the exact model instead of how hard the work is'}
            >
              <input
                type="checkbox"
                className="size-3 accent-[var(--color-accent)]"
                checked={cli !== null && advanced}
                disabled={!editable || cli === null || conversionBlocked}
                onChange={(event) => toggleAdvanced(event.target.checked)}
              />
              Advanced
            </label>
          </div>
          {cli === null ? (
            /*
              OpenCode's provider and model change together in its switch
              dialog, so the column is that dialog's button, drawn as the field
              it stands in for (a select that cannot change would offer a
              choice it does not have).
            */
            <button
              type="button"
              id="vault-model"
              aria-haspopup="dialog"
              aria-label={`Model: ${opencodeModel ?? 'not set'}. Change model…`}
              title="Change model…"
              className={`${FIELD} flex items-center justify-between gap-1 text-left`}
              disabled={!editable}
              onClick={changeOpencodeModel}
            >
              <span className="min-w-0 truncate">{opencodeModel ?? 'Not set — OpenCode default'}</span>
              <ChevronDown size={12} aria-hidden="true" className="shrink-0 text-[var(--color-text-muted)]" />
            </button>
          ) : pickerUnknown ? (
            <select id="vault-model-pending" aria-label="Model choice" className={FIELD} disabled>
              <option>Loading…</option>
            </select>
          ) : advanced ? (
            <div className="flex gap-1">
              <select
                id="vault-model"
                aria-label="Model"
                className={`${FIELD_IN_ROW} min-w-0 flex-1`}
                title={declaredModel ?? undefined}
                disabled={!editable || catalogLoading}
                value={catalogLoading ? '' : (declaredModel ?? '')}
                onChange={(event) => changeModel(event.target.value || null)}
              >
                {catalogLoading ? (
                  <option value="">Checking models…</option>
                ) : (
                  <>
                    <option value="">{advancedUnset}</option>
                    {/* Still selectable when the list lacks it, so the select never misreports the vault. */}
                    {declaredModel && !(catalog?.models ?? []).some((model) => model.id === declaredModel) && (
                      <option value={declaredModel}>{declaredModel}</option>
                    )}
                    {(catalog?.models ?? []).map((model) => (
                      <option key={model.id} value={model.id} title={model.description ? `${model.id} — ${model.description}` : model.id}>
                        {model === toolDefault ? toolDefaultLabel : model.name}
                      </option>
                    ))}
                  </>
                )}
              </select>
              {TAKES_EFFORT[current] && (
                <select
                  id="vault-effort"
                  aria-label="Effort"
                  title={declaredModel ? 'Reasoning effort' : 'Pick a model to set its reasoning effort'}
                  className={`${FIELD_IN_ROW} w-[4.75rem] shrink-0`}
                  disabled={!editable || catalogLoading || declaredModel === null || efforts.length === 0}
                  value={declaredEffort ?? ''}
                  onChange={(event) => save({ model: declaredModel, effort: event.target.value || null, complexity: null })}
                >
                  <option value="">Default</option>
                  {declaredEffort && !efforts.some((effort) => effort.id === declaredEffort) && (
                    <option value={declaredEffort}>{capitalised(declaredEffort)}</option>
                  )}
                  {efforts.map((effort) => (
                    <option key={effort.id} value={effort.id} title={effort.name}>
                      {capitalised(effort.id)}
                    </option>
                  ))}
                </select>
              )}
            </div>
          ) : (
            <select
              id="vault-complexity"
              aria-label="Work complexity"
              className={FIELD}
              title={WORK_COMPLEXITIES.map((tier) => `${WORK_COMPLEXITY_LABELS[tier]} — ${WORK_COMPLEXITY_HINTS[tier]}`).join('\n')}
              disabled={!editable}
              value={declaredComplexity ?? ''}
              onChange={(event) => save({ model: null, effort: null, complexity: isWorkComplexity(event.target.value) ? event.target.value : null })}
            >
              <option value="">{TIER_UNSET[cli]()}</option>
              {WORK_COMPLEXITIES.map((tier) => (
                <option key={tier} value={tier} title={WORK_COMPLEXITY_HINTS[tier]}>
                  {WORK_COMPLEXITY_LABELS[tier]}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="col-span-2 @2xl:col-span-1">
          <ClaudeStatus
            label={STATUS_LABEL[current]}
            tool={{ path: null, version: version ? (cli === null ? opencodeVersionLabel(version) : version) : null }}
            unknown={open && !choices && !engines.isError}
            auth={authState}
            hint={!open
              ? 'Inside the vault. Unlock it to check its engine.'
              : authState === 'logged_out' ? 'Inside the vault, not signed in.' : 'Inside the vault.'}
          />
        </div>
      </div>

      {/* A reserved line: what it says changes, its height never does (rule 1); its button is h-4 too. */}
      <div className="mt-2 h-4">
        <div className="flex h-4 min-w-0 items-center gap-2" role={line.alert ? 'alert' : undefined}>
          {line.action && !line.action.after && <LineAction action={line.action} />}
          <span className={`flex min-w-0 items-center gap-1.5 ${line.tone}`}>
            {line.spinner && <Loader2 size={10} className="shrink-0 animate-spin" aria-hidden="true" />}
            <span className="min-w-0 truncate" title={line.title ?? line.text}>{line.text}</span>
          </span>
          {line.action?.after && <LineAction action={line.action} />}
        </div>
      </div>
      {dialog && (
        <VaultEngineSetupDialog
          engine={dialog}
          setUp={dialog === current || (choiceOf(dialog)?.setUp ?? false)}
          initial={dialog === 'opencode' ? prefill : null}
          allowedHosts={status?.egress.hosts ?? []}
          pending={switchEngine.isPending}
          steps={steps}
          error={switchEngine.error ? vaultErrorText(switchEngine.error) : null}
          onCancel={() => {
            switchEngine.reset()
            setDialog(null)
            setPrefill(null)
          }}
          onSubmit={(options) => start({ engine: dialog, ...options }, true)}
        />
      )}
    </section>
  )
}

/**
 * The line's inline button, at the line's own height; pending, a spinner and
 * no second click. One with a `pendingLabel` keeps one width idle and pending
 * (`StableLabel`): Unlock and "Unlocking…" swap in place, so neither the button
 * nor the sentence after it moves (rules 1 and 19).
 */
function LineAction({ action }: { action: NonNullable<Line['action']> }): React.JSX.Element {
  const pending = action.pending === true
  return (
    <button
      type="button"
      className={LINE_BUTTON}
      aria-disabled={pending || undefined}
      aria-busy={pending || undefined}
      onClick={() => { if (!pending) action.onClick() }}
    >
      {action.pendingLabel !== undefined ? (
        <StableLabel
          pending={pending}
          reserve={<><Loader2 size={10} />{action.pendingLabel}</>}
          label={action.label}
          pendingLabel={<><Loader2 size={10} className="animate-spin" aria-hidden="true" />{action.pendingLabel}</>}
        />
      ) : (
        <>
          {pending && <Loader2 size={10} className="animate-spin" aria-hidden="true" />}
          {action.label}
        </>
      )}
    </button>
  )
}

/**
 * Set up <Engine> in the vault (or Switch to OpenCode, when it is set up): what
 * will happen, as the steps it will run, then the fields it needs. The steps
 * are listed from the start and only their icons change while it runs, so
 * nothing moves between the form and its progress (rule 1); a failure keeps
 * the dialog open with the step's sentence and Try again (rule 6).
 */
export function VaultEngineSetupDialog({
  engine,
  setUp,
  initial = null,
  allowedHosts,
  pending,
  steps,
  error,
  onCancel,
  onSubmit
}: {
  engine: VaultEngine
  setUp: boolean
  /** OpenCode's provider and model to start from (Change model…); absent, OpenAI and its default. */
  initial?: { provider: VaultLaunchProvider; model: string } | null
  allowedHosts: readonly string[]
  pending: boolean
  steps: Steps
  error: string | null
  onCancel: () => void
  onSubmit: (options: { provider?: VaultLaunchProvider; model?: string; apiKey?: string }) => void
}): React.JSX.Element {
  const name = VAULT_ENGINE_NAME[engine]
  const primaryRef = useRef<HTMLButtonElement>(null)
  const opencode = VAULT_ENGINE_NAMES_MODEL[engine]
  const [provider, setProvider] = useState<VaultLaunchProvider>(initial?.provider ?? 'openai')
  const [model, setModel] = useState(initial?.model ?? VAULT_OPENCODE_DEFAULT_MODEL.openai)
  const [modelEdited, setModelEdited] = useState(false)
  const [apiKey, setApiKey] = useState('')
  // Decided when the dialog opened; stays as it was while it runs.
  const [plan] = useState(() => ({
    install: !setUp,
    hosts: VAULT_ENGINE_HOSTS[engine].filter((host) => !allowedHosts.includes(host))
  }))
  const login = VAULT_ENGINE_LOGIN[engine]
  const keyName = vaultEngineKeyName(engine, opencode ? provider : null)
  const title = !plan.install && opencode ? 'Switch to OpenCode' : `Set up ${name} in the vault`
  const prompts = (plan.install ? 1 : 0) + (plan.hosts.length > 0 ? 1 : 0)
  const items: { step: VaultSwitchStep; label: string }[] = [
    ...(plan.install ? [{ step: 'runtime' as const, label: `Downloads the pinned ${name} runtime into the vault` }] : []),
    ...(plan.hosts.length > 0 ? [{ step: 'egress' as const, label: `Allows ${plan.hosts.join(', ')}` }] : []),
    { step: 'credentials', label: 'Stores the key (if given)' },
    { step: 'engine', label: `Switches the agent to ${name}` }
  ]
  const submit = (): void => {
    if (pending) return
    onSubmit({
      ...(opencode ? { provider, model: model.trim() } : {}),
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {})
    })
  }
  const verb = !plan.install && opencode ? 'Switch' : 'Set up'
  return (
    <VaultDialog title={title} pending={pending} onDismiss={onCancel} initialFocusRef={primaryRef}>
      <ol aria-label="Steps" className="space-y-1.5">
        {items.map((item) => (
          <li key={item.step} data-step={item.step} data-status={steps[item.step]} className="flex items-start gap-2 text-[13px]">
            <span className="mt-[3px]"><StepIcon status={steps[item.step]} /></span>
            <span className={`min-w-0 break-words ${steps[item.step] === 'failed' ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-secondary)]'}`}>
              {item.label}
            </span>
          </li>
        ))}
      </ol>
      {prompts > 0 && (
        <p className={DIALOG_NOTE}>
          {prompts === 1 ? 'It asks for Touch ID or your password.' : 'Each of the first two asks for Touch ID or your password.'}
        </p>
      )}
      <form
        className="space-y-2 border-t border-[var(--color-border)] pt-3"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        {opencode && (
          <>
            <label className="flex items-center gap-2">
              <span className={`${DIALOG_LABEL} w-24 shrink-0`}>Provider</span>
              <select
                value={provider}
                disabled={pending}
                aria-label="Provider"
                onChange={(event) => {
                  const next = event.target.value as VaultLaunchProvider
                  setProvider(next)
                  if (!modelEdited) setModel(VAULT_OPENCODE_DEFAULT_MODEL[next])
                }}
                className={`min-w-0 flex-1 ${FIELD_BASE}`}
              >
                {VAULT_LAUNCH_PROVIDERS.map((each) => (
                  <option key={each} value={each}>{PROVIDER_NAME[each]}</option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2">
              <span className={`${DIALOG_LABEL} w-24 shrink-0`}>Model</span>
              <input
                value={model}
                disabled={pending}
                spellCheck={false}
                autoComplete="off"
                aria-label="Model"
                onChange={(event) => {
                  setModel(event.target.value)
                  setModelEdited(true)
                }}
                className={`min-w-0 flex-1 font-mono ${FIELD_BASE}`}
              />
            </label>
          </>
        )}
        <label className="flex items-center gap-2">
          <span className={`${DIALOG_LABEL} w-24 shrink-0`}>{login?.short ?? 'API key'}</span>
          <input
            type="password"
            value={apiKey}
            disabled={pending}
            autoComplete="off"
            placeholder={apiKeyPlaceholder(keyName)}
            aria-label={`${login?.short ?? 'API key'} for ${name} inside the vault`}
            onChange={(event) => setApiKey(event.target.value)}
            className={`min-w-0 flex-1 font-mono ${FIELD_BASE}`}
          />
        </label>
        <p className={`${DIALOG_NOTE} pl-[6.5rem]`}>Leave empty to add it later on the Security tab.</p>
        <DialogFooter error={error}>
          <button type="button" className={CANCEL} disabled={pending} onClick={onCancel}>
            Cancel
          </button>
          <button
            ref={primaryRef}
            type="submit"
            className={`${PRIMARY} min-w-[7rem]`}
            disabled={pending || (opencode && !model.trim())}
            aria-busy={pending || undefined}
          >
            {pending ? (
              <>
                <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                {verb === 'Switch' ? 'Switching…' : 'Setting up…'}
              </>
            ) : error ? 'Try again' : verb}
          </button>
        </DialogFooter>
      </form>
    </VaultDialog>
  )
}
