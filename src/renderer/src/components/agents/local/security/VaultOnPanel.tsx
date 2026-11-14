import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, Download, File, Folder, FolderOutput, Loader2, Lock, LockOpen, Plus, SquareTerminal, Trash2 } from 'lucide-react'
import type { LocalAgentDto } from '../../../../../../shared/localAgents'
import type { LocalAgentVaultInfo, VaultEngine, VaultStatusDto } from '../../../../../../shared/vault/types'
import { VAULT_ENGINE_HOSTS, VAULT_ENGINE_LOGIN } from '../../../../../../shared/vault/protocol'
import {
  onVaultMoveProgress,
  useVaultDeleteHostCopy,
  useVaultDeleteSecret,
  useVaultDestroy,
  useVaultEngineAuth,
  useVaultExportFile,
  useVaultFiles,
  useVaultHostCopy,
  useVaultLock,
  useVaultMoveOut,
  useVaultRuntimes,
  useVaultSecrets,
  useVaultSetEgress,
  useVaultSetSecret,
  useVaultSetSize,
  useVaultStatus,
  useVaultUnlock,
  useVaultUpdateDependencies,
  vaultErrorText
} from '../../../../hooks/useVault'
import {
  SettingsBadge,
  SettingsButton,
  SettingsCard,
  SettingsIconButton,
  SettingsLabel,
  SettingsRow,
  SettingsRows,
  SettingsStatusRow,
  settingsInputClass
} from '../../../settings/SettingsLayout'
import { AnimatedCollapse } from '../../../ui/AnimatedCollapse'
import { TypeNameConfirmDialog, VaultConfirmDialog } from './VaultDialog'
import { VaultTerminalDialog } from './VaultTerminalDialog'
import { GB, STATE_LABEL, formatBytes, isHostPattern, isSecretName, sizeLimitProblem, unlockedLabel } from './vaultText'

const APPROVAL = 'Waiting for approval…'
const ENGINE_NAME: Record<VaultEngine, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  antigravity: 'Antigravity'
}
/** The API key secret each engine reads inside the vault; null where none is offered yet. */
/**
 * The secret each engine signs in with inside a vault. OpenCode's is its model
 * provider's key, which only the vault knows: `vault:engine-auth` names it.
 * Antigravity's is a Gemini API key (its Google sign-in cannot be completed inside yet).
 */
const ENGINE_KEY: Record<VaultEngine, string | null | 'provider'> = {
  claude: 'ANTHROPIC_API_KEY',
  codex: 'OPENAI_API_KEY',
  opencode: 'provider',
  antigravity: 'GEMINI_API_KEY'
}

function engineKeyName(engine: VaultEngine, auth: { keyName?: string | null } | undefined): string | null {
  const key = ENGINE_KEY[engine]
  return key === 'provider' ? auth?.keyName ?? null : key
}
export const BACKEND_NAME: Record<string, string> = {
  'apple-vz': 'Apple Virtualization (Linux VM)',
  fake: 'Test backend (no isolation)'
}

/**
 * The edit forms on this panel. One at a time (ux_rules rule 13): while one
 * holds input, the buttons that would open another are disabled, and only the
 * form's own Cancel or Save closes it.
 */
type VaultForm = 'size' | 'network' | 'key' | 'secret'
interface FormSlot {
  active: VaultForm | null
  setActive: (form: VaultForm | null) => void
}

/** Said inside a form that needs the vault when it locks under it; the typed input stays. */
const LOCKED_SAVE = 'Locked — unlock to save.'

/** "2.1.318-host" → "2.1.318", "0.101.0-b009fefc" → "0.101.0"; anything else as it is. */
function shortVersion(version: string): string {
  return version.replace(/^(\d+\.\d+\.\d+)-.+$/, '$1')
}

/** "Claude Code 2.1.318", "adapter 0.101.0": the engine by its name, the adapter by its role. */
function runtimeName(runtime: { engine: VaultEngine; kind: string }, version: string): string {
  return runtime.kind === 'adapter' ? `adapter ${version}` : `${ENGINE_NAME[runtime.engine]} ${version}`
}

/** Ticks once a second while `active`, for the unlock countdown. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [active])
  return now
}

/** The vault's controls; information (disk, backend) last, under them (ux_rules rule 2). */
export function VaultOnPanel({
  agent,
  vault
}: {
  agent: LocalAgentDto
  vault: LocalAgentVaultInfo
}): React.JSX.Element {
  const statusQuery = useVaultStatus(agent.id)
  const status = statusQuery.data ?? null
  const state = status?.state ?? vault.state
  const open = state === 'unlocked'
  const [active, setActive] = useState<VaultForm | null>(null)
  const forms: FormSlot = { active, setActive }
  return (
    <>
      <VaultStatusCard agentId={agent.id} status={status} fallbackState={vault.state} loadError={statusQuery.error} />
      <HostCopyCard agent={agent} />
      <SettingsRows>
        <DiskSizeRow agentId={agent.id} status={status} forms={forms} />
        <NetworkRow agentId={agent.id} engine={vault.engine} status={status} forms={forms} />
        <EngineLoginRow agentId={agent.id} engine={vault.engine} open={open} forms={forms} />
        <SecretsRow agentId={agent.id} engine={vault.engine} open={open} forms={forms} />
        <ToolchainRow agentId={agent.id} open={open} />
        <TerminalRow agent={agent} open={open} />
      </SettingsRows>
      <FilesCard agentId={agent.id} open={open} />
      <LeaveVaultCard agent={agent} />
      {/*
        What the user can know, under what they can do. Not the size (the Disk
        size row says it) nor the backend (the Test helper badge's tooltip).
      */}
      <p data-vault-facts className="min-h-[1lh] truncate text-[12px] text-[var(--color-text-muted)]">
        {status
          ? [`Created ${new Date(status.createdAt).toLocaleDateString()}`, status.imageVersion ? `guest image ${status.imageVersion}` : null]
              .filter(Boolean)
              .join(' · ')
          : null}
      </p>
    </>
  )
}

