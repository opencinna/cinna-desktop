import { useState } from 'react'
import {
  RefreshCw,
  ShieldCheck,
  Pause,
  Play,
  Unlock,
  KeyRound,
  Smartphone,
  Laptop,
  Trash2,
  Copy,
  Check
} from 'lucide-react'
import { useAuthStore } from '../../stores/auth.store'
import {
  useSyncState,
  useSyncEvents,
  useSyncInit,
  useSyncUnlock,
  useSyncLock,
  useSyncNow,
  usePairingScan,
  useRevokeDevice,
  useSyncWipe
} from '../../hooks/useSync'
import type { SyncState, SyncInitResult } from '../../../../shared/sync'

/**
 * Settings → Profile → Cloud Sync. End-to-end-encrypted cross-device sync of
 * notes, jobs, and folders through cinna-core. The renderer never sees keys or
 * plaintext — every call goes through the `useSync` hooks (React Query) which
 * wrap the main-process engine. See plans/native-client-data-sync.md §10.
 */
export function CloudSyncSettingsSection(): React.JSX.Element {
  const currentUser = useAuthStore((s) => s.currentUser)
  const isCinnaUser = currentUser?.type === 'cinna_user'

  const { data: state } = useSyncState(isCinnaUser)
  useSyncEvents(isCinnaUser)

  const init = useSyncInit()
  const lock = useSyncLock()
  const syncNow = useSyncNow()

  const [error, setError] = useState<string | null>(null)
  const [initResult, setInitResult] = useState<SyncInitResult | null>(null)

  if (!isCinnaUser) {
    return (
      <div className="text-[14px] text-[var(--color-text-muted)]">
        Cloud Sync is available when signed in to a Cinna account.
      </div>
    )
  }

  // First-device setup just completed — force the recovery-key backup screen.
  if (initResult) {
    return <RecoveryBackupScreen result={initResult} onDone={() => setInitResult(null)} />
  }

  const handleInit = async (): Promise<void> => {
    setError(null)
    try {
      setInitResult(await init.mutateAsync())
    } catch (err) {
      setError(toMessage(err))
    }
  }

  const handle = async (fn: () => Promise<unknown>): Promise<void> => {
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(toMessage(err))
    }
  }

  return (
    <div className="space-y-6">
      <section>
        <SectionTitle>Cloud Sync</SectionTitle>

        <Card>
          <div className="flex items-start gap-3">
            <div className="mt-0.5 text-[var(--color-accent)]">
              <ShieldCheck size={18} />
            </div>
            <div className="flex-1">
              <div className="text-[14px] font-medium text-[var(--color-text)]">
                End-to-end encrypted sync
              </div>
              <div className="text-[13px] text-[var(--color-text-muted)] mt-0.5 leading-relaxed">
                Your notes, jobs, and folders sync across devices. Everything is encrypted on this
                device — Cinna stores only ciphertext and cannot read your data.
              </div>
              <StatusLine state={state ?? null} />
              {error && <div className="text-[13px] text-[var(--color-danger)] mt-1.5">{error}</div>}
            </div>
            <div className="shrink-0">
              {!state?.initialized ? (
                <PrimaryButton onClick={handleInit} busy={init.isPending}>
                  Enable
                </PrimaryButton>
              ) : state.locked ? (
                <span className="inline-flex items-center gap-1.5 text-[13px] text-[var(--color-text-muted)]">
                  <Pause size={13} /> Paused
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-[13px] text-[var(--color-accent)]">
                  <Unlock size={13} /> Active
                </span>
              )}
            </div>
          </div>

          {state?.initialized && (
            <div className="mt-3 flex flex-wrap gap-2">
              <SecondaryButton
                onClick={() => handle(() => syncNow.mutateAsync())}
                busy={syncNow.isPending}
              >
                <RefreshCw size={12} className={syncNow.isPending ? 'animate-spin' : ''} /> Sync now
              </SecondaryButton>
              {state.locked ? (
                <UnlockControls onError={setError} />
              ) : (
                <SecondaryButton
                  onClick={() => handle(() => lock.mutateAsync())}
                  busy={lock.isPending}
                >
                  <Pause size={12} /> Pause sync
                </SecondaryButton>
              )}
            </div>
          )}
        </Card>
      </section>

      {state?.initialized && !state.locked && (
        <>
          <PairingCard />
          <DevicesCard state={state} />
          <StorageCard state={state} />
          <DangerCard />
        </>
      )}

      <MandatoryNotice />
    </div>
  )
}

