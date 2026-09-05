import { CheckCircle2, FileText } from 'lucide-react'
import { useOpenAgentPath } from '../../../hooks/useLocalAgents'
import { MANIFEST_FILE } from '../../../../../shared/kit/manifest'
import {
  LOCAL_AGENT_PROMPT_PATHS,
  type LocalAgentDto
} from '../../../../../shared/localAgents'
import { AgentCard } from './AgentCard'
import { CredentialsCard, PublishedCard, RunsCard } from './ReadOnlyCards'

const EMPTY = 'text-[10px] italic text-[var(--color-text-muted)]'

/** The files the page reads, in the order the folder model lists them. */
const FILES: { rel: string; what: string }[] = [
  { rel: MANIFEST_FILE, what: 'name, description, runtime, example prompts' },
  { rel: LOCAL_AGENT_PROMPT_PATHS.workflow, what: 'the system prompt' },
  { rel: LOCAL_AGENT_PROMPT_PATHS.entrypoint, what: 'first message of an unattended run' },
  { rel: LOCAL_AGENT_PROMPT_PATHS.refiner, what: 'defaults and required inputs' },
  { rel: 'docs/CLI_COMMANDS.yaml', what: 'the /run: commands' },
  { rel: 'credentials/.env', what: 'secrets — never read by Cinna' },
  { rel: 'app-data/storage/STATUS.md', what: 'what the agent last said about itself' }
]

/** The validator's findings in full — the same codes `kit.py validate` prints. */
function ValidationCard({ agent }: { agent: LocalAgentDto }): React.JSX.Element {
  const openPath = useOpenAgentPath()
  const findings = [...agent.validation.errors, ...agent.validation.warnings]
  return (
    <AgentCard
      title="Validation"
      file={MANIFEST_FILE}
      onReveal={() => openPath.mutate({ agentId: agent.id, relPath: MANIFEST_FILE })}
    >
      {findings.length === 0 ? (
        <div className="flex items-center gap-1.5 text-xs text-[var(--color-text-secondary)]">
          <CheckCircle2 size={12} className="text-[var(--color-success)]" />
          This folder validates against kit contract {agent.manifest.contract_version ?? '(legacy)'}.
        </div>
      ) : (
        <ul className="space-y-1">
          {findings.map((finding, index) => (
            <li key={`${finding.code}:${index}`} className="text-[11px]">
              <span className="font-mono text-[10px] text-[var(--color-text-muted)]">
                {finding.path ?? finding.code}
              </span>{' '}
              <span className="text-[var(--color-text-secondary)]">{finding.message}</span>
            </li>
          ))}
        </ul>
      )}
      {agent.readinessReason && agent.readiness !== 'ok' && (
        <div className="mt-2 text-[10px] text-[var(--color-text-muted)]">{agent.readinessReason}</div>
      )}
    </AgentCard>
  )
}

/** Where the row id comes from — what survives a rename, and what does not. */
function IdentityCard({ agent }: { agent: LocalAgentDto }): React.JSX.Element {
  const openPath = useOpenAgentPath()
  return (
    <AgentCard
      title="Identity"
      file={MANIFEST_FILE}
      onReveal={() => openPath.mutate({ agentId: agent.id, relPath: MANIFEST_FILE })}
    >
      <dl className="space-y-1 text-xs">
        <div className="flex gap-2">
          <dt className="w-20 shrink-0 text-[var(--color-text-muted)]">Id</dt>
          <dd className="min-w-0 flex-1 truncate font-mono text-[10px] text-[var(--color-text-secondary)]">
            {agent.manifestId || '(none — identified by folder name)'}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-20 shrink-0 text-[var(--color-text-muted)]">Folder</dt>
          <dd className="min-w-0 flex-1 truncate font-mono text-[10px] text-[var(--color-text-secondary)]">
            {agent.slug}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-20 shrink-0 text-[var(--color-text-muted)]">Kit</dt>
          <dd className="min-w-0 flex-1 text-[10px] text-[var(--color-text-secondary)]">
            {agent.manifest.contract_version
              ? `contract ${agent.manifest.contract_version}`
              : 'legacy manifest'}
            {agent.manifest.kit_version ? ` · kit ${agent.manifest.kit_version}` : ''}
          </dd>
        </div>
      </dl>
      {agent.identity === 'legacy' && (
        <div className={`mt-2 ${EMPTY}`}>
          Renaming or moving this folder starts a new agent. Use Stamp identity in the ⋯ menu to
          give it a durable id.
        </div>
      )}
    </AgentCard>
  )
}

/** Every file the page reads, each a click from the file manager. */
function FilesCard({ agent }: { agent: LocalAgentDto }): React.JSX.Element {
  const openPath = useOpenAgentPath()
  return (
    <AgentCard
      title="Files"
      file={agent.slug}
      onReveal={() => openPath.mutate({ agentId: agent.id })}
    >
      <ul className="space-y-1">
        {FILES.map((file) => (
          <li key={file.rel} className="flex items-center gap-2 text-xs">
            <button
              type="button"
              onClick={() => openPath.mutate({ agentId: agent.id, relPath: file.rel })}
              title={`Reveal ${file.rel}`}
              className="flex min-w-0 items-center gap-1 font-mono text-[10px] text-[var(--color-text)]
                transition-colors hover:text-[var(--color-accent)]"
            >
              <FileText size={11} className="shrink-0 text-[var(--color-text-muted)]" />
              <span className="truncate">{file.rel}</span>
            </button>
            <span className="min-w-0 flex-1 truncate text-[10px] text-[var(--color-text-muted)]">
              {file.what}
            </span>
          </li>
        ))}
      </ul>
    </AgentCard>
  )
}

/**
 * The Folder tab: what the desktop knows *about* the folder, for the moment a
 * user needs it and not before. Validation findings in full, where the identity
 * comes from, the credential slots in detail, publications, saved sessions and
 * the files themselves — each card still names the file it reads, because this
 * page is a viewer over a folder and that is the tab where it says so.
 */
export function FolderTab({ agent }: { agent: LocalAgentDto }): React.JSX.Element {
  return (
    <div className="space-y-3">
      <ValidationCard agent={agent} />
      <IdentityCard agent={agent} />
      <CredentialsCard agent={agent} />
      <FilesCard agent={agent} />
      <PublishedCard agent={agent} />
      <RunsCard agent={agent} />
    </div>
  )
}
