import { useEffect } from 'react'
import { X } from 'lucide-react'
import { useToastStore } from '../../stores/toast.store'
import { useUIStore } from '../../stores/ui.store'

export function DesktopToast(): React.JSX.Element | null {
  const { toast, dismiss } = useToastStore()
  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(dismiss, 10000)
    return () => window.clearTimeout(timer)
  }, [toast, dismiss])
  if (!toast) return null
  return <div role="status" className="app-popover-surface fixed bottom-5 left-1/2 z-50 flex max-w-lg -translate-x-1/2 items-start gap-3 rounded-lg border border-[var(--color-border)] px-4 py-3 text-xs shadow-lg">
    <div className="space-y-1">
      <p>{toast.message}</p>
      <button type="button" onClick={() => { useUIStore.getState().setSettingsMenu('profile-agents'); useUIStore.getState().setActiveView('settings'); dismiss() }} className="text-[var(--color-accent)]">Settings → Profile → Agents</button>
    </div>
    <button type="button" aria-label="Dismiss notification" onClick={dismiss} className="text-[var(--color-text-muted)]"><X size={14} /></button>
  </div>
}