// ---------------- helpers ----------------

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ---------------- sub-components ----------------

function StatusLine({ state }: { state: SyncState | null }): React.JSX.Element | null {
  if (!state) return null
  const label =
    state.status === 'syncing'
      ? 'Syncing…'
      : state.status === 'error'
        ? 'Sync error'
        : state.status === 'offline'
          ? 'Offline'
          : state.lastSyncAt
            ? `Last synced ${new Date(state.lastSyncAt).toLocaleString()}`
            : 'Idle'
  return <div className="text-[12px] text-[var(--color-text-muted)] mt-1.5">{label}</div>
}

function UnlockControls({ onError }: { onError: (msg: string) => void }): React.JSX.Element {
  const unlock = useSyncUnlock()
  const [mode, setMode] = useState<'idle' | 'recovery' | 'passphrase'>('idle')
  const [value, setValue] = useState('')

  const submit = async (): Promise<void> => {
    onError('')
    try {
      await unlock.mutateAsync(
        mode === 'recovery'
          ? { method: 'recovery', recoveryMnemonic: value }
          : { method: 'passphrase', passphrase: value }
      )
      setMode('idle')
      setValue('')
    } catch (err) {
      onError(toMessage(err))
    }
  }

  const unlockDevice = async (): Promise<void> => {
    onError('')
    try {
      await unlock.mutateAsync({ method: 'device' })
    } catch (err) {
      onError(toMessage(err))
    }
  }

  if (mode === 'idle') {
    return (
      <>
        <SecondaryButton onClick={unlockDevice} busy={unlock.isPending}>
          <Play size={12} /> Resume sync
        </SecondaryButton>
        <SecondaryButton onClick={() => setMode('recovery')}>
          <KeyRound size={12} /> Recovery key
        </SecondaryButton>
        <SecondaryButton onClick={() => setMode('passphrase')}>Passphrase</SecondaryButton>
      </>
    )
  }

  return (
    <div className="w-full flex flex-col gap-2">
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={mode === 'recovery' ? 2 : 1}
        placeholder={mode === 'recovery' ? 'Enter your 24-word recovery phrase' : 'Enter passphrase'}
        className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-[13px] text-[var(--color-text)]"
      />
      <div className="flex gap-2">
        <PrimaryButton busy={unlock.isPending} onClick={submit}>
          Unlock
        </PrimaryButton>
        <SecondaryButton onClick={() => setMode('idle')}>Cancel</SecondaryButton>
      </div>
    </div>
  )
}

/**
 * "Add a device" — the **sealer** half of pairing only. This card renders solely
 * on an already-unlocked device (gated by `initialized && !locked` upstream),
 * which always holds the UMK, so its only useful pairing role is to seal the key
 * to a joiner. The **joiner** half (showing a pairing code) lives in
 * `SyncSetupModal`'s restore flow on the new/locked device — the device that
 * actually lacks the key.
 */
