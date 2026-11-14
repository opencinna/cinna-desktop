import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, ChevronDown, Circle, GitBranch, Info, KeyRound, Loader2, Minus, X, XCircle } from 'lucide-react'
import {
  VAULT_MOVE_STEPS,
  type VaultMoveProgressEvent,
  type VaultMoveStep,
  type VaultPrecheckItem,
  type VaultRotationItem
} from '../../../../../../shared/vault/types'
import { VAULT_DEFAULT_SIZE_BYTES } from '../../../../../../shared/vault/protocol'
import {
  cancelVaultMove,
  onVaultMoveProgress,
  startVaultMove,
  useVaultDeleteHostCopy,
  useVaultHostCopy,
  useVaultPrecheck,
  vaultErrorText
} from '../../../../hooks/useVault'
import { useServiceCredentials } from '../../../../hooks/useServiceCredentials'
import { useAuthStore } from '../../../../stores/auth.store'
import { credentialManageUrl } from '../../../settings/credentialPresentation'
import { ManageCredentialButton } from '../../../settings/CredentialRow'
import { CANCEL, DANGER, DIALOG_LABEL, DIALOG_TEXT, DialogFooter, FIELD_BASE, PRIMARY, SECONDARY } from '../sharing/ShareDialogs'
import { VaultDialog } from './VaultDialog'
import { HostCopyConsequences } from './VaultOnPanel'
import { GB, formatBytes, sizeLimitProblem } from './vaultText'

export const MOVE_STEP_LABEL: Record<VaultMoveStep, string> = {
  create: 'Create the vault',
  unlock: 'Unlock it',
  approve: 'Approve the move',
  runtime: 'Install the engine',
  copy: 'Copy the folder in',
  rebuild: 'Rebuild dependencies',
  credentials: 'Deliver credentials',
  check: 'Check it runs'
}

type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'
interface StepState {
  status: StepStatus
  message?: string
  output: string
}
type Phase = 'check' | 'move' | 'original' | 'rotate'

/** Every step the dialog will show, listed from the start so nothing appears later (ux_rules rule 1). */
const OUTLINE: { id: 'precheck' | VaultMoveStep | 'original' | 'rotate'; label: string }[] = [
  { id: 'precheck', label: 'Check the folder' },
  ...VAULT_MOVE_STEPS.map((step) => ({ id: step, label: MOVE_STEP_LABEL[step] })),
  { id: 'original', label: 'Delete the original' },
  { id: 'rotate', label: 'Rotate credentials' }
]

function emptySteps(): Record<VaultMoveStep, StepState> {
  return Object.fromEntries(VAULT_MOVE_STEPS.map((step) => [step, { status: 'pending', output: '' }])) as Record<
    VaultMoveStep,
    StepState
  >
}

/**
 * Move to vault… (README "Moving an existing agent"): the pre-check first,
 * then the move's steps as they run, then deleting the folder left on the
 * host and the rotation checklist. One fixed footprint for every phase — the
 * outline on the left lists every step from the start, the right column is the
 * same height in each — so clicking through moves nothing (ux_rules rule 1).
 * A failure lands in the dialog and closes nothing (rule 6).
 */
