/**
 * The **joiner** half of device pairing — shown on the device that lacks the key
 * (a new/wiped/untrusted device restoring its data). It registers a pairing
 * request, waits for a trusted device to pick it up, then reveals the 6-digit
 * verification code (commit-then-reveal SAS) for the user to enter on that
 * trusted device. Finishes once the trusted device seals the UMK back.
 *
 * Shared by `SyncSetupModal` (login-time restore) and the Cloud Sync settings
 * card (restore on an untrusted device), so the joiner flow lives in one place.
 */
import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { usePairingStart, pollPairing } from '../../hooks/useSync'

const PAIRING_POLL_INTERVAL_MS = 2000
const PAIRING_POLL_MAX_ATTEMPTS = 90 // ~3 minutes, then the request is treated as expired

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function PairJoinPane({ onPaired }: { onPaired?: () => void }): React.JSX.Element {
  const pairingStart = usePairingStart()
  const [offer, setOffer] = useState<Awaited<ReturnType<typeof pairingStart.mutateAsync>> | null>(
    null
  )
  const [expired, setExpired] = useState(false)
  // SAS appears only after the trusted device joins the handshake (commit-then-
  // reveal): the joiner can't show it up front anymore.
  const [sas, setSas] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Start a request immediately so the QR/code shows without an extra click.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const o = await pairingStart.mutateAsync()
        if (!cancelled) setOffer(o)
      } catch (err) {
        if (!cancelled) setError(toMessage(err))
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Poll the relay: surface the SAS once the sealer joins, finish once the UMK
  // has been sealed back to us (a `state` event then flips the card to Active).
  useEffect(() => {
    if (!offer) return
    let attempts = 0
    const timer = setInterval(async () => {
      attempts += 1
      if (attempts > PAIRING_POLL_MAX_ATTEMPTS) {
        clearInterval(timer)
        setExpired(true)
        setOffer(null)
        return
      }
      try {
        const res = await pollPairing(offer.code)
        if (res.sas) setSas(res.sas)
        if (res.done) {
          clearInterval(timer)
          onPaired?.()
        }
      } catch {
        /* transient — keep polling until the cap */
      }
    }, PAIRING_POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [offer, onPaired])

  if (expired) {
    return (
      <div className="text-[12px] text-[var(--color-text-muted)]">
        Pairing request expired — go back and try again.
      </div>
    )
  }
  if (!offer) {
    return (
      <div className="text-[12px] text-[var(--color-text-muted)]">
        {error ?? 'Generating pairing request…'}
      </div>
    )
  }

  return (
    <div>
      <p className="text-[12px] text-[var(--color-text-muted)] leading-relaxed mb-2">
        On a device that already has sync unlocked, open Settings → Cloud Sync → Add a device. This
        request appears there automatically; then enter the code below on it to confirm.
      </p>
      <div className="flex items-center gap-3">
        <img src={offer.qrDataUrl} alt="Pairing QR" className="w-32 h-32 rounded-md bg-white p-1" />
        <div className="text-[12px] text-[var(--color-text-muted)] space-y-1.5">
          <div>
            Code: <code className="text-[var(--color-text)] break-all">{offer.code}</code>
          </div>
          {sas ? (
            <div className="space-y-0.5">
              <div className="text-[13px]">Enter this code on your trusted device:</div>
              <div className="font-mono text-[18px] tracking-widest text-[var(--color-accent)]">
                {sas}
              </div>
            </div>
          ) : (
            <div className="inline-flex items-center gap-1.5">
              <RefreshCw size={12} className="animate-spin" /> Waiting for your trusted device…
            </div>
          )}
        </div>
      </div>
      {error && <div className="text-[12px] text-[var(--color-danger)] mt-2">{error}</div>}
    </div>
  )
}
