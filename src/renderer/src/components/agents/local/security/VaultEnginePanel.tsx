import { useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { LocalAgentDto } from '../../../../../../shared/localAgents'
import {
  VAULT_SWITCH_STEPS,
  type VaultEngine,
  type VaultEngineChoiceDto,
  type VaultMoveProgressEvent,
  type VaultSwitchStep,
  vaultImageDownloadText
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
  useVaultEngines,
  useVaultStatus,
  useVaultSwitchEngine,
  useVaultSwitchingTo,
  useVaultUnlock,
  useVaultUnlocking,
  useVaultUnlockPercent,
  vaultErrorText
} from '../../../../hooks/useVault'
import { FIELD, LABEL, LINE_BUTTON } from '../fieldClasses'
import { SettingsButton } from '../../../settings/SettingsLayout'
import { VaultUnlockLabel } from '../../../chat/VaultUnlockLabel'
import { CANCEL, DIALOG_LABEL, DIALOG_NOTE, DialogFooter, FIELD_BASE, PRIMARY } from '../sharing/ShareDialogs'
import { VaultDialog } from './VaultDialog'
import { StepIcon, apiKeyPlaceholder, type StepStatus } from './MoveToVaultDialog'
import { VAULT_ENGINE_CHOICE_NAME as VAULT_ENGINE_NAME } from './vaultText'

const PROVIDER_NAME: Record<VaultLaunchProvider, string> = { openai: 'OpenAI', anthropic: 'Anthropic' }
const NOTE = 'text-[10px] text-[var(--color-text-muted)]'
const DANGER_NOTE = 'text-[10px] text-[var(--color-danger)]'

type Steps = Record<VaultSwitchStep, StepStatus>

/**
 * The panel's one line: what it says, its tone, and at most one inline action,
 * placed as the Runs-with panel places its own: a sign-in-like step (Unlock)
 * before the text, as Log in is; a follow-up (Refresh, Change model…) after it.
 */
interface Line {
  text: string
  tone: string
  spinner?: boolean
  alert?: boolean
  action?: { label: string; pending?: boolean; after?: true; onClick: () => void }
}
const emptySteps = (): Steps => Object.fromEntries(VAULT_SWITCH_STEPS.map((step) => [step, 'pending'])) as Steps

/**
 * What a vault agent runs on, in the slot the Runs-with panel has for any
 * other agent: one select of the four vault engines. A set-up engine (other
 * than OpenCode, which always names a model) switches at once; any other
 * opens the setup dialog. The select keeps showing the engine the agent runs
 * on until a switch is done, and the line under it is always there (rule 1).
 */
export function VaultEnginePanel({ agent }: { agent: LocalAgentDto }): React.JSX.Element | null {
  const vault = agent.vault
  const status = useVaultStatus(agent.id).data
  const state = status?.state ?? vault?.state
  const open = state === 'unlocked'
  const engines = useVaultEngines(agent.id, open)
  const switchEngine = useVaultSwitchEngine(agent.id)
  const switchingTo = useVaultSwitchingTo(agent.id)
  const unlock = useVaultUnlock()
  // From any surface: an unlock the sidebar's menu started shows here too.
  const unlockInFlight = useVaultUnlocking(agent.id)
  const unlockPercent = useVaultUnlockPercent(agent.id)
  const unlockDownload = unlockPercent === null ? null : vaultImageDownloadText(unlockPercent)
  const [dialog, setDialog] = useState<VaultEngine | null>(null)
  /** OpenCode's provider and model to open the dialog with (Change model…), else its defaults. */
  const [prefill, setPrefill] = useState<{ provider: VaultLaunchProvider; model: string } | null>(null)
  const [steps, setSteps] = useState<Steps>(emptySteps)
  if (!vault) return null
  const current = vault.engine
  const choices = engines.data ?? null
  const choiceOf = (engine: VaultEngine): VaultEngineChoiceDto | undefined => choices?.find((c) => c.engine === engine)

  const start = (options: Parameters<typeof switchEngine.mutate>[0]['options'], fromDialog: boolean): void => {
    setSteps(emptySteps())
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
  const changeModel = (): void => {
    switchEngine.reset()
    setSteps(emptySteps())
    const provider = vault.provider ?? 'openai'
    setPrefill({ provider, model: vault.model ?? VAULT_OPENCODE_DEFAULT_MODEL[provider] })
    setDialog('opencode')
  }

  const switching = switchEngine.isPending || switchingTo !== null
  const target = switchingTo ?? (switchEngine.isPending ? switchEngine.variables?.options.engine ?? null : null)
  // The dialog says its own failure; the line says one of a switch started from the select.
  const lineError = !dialog && switchEngine.error ? vaultErrorText(switchEngine.error) : null
  const model = vault.model ?? null
  const version = choiceOf(current)?.version ?? null
  const runsOn = `${VAULT_ENGINE_NAME[current]}${version ? ` ${version}` : ''}`
  const modelText = VAULT_ENGINE_NAMES_MODEL[current] && model && vault.provider
    ? `model ${vault.provider}/${model}`
    : model
      ? `model ${model}`
      : 'the CLI’s default model'
  // Unlock is the card's own action, a button on its right (Booting is an unlock already under way).
  const unlocking = unlockInFlight || state === 'booting'
  const line: Line = !open
    ? unlocking
      ? { text: unlockDownload ?? 'Unlocking…', tone: NOTE, spinner: true }
      : {
          text: unlock.error ? vaultErrorText(unlock.error, 'Unlock was cancelled at the prompt.') : 'Unlock the vault to change the engine.',
          tone: unlock.error ? DANGER_NOTE : NOTE,
          alert: !!unlock.error
        }
    : switching
      ? { text: `Switching to ${VAULT_ENGINE_NAME[target ?? current]}…`, tone: NOTE, spinner: true }
      : lineError
        ? { text: lineError, tone: DANGER_NOTE, alert: true }
        : engines.isError
          ? { text: 'Couldn’t read the vault’s engines.', tone: DANGER_NOTE, alert: true, action: { label: 'Refresh', after: true, onClick: () => void engines.refetch() } }
          : {
              text: `Runs inside the vault on ${runsOn} · ${modelText}.`,
              tone: NOTE,
              ...(current === 'opencode' ? { action: { label: 'Change model…', after: true, onClick: changeModel } } : {})
            }

  return (
    <section
      aria-label="Runs with"
      className="@container relative rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-4 py-3"
    >
      <div className="flex items-end gap-3">
      <div className="grid flex-1 grid-cols-2 gap-3 @2xl:grid-cols-3">
        <div>
          <label htmlFor="vault-engine" className={LABEL}>
            Runs on
          </label>
          <select
            id="vault-engine"
            className={FIELD}
            value={current}
            disabled={!open || switching || !choices}
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
      </div>
      {/*
        The slot is kept while the vault is open, only hidden, so the select is
        as wide unlocked as locked; the label is fixed-width, so pressing it
        never widens it either (rule 1).
      */}
      <div className={`shrink-0 ${open ? 'invisible' : ''}`} aria-hidden={open || undefined} data-vault-engine-unlock>
        <SettingsButton
          aria-disabled={unlocking || undefined}
          aria-busy={unlocking || undefined}
          onClick={() => { if (open) return; unlock.reset(); unlock.mutate(agent.id) }}
        >
          <VaultUnlockLabel pending={unlocking} percent={unlockPercent} />
        </SettingsButton>
      </div>
      </div>
      {/* A reserved line: what it says changes, its height never does (rule 1); its button is h-4 too. */}
      <div className="mt-2 h-4">
        <div className="flex h-4 min-w-0 items-center gap-2" role={line.alert ? 'alert' : undefined}>
          {line.action && !line.action.after && <LineAction action={line.action} />}
          <span className={`flex min-w-0 items-center gap-1.5 ${line.tone}`}>
            {line.spinner && <Loader2 size={10} className="shrink-0 animate-spin" aria-hidden="true" />}
            <span className="min-w-0 truncate" title={line.text}>{line.text}</span>
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

/** The line's inline button, at the line's own height; pending, a spinner and no second click. */
function LineAction({ action }: { action: NonNullable<Line['action']> }): React.JSX.Element {
  return (
    <button
      type="button"
      className={LINE_BUTTON}
      aria-disabled={action.pending || undefined}
      aria-busy={action.pending || undefined}
      onClick={() => { if (!action.pending) action.onClick() }}
    >
      {action.pending && <Loader2 size={10} className="animate-spin" aria-hidden="true" />}
      {action.label}
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