export function MoveToVaultDialog({
  agentId,
  agentName,
  onClose
}: {
  agentId: string
  agentName: string
  onClose: () => void
}): React.JSX.Element {
  const precheck = useVaultPrecheck(agentId, true)
  const hostCopy = useVaultHostCopy(agentId)
  const deleteOriginal = useVaultDeleteHostCopy()
  const [phase, setPhase] = useState<Phase>('check')
  const [sizeText, setSizeText] = useState(String(VAULT_DEFAULT_SIZE_BYTES / GB))
  const [apiKey, setApiKey] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  /** A refused size, said on the field's own line (rule 6), not in the footer. */
  const [sizeError, setSizeError] = useState<string | null>(null)
  const [steps, setSteps] = useState(emptySteps)
  const [failure, setFailure] = useState<{ step: VaultMoveStep; message: string } | null>(null)
  const [rolledBack, setRolledBack] = useState<boolean | null>(null)
  const [rotation, setRotation] = useState<VaultRotationItem[]>([])
  const [cancelling, setCancelling] = useState(false)
  const [typedName, setTypedName] = useState('')
  const moveIdRef = useRef<string | null>(null)
  const runningRef = useRef(false)
  const primaryRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    return onVaultMoveProgress((event: VaultMoveProgressEvent) => {
      if (event.agentId !== agentId || !runningRef.current) return
      if (moveIdRef.current && event.moveId !== moveIdRef.current) return
      moveIdRef.current ??= event.moveId
      setSteps((prev) => ({
        ...prev,
        [event.step]: {
          status: event.status,
          message: event.message ?? prev[event.step].message,
          output: prev[event.step].output + (event.output ?? '')
        }
      }))
      if (event.status === 'failed') {
        setFailure({ step: event.step, message: event.message ?? '' })
        if (event.rolledBack !== undefined) {
          setRolledBack(event.rolledBack)
          runningRef.current = false
        }
      } else if (event.rolledBack !== undefined) {
        setRolledBack(event.rolledBack)
        runningRef.current = false
      }
      if (event.rotation !== undefined || (event.step === 'check' && event.status === 'done')) {
        runningRef.current = false
        setRotation(event.rotation ?? [])
        void hostCopy.refetch()
        setPhase('original')
      }
    })
    // `hostCopy.refetch` is stable for the query's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId])

  const data = precheck.data
  const blockers = data?.items.filter((item) => item.severity === 'blocker') ?? []
  const moving = phase === 'move' && failure === null
  const canStart = !!data && data.canMove && blockers.length === 0

  const start = async (): Promise<void> => {
    const sizeProblem = sizeLimitProblem(sizeText, null)
    setSizeError(sizeProblem)
    setFormError(null)
    if (sizeProblem) return
    setSteps(emptySteps())
    setFailure(null)
    setRolledBack(null)
    moveIdRef.current = null
    runningRef.current = true
    setPhase('move')
    try {
      const moveId = await startVaultMove(agentId, {
        sizeBytes: Math.round(Number(sizeText) * GB),
        // Optional: main's pre-check says the key can be added later on the Security tab.
        ...(data?.needsApiKey && apiKey.trim() ? { apiKey: apiKey.trim() } : {})
      })
      moveIdRef.current = moveId
    } catch (err) {
      // Refused before anything ran: back where the user pressed Move, with the reason (rule 6).
      runningRef.current = false
      setPhase('check')
      setFormError(vaultErrorText(err, 'Cancelled at the prompt — nothing was moved.'))
    }
  }

  const cancel = async (): Promise<void> => {
    if (!moveIdRef.current) return
    setCancelling(true)
    try {
      await cancelVaultMove(moveIdRef.current)
    } catch (err) {
      setFailure({ step: currentStep(steps) ?? 'create', message: vaultErrorText(err) })
    } finally {
      setCancelling(false)
    }
  }

  const statusOf = (id: (typeof OUTLINE)[number]['id']): StepStatus => {
    if (id === 'precheck') return phase === 'check' ? (precheck.isLoading ? 'running' : 'pending') : 'done'
    if (id === 'original') return phase === 'original' ? 'running' : phase === 'rotate' ? (hostCopy.data ? 'skipped' : 'done') : 'pending'
    // The checklist is the step's whole content: shown is done, nothing to rotate is skipped.
    if (id === 'rotate') return phase === 'rotate' ? (rotation.length > 0 ? 'done' : 'skipped') : 'pending'
    return steps[id].status
  }

  return (
    <VaultDialog
      title="Move to vault"
      pending={moving}
      onDismiss={onClose}
      initialFocusRef={primaryRef}
      width="max-w-[46rem]"
    >
      <p className={DIALOG_TEXT}>
        Moves <span className="font-medium text-[var(--color-text)]">{agentName}</span> into its own vault on this Mac.
        If any step fails, the half-built vault is removed and the agent stays as it is.
      </p>
      <div className="grid grid-cols-[12rem_minmax(0,1fr)] gap-4">
        <ol aria-label="Steps" className="space-y-1.5 border-r border-[var(--color-border)] pr-3">
          {OUTLINE.map((item) => {
            const status = statusOf(item.id)
            return (
              <li key={item.id} data-step={item.id} data-status={status} className="flex items-center gap-2 text-[13px]">
                <StepIcon status={status} />
                <span className={status === 'pending' ? 'text-[var(--color-text-muted)]' : status === 'failed' ? 'text-[var(--color-danger)]' : 'text-[var(--color-text)]'}>
                  {item.label}
                </span>
              </li>
            )
          })}
        </ol>
        {/* The same height in every phase; what is longer scrolls inside. */}
        <div className="flex h-[22rem] min-w-0 flex-col">
          {phase === 'check' ? (
            <PrecheckPanel
              loading={precheck.isLoading}
              error={precheck.error ? vaultErrorText(precheck.error) : null}
              data={data ?? null}
              sizeText={sizeText}
              setSizeText={(value) => {
                setSizeText(value)
                // The refusal goes with the value it refused; the line keeps its height.
                setSizeError(null)
              }}
              sizeError={sizeError}
              apiKey={apiKey}
              setApiKey={setApiKey}
            />
          ) : phase === 'move' ? (
            <ProgressPanel steps={steps} />
          ) : phase === 'original' ? (
            <div className={`min-h-0 flex-1 space-y-3 overflow-y-auto ${DIALOG_TEXT}`}>
              {hostCopy.data ? (
                <>
                  <HostCopyConsequences {...hostCopy.data} />
                  <label className="block space-y-1">
                    <span className={DIALOG_LABEL}>
                      Type <span className="font-medium text-[var(--color-text)]">{agentName}</span> to delete it
                    </span>
                    <input
                      value={typedName}
                      onChange={(event) => setTypedName(event.target.value)}
                      disabled={deleteOriginal.isPending}
                      spellCheck={false}
                      autoComplete="off"
                      aria-label={`Type ${agentName} to delete it`}
                      className={`w-full ${FIELD_BASE}`}
                    />
                  </label>
                </>
              ) : hostCopy.isLoading ? (
                <p>Looking for the original folder…</p>
              ) : (
                <p>{agentName} now lives in its vault, and no copy is left in its old folder.</p>
              )}
            </div>
          ) : (
            <RotationPanel items={rotation} />
          )}
        </div>
      </div>
      <DialogFooter
        error={
          phase === 'check'
            ? formError
            : phase === 'move' && failure
              ? `${MOVE_STEP_LABEL[failure.step]} failed${failure.message ? `: ${sentence(failure.message)}` : '.'}${
                  rolledBack === true
                    ? ` The half-built vault was removed; ${agentName} is untouched on this Mac.`
                    : rolledBack === false
                      ? ' The half-built vault could not be removed completely.'
                      : ' Removing the half-built vault…'
                }`
              : phase === 'original' && deleteOriginal.error
                ? vaultErrorText(deleteOriginal.error)
                : null
        }
      >
        {phase === 'check' && (
          <>
            <button type="button" className={CANCEL} onClick={onClose}>Cancel</button>
            <button ref={primaryRef} type="button" className={PRIMARY} disabled={!canStart} onClick={() => void start()}>
              Move
            </button>
          </>
        )}
        {phase === 'move' &&
          (failure ? (
            <button ref={primaryRef} type="button" className={PRIMARY} disabled={rolledBack === null && runningRef.current} onClick={onClose}>
              Close
            </button>
          ) : (
            <button ref={primaryRef} type="button" className={`${SECONDARY} min-w-[7rem]`} disabled={cancelling || !moveIdRef.current} onClick={() => void cancel()}>
              {cancelling ? <><Loader2 size={14} className="animate-spin" aria-hidden="true" />Cancelling…</> : 'Cancel'}
            </button>
          ))}
        {phase === 'original' && (
          <>
            <button type="button" className={SECONDARY} disabled={deleteOriginal.isPending} onClick={() => setPhase('rotate')}>
              {hostCopy.data ? 'Keep for now' : 'Next'}
            </button>
            {hostCopy.data && (
              <button
                type="button"
                className={`${DANGER} min-w-[8rem]`}
                disabled={typedName !== agentName || deleteOriginal.isPending}
                aria-busy={deleteOriginal.isPending}
                onClick={() =>
                  deleteOriginal.mutate({ agentId, typedName }, { onSuccess: () => setPhase('rotate') })
                }
              >
                {deleteOriginal.isPending ? <><Loader2 size={14} className="animate-spin" aria-hidden="true" />Deleting…</> : 'Delete original'}
              </button>
            )}
          </>
        )}
        {phase === 'rotate' && (
          <button ref={primaryRef} type="button" className={PRIMARY} onClick={onClose}>
            Done
          </button>
        )}
      </DialogFooter>
    </VaultDialog>
  )
}