function PairingCard(): React.JSX.Element {
  const pairingScan = usePairingScan()
  const [scanCode, setScanCode] = useState('')
  const [scanSas, setScanSas] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const scan = async (): Promise<void> => {
    setError(null)
    try {
      const { sas } = await pairingScan.mutateAsync(scanCode.trim())
      setScanSas(sas)
      setScanCode('')
    } catch (err) {
      setError(toMessage(err))
    }
  }

  return (
    <section>
      <SectionTitle>Add a device</SectionTitle>
      <Card>
        <div className="text-[13px] font-medium text-[var(--color-text)] mb-1">
          Authorize a new device
        </div>
        <p className="text-[12px] text-[var(--color-text-muted)] leading-relaxed mb-2">
          On the new device, sign in and choose <strong>Pair with another device</strong>. Paste the
          code it shows here, then confirm the verification numbers match on both devices.
        </p>
        <div className="flex gap-2 max-w-md">
          <input
            value={scanCode}
            onChange={(e) => setScanCode(e.target.value)}
            placeholder="Paste pairing code"
            className="flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-[13px] text-[var(--color-text)]"
          />
          <PrimaryButton busy={pairingScan.isPending} onClick={scan}>
            Authorize device
          </PrimaryButton>
        </div>
        {scanSas && (
          <div className="text-[13px] mt-2">
            Confirm these match the other device:{' '}
            <span className="font-mono text-[var(--color-accent)]">{scanSas}</span>
          </div>
        )}
        {error && <div className="text-[13px] text-[var(--color-danger)] mt-3">{error}</div>}
      </Card>
    </section>
  )
}

function DevicesCard({ state }: { state: SyncState }): React.JSX.Element {
  const revoke = useRevokeDevice()
  return (
    <section>
      <SectionTitle>Trusted devices</SectionTitle>
      <Card>
        {state.devices.length === 0 ? (
          <div className="text-[13px] text-[var(--color-text-muted)]">No other devices yet.</div>
        ) : (
          <ul className="divide-y divide-[var(--color-border)]">
            {state.devices.map((d) => {
              const DeviceIcon = deviceIcon(d.name)
              return (
              <li key={d.id} className="flex items-center gap-3 py-2 first:pt-0 last:pb-0">
                <DeviceIcon size={14} className="text-[var(--color-text-muted)]" />
                <div className="flex-1">
                  <div className="text-[13px] text-[var(--color-text)]">
                    {d.name}
                    {d.current && (
                      <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-[var(--color-accent)]/15 text-[var(--color-accent)]">
                        this device
                      </span>
                    )}
                  </div>
                  {d.lastSeenAt && (
                    <div className="text-[11px] text-[var(--color-text-muted)]">
                      Last seen {new Date(d.lastSeenAt).toLocaleString()}
                    </div>
                  )}
                </div>
                {!d.current && (
                  <button
                    type="button"
                    disabled={revoke.isPending}
                    onClick={() => revoke.mutate(d.id)}
                    className="text-[12px] text-[var(--color-danger)] hover:underline disabled:opacity-50"
                  >
                    Revoke
                  </button>
                )}
              </li>
              )
            })}
          </ul>
        )}
      </Card>
    </section>
  )
}

function StorageCard({ state }: { state: SyncState }): React.JSX.Element | null {
  if (state.usage == null && state.quota == null) return null
  const used = state.usage ?? 0
  const quota = state.quota ?? 0
  const pct = quota > 0 ? Math.min(100, Math.round((used / quota) * 100)) : 0
  return (
    <section>
      <SectionTitle>Storage</SectionTitle>
      <Card>
        <div className="text-[13px] text-[var(--color-text)] mb-1.5">
          {formatBytes(used)}
          {quota > 0 && ` of ${formatBytes(quota)} used`}
        </div>
        {quota > 0 && (
          <div className="h-1.5 rounded-full bg-[var(--color-bg-hover)] overflow-hidden">
            <div className="h-full bg-[var(--color-accent)]" style={{ width: `${pct}%` }} />
          </div>
        )}
      </Card>
    </section>
  )
}

