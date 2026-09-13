import { AlertTriangle } from 'lucide-react'
import type { ReactNode } from 'react'

/** Shared warning above a composer; healthy composers render no panel. */
export function ComposerWarning({ children, action, tone = 'warning', className = '', role = 'status', label }: {
  children: ReactNode
  action?: ReactNode
  tone?: 'warning' | 'danger'
  className?: string
  role?: 'status' | 'alert'
  label?: string
}): React.JSX.Element {
  return <div role={role} aria-label={label} className={`flex items-start gap-2 rounded-xl border p-3 text-sm text-[var(--color-text)] ${tone === 'danger' ? 'border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10' : 'border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10'} ${className}`}>
    <AlertTriangle size={15} aria-hidden="true" className={`mt-0.5 shrink-0 ${tone === 'danger' ? 'text-[var(--color-danger)]' : 'text-[var(--color-warning)]'}`} />
    <div className="min-w-0 flex-1 break-words">{children}{action && <div className="mt-2 flex flex-wrap gap-2">{action}</div>}</div>
  </div>
}