function VaultStatusCard({
  agentId,
  status,
  fallbackState,
  loadError
}: {
  agentId: string
  status: VaultStatusDto | null
  fallbackState: LocalAgentVaultInfo['state']
  loadError: Error | null
}): React.JSX.Element {
  const unlock = useVaultUnlock()
  const lock = useVaultLock()
  const state = status?.state ?? fallbackState
  const until = status?.until ?? null
  const now = useNow(state === 'unlocked' && until !== null)
  const label = state === 'unlocked' ? unlockedLabel(until, now) : STATE_LABEL[state]
  // One line in every state, so a state change replaces the line and moves nothing.
  const detail =
    state === 'error'
      ? (status?.error ?? 'The vault stopped with an error.')
      : state === 'tampered'
        ? 'Its disk image changed outside the vault helper. Nothing was unlocked.'
        : state === 'unlocked'
          ? until === null
            ? 'A turn is running; it stays open until the turn ends.'
            : 'Locks a minute after the last turn, or when this Mac locks.'
          : state === 'booting'
            ? 'Waiting for the vault helper…'
            : state === 'locking'
              ? 'Sealing the disk…'
              : 'Unlocking asks for Touch ID or your password.'
  const canLock = state === 'unlocked' || state === 'booting'
  const pending = unlock.isPending || lock.isPending
  const error = unlock.error ?? lock.error ?? loadError
  return (
    <SettingsCard>
      <SettingsStatusRow
        tone={state === 'unlocked' ? 'ok' : state === 'error' || state === 'tampered' ? 'warning' : 'neutral'}
        label={<span data-vault-state={state}>{label}</span>}
        detail={<span className="block truncate" title={detail}>{detail}</span>}
        action={
          <SettingsButton
            disabled={state === 'tampered' || state === 'locking'}
            aria-busy={pending}
            aria-disabled={pending || undefined}
            onClick={() => {
              unlock.reset()
              lock.reset()
              if (canLock) lock.mutate(agentId)
              else unlock.mutate(agentId)
            }}
          >
            {/* Fixed width: Unlock, Lock now and their pending labels swap in place. */}
            <span className="inline-flex min-w-[6.5rem] items-center justify-center gap-1.5">
              {pending ? (
                <Loader2 size={14} className="animate-spin" aria-hidden="true" />
              ) : canLock ? (
                <Lock size={14} aria-hidden="true" />
              ) : (
                <LockOpen size={14} aria-hidden="true" />
              )}
              {unlock.isPending ? 'Unlocking…' : lock.isPending ? 'Locking…' : canLock ? 'Lock now' : 'Unlock'}
            </span>
          </SettingsButton>
        }
      />
      {error && (
        <p role="alert" className="mt-2 text-[13px] text-[var(--color-danger)]">
          {vaultErrorText(error, 'Unlock was cancelled at the prompt.')}
        </p>
      )}
    </SettingsCard>
  )
}

/** The folder a move left behind, until the user deletes it (README step 7). */
function HostCopyCard({ agent }: { agent: LocalAgentDto }): React.JSX.Element | null {
  const hostCopy = useVaultHostCopy(agent.id)
  const remove = useVaultDeleteHostCopy()
  const [confirming, setConfirming] = useState(false)
  const copy = hostCopy.data
  if (!copy) return null
  return (
    <SettingsCard>
      <SettingsStatusRow
        tone="warning"
        label="The original folder is still on this Mac"
        detail={<span className="block truncate font-mono text-[12px]" title={copy.folderPath}>{copy.folderPath}</span>}
        action={
          <SettingsButton onClick={() => { remove.reset(); setConfirming(true) }}>
            <Trash2 size={14} aria-hidden="true" />
            Delete original…
          </SettingsButton>
        }
      />
      {confirming && (
        <TypeNameConfirmDialog
          title="Delete the original folder"
          agentName={agent.name}
          confirmLabel="Delete original"
          pendingLabel="Deleting…"
          pending={remove.isPending}
          error={remove.error ? vaultErrorText(remove.error) : null}
          onCancel={() => setConfirming(false)}
          onConfirm={(typedName) =>
            remove.mutate({ agentId: agent.id, typedName }, { onSuccess: () => setConfirming(false) })
          }
        >
          <HostCopyConsequences folderPath={copy.folderPath} gitRemote={copy.gitRemote} inGitRepo={copy.inGitRepo} underTimeMachine={copy.underTimeMachine} />
        </TypeNameConfirmDialog>
      )}
    </SettingsCard>
  )
}

