import { useEffect } from 'react'
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react'
import { useToastStore, type ToastKind } from '../../stores/toast.store'
import { useUIStore } from '../../stores/ui.store'

/** A kind adds its icon and a tinted border; a toast without one stays plain. */
const KINDS: Record<ToastKind, { icon: typeof Info; color: string; label: string }> = {
  info: { icon: Info, color: 'var(--color-severity-info)', label: 'Info' },
  success: { icon: CheckCircle2, color: 'var(--color-success)', label: 'Done' },
  warning: { icon: AlertTriangle, color: 'var(--color-warning)', label: 'Warning' },
  error: { icon: XCircle, color: 'var(--color-danger)', label: 'Error' }
}

export function DesktopToast(): React.JSX.Element | null {
  const { toast, dismiss } = useToastStore()
  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(dismiss, 10000)
    return () => window.clearTimeout(timer)
  }, [toast, dismiss])
  if (!toast) return null
  const link = toast.link
  const kind = toast.kind ? KINDS[toast.kind] : null
  const Icon = kind?.icon
  return <div role={toast.kind === 'error' ? 'alert' : 'status'} style={kind ? { borderColor: `color-mix(in srgb, ${kind.color} 45%, transparent)` } : undefined} className="app-popover-surface fixed bottom-5 left-1/2 z-50 flex max-w-lg -translate-x-1/2 items-start gap-3 rounded-lg border border-[var(--color-border)] px-4 py-3 text-xs shadow-lg">
    {Icon && <Icon size={14} aria-label={kind.label} style={{ color: kind.color }} className="mt-px shrink-0" />}
    <div className="space-y-1">
      <p>{toast.message}</p>
      {link && <button type="button" onClick={() => { useUIStore.getState().setSettingsMenu(link.settingsMenu); useUIStore.getState().setActiveView('settings'); dismiss() }} className="text-[var(--color-accent)]">{link.label}</button>}
    </div>
    <button type="button" aria-label="Dismiss notification" onClick={dismiss} className="text-[var(--color-text-muted)]"><X size={14} /></button>
  </div>
}
