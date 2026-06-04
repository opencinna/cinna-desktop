import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  RefreshCw,
  ShieldCheck,
  Pause,
  Play,
  Unlock,
  Lock,
  KeyRound,
  Smartphone,
  Laptop,
  CloudOff,
  Copy,
  Check
} from 'lucide-react'
import { useAuthStore } from '../../stores/auth.store'
import {
  useSyncState,
  useSyncInit,
  useSyncUnlock,
  useSyncLock,
  useSyncNow,
  usePairingInbox,
  usePairingBeginVerify,
  usePairingConfirmVerify,
  usePairingCancelVerify,
  useRevokeDevice,
  useSyncDisconnect,
  useSyncReconnect
} from '../../hooks/useSync'
import { PairJoinPane } from '../sync/PairJoinPane'
import type { SyncState, SyncInitResult, IncomingPairing } from '../../../../shared/sync'

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
  // `useSyncEvents` is mounted app-level (App.tsx → Shell) so note/job caches
  // and the sync-state read stay live regardless of which screen is open.

  const init = useSyncInit()
  const lock = useSyncLock()
  const syncNow = useSyncNow()
  const reconnect = useSyncReconnect()

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
              {state?.disconnected ? (
                <PrimaryButton
                  onClick={() => handle(() => reconnect.mutateAsync())}
                  busy={reconnect.isPending}
                >
                  Connect
                </PrimaryButton>
              ) : !state?.initialized ? (
                <PrimaryButton onClick={handleInit} busy={init.isPending}>
                  Enable
                </PrimaryButton>
              ) : state.locked ? (
                <span className="inline-flex items-center gap-1.5 text-[13px] text-[var(--color-text-muted)]">
                  {state.paused ? (
                    <>
                      <Pause size={13} /> Paused
                    </>
                  ) : (
                    <>
                      <Lock size={13} /> Locked
                    </>
                  )}
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
              {state.locked ? (
                // A user-initiated **pause** resumes via device-unlock; any other
                // locked state means this device can't auto-unlock (new/wiped, or
                // the account was reset + re-initialized on a peer) → it must
                // **restore** via pairing or recovery, not a dead "Resume".
                <UnlockControls variant={state.paused ? 'paused' : 'restore'} onError={setError} />
              ) : (
                <>
                  <SecondaryButton
                    onClick={() => handle(() => syncNow.mutateAsync())}
                    busy={syncNow.isPending}
                  >
                    <RefreshCw size={12} className={syncNow.isPending ? 'animate-spin' : ''} /> Sync
                    now
                  </SecondaryButton>
                  <SecondaryButton
                    onClick={() => handle(() => lock.mutateAsync())}
                    busy={lock.isPending}
                  >
                    <Pause size={12} /> Pause sync
                  </SecondaryButton>
                </>
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
        </>
      )}

      {/* Disconnect is offered whenever this device participates (active, paused,
          or locked-untrusted) — it's per-device and reversible. Hidden once
          already disconnected (the header shows **Connect** instead). */}
      {state?.initialized && <DisconnectSyncCard onError={setError} />}

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
  const label = state.disconnected
    ? 'Online sync is off on this device — your data is still here. Connect to sync again.'
    : state.status === 'syncing'
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

/**
 * Locked-state controls. Two variants:
 *  - `paused` — the user paused a **trusted** device; "Resume sync" re-unlocks it
 *    via the device key (recovery / passphrase remain as fallbacks).
 *  - `restore` — this device can't auto-unlock (new/wiped, or the account was
 *    reset + re-initialized on a peer). Device-unlock would only ever fail, so we
 *    offer **Pair with another device** instead, plus recovery / passphrase. This
 *    is what unsticks the "Locked" trap that a plain "Resume" left behind.
 */
function UnlockControls({
  variant,
  onError
}: {
  variant: 'paused' | 'restore'
  onError: (msg: string) => void
}): React.JSX.Element {
  const queryClient = useQueryClient()
  const unlock = useSyncUnlock()
  const [mode, setMode] = useState<'idle' | 'recovery' | 'passphrase' | 'pair'>('idle')
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

  if (mode === 'pair') {
    return (
      <div className="w-full">
        <PairJoinPane
          onPaired={() => {
            // The sealed UMK arrived → pull synced data back into view.
            void queryClient.invalidateQueries()
            setMode('idle')
          }}
        />
        <div className="mt-2">
          <SecondaryButton onClick={() => setMode('idle')}>Cancel</SecondaryButton>
        </div>
      </div>
    )
  }

  if (mode === 'idle') {
    return (
      <>
        {variant === 'paused' ? (
          <SecondaryButton onClick={unlockDevice} busy={unlock.isPending}>
            <Play size={12} /> Resume sync
          </SecondaryButton>
        ) : (
          <SecondaryButton onClick={() => setMode('pair')}>
            <Smartphone size={12} /> Pair with another device
          </SecondaryButton>
        )}
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
 *
 * Discovery is automatic: while this (foregrounded, unlocked) device is active,
 * the main process polls its pairing inbox and surfaces incoming requests here —
 * no routing code to transfer. The user opts in per request, then transcribes
 * the 6-digit code shown on the new device (commit-then-reveal: a tampered
 * request aborts before any code is accepted).
 */
function PairingCard(): React.JSX.Element {
  const { incoming, dismiss } = usePairingInbox(true)

  return (
    <section>
      <SectionTitle>Add a device</SectionTitle>
      <Card>
        <div className="text-[13px] font-medium text-[var(--color-text)] mb-1">
          Authorize a new device
        </div>
        <p className="text-[12px] text-[var(--color-text-muted)] leading-relaxed mb-2">
          On the new device, sign in and choose <strong>Pair with another device</strong>. Its
          request appears here automatically — verify it by entering the 6-digit code it shows.
        </p>
        {incoming.length === 0 ? (
          <div className="text-[12px] text-[var(--color-text-muted)]">
            No incoming requests. Waiting for a new device…
          </div>
        ) : (
          <ul className="space-y-2">
            {incoming.map((req) => (
              <IncomingPairingRow key={req.id} request={req} onDone={() => dismiss(req.id)} />
            ))}
          </ul>
        )}
      </Card>
    </section>
  )
}

/**
 * One incoming pairing request: the user opts in (`Verify`), the handshake runs
 * ("Establishing secure channel…"), then they enter the new device's 6-digit
 * code to authorize. A mismatch/tamper shows inline and never seals the key.
 */
function IncomingPairingRow({
  request,
  onDone
}: {
  request: IncomingPairing
  onDone: () => void
}): React.JSX.Element {
  const beginVerify = usePairingBeginVerify()
  const confirmVerify = usePairingConfirmVerify()
  const cancelVerify = usePairingCancelVerify()
  const [phase, setPhase] = useState<'idle' | 'verifying' | 'enter' | 'done'>('idle')
  const [sas, setSas] = useState('')
  const [error, setError] = useState<string | null>(null)
  // True once the handshake reached a terminal outcome (explicit cancel or a
  // successful seal) — so the unmount cleanup doesn't redundantly cancel again.
  const handledRef = useRef(false)

  const start = async (): Promise<void> => {
    setError(null)
    setPhase('verifying')
    try {
      await beginVerify.mutateAsync(request.id)
      setPhase('enter')
    } catch (err) {
      setError(toMessage(err))
      setPhase('idle')
    }
  }

  const confirm = async (): Promise<void> => {
    setError(null)
    try {
      await confirmVerify.mutateAsync({ id: request.id, sas })
      handledRef.current = true
      setPhase('done')
      setTimeout(onDone, 2500)
    } catch (err) {
      setError(toMessage(err))
    }
  }

  const cancel = (): void => {
    handledRef.current = true
    void cancelVerify.mutate(request.id)
    onDone()
  }

  // If the row unmounts mid-handshake (e.g. Settings closed while
  // "Establishing secure channel…"), abandon the verification so the
  // main-process poll bails and the stashed joiner key is freed. A ref mirrors
  // the phase so the cleanup doesn't capture a stale value; a successful seal or
  // an explicit cancel (`handledRef`) is left alone.
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  useEffect(() => {
    return () => {
      if (
        !handledRef.current &&
        (phaseRef.current === 'verifying' || phaseRef.current === 'enter')
      ) {
        void window.api.sync.pairingCancelVerify(request.id)
      }
    }
  }, [request.id])

  const label = request.deviceLabel || 'New device'

  return (
    <li className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-3">
      <div className="flex items-center gap-2">
        <Smartphone size={14} className="text-[var(--color-text-muted)]" />
        <span className="text-[13px] text-[var(--color-text)] flex-1">{label}</span>
        {phase === 'idle' && (
          <>
            <PrimaryButton onClick={start}>Verify</PrimaryButton>
            <SecondaryButton onClick={onDone}>Dismiss</SecondaryButton>
          </>
        )}
      </div>

      {phase === 'verifying' && (
        <div className="text-[12px] text-[var(--color-text-muted)] mt-2 inline-flex items-center gap-1.5">
          <RefreshCw size={12} className="animate-spin" /> Establishing secure channel…
        </div>
      )}

      {phase === 'enter' && (
        <div className="mt-2 space-y-2 max-w-md">
          <div className="text-[12px] text-[var(--color-text-muted)]">
            Enter the 6-digit code shown on <strong>{label}</strong>:
          </div>
          <div className="flex gap-2">
            <input
              value={sas}
              onChange={(e) => setSas(e.target.value)}
              autoFocus
              inputMode="numeric"
              placeholder="123 456"
              className="flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-[13px] font-mono tracking-widest text-[var(--color-text)]"
            />
            <PrimaryButton
              busy={confirmVerify.isPending}
              disabled={sas.replace(/\D/g, '').length < 6}
              onClick={confirm}
            >
              Authorize
            </PrimaryButton>
            <SecondaryButton onClick={cancel}>Cancel</SecondaryButton>
          </div>
        </div>
      )}

      {phase === 'done' && (
        <div className="text-[12px] mt-2 text-[var(--color-text-muted)]">
          Device authorized — it will finish syncing on its own.
        </div>
      )}

      {error && <div className="text-[12px] text-[var(--color-danger)] mt-2">{error}</div>}
    </li>
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

/**
 * "Disconnect online sync" — opts THIS device out of online sync (like deleting a
 * git remote): it's revoked from the account's authorized-devices list and stops
 * syncing here, while the account, every OTHER device, and all local data stay
 * intact. Reversible via **Connect**. Nothing — local or remote — is deleted.
 */
function DisconnectSyncCard({ onError }: { onError: (msg: string) => void }): React.JSX.Element {
  const disconnect = useSyncDisconnect()
  const [confirm, setConfirm] = useState(false)
  const [error, setError] = useState('')
  return (
    <section>
      <SectionTitle>Online sync</SectionTitle>
      <Card>
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <div className="text-[13px] font-medium text-[var(--color-text)]">
              Disconnect this device
            </div>
            <div className="text-[12px] text-[var(--color-text-muted)]">
              Stops online sync on <strong>this device only</strong> and removes it from your
              trusted-devices list. Your notes and jobs stay here, and your other devices keep
              syncing untouched. You can reconnect anytime.
            </div>
          </div>
          {confirm ? (
            <div className="flex gap-2">
              <button
                type="button"
                disabled={disconnect.isPending}
                onClick={async () => {
                  setError('')
                  try {
                    const { deviceRemoved } = await disconnect.mutateAsync()
                    setConfirm(false)
                    // The card unmounts now (state flips to disconnected), so a
                    // partial-failure note must go to the parent's header slot.
                    if (!deviceRemoved) {
                      onError(
                        "Disconnected on this device. It couldn't be removed from your trusted-devices list right now (offline) — revoke it from another device."
                      )
                    }
                  } catch (err) {
                    setError(toMessage(err))
                  }
                }}
                className="px-3 py-1.5 rounded-md text-[13px] font-medium bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white disabled:opacity-50"
              >
                Confirm disconnect
              </button>
              <SecondaryButton onClick={() => setConfirm(false)}>Cancel</SecondaryButton>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirm(true)}
              className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[13px] font-medium border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] transition-colors"
            >
              <CloudOff size={12} /> Disconnect
            </button>
          )}
        </div>
        {error && <div className="text-[12px] text-[var(--color-danger)] mt-2">{error}</div>}
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