/** Main's message as a sentence: a full stop unless it already ends in one. */
function sentence(text: string): string {
  const trimmed = text.trim()
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

function currentStep(steps: Record<VaultMoveStep, StepState>): VaultMoveStep | null {
  return VAULT_MOVE_STEPS.find((step) => steps[step].status === 'running') ?? null
}

function StepIcon({ status }: { status: StepStatus }): React.JSX.Element {
  const box = 'flex h-[15px] w-[15px] shrink-0 items-center justify-center'
  if (status === 'running') return <span className={box}><Loader2 size={14} className="animate-spin text-[var(--color-accent)]" aria-label="Running" /></span>
  if (status === 'done') return <span className={box}><Check size={14} className="text-[var(--color-success)]" aria-label="Done" /></span>
  if (status === 'failed') return <span className={box}><X size={14} className="text-[var(--color-danger)]" aria-label="Failed" /></span>
  if (status === 'skipped') return <span className={box}><Minus size={14} className="text-[var(--color-text-muted)]" aria-label="Skipped" /></span>
  return <span className={box}><Circle size={7} className="fill-current text-[var(--color-text-muted)]" aria-label="Not started" /></span>
}

const SEVERITY_ORDER: Record<VaultPrecheckItem['severity'], number> = { blocker: 0, warning: 1, info: 2 }

function PrecheckPanel({
  loading,
  error,
  data,
  sizeText,
  setSizeText,
  sizeError,
  apiKey,
  setApiKey
}: {
  loading: boolean
  error: string | null
  data: import('../../../../../../shared/vault/types').VaultPrecheckDto | null
  sizeText: string
  setSizeText: (value: string) => void
  sizeError: string | null
  apiKey: string
  setApiKey: (value: string) => void
}): React.JSX.Element {
  const items = [...(data?.items ?? [])].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
  return (
    <>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
        {loading ? (
          <p className={DIALOG_TEXT}>Checking the folder… nothing is changed yet.</p>
        ) : error ? (
          <p role="alert" className="text-[13px] text-[var(--color-danger)]">{error}</p>
        ) : data ? (
          <>
            <p className={DIALOG_TEXT}>
              Copies {data.copyFiles.toLocaleString()} file{data.copyFiles === 1 ? '' : 's'} ({formatBytes(data.copyBytes)}) from{' '}
              <span className="break-all font-mono text-[12px] text-[var(--color-text)]">{data.folderPath}</span>, with its git
              history and without build outputs, which are rebuilt inside.
            </p>
            {items.length === 0 ? (
              <p className={DIALOG_TEXT}>Nothing found that would stop working inside.</p>
            ) : (
              <ul aria-label="Pre-check" className="space-y-2">
                {items.map((item, index) => (
                  <PrecheckRow key={`${item.kind}:${index}`} item={item} />
                ))}
              </ul>
            )}
          </>
        ) : null}
      </div>
      {/* Pinned under the list, so a long list scrolls and the fields stay put. */}
      <div className="mt-3 shrink-0 space-y-2 border-t border-[var(--color-border)] pt-3">
        <label className="flex items-center gap-2">
          <span className={`${DIALOG_LABEL} w-32 shrink-0`}>Disk size limit</span>
          <input
            inputMode="decimal"
            value={sizeText}
            onChange={(event) => setSizeText(event.target.value)}
            aria-label="Disk size limit in GB"
            aria-invalid={sizeError ? true : undefined}
            aria-describedby="vault-size-note"
            className={`w-24 ${FIELD_BASE}`}
          />
          <span className="text-[13px] text-[var(--color-text-muted)]">GB</span>
          {/* One line in both states: the hint, or the refusal in its place (rules 1 and 6). */}
          <span
            id="vault-size-note"
            role={sizeError ? 'alert' : undefined}
            title={sizeError ?? undefined}
            className={`min-w-0 flex-1 truncate text-[13px] ${
              sizeError ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-muted)]'
            }`}
          >
            {sizeError ?? 'grows as used'}
          </span>
        </label>
        {data?.needsApiKey && (
          <label className="flex items-center gap-2">
            <span className={`${DIALOG_LABEL} w-32 shrink-0`}>API key</span>
            <input
              type="password"
              value={apiKey}
              autoComplete="off"
              placeholder={apiKeyPlaceholder(data.apiKeyName)}
              onChange={(event) => setApiKey(event.target.value)}
              aria-label="API key for the engine inside the vault"
              title="This Mac signs in with a subscription login, which stays here. The vault signs in with this key; Cinna keeps no copy."
              className={`min-w-0 flex-1 font-mono ${FIELD_BASE}`}
            />
          </label>
        )}
      </div>
    </>
  )
}

/** What a key of each provider starts with, as a hint in the empty field; a generic word when the provider is unknown. */
const API_KEY_PLACEHOLDER: Record<string, string> = {
  ANTHROPIC_API_KEY: 'sk-ant-… or a claude setup-token token',
  OPENAI_API_KEY: 'sk-…',
  GEMINI_API_KEY: 'AIza…'
}

export function apiKeyPlaceholder(keyName: string | null | undefined): string {
  return (keyName && API_KEY_PLACEHOLDER[keyName]) || 'API key'
}

function PrecheckRow({ item }: { item: VaultPrecheckItem }): React.JSX.Element {
  const Icon = item.severity === 'blocker' ? XCircle : item.severity === 'warning' ? AlertTriangle : Info
  const tone =
    item.severity === 'blocker'
      ? 'text-[var(--color-danger)]'
      : item.severity === 'warning'
        ? 'text-[var(--color-warning)]'
        : 'text-[var(--color-text-muted)]'
  const paths = item.paths ?? []
  return (
    <li data-severity={item.severity} className="flex items-start gap-2">
      <Icon size={15} className={`mt-0.5 shrink-0 ${tone}`} aria-label={item.severity === 'blocker' ? 'Blocks the move' : item.severity === 'warning' ? 'Warning' : 'Note'} />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-[var(--color-text)]">{item.title}</div>
        {item.detail && <div className="text-[13px] leading-relaxed text-[var(--color-text-muted)]">{item.detail}</div>}
        {paths.length > 0 && (
          <div className="truncate font-mono text-[12px] text-[var(--color-text-secondary)]" title={paths.join('\n')}>
            {paths.slice(0, 3).join(', ')}
            {paths.length > 3 ? ` +${paths.length - 3} more` : ''}
          </div>
        )}
      </div>
    </li>
  )
}

/**
 * The detail behind the outline: only steps that have something to say — output
 * (rebuild, check), a message while running, or the failure. The outline on the
 * left already lists every step and its status; repeating it here was noise.
 */
function ProgressPanel({ steps }: { steps: Record<VaultMoveStep, StepState> }): React.JSX.Element {
  const shown = VAULT_MOVE_STEPS.filter((step) => {
    const state = steps[step]
    return state.output !== '' || state.status === 'failed' || (state.status === 'running' && !!state.message)
  })
  return (
    <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1" aria-live="polite">
      {shown.map((step) => (
        <StepLog key={step} step={step} state={steps[step]} />
      ))}
    </div>
  )
}

function StepLog({ step, state }: { step: VaultMoveStep; state: StepState }): React.JSX.Element {
  const [open, setOpen] = useState<boolean | null>(null)
  // Open by default while it runs or after it failed; the user's own toggle wins.
  const expanded = open ?? (state.status === 'running' || state.status === 'failed')
  return (
    <div data-step-log={step}>
      <div className="flex items-center gap-2">
        <StepIcon status={state.status} />
        <span className="text-[13px] font-medium text-[var(--color-text)]">{MOVE_STEP_LABEL[step]}</span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--color-text-muted)]" title={state.message}>
          {state.message}
        </span>
        {state.output && (
          <button
            type="button"
            onClick={() => setOpen(!expanded)}
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Hide' : 'Show'} output of ${MOVE_STEP_LABEL[step]}`}
            title={expanded ? 'Hide output' : 'Show output'}
            className="rounded p-1 text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)]"
          >
            <ChevronDown size={14} className={`transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`} />
          </button>
        )}
      </div>
      {state.output && expanded && (
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2 font-mono text-[12px] text-[var(--color-text-secondary)]">
          {state.output}
        </pre>
      )}
    </div>
  )
}

