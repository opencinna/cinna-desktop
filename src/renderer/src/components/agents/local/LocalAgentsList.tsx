import { useMemo, useState } from 'react'
import { Circle, Plus } from 'lucide-react'
import { useUIStore } from '../../../stores/ui.store'
import { useAgentCredentialBindings, useLocalAgents } from '../../../hooks/useLocalAgents'
import { useProviders } from '../../../hooks/useProviders'
import { agentSubline, groupAgentsByRoot } from '../../../utils/localAgents'
import type { LocalAgentDto } from '../../../../../shared/localAgents'
import { isCredentialActive } from '../../../../../shared/credentials'
import { NewLocalAgentModal } from './NewLocalAgentModal'

/**
 * Dot colour for a folder's readiness. Severity tokens, never a raw colour.
 *
 * `credentialInactive` outranks every readiness state and is red, not amber:
 * amber here means "the folder is missing something optional and still runs",
 * and an agent whose AI credential is switched off does not run at all — the
 * engine is not given that credential (`collectEngineProviders`), so the first
 * turn fails rather than degrading.
 */
function readinessColor(agent: LocalAgentDto, credentialInactive: boolean): string {
  if (credentialInactive) return 'text-[var(--color-danger)]'
  switch (agent.readiness) {
    case 'ok':
      return 'text-[var(--color-success)]'
    case 'credentials_needed':
      return 'text-[var(--color-warning)]'
    default:
      return 'text-[var(--color-danger)]'
  }
}

function AgentRow({
  agent,
  credentialInactive
}: {
  agent: LocalAgentDto
  credentialInactive: boolean
}): React.JSX.Element {
  const activeLocalAgentId = useUIStore((s) => s.activeLocalAgentId)
  const activeView = useUIStore((s) => s.activeView)
  const setActiveLocalAgentId = useUIStore((s) => s.setActiveLocalAgentId)
  const setActiveView = useUIStore((s) => s.setActiveView)
  const isActive = activeLocalAgentId === agent.id && activeView === 'local-agent'
  const subline = agentSubline(agent, credentialInactive)

  return (
    <button
      type="button"
      onClick={() => {
        setActiveLocalAgentId(agent.id)
        setActiveView('local-agent')
      }}
      className={`w-full text-left flex items-start gap-1.5 px-2.5 py-1.5 rounded-md cursor-pointer transition-colors ${
        isActive
          ? 'app-nav-active text-[var(--color-text)]'
          : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]'
      }`}
    >
      <Circle
        size={6}
        className={`mt-1.5 shrink-0 fill-current ${readinessColor(agent, credentialInactive)}`}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs">{agent.name}</span>
        {subline && (
          <span className="block truncate text-[10px] text-[var(--color-text-muted)]">
            {subline}
          </span>
        )}
      </span>
    </button>
  )
}

/**
 * The Agents tab's sidebar list: every folder agent, grouped by the root it
 * lives in — the default home first, then any folder the user added.
 *
 * A root heading appears once there is more than one root to tell apart — with
 * a single home called "Agents", it would only repeat the header above it. The
 * sub-line under each name is the folder talking: `STATUS.md` if the agent
 * wrote one, else what is stopping it running, else its description.
 */
export function LocalAgentsList(): React.JSX.Element {
  const { data, isLoading, error } = useLocalAgents()
  const { data: bindings } = useAgentCredentialBindings()
  const { data: providers } = useProviders()
  const [creating, setCreating] = useState(false)
  const groups = useMemo(
    () => groupAgentsByRoot(data?.roots ?? [], data?.agents ?? []),
    [data]
  )
  const total = data?.agents.length ?? 0

  /**
   * Agents whose resolved credential cannot run.
   *
   * The join is here rather than in main so the dot follows the provider cache:
   * flipping a credential's switch in Settings invalidates `['providers']` and
   * the bindings together, and both surfaces re-render off the same answer.
   *
   * An agent missing from the map is *not* marked — either the query has not
   * landed yet or main resolved no credential for it, and neither is a fact
   * about a credential being off. Saying nothing is right for both: an agent
   * with no runtime at all already reports that through its readiness.
   */
  const inactiveAgentIds = useMemo(() => {
    if (!bindings || !providers) return new Set<string>()
    const off = new Set(
      providers.filter((provider) => !isCredentialActive(provider)).map((p) => p.id)
    )
    return new Set(
      bindings
        .filter((binding) => binding.credentialId !== null && off.has(binding.credentialId))
        .map((binding) => binding.agentId)
    )
  }, [bindings, providers])

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 pt-1 pb-1">
        <span className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
          Agents
        </span>
        <button
          onClick={() => setCreating(true)}
          className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
          // Not "New agent" any more: this opens a choice between scaffolding
          // one and pointing at a folder that already is one. It also has to
          // differ from the "New agent" card the dialog then shows, or the two
          // are one ambiguous name to a screen reader and to every test.
          title="Add an agent"
          aria-label="Add an agent"
        >
          <Plus size={14} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="px-2.5 py-2 text-xs text-[var(--color-text-muted)]">Loading...</div>
        ) : error ? (
          <div className="px-2.5 py-2 text-[10px] text-[var(--color-danger)]">
            {error instanceof Error ? error.message : 'Could not read the agents folder.'}
          </div>
        ) : total === 0 && groups.length <= 1 ? (
          <div className="px-2.5 py-6 text-center text-xs text-[var(--color-text-muted)]">
            No agents yet — click + to add one
          </div>
        ) : (
          <div className="px-1.5 py-1 space-y-2">
            {groups.map(({ root, agents }) => (
              <div key={root.id}>
                {/* One root is the common case, and its label is "Agents" —
                    the same word as the header above it. The grouping only
                    earns its heading once there is something to tell apart. */}
                {(groups.length > 1 || !root.exists) && (
                  <div
                    className="px-1 pb-0.5 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)] truncate"
                    title={root.path}
                  >
                    {root.label}
                    {!root.exists && ' — missing'}
                  </div>
                )}
                {agents.length === 0 ? (
                  <div className="px-2.5 py-1 text-[10px] text-[var(--color-text-muted)] italic">
                    Empty
                  </div>
                ) : (
                  <div className="space-y-px">
                    {agents.map((agent) => (
                      <AgentRow
                        key={agent.id}
                        agent={agent}
                        credentialInactive={inactiveAgentIds.has(agent.id)}
                      />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {creating && <NewLocalAgentModal onClose={() => setCreating(false)} />}
    </div>
  )
}
