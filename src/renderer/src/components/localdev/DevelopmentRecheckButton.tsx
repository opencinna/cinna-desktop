import { useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { unwrapIpcError } from '../../utils/ipcError'
import { SettingsButton } from '../settings/SettingsLayout'

/** Keep a quick check visible long enough to register, and prevent duplicate clicks. */
export function DevelopmentRecheckButton({ onCheck, fetching = false }: {
  onCheck: () => Promise<unknown> | void
  fetching?: boolean
}): React.JSX.Element {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const running = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const check = async (): Promise<void> => {
    if (running.current || fetching) return
    running.current = true
    setPending(true)
    setError(null)
    const started = Date.now()
    try { await onCheck() }
    catch (err) { if (mounted.current) setError(unwrapIpcError(err, 'Could not check the workspace. Try again.')) }
    finally {
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, 600 - (Date.now() - started))))
      running.current = false
      if (mounted.current) setPending(false)
    }
  }
  const checking = pending || fetching
  return <>
    <SettingsButton disabled={checking} aria-busy={checking} onClick={() => void check()}>
      <RefreshCw size={13} className={checking ? 'animate-spin' : undefined} />
      {checking ? 'Checking…' : 'Check again'}
    </SettingsButton>
    {error && <p role="alert" className="text-sm text-[var(--color-danger)]">{error}</p>}
  </>
}
