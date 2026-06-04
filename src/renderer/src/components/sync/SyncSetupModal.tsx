/**
 * App-level modal raised right after a Cinna profile signs in, to make Cloud
 * Sync as seamless as the end-to-end-encryption model allows. It evaluates the
 * sync state once per profile per app session and picks one of three outcomes:
 *
 *  - **Not initialized** → an "Enable sync" prompt with a toggle that is ON by
 *    default. Confirming runs first-device init and then forces the one-time
 *    recovery-key backup (the recovery phrase is the only way back in if every
 *    trusted device is lost).
 *  - **Initialized but locked** (a new/wiped device, or one signed out with
 *    "remove device") → a "Restore your data" prompt. Because the server is
 *    zero-knowledge, the data cannot come back silently — the user pairs with
 *    another device or enters their recovery key/passphrase.
 *  - **Initialized and already unlocked** (a trusted device that auto-unlocked
 *    on activation) → nothing; data re-syncs on its own.
 *
 * Mounted once in App.tsx beside ReauthModal. Keys never cross the bridge — it
 * only ever sees the high-level SyncState and drives the same `useSync` hooks
 * the settings screen uses.
 */
import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ShieldCheck, KeyRound, Smartphone, Check, Copy, RefreshCw, X } from 'lucide-react'
import { useAuthStore } from '../../stores/auth.store'
import { SYNC_KEY, useSyncInit, useSyncUnlock } from '../../hooks/useSync'
import { PairJoinPane } from './PairJoinPane'
import type { SyncInitResult, UnlockMethod } from '../../../../shared/sync'

type Mode = 'enable' | 'restore'

// TEMP (re-enable later): suppress the post-login "Enable Cloud Sync" prompt.
// The restore flow (for devices that already have sync initialized) stays on —
// only the proactive enable-onboarding nag is paused. Flip back to `true` (or
// remove this flag and its use below) to bring the enable prompt back.
const SHOW_ENABLE_PROMPT = false