function DangerCard(): React.JSX.Element {
  const wipe = useSyncWipe()
  const [confirm, setConfirm] = useState(false)
  return (
    <section>
      <SectionTitle>Danger zone</SectionTitle>
      <Card>
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <div className="text-[13px] font-medium text-[var(--color-text)]">
              Delete synced data
            </div>
            <div className="text-[12px] text-[var(--color-text-muted)]">
              Removes all encrypted data from Cinna. Local copies on your devices are kept.
            </div>
          </div>
          {confirm ? (
            <div className="flex gap-2">
              <button
                type="button"
                disabled={wipe.isPending}
                onClick={async () => {
                  await wipe.mutateAsync().catch(() => {})
                  setConfirm(false)
                }}
                className="px-3 py-1.5 rounded-md text-[13px] font-medium bg-[var(--color-danger)] text-white disabled:opacity-50"
              >
                Confirm delete
              </button>
              <SecondaryButton onClick={() => setConfirm(false)}>Cancel</SecondaryButton>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirm(true)}
              className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[13px] font-medium border border-[var(--color-danger)] text-[var(--color-danger)] hover:bg-[var(--color-danger)] hover:text-white transition-colors"
            >
              <Trash2 size={12} /> Delete
            </button>
          )}
        </div>
      </Card>
    </section>
  )
}

function RecoveryBackupScreen({
  result,
  onDone
}: {
  result: SyncInitResult
  onDone: () => void
}): React.JSX.Element {
  const [saved, setSaved] = useState(false)
  const [copied, setCopied] = useState(false)

  const download = (): void => {
    const blob = new Blob([result.recoveryMnemonic], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'cinna-sync-recovery.txt'
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-6">
      <section>
        <SectionTitle>Save your recovery key</SectionTitle>
        <Card>
          <p className="text-[13px] text-[var(--color-text-muted)] leading-relaxed mb-3">
            This is the only way to recover your data on a new device if you lose access to all your
            trusted devices. Store it somewhere safe — <strong>we cannot recover it for you.</strong>
          </p>
          <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 font-mono text-[13px] text-[var(--color-text)] leading-relaxed break-words">
            {result.recoveryMnemonic}
          </div>
          <div className="flex flex-wrap gap-2 mt-3">
            <SecondaryButton
              onClick={async () => {
                await navigator.clipboard.writeText(result.recoveryMnemonic)
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              }}
            >
              {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? 'Copied' : 'Copy'}
            </SecondaryButton>
            <SecondaryButton onClick={download}>Download .txt</SecondaryButton>
          </div>
          <img
            src={result.recoveryQrDataUrl}
            alt="Recovery QR"
            className="w-40 h-40 rounded-md bg-white p-1 mt-3"
          />
          <label className="flex items-center gap-2 mt-4 text-[13px] text-[var(--color-text)]">
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />I
            have saved my recovery key somewhere safe
          </label>
          <div className="mt-3">
            <PrimaryButton disabled={!saved} onClick={onDone}>
              Done
            </PrimaryButton>
          </div>
        </Card>
      </section>
    </div>
  )
}

function MandatoryNotice(): React.JSX.Element {
  return (
    <p className="text-[12px] text-[var(--color-text-muted)] leading-relaxed">
      Signing in again restores your data only with a trusted device, your recovery key, or your
      passphrase — your account password is not enough. Lose all three and the data is unrecoverable,
      including by us.
    </p>
  )
}

// ---------------- primitives ----------------

function SectionTitle({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <h2 className="text-[14px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-2">
      {children}
    </h2>
  )
}

function Card({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
      {children}
    </div>
  )
}

function PrimaryButton({
  children,
  onClick,
  busy,
  disabled
}: {
  children: React.ReactNode
  onClick?: () => void | Promise<void>
  busy?: boolean
  disabled?: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || disabled}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[13px] font-medium bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white transition-colors disabled:opacity-50"
    >
      {children}
    </button>
  )
}

function SecondaryButton({
  children,
  onClick,
  busy
}: {
  children: React.ReactNode
  onClick?: () => void | Promise<void>
  busy?: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[13px] font-medium border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] transition-colors disabled:opacity-50"
    >
      {children}
    </button>
  )
}

/**
 * Pick a device icon from its label. There's no device-type field on
 * `SyncDeviceInfo` — the desktop client labels itself "<host> (desktop)", so we
 * infer from keywords: mobile labels → phone, everything else (desktop/laptop or
 * unknown) → laptop.
 */
function deviceIcon(name: string): typeof Smartphone {
  return /mobile|phone|android|ios|iphone|ipad|tablet/i.test(name) ? Smartphone : Laptop
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
