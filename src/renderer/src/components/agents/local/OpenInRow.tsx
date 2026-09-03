import { FolderOpen, TerminalSquare } from 'lucide-react'
import { useState } from 'react'
import { useAvailableTools, useOpenIn } from '../../../hooks/useLocalTools'
import type { LocalAgentDto } from '../../../../../shared/localAgents'

const BUTTON =
  'flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[10px] font-medium ' +
  'border border-[var(--color-border)] text-[var(--color-text-secondary)] ' +
  'hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] transition-colors ' +
  'disabled:opacity-40 disabled:cursor-not-allowed'

/**
 * Hand the folder to something else: a coding assistant in a terminal, an
 * editor, or the file manager.
 *
 * Only tools actually found on this machine are offered — the alternative is a
 * button that fails after the click, for a tool the user may never have
 * installed. Main re-validates the folder against the registered agents roots,
 * so a refusal here is expected and is shown rather than swallowed.
 */
export function OpenInRow({ agent }: { agent: LocalAgentDto }): React.JSX.Element {
  const assistants = useAvailableTools('cli-assistant')
  const editors = useAvailableTools('editor')
  const openIn = useOpenIn()
  const [error, setError] = useState<string | null>(null)

  const launch = (request: Parameters<typeof openIn.mutate>[0]): void => {
    setError(null)
    openIn.mutate(request, {
      onError: (err) => setError(err instanceof Error ? err.message : 'Could not open that.')
    })
  }

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {assistants.map((tool) => (
          <button
            key={tool.id}
            type="button"
            className={BUTTON}
            onClick={() =>
              launch({ folder: agent.path, toolId: tool.id, action: 'terminal-command' })
            }
            title={`Run ${tool.label} in this folder`}
          >
            <TerminalSquare size={11} />
            {tool.label}
          </button>
        ))}
        {editors.map((tool) => (
          <button
            key={tool.id}
            type="button"
            className={BUTTON}
            onClick={() => launch({ folder: agent.path, toolId: tool.id, action: 'editor' })}
            title={`Open this folder in ${tool.label}`}
          >
            <FolderOpen size={11} />
            {tool.label}
          </button>
        ))}
        <button
          type="button"
          className={BUTTON}
          onClick={() => launch({ folder: agent.path, action: 'terminal' })}
          title="Open a terminal in this folder"
        >
          <TerminalSquare size={11} />
          Terminal
        </button>
        <button
          type="button"
          className={BUTTON}
          onClick={() => launch({ folder: agent.path, action: 'reveal' })}
          title="Reveal this folder"
        >
          <FolderOpen size={11} />
          Reveal
        </button>
      </div>
      {assistants.length === 0 && editors.length === 0 && (
        <div className="text-[10px] text-[var(--color-text-muted)]">
          No coding assistant or editor was found on this machine. Install one, then use Refresh in
          Settings → Local Agents.
        </div>
      )}
      {error && <div className="text-[10px] text-[var(--color-danger)]">{error}</div>}
    </div>
  )
}