/** What deleting the host copy does and does not take back; shared with the move dialog. */
export function HostCopyConsequences({
  folderPath,
  gitRemote,
  inGitRepo,
  underTimeMachine
}: {
  folderPath: string
  gitRemote: string | null
  inGitRepo: boolean
  underTimeMachine: boolean
}): React.JSX.Element {
  return (
    <>
      <p>
        The agent now lives in its vault. This deletes the copy it left at{' '}
        <span className="break-all font-mono text-[12px] text-[var(--color-text)]">{folderPath}</span>. It is not
        moved to the Trash and can’t be brought back from this Mac.
      </p>
      {(gitRemote || inGitRepo || underTimeMachine) && (
        <p>
          Copies elsewhere stay:{' '}
          {[
            gitRemote ? `the git remote ${gitRemote} keeps its history` : inGitRepo ? 'the folder is in a git repository, whose history keeps its files' : null,
            underTimeMachine ? 'Time Machine backups keep earlier versions' : null
          ]
            .filter(Boolean)
            .join(', and ')}
          . Delete them there too if they hold secrets.
        </p>
      )}
    </>
  )
}

/** A settings row: label with its (?), one line of live value, the control on the right, and its editor under it. */
function VaultRow({
  label,
  info,
  value,
  valueTitle,
  control,
  children
}: {
  label: string
  info: ReactNode
  value: ReactNode
  valueTitle?: string
  control: ReactNode
  children?: ReactNode
}): React.JSX.Element {
  return (
    <SettingsRow>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <SettingsLabel info={info}>{label}</SettingsLabel>
          <p className="min-h-[1lh] truncate text-[13px] text-[var(--color-text-muted)]" title={valueTitle}>
            {value}
          </p>
        </div>
        {control}
      </div>
      {children}
    </SettingsRow>
  )
}

function PendingLabel({ pending, label, pendingLabel = APPROVAL, icon }: {
  pending: boolean
  label: string
  pendingLabel?: string
  icon?: ReactNode
}): React.JSX.Element {
  return pending ? (
    <><Loader2 size={14} className="animate-spin" aria-hidden="true" />{pendingLabel}</>
  ) : (
    <>{icon}{label}</>
  )
}

const CANCEL_TEXT =
  'rounded-md px-2.5 py-1 text-[13px] font-medium text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-secondary)] disabled:opacity-50'
const DANGER_TEXT =
  'inline-flex shrink-0 items-center gap-1.5 rounded-md bg-[var(--color-danger)] px-2.5 py-1 text-[13px] font-medium text-white transition-colors hover:opacity-90 disabled:opacity-50'

function RowError({ error }: { error: string | null }): React.JSX.Element | null {
  return error ? <p role="alert" className="mt-2 text-[13px] text-[var(--color-danger)]">{error}</p> : null
}

function DiskSizeRow({ agentId, status, forms }: { agentId: string; status: VaultStatusDto | null; forms: FormSlot }): React.JSX.Element {
  const setSize = useVaultSetSize()
  const editing = forms.active === 'size'
  const setEditing = (on: boolean): void => forms.setActive(on ? 'size' : null)
  const [text, setText] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const used = status?.usedBytes ?? null
  const start = (): void => {
    setSize.reset()
    setProblem(null)
    setText(status ? String(Math.round((status.sizeBytes / GB) * 10) / 10) : '10')
    setEditing(true)
  }
  const save = (): void => {
    // Checked on submit, never per keystroke (ux_rules rule 1); main checks again.
    const reason = sizeLimitProblem(text, used)
    setProblem(reason)
    if (reason) return
    setSize.mutate(
      { agentId, sizeBytes: Math.round(Number(text) * GB) },
      { onSuccess: () => setEditing(false) }
    )
  }
  return (
    <VaultRow
      label="Disk size limit"
      info={
        <p>
          The most the vault’s disk may grow to. The image grows only as it is used. Raising the limit asks
          for your approval and takes effect the next time the vault unlocks; it can’t go below what is
          already used.
        </p>
      }
      value={status ? `${formatBytes(status.sizeBytes)}${used !== null ? ` · ${formatBytes(used)} used` : ''}` : 'Reading…'}
      control={
        <SettingsButton onClick={start} disabled={forms.active !== null || !status}>
          Change
        </SettingsButton>
      }
    >
      <AnimatedCollapse open={editing}>
        <form
          className="mt-3"
          onSubmit={(event) => {
            event.preventDefault()
            save()
          }}
        >
          <div className="flex items-center gap-2">
            <input
              aria-label="Disk size limit in GB"
              inputMode="decimal"
              value={text}
              disabled={setSize.isPending}
              onChange={(event) => setText(event.target.value)}
              className={`${settingsInputClass} max-w-[8rem]`}
            />
            <span className="text-[13px] text-[var(--color-text-muted)]">GB</span>
            <div className="flex-1" />
            <button type="button" className={CANCEL_TEXT} disabled={setSize.isPending} onClick={() => setEditing(false)}>
              Cancel
            </button>
            <SettingsButton onClick={save} aria-busy={setSize.isPending} aria-disabled={setSize.isPending || undefined}>
              <PendingLabel pending={setSize.isPending} label="Save" />
            </SettingsButton>
          </div>
          <RowError error={problem ?? (setSize.error ? vaultErrorText(setSize.error) : null)} />
        </form>
      </AnimatedCollapse>
    </VaultRow>
  )
}

