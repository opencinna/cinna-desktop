import { useRef, useState } from 'react'
import { DashboardDialog, DIALOG_PRIMARY } from './DashboardDialog'

const OPEN_ERRORS: Record<string, string> = {
  invalid_url: 'This is not a link that can be opened.',
  unsupported_protocol: 'Only web (http, https) and mailto links open from a dashboard.'
}

/**
 * A page asked to open a link (`cinna.openLink` / `ui/open-link`, README D17):
 * the full URL, and nothing opens until the owner says so. A URL built from
 * the data on screen is a leak, so the page's own click is not enough.
 * `onDone(true)` once the browser took it; Cancel is `onDone(false)`. A
 * failure to open says so here and closes nothing (ux rule 6).
 */
export function OpenLinkDialog({ url, onDone }: { url: string; onDone: (opened: boolean) => void }): React.JSX.Element {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  let host = url
  let mail: string | null = null
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'mailto:') mail = decodeURIComponent(parsed.pathname) || url
    else host = parsed.host || url
  } catch {
    // Shown whole below.
  }
  const open = (): void => {
    setPending(true)
    setError(null)
    window.api.system
      .openExternal(url)
      .then((result) => {
        if (result.success) return onDone(true)
        setPending(false)
        setError(OPEN_ERRORS[result.error] ?? 'The browser could not open it.')
      })
      .catch(() => {
        setPending(false)
        setError('The browser could not open it.')
      })
  }
  const title = mail !== null ? `Write to ${mail}?` : `Open ${host} in your browser?`
  return (
    <DashboardDialog label={title} pending={pending} onClose={() => onDone(false)} initialFocusRef={cancelRef}>
      <h2 className="text-sm font-semibold text-[var(--color-text)]">{title}</h2>
      <p className="mt-2 text-xs text-[var(--color-text-secondary)]">A dashboard page asked to open this link:</p>
      <p data-testid="open-link-url" className="mt-1.5 max-h-32 overflow-auto break-all rounded-md bg-[var(--color-bg-secondary)] px-2.5 py-1.5 font-mono text-[11px] text-[var(--color-text)]">
        {url}
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <button ref={cancelRef} type="button" disabled={pending} onClick={() => onDone(false)} className="px-3 py-1.5 text-xs font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] disabled:opacity-50">
          Cancel
        </button>
        <button type="button" disabled={pending} onClick={open} className={DIALOG_PRIMARY}>
          {pending ? 'Opening…' : 'Open'}
        </button>
      </div>
      {error && <p role="alert" className="mt-3 text-xs text-[var(--color-danger)]">{error}</p>}
    </DashboardDialog>
  )
}