const ROTATION_ICON: Record<VaultRotationItem['kind'], typeof KeyRound> = {
  'service-credential': KeyRound,
  'env-key': KeyRound,
  'engine-login': KeyRound,
  'git-history': GitBranch
}

/** README step 8: what other agents could have read before the move, with Manage for a Core record. */
function RotationPanel({ items }: { items: VaultRotationItem[] }): React.JSX.Element {
  const credentials = useServiceCredentials()
  const serverUrl = useAuthStore((s) => s.currentUser?.cinnaServerUrl ?? null)
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
      <p className={DIALOG_TEXT}>
        The vault can’t take back what other apps and agents already read. Change these where they were issued.
      </p>
      {items.length === 0 ? (
        <p className={DIALOG_TEXT}>Nothing to rotate: the agent had no credentials attached or in .env.</p>
      ) : (
        <ul aria-label="Rotation checklist" className="space-y-2">
          {items.map((item, index) => {
            const Icon = ROTATION_ICON[item.kind]
            const record = item.credentialId ? credentials.data?.items.find((c) => c.id === item.credentialId) : undefined
            const manage = record ? credentialManageUrl(record.cloudId, serverUrl) : null
            return (
              <li key={`${item.kind}:${item.name}:${index}`} className="flex items-center gap-2">
                <Icon size={15} className="shrink-0 text-[var(--color-warning)]" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium text-[var(--color-text)]">{item.name}</div>
                  {item.detail && <div className="truncate text-[13px] text-[var(--color-text-muted)]" title={item.detail}>{item.detail}</div>}
                </div>
                {manage && <ManageCredentialButton name={item.name} url={manage} onError={setError} />}
              </li>
            )
          })}
        </ul>
      )}
      {error && <p role="alert" className="text-[13px] text-[var(--color-danger)]">{error}</p>}
    </div>
  )
}