function NetworkRow({
  agentId,
  engine,
  status,
  forms
}: {
  agentId: string
  engine: VaultEngine
  status: VaultStatusDto | null
  forms: FormSlot
}): React.JSX.Element {
  const setEgress = useVaultSetEgress()
  const defaults = VAULT_ENGINE_HOSTS[engine]
  const hosts = status?.egress.hosts ?? []
  const extra = hosts.filter((host) => !defaults.includes(host))
  const editing = forms.active === 'network'
  const setEditing = (on: boolean): void => forms.setActive(on ? 'network' : null)
  const [text, setText] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const shown = [...defaults, ...extra]
  const save = (): void => {
    const typed = text.split(/[\s,]+/).map((host) => host.trim()).filter(Boolean)
    const bad = typed.filter((host) => !isHostPattern(host))
    if (bad.length > 0) {
      setProblem(`Not a host name: ${bad.join(', ')}. Use names like api.example.com or *.example.com.`)
      return
    }
    setProblem(null)
    setEgress.mutate(
      { agentId, hosts: [...new Set([...defaults, ...typed.map((host) => host.toLowerCase())])] },
      { onSuccess: () => setEditing(false) }
    )
  }
  return (
    <VaultRow
      label="Network access"
      info={
        <p>
          The vault reaches only these hosts, through the vault helper. {ENGINE_NAME[engine]} needs its own,
          which are always allowed. Changing the list asks for your approval. Dependency installs open the
          package hosts for that install only.
        </p>
      }
      value={`${shown.length} host${shown.length === 1 ? '' : 's'}: ${shown.join(', ')}`}
      valueTitle={shown.join('\n')}
      control={
        <SettingsButton
          disabled={forms.active !== null || !status}
          onClick={() => {
            setEgress.reset()
            setProblem(null)
            setText(extra.join('\n'))
            setEditing(true)
          }}
        >
          Edit
        </SettingsButton>
      }
    >
      <AnimatedCollapse open={editing}>
        <div className="mt-3 space-y-2">
          <p className="text-[13px] text-[var(--color-text-muted)]">
            Always allowed for {ENGINE_NAME[engine]}:{' '}
            {defaults.map((host) => (
              <code key={host} className="mr-1 rounded bg-[var(--color-bg-tertiary)] px-1.5 py-px font-mono text-[12px] text-[var(--color-text-secondary)]">
                {host}
              </code>
            ))}
          </p>
          <textarea
            aria-label="Other allowed hosts, one per line"
            placeholder="api.example.com"
            rows={3}
            value={text}
            disabled={setEgress.isPending}
            onChange={(event) => setText(event.target.value)}
            className={`${settingsInputClass} font-mono`}
          />
          <div className="flex items-center justify-end gap-2">
            <button type="button" className={CANCEL_TEXT} disabled={setEgress.isPending} onClick={() => setEditing(false)}>
              Cancel
            </button>
            <SettingsButton onClick={save} aria-busy={setEgress.isPending} aria-disabled={setEgress.isPending || undefined}>
              <PendingLabel pending={setEgress.isPending} label="Save" />
            </SettingsButton>
          </div>
          <RowError error={problem ?? (setEgress.error ? vaultErrorText(setEgress.error) : null)} />
        </div>
      </AnimatedCollapse>
    </VaultRow>
  )
}

const LOCKED_VALUE = 'Unlock the vault to see this.'

