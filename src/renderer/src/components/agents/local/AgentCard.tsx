import { FileText } from 'lucide-react'

interface AgentCardProps {
  title: string
  /**
   * The agent-relative file this card renders. Every card names one — the page
   * is a viewer over a folder, and a user who wants to know where a value came
   * from should be able to read it off the card rather than guess.
   */
  file: string
  /** Reveal that file in the OS file manager. */
  onReveal?: () => void
  /**
   * What the reveal button promises, where `Reveal <file>` would be a lie —
   * a card whose action lands on the folder rather than on the file it names.
   */
  revealTitle?: string
  /** Right-aligned controls: a save indicator, an "add", a disabled action. */
  actions?: React.ReactNode
  children: React.ReactNode
}

/** The shell every card on the agent page shares. */
export function AgentCard({
  title,
  file,
  onReveal,
  revealTitle,
  actions,
  children
}: AgentCardProps): React.JSX.Element {
  return (
    <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] overflow-hidden">
      <header className="flex items-center gap-2 px-4 py-2.5 border-b border-[var(--color-border)]">
        <h2 className="text-xs font-medium text-[var(--color-text)]">{title}</h2>
        {onReveal ? (
          <button
            type="button"
            onClick={onReveal}
            title={revealTitle ?? `Reveal ${file}`}
            className="flex items-center gap-1 text-[10px] font-mono text-[var(--color-text-muted)]
              hover:text-[var(--color-text-secondary)] transition-colors min-w-0"
          >
            <FileText size={11} className="shrink-0" />
            <span className="truncate">{file}</span>
          </button>
        ) : (
          <span className="flex items-center gap-1 text-[10px] font-mono text-[var(--color-text-muted)] min-w-0">
            <FileText size={11} className="shrink-0" />
            <span className="truncate">{file}</span>
          </span>
        )}
        <div className="flex-1" />
        {actions}
      </header>
      <div className="px-4 py-3">{children}</div>
    </section>
  )
}