/** Evaluate at most once per profile per app session (StrictMode-safe). */
const evaluatedUserIds = new Set<string>()

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function SyncSetupModal(): React.JSX.Element | null {
  const currentUser = useAuthStore((s) => s.currentUser)
  const queryClient = useQueryClient()
  const isCinnaUser = currentUser?.type === 'cinna_user'
  const userId = currentUser?.id ?? null

  const [mode, setMode] = useState<Mode | null>(null)
  const [methods, setMethods] = useState<UnlockMethod[]>([])
  const [initResult, setInitResult] = useState<SyncInitResult | null>(null)

  // On sign-in, ask the main process where this device stands and decide which
  // prompt (if any) to raise. This is an intentional imperative one-shot (once
  // per profile per session), but it goes through `fetchQuery` so the result
  // seeds the same `['sync','state']` cache the Settings card reads. getState()
  // drives activation + the silent device-key auto-unlock first, so `locked`
  // already reflects the final state.
  useEffect(() => {
    if (!isCinnaUser || !userId) return
    if (evaluatedUserIds.has(userId)) return
    evaluatedUserIds.add(userId)
    let cancelled = false
    void (async () => {
      try {
        const state = await queryClient.fetchQuery({
          queryKey: SYNC_KEY,
          queryFn: () => window.api.sync.getState()
        })
        if (cancelled) return
        // This device opted out of online sync — respect that, don't nag to
        // enable/restore. It re-engages only via an explicit "Connect" in Settings.
        if (state.disconnected) return
        setMethods(state.unlockMethods)
        if (!state.initialized) {
          if (SHOW_ENABLE_PROMPT) setMode('enable')
        } else if (state.locked && state.status !== 'offline') setMode('restore')
      } catch {
        // Offline or not ready — skip; the Settings → Cloud Sync card still works.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [isCinnaUser, userId, queryClient])

  const close = (): void => {
    setMode(null)
    setInitResult(null)
  }

  if (!isCinnaUser || mode === null) return null

  return (
    <ModalShell onClose={close}>
      {initResult ? (
        <RecoveryBackup result={initResult} onDone={close} />
      ) : mode === 'enable' ? (
        <EnablePane onEnabled={setInitResult} onDismiss={close} />
      ) : (
        <RestorePane methods={methods} onDone={close} onDismiss={close} />
      )}
    </ModalShell>
  )
}

// ---------------- shell ----------------

function ModalShell({
  children,
  onClose
}: {
  children: React.ReactNode
  onClose: () => void
}): React.JSX.Element {
  return (
    // z-[95] sits just under the reauth modal (z-[100]) — a dead session is more
    // urgent than a sync prompt.
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div
        className="w-[460px] max-w-[92vw] rounded-lg border border-[var(--color-border)]
          bg-[var(--color-bg-secondary)] shadow-2xl"
      >
        <div className="flex items-center justify-between px-4 pt-3.5 pb-2">
          <div className="flex items-center gap-2 text-[var(--color-accent)]">
            <ShieldCheck size={18} />
            <span className="text-sm font-semibold text-[var(--color-text)]">Cloud Sync</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
          >
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

// ---------------- enable (first device) ----------------

function EnablePane({
  onEnabled,
  onDismiss
}: {
  onEnabled: (r: SyncInitResult) => void
  onDismiss: () => void
}): React.JSX.Element {
  const init = useSyncInit()
  const [enabled, setEnabled] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const handleContinue = async (): Promise<void> => {
    if (!enabled) {
      onDismiss()
      return
    }
    setError(null)
    try {
      onEnabled(await init.mutateAsync())
    } catch (err) {
      setError(toMessage(err))
    }
  }

  return (
    <div className="px-4 pb-4">
      <p className="text-[13px] text-[var(--color-text-muted)] leading-relaxed">
        Sync your notes, jobs, and folders across your devices. Everything is encrypted on this
        device before it leaves — Cinna stores only ciphertext and can never read your data.
      </p>

      <label className="mt-3 flex items-center gap-2.5 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 cursor-pointer">
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          onClick={() => setEnabled((v) => !v)}
          className={`shrink-0 relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${
            enabled ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-bg-tertiary)]'
          }`}
        >
          <span
            className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
              enabled ? 'translate-x-3.5' : 'translate-x-0.5'
            }`}
          />
        </button>
        <span className="text-[13px] text-[var(--color-text)]">Enable data sync between devices</span>
      </label>

      {error && <div className="text-[12px] text-[var(--color-danger)] mt-2">{error}</div>}

      <div className="flex justify-end gap-2 mt-4">
        <SecondaryButton onClick={onDismiss}>Not now</SecondaryButton>
        <PrimaryButton onClick={handleContinue} busy={init.isPending}>
          {enabled ? 'Enable sync' : 'Continue'}
        </PrimaryButton>
      </div>
    </div>
  )
}

// ---------------- restore (new / wiped device) ----------------

function RestorePane({
  methods,
  onDone,
  onDismiss
}: {
  methods: UnlockMethod[]
  onDone: () => void
  onDismiss: () => void
}): React.JSX.Element {
  const queryClient = useQueryClient()
  const unlock = useSyncUnlock()
  const [sub, setSub] = useState<'choose' | 'recovery' | 'passphrase' | 'pair'>('choose')
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)

  const finish = (): void => {
    // Pull synced collections back into view without a manual refetch.
    void queryClient.invalidateQueries()
    onDone()
  }

  const submit = async (): Promise<void> => {
    setError(null)
    try {
      await unlock.mutateAsync(
        sub === 'recovery'
          ? { method: 'recovery', recoveryMnemonic: value.trim() }
          : { method: 'passphrase', passphrase: value }
      )
      finish()
    } catch (err) {
      setError(toMessage(err))
    }
  }

  return (
    <div className="px-4 pb-4">
      <p className="text-[13px] text-[var(--color-text-muted)] leading-relaxed">
        Your account has synced data, but this device isn&apos;t set up to decrypt it yet. Restore it
        by pairing with a signed-in device or entering your recovery key — your account password is
        not enough.
      </p>

      {sub === 'choose' && (
        <div className="mt-3 flex flex-col gap-2">
          <ChoiceButton icon={<Smartphone size={14} />} onClick={() => setSub('pair')}>
            Pair with another device
          </ChoiceButton>
          <ChoiceButton icon={<KeyRound size={14} />} onClick={() => setSub('recovery')}>
            Use recovery key
          </ChoiceButton>
          {methods.includes('passphrase') && (
            <ChoiceButton icon={<KeyRound size={14} />} onClick={() => setSub('passphrase')}>
              Use passphrase
            </ChoiceButton>
          )}
          <div className="flex justify-end mt-1">
            <SecondaryButton onClick={onDismiss}>Not now</SecondaryButton>
          </div>
        </div>
      )}

      {(sub === 'recovery' || sub === 'passphrase') && (
        <div className="mt-3 flex flex-col gap-2">
          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            rows={sub === 'recovery' ? 2 : 1}
            autoFocus
            placeholder={
              sub === 'recovery' ? 'Enter your 24-word recovery phrase' : 'Enter your passphrase'
            }
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-[13px] text-[var(--color-text)]"
          />
          {error && <div className="text-[12px] text-[var(--color-danger)]">{error}</div>}
          <div className="flex justify-end gap-2">
            <SecondaryButton
              onClick={() => {
                setSub('choose')
                setValue('')
                setError(null)
              }}
            >
              Back
            </SecondaryButton>
            <PrimaryButton onClick={submit} busy={unlock.isPending} disabled={!value.trim()}>
              Restore
            </PrimaryButton>
          </div>
        </div>
      )}

      {sub === 'pair' && <PairPane onPaired={finish} onBack={() => setSub('choose')} />}
    </div>
  )
}

function PairPane({
  onPaired,
  onBack
}: {
  onPaired: () => void
  onBack: () => void
}): React.JSX.Element {
  return (
    <div className="mt-3">
      <PairJoinPane onPaired={onPaired} />
      <div className="flex justify-end mt-3">
        <SecondaryButton onClick={onBack}>Back</SecondaryButton>
      </div>
    </div>
  )
}

// ---------------- recovery backup (after first-device enable) ----------------

function RecoveryBackup({
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
    <div className="px-4 pb-4">
      <div className="text-[13px] font-medium text-[var(--color-text)] mb-1">
        Save your recovery key
      </div>
      <p className="text-[12px] text-[var(--color-text-muted)] leading-relaxed mb-2">
        This is the only way to recover your data on a new device if you lose access to all your
        trusted devices. Store it somewhere safe — <strong>we cannot recover it for you.</strong>
      </p>
      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 font-mono text-[13px] text-[var(--color-text)] leading-relaxed break-words">
        {result.recoveryMnemonic}
      </div>
      <div className="flex flex-wrap items-center gap-2 mt-2">
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
        <img
          src={result.recoveryQrDataUrl}
          alt="Recovery QR"
          className="w-20 h-20 rounded-md bg-white p-1 ml-auto"
        />
      </div>
      <label className="flex items-center gap-2 mt-3 text-[13px] text-[var(--color-text)]">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />I have
        saved my recovery key somewhere safe
      </label>
      <div className="flex justify-end mt-3">
        <PrimaryButton disabled={!saved} onClick={onDone}>
          Done
        </PrimaryButton>
      </div>
    </div>
  )
}

// ---------------- primitives ----------------

function ChoiceButton({
  icon,
  children,
  onClick
}: {
  icon: React.ReactNode
  children: React.ReactNode
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-2 w-full px-3 py-2 rounded-md text-[13px] font-medium
        border border-[var(--color-border)] text-[var(--color-text)]
        hover:bg-[var(--color-bg-hover)] transition-colors text-left"
    >
      <span className="text-[var(--color-accent)]">{icon}</span>
      {children}
    </button>
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
      {busy && <RefreshCw size={12} className="animate-spin" />}
      {children}
    </button>
  )
}

function SecondaryButton({
  children,
  onClick
}: {
  children: React.ReactNode
  onClick?: () => void | Promise<void>
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[13px] font-medium border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] transition-colors"
    >
      {children}
    </button>
  )
}