function EngineLoginRow({
  agentId,
  engine,
  open,
  forms
}: {
  agentId: string
  engine: VaultEngine
  open: boolean
  forms: FormSlot
}): React.JSX.Element {
  const auth = useVaultEngineAuth(agentId, open)
  const setSecret = useVaultSetSecret()
  const remove = useVaultDeleteSecret()
  const keyName = engineKeyName(engine, auth.data)
  const editing = forms.active === 'key'
  const setEditing = (on: boolean): void => forms.setActive(on ? 'key' : null)
  const [value, setValue] = useState('')
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const loggedIn = auth.data?.loggedIn ?? false
  // A `claude setup-token` token is set and removed the same way as a key (main files it by prefix).
  const onKey = loggedIn && (auth.data?.method === 'api_key' || auth.data?.method === 'oauth_token')
  const login = VAULT_ENGINE_LOGIN[engine]
  const keyWord = login?.short ?? 'API key'
  const text = !open
    ? LOCKED_VALUE
    : auth.isLoading
      ? 'Reading…'
      : auth.error
        ? vaultErrorText(auth.error)
        : loggedIn
          ? auth.data?.method === 'api_key'
            ? 'Signed in with an API key'
            : auth.data?.method === 'oauth_token'
              ? 'Signed in with a token'
              : 'Signed in'
          : 'Not signed in'
  // A lock closes the question: nothing could be removed until the vault opens again.
  useEffect(() => {
    if (!open) setConfirmingRemove(false)
  }, [open])
  const save = (): void => {
    if (!keyName || !value.trim() || !open) return
    setSecret.mutate(
      { agentId, name: keyName, value: value.trim() },
      {
        onSuccess: () => {
          setValue('')
          setEditing(false)
        }
      }
    )
  }
  return (
    <VaultRow
      label="Engine login"
      info={
        <p>
          How {ENGINE_NAME[engine]} signs in inside the vault. The key goes straight into the vault; Cinna keeps
          no copy and never shows it again.
        </p>
      }
      value={text}
      control={
        keyName ? (
          <div className="flex shrink-0 items-center gap-2">
            <SettingsButton
              disabled={!open || forms.active !== null || confirmingRemove}
              title={open ? undefined : 'Unlock the vault first'}
              onClick={() => {
                setSecret.reset()
                setValue('')
                setEditing(true)
              }}
            >
              {onKey ? `Replace ${keyWord}` : `Set ${keyWord}`}
            </SettingsButton>
            {open && onKey && (
              <SettingsIconButton
                danger
                title={`Remove ${keyWord}`}
                aria-label={`Remove ${keyWord}`}
                disabled={forms.active !== null || confirmingRemove}
                onClick={() => {
                  remove.reset()
                  setConfirmingRemove(true)
                }}
              >
                <Trash2 size={14} />
              </SettingsIconButton>
            )}
          </div>
        ) : null
      }
    >
      {confirmingRemove && keyName && (
        <div className="mt-2 flex min-h-[30px] items-center gap-2">
          <span className="min-w-0 flex-1 text-[13px] text-[var(--color-text)]">
            Remove the {keyWord}? {ENGINE_NAME[engine]} is signed out in this vault until you set a new one.
          </span>
          <button type="button" className={CANCEL_TEXT} disabled={remove.isPending} onClick={() => setConfirmingRemove(false)}>
            Cancel
          </button>
          <button
            type="button"
            disabled={remove.isPending}
            aria-busy={remove.isPending}
            onClick={() => remove.mutate({ agentId, name: keyName }, { onSuccess: () => setConfirmingRemove(false) })}
            className={DANGER_TEXT}
          >
            <PendingLabel pending={remove.isPending} label="Remove and sign out" pendingLabel="Removing…" />
          </button>
        </div>
      )}
      {confirmingRemove && <RowError error={remove.error ? vaultErrorText(remove.error) : null} />}
      <AnimatedCollapse open={editing}>
        <form
          className="mt-3 flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            save()
          }}
        >
          <input
            type="password"
            aria-label={login?.short ?? keyName ?? 'API key'}
            placeholder={login?.what ?? keyName ?? ''}
            autoComplete="off"
            value={value}
            disabled={setSecret.isPending}
            onChange={(event) => setValue(event.target.value)}
            className={`${settingsInputClass} min-w-0 flex-1 font-mono`}
          />
          <button type="button" className={CANCEL_TEXT} disabled={setSecret.isPending} onClick={() => { setValue(''); setEditing(false) }}>
            Cancel
          </button>
          <SettingsButton onClick={save} disabled={!value.trim() || !open} aria-busy={setSecret.isPending} aria-disabled={setSecret.isPending || undefined}>
            <PendingLabel pending={setSecret.isPending} label="Save" pendingLabel="Saving…" />
          </SettingsButton>
        </form>
        <FormNote locked={!open} error={setSecret.error ? vaultErrorText(setSecret.error) : null} />
      </AnimatedCollapse>
    </VaultRow>
  )
}

/** Under a form that needs the vault: the lock first (the save cannot happen), else its error. */
function FormNote({ locked, error }: { locked: boolean; error: string | null }): React.JSX.Element | null {
  if (locked) {
    return (
      <p role="status" className="mt-2 text-[13px] text-[var(--color-warning)]">
        {LOCKED_SAVE}
      </p>
    )
  }
  return <RowError error={error} />
}

