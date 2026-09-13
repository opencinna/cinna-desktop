import type { DevelopmentContext } from '../../../../shared/developmentSession'
import { codexEffortForComplexity } from '../../../../shared/engine'
import { useClaudeAuth } from '../../hooks/useLocalTools'

const badge = 'max-w-full truncate rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)]'

/** Match the compact runtime summary on a local agent's start-chat page. */
export function DevelopmentRuntimeBadges({ data }: { data?: DevelopmentContext }): React.JSX.Element {
  const runtime = data?.runtime
  const model = runtime?.launcher === 'codex'
    ? `${runtime.modelId ?? 'CLI default'} · ${codexEffortForComplexity(data!.complexity)} effort`
    : runtime?.modelId
  return <div role="group" aria-label="Runtime summary" className="mt-2 flex flex-wrap items-center gap-1.5">
    {runtime?.launcher === 'claude' ? <ClaudeBadge /> : <span className={badge}>{!runtime ? 'Checking runtime…' : runtime.launcher === 'codex' ? 'Codex' : runtime.credentialName ? `OpenCode with ${runtime.credentialName}` : 'OpenCode'}</span>}
    {model && <span className={badge} title={`Model: ${model}`}>{model}</span>}
  </div>
}

function ClaudeBadge(): React.JSX.Element {
  const { data: auth } = useClaudeAuth()
  const subscription = auth?.state === 'logged_in' && (auth.authMethod === 'claude.ai' || !!auth.subscriptionType)
  return <span className={badge}>Claude Agent{subscription ? ' with subscription' : ''}</span>
}
