/**
 * What "local development" actually installs, and where.
 *
 * One copy of this list, shared by every surface that offers the choice — the
 * consent panel, the consent modal, and the checkbox on the connect screen.
 * They are all asking the same question, and a user who reads two different
 * answers to "what is this going to do to my machine" is right to trust
 * neither.
 *
 * The workspace line only appears when the caller knows both halves of the
 * path. On the connect screen the agents home has not been resolved yet, and a
 * bullet that says "creates a folder somewhere" is worse than no bullet.
 */
export interface LocalDevExplainerProps {
  /** The Cinna host, used for the per-server workspace folder name. */
  host?: string
  /** `<AgentsHome>/Cloud`, when the caller has resolved it. */
  agentsHomeHint?: string
}

export function LocalDevExplainer({
  host,
  agentsHomeHint
}: LocalDevExplainerProps): React.JSX.Element {
  return (
    <ul className="space-y-1.5 text-[11px] text-[var(--color-text-secondary)]">
      <li>
        Installs <span className="text-[var(--color-text)]">uv</span>,{' '}
        <span className="text-[var(--color-text)]">cinna-cli</span> and{' '}
        <span className="text-[var(--color-text)]">Mutagen</span> inside Cinna&rsquo;s own data
        folder — not into your system or your Python.
      </li>
      {agentsHomeHint && (
        <li>
          Creates{' '}
          <span className="text-[var(--color-text)] break-all">
            {agentsHomeHint}/{host?.replace(/:/g, '_') || 'your-server'}
          </span>{' '}
          for this server.
        </li>
      )}
      <li>Nothing is synced and no agent is downloaded.</li>
    </ul>
  )
}
