import { describeNetworkError } from '../../utils/networkError'

/**
 * A message that may be a raw network error from main. `net::ERR_CONNECTION_REFUSED`
 * reads as a sentence, and the code itself waits behind Show details.
 */
export function ErrorText({ text, className, role }: { text: string; className?: string; role?: 'alert' }): React.JSX.Element {
  const network = describeNetworkError(text)
  if (!network) return <p role={role} className={className}>{text}</p>
  return (
    <div role={role} className="space-y-1">
      <p className={className}>{network.summary}</p>
      <details className="text-xs text-[var(--color-text-muted)]">
        <summary className="cursor-pointer font-medium text-[var(--color-accent)]">Show details</summary>
        <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-[11px] select-text">{network.technical}</pre>
      </details>
    </div>
  )
}