function SecretsRow({
  agentId,
  engine,
  open,
  forms
}: {
  agentId: string
  engine: VaultEngine
  open: boolean
  forms: FormSlot
}): React.JSX.Element {
  // Kept after a lock (the query is only disabled), so the list keeps its rows while locked.
  const secrets = useVaultSecrets(agentId, open)
  const setSecret = useVaultSetSecret()
  const remove = useVaultDeleteSecret()
  const adding = forms.active === 'secret'
  const setAdding = (on: boolean): void => forms.setActive(on ? 'secret' : null)
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  /**
   * The engine's own key is Engine login's, not a secret the agent's scripts
   * read: deleting it here signed the engine out without saying so (rule 5).
   */
  const auth = useVaultEngineAuth(agentId, open)
  const engineKey = engineKeyName(engine, auth.data)
  // An engine login of several names (Claude: API key or setup-token token); all belong to Engine login.
  const loginNames = VAULT_ENGINE_LOGIN[engine]?.names ?? (engineKey ? [engineKey] : [])
  const names = (secrets.data ?? []).filter((secret) => !loginNames.includes(secret))
  const known = secrets.data !== undefined
  const count = `${names.length} secret${names.length === 1 ? '' : 's'}`
  const text = !open
    ? known && names.length > 0
      ? `${count} · names hidden while locked`
      : LOCKED_VALUE
    : secrets.isLoading
      ? 'Reading…'
      : secrets.error
        ? vaultErrorText(secrets.error)
        : names.length === 0
          ? 'None'
          : count
  useEffect(() => {
    if (!open) setConfirming(null)
  }, [open])
  const save = (): void => {
    if (!open) return
    if (!isSecretName(name.trim())) {
      setProblem('A name is letters, digits and underscores, not starting with a digit.')
      return
    }
    if (loginNames.includes(name.trim())) {
      setProblem(`${name.trim()} is the engine’s key; set it under Engine login.`)
      return
    }
    if (!value) {
      setProblem('Enter the value.')
      return
    }
    setProblem(null)
    setSecret.mutate(
      { agentId, name: name.trim(), value },
      { onSuccess: () => { setName(''); setValue(''); setAdding(false) } }
    )
  }
  return (
    <VaultRow
      label="Secrets"
      info={
        <p>
          Environment variables the agent’s scripts read inside the vault. Only the names are shown; the values
          stay inside. The engine’s own key is under Engine login.
        </p>
      }
      value={text}
      control={
        <SettingsButton
          disabled={!open || forms.active !== null}
          title={open ? undefined : 'Unlock the vault first'}
          onClick={() => {
            setSecret.reset()
            setProblem(null)
            setName('')
            setValue('')
            setAdding(true)
          }}
        >
          <Plus size={14} aria-hidden="true" />
          Add
        </SettingsButton>
      }
    >
      {/* The same rows locked and unlocked, names hidden while locked: a lock moves nothing below (rule 1). */}
      {names.length > 0 && (
        <ul className="mt-2 space-y-1" aria-label="Secrets">
          {names.map((secret) => (
            <li key={secret} className="flex min-h-[30px] items-center gap-2">
              {!open ? (
                <span
                  aria-label="Name hidden while locked"
                  className="min-w-0 flex-1 truncate font-mono text-[12px] tracking-widest text-[var(--color-text-muted)]"
                >
                  ••••••••
                </span>
              ) : confirming === secret ? (
                <>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--color-text)]">
                    Delete <code className="font-mono text-[12px]">{secret}</code>? Its value is gone for good.
                  </span>
                  <button type="button" className={CANCEL_TEXT} disabled={remove.isPending} onClick={() => setConfirming(null)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={remove.isPending}
                    aria-busy={remove.isPending}
                    onClick={() => remove.mutate({ agentId, name: secret }, { onSuccess: () => setConfirming(null) })}
                    className={DANGER_TEXT}
                  >
                    <PendingLabel pending={remove.isPending} label="Delete" pendingLabel="Deleting…" />
                  </button>
                </>
              ) : (
                <>
                  <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-[var(--color-text-secondary)]">{secret}</code>
                  <SettingsIconButton
                    danger
                    title="Delete this secret"
                    aria-label={`Delete ${secret}`}
                    disabled={confirming !== null}
                    onClick={() => { remove.reset(); setConfirming(secret) }}
                  >
                    <Trash2 size={14} />
                  </SettingsIconButton>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <RowError error={remove.error ? vaultErrorText(remove.error) : null} />
      <AnimatedCollapse open={adding}>
        <form
          className="mt-3 flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            save()
          }}
        >
          <input
            aria-label="Secret name"
            placeholder="NAME"
            value={name}
            spellCheck={false}
            disabled={setSecret.isPending}
            onChange={(event) => setName(event.target.value)}
            className={`${settingsInputClass} max-w-[11rem] shrink-0 font-mono`}
          />
          <input
            type="password"
            aria-label="Secret value"
            placeholder="Value"
            autoComplete="off"
            value={value}
            disabled={setSecret.isPending}
            onChange={(event) => setValue(event.target.value)}
            className={`${settingsInputClass} min-w-0 flex-1`}
          />
          <button type="button" className={CANCEL_TEXT} disabled={setSecret.isPending} onClick={() => setAdding(false)}>
            Cancel
          </button>
          <SettingsButton onClick={save} disabled={!open} aria-busy={setSecret.isPending} aria-disabled={setSecret.isPending || undefined}>
            <PendingLabel pending={setSecret.isPending} label="Save" pendingLabel="Saving…" />
          </SettingsButton>
        </form>
        <FormNote locked={!open} error={problem ?? (setSecret.error ? vaultErrorText(setSecret.error) : null)} />
      </AnimatedCollapse>
    </VaultRow>
  )
}

function ToolchainRow({ agentId, open }: { agentId: string; open: boolean }): React.JSX.Element {
  const runtimes = useVaultRuntimes(agentId, open)
  const update = useVaultUpdateDependencies()
  const [output, setOutput] = useState('')
  const [outcome, setOutcome] = useState<{ status: 'running' | 'done' | 'failed'; message?: string } | null>(null)
  const [showOutput, setShowOutput] = useState(false)
  // Output streams on the move-progress channel as step `rebuild` (preload).
  const listening = useRef(false)
  useEffect(() => {
    return onVaultMoveProgress((event) => {
      if (event.agentId !== agentId || event.step !== 'rebuild' || !listening.current) return
      if (event.output) setOutput((prev) => prev + event.output)
      if (event.status === 'running') setOutcome({ status: 'running', message: event.message })
      if (event.status === 'done' || event.status === 'failed' || event.status === 'skipped') {
        listening.current = false
        setOutcome({ status: event.status === 'failed' ? 'failed' : 'done', message: event.message })
        void runtimes.refetch()
      }
    })
    // `runtimes.refetch` is stable for the query's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId])
  const list = runtimes.data ?? []
  const outdated = list.filter((runtime) => runtime.pinned && runtime.pinned !== runtime.version)
  const text = !open
    ? LOCKED_VALUE
    : runtimes.isLoading
      ? 'Reading…'
      : runtimes.error
        ? vaultErrorText(runtimes.error)
        : list.length === 0
          ? 'Nothing installed'
          : list.map((runtime) => runtimeName(runtime, shortVersion(runtime.version))).join(' · ')
  const running = update.isPending || outcome?.status === 'running'
  return (
    <VaultRow
      label="Toolchain"
      info={
        <p>
          The engine and the agent’s dependencies inside the vault, installed from pinned versions. Updating asks
          for your approval and opens the package hosts for that install only.
        </p>
      }
      value={
        <>
          {text}
          {/* A state, so a badge; the versions it would install are its tooltip (rule 13). */}
          {open && outdated.length > 0 && (
            // Top-aligned: centred, the badge grew the line by a few pixels and the row with it (rule 1).
            <span className="ml-2 inline-block align-top">
              <SettingsBadge
                title={`Update dependencies installs ${outdated
                  .map((runtime) => runtimeName(runtime, runtime.pinned!))
                  .join(' and ')}.`}
              >
                Update available
              </SettingsBadge>
            </span>
          )}
        </>
      }
      valueTitle={list.map((runtime) => runtimeName(runtime, runtime.version)).join('\n') || undefined}
      control={
        <SettingsButton
          disabled={!open}
          title={open ? undefined : 'Unlock the vault first'}
          aria-busy={running}
          aria-disabled={running || undefined}
          onClick={() => {
            update.reset()
            setOutput('')
            setOutcome(null)
            listening.current = true
            update.mutate(agentId, { onError: () => { listening.current = false } })
          }}
        >
          <PendingLabel pending={running} label="Update dependencies" pendingLabel={update.isPending ? APPROVAL : 'Updating…'} />
        </SettingsButton>
      }
    >
      {(outcome || output) && (
        <div className="mt-2">
          <div className="flex items-center gap-2 text-[13px]">
            <span className={`min-w-0 flex-1 truncate ${outcome?.status === 'failed' ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-muted)]'}`}>
              {outcome?.message ?? (outcome?.status === 'done' ? 'Dependencies updated.' : outcome?.status === 'failed' ? 'The update failed.' : 'Updating…')}
            </span>
            {output && (
              <SettingsIconButton
                title={showOutput ? 'Hide output' : 'Show output'}
                aria-label={showOutput ? 'Hide update output' : 'Show update output'}
                onClick={() => setShowOutput((value) => !value)}
              >
                <ChevronDown size={14} className={`transition-transform duration-200 ${showOutput ? 'rotate-180' : ''}`} />
              </SettingsIconButton>
            )}
          </div>
          <AnimatedCollapse open={showOutput && !!output}>
            <pre className="mt-2 max-h-48 overflow-auto rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-2 font-mono text-[12px] text-[var(--color-text-secondary)]">
              {output}
            </pre>
          </AnimatedCollapse>
        </div>
      )}
      <RowError error={update.error ? vaultErrorText(update.error) : null} />
    </VaultRow>
  )
}

/** A shell inside the vault (gated: the helper asks every time). */
function TerminalRow({ agent, open }: { agent: LocalAgentDto; open: boolean }): React.JSX.Element {
  const [showing, setShowing] = useState(false)
  return (
    <VaultRow
      label="Terminal"
      info={
        <p>
          A shell inside the vault, as the agent, in its folder. Each terminal asks for your approval first, and the
          vault stays unlocked while it is open.
        </p>
      }
      value={open ? 'A shell inside the vault' : LOCKED_VALUE}
      control={
        <SettingsButton
          disabled={!open}
          title={open ? undefined : 'Unlock the vault first'}
          onClick={() => setShowing(true)}
        >
          <SquareTerminal size={14} aria-hidden="true" />
          Open terminal
        </SettingsButton>
      }
    >
      {showing && <VaultTerminalDialog agentId={agent.id} agentName={agent.name} onClose={() => setShowing(false)} />}
    </VaultRow>
  )
}

/** The vault's own files, read through the guest; each export asks (D4). */
function FilesCard({ agentId, open }: { agentId: string; open: boolean }): React.JSX.Element {
  const [path, setPath] = useState('')
  const files = useVaultFiles(agentId, path, open)
  const exportFile = useVaultExportFile()
  const [exporting, setExporting] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const parts = path ? path.split('/') : []
  const entries = [...(files.data ?? [])].sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1
  )
  const run = (target: string): void => {
    exportFile.reset()
    setNote(null)
    setExporting(target)
    exportFile.mutate(
      { agentId, path: target },
      {
        onSuccess: (result) => setNote(result ? `Saved to ${result.savedTo}` : null),
        onSettled: () => setExporting(null)
      }
    )
  }
  return (
    <SettingsCard>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <SettingsLabel info={<p>The agent’s folder inside the vault. Exporting a file or folder asks for your approval each time, then saves it where you choose.</p>}>
            Files
          </SettingsLabel>
        </div>
        {/* There while locked too (disabled), so a lock moves nothing in this card (rule 1). */}
        <SettingsButton
          onClick={() => run(path || '.')}
          disabled={!open || exporting !== null}
          aria-busy={exporting === (path || '.')}
          title={!open ? 'Unlock the vault first' : path ? `Export ${path}` : 'Export the whole folder'}
        >
          <PendingLabel pending={exporting === (path || '.')} label="Export…" icon={<Download size={14} aria-hidden="true" />} />
        </SettingsButton>
      </div>
      <nav aria-label="Vault folder" className="mt-1 flex min-h-[1lh] flex-wrap items-center gap-1 text-[13px]">
        <button type="button" disabled={!open} onClick={() => setPath('')} className="font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] disabled:text-[var(--color-text-muted)]">
          Agent folder
        </button>
        {parts.map((part, index) => (
          <span key={index} className="flex items-center gap-1">
            <ChevronRight size={12} className="text-[var(--color-text-muted)]" aria-hidden="true" />
            <button
              type="button"
              onClick={() => setPath(parts.slice(0, index + 1).join('/'))}
              className="font-medium text-[var(--color-accent)] hover:text-[var(--color-accent-hover)]"
            >
              {part}
            </button>
          </span>
        ))}
      </nav>
      {!open ? (
        <p className="mt-2 text-[13px] text-[var(--color-text-muted)]">{LOCKED_VALUE}</p>
      ) : files.isLoading ? (
        <p className="mt-2 text-[13px] text-[var(--color-text-muted)]">Reading…</p>
      ) : files.error ? (
        <p role="alert" className="mt-2 text-[13px] text-[var(--color-danger)]">{vaultErrorText(files.error)}</p>
      ) : entries.length === 0 ? (
        <p className="mt-2 text-[13px] text-[var(--color-text-muted)]">Empty folder.</p>
      ) : (
        <ul className="mt-2 max-h-64 divide-y divide-[var(--color-border)] overflow-y-auto rounded-md border border-[var(--color-border)]">
          {entries.map((entry) => {
            const target = path ? `${path}/${entry.name}` : entry.name
            return (
              <li key={entry.name} className="flex items-center gap-2 px-2.5 py-1.5">
                {entry.type === 'dir' ? (
                  <Folder size={14} className="shrink-0 text-[var(--color-text-muted)]" aria-hidden="true" />
                ) : (
                  <File size={14} className="shrink-0 text-[var(--color-text-muted)]" aria-hidden="true" />
                )}
                {entry.type === 'dir' ? (
                  <button
                    type="button"
                    onClick={() => setPath(target)}
                    className="min-w-0 flex-1 truncate text-left text-[13px] font-medium text-[var(--color-text)] hover:text-[var(--color-accent)]"
                  >
                    {entry.name}
                  </button>
                ) : (
                  <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--color-text)]">{entry.name}</span>
                )}
                <span className="shrink-0 text-[12px] text-[var(--color-text-muted)]">
                  {entry.type === 'file' ? formatBytes(entry.size) : ''}
                </span>
                <SettingsIconButton
                  title="Export…"
                  aria-label={`Export ${entry.name}`}
                  disabled={exporting !== null}
                  onClick={() => run(target)}
                >
                  {exporting === target ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                </SettingsIconButton>
              </li>
            )
          })}
        </ul>
      )}
      {exportFile.error ? (
        <p role="alert" className="mt-2 text-[13px] text-[var(--color-danger)]">
          {vaultErrorText(exportFile.error, 'Export cancelled at the prompt — nothing left the vault.')}
        </p>
      ) : note ? (
        <p role="status" className="mt-2 truncate text-[13px] text-[var(--color-text-muted)]" title={note}>
          {note}
        </p>
      ) : null}
    </SettingsCard>
  )
}

/** Move out of vault… and Delete vault…, each behind its own confirm (ux_rules rule 5). */
function LeaveVaultCard({ agent }: { agent: LocalAgentDto }): React.JSX.Element {
  const moveOut = useVaultMoveOut()
  const destroy = useVaultDestroy()
  const [asking, setAsking] = useState<'move-out' | 'destroy' | null>(null)
  return (
    <SettingsCard>
      {/* The buttons say what they do; a sentence restating them was removed (rule 7). */}
      <div className="flex items-center justify-end gap-2">
        <SettingsButton onClick={() => { moveOut.reset(); setAsking('move-out') }}>
          <FolderOutput size={14} aria-hidden="true" />
          Move out of vault…
        </SettingsButton>
        <button
          type="button"
          onClick={() => { destroy.reset(); setAsking('destroy') }}
          className="ambient-button inline-flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--color-danger)]/40 bg-[var(--color-bg-secondary)] px-2.5 py-1 text-[13px] font-medium text-[var(--color-danger)] transition-colors hover:bg-[var(--color-danger)]/10"
        >
          <Trash2 size={14} aria-hidden="true" />
          Delete vault…
        </button>
      </div>
      {asking === 'move-out' && (
        <VaultConfirmDialog
          title="Move out of vault"
          confirmLabel="Move out"
          pendingLabel={APPROVAL}
          pending={moveOut.isPending}
          error={moveOut.error ? vaultErrorText(moveOut.error) : null}
          onCancel={() => setAsking(null)}
          onConfirm={() => moveOut.mutate(agent.id, { onSuccess: () => setAsking(null) })}
        >
          <p>
            {agent.name} goes back to a normal folder in your agents folder, and its vault is deleted. Everything
            inside — files, chats, secrets, the engine login — becomes readable by other apps and agents on this
            Mac again.
          </p>
          <p>The vault helper asks for your approval before anything leaves.</p>
        </VaultConfirmDialog>
      )}
      {asking === 'destroy' && (
        <TypeNameConfirmDialog
          title="Delete vault"
          agentName={agent.name}
          confirmLabel="Delete vault"
          pendingLabel={APPROVAL}
          pending={destroy.isPending}
          error={destroy.error ? vaultErrorText(destroy.error) : null}
          onCancel={() => setAsking(null)}
          onConfirm={() => destroy.mutate(agent.id, { onSuccess: () => setAsking(null) })}
        >
          <p>
            Nothing can be recovered. {agent.name}, its files, its chats, its secrets and its engine login are
            deleted with the vault. There is no backup, and nothing goes to the Trash.
          </p>
          <p>Files you exported earlier stay where you saved them.</p>
        </TypeNameConfirmDialog>
      )}
    </SettingsCard>
  )
}

