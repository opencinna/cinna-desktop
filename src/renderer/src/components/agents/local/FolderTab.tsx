import { CheckCircle2, FileText } from 'lucide-react'
import { useOpenAgentPath } from '../../../hooks/useLocalAgents'
import { MANIFEST_FILE } from '../../../../../shared/kit/manifest'
import {
  BARE_AGENT_PROMPT_FILE,
  BARE_AGENT_README_FILE,
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

/**
 * The two files a **bare** folder is read through.
 *
 * The kit list above is the contract's layout, and a bare folder has none of
 * it: rendering it listed seven files that do not exist, each with a Reveal
 * button, under a heading claiming they are the files the page reads. Nothing
 * else on the page names the folder's *own* two, so this is where they belong.
 */
const BARE_FILES: { rel: string; what: string }[] = [
  { rel: BARE_AGENT_PROMPT_FILE, what: 'the system prompt' },
  { rel: BARE_AGENT_README_FILE, what: 'what an assistant opening the folder reads first' }
]

/** The validator's findings in full — the same codes `kit.py validate` prints. */
function ValidationCard({ agent }: { agent: LocalAgentDto }): React.JSX.Element {
  const openPath = useOpenAgentPath()
  const findings = [...agent.validation.errors, ...agent.validation.warnings]
  /**
   * Infos, below the rest and quieter.
   *
   * They were produced and rendered nowhere. The contract calls them "worth
   * knowing" — a folder that predates the active contract, one still carrying
   * the deprecated `cloud` stamp — and a bare folder's says what it *is*: no
   * manifest, so no commands, no credential slots and no runtime it names
   * itself. This tab is where the things that are true about a folder's
   * contents belong, and until now the only place that fact appeared was a note
   * in the Runs-with panel, restating a label two lines above it.
   *
   * Deliberately **not** in the tab's count badge, which stays errors +
   * warnings: a badge on every healthy folder is the banner-in-the-healthy-state
   * failure (ux_rules rule 2), and an info is by definition not attention.
   */
  const infos = agent.validation.infos
  return (
    <AgentCard
      title="Validation"
      file={agent.kind === 'bare' ? undefined : MANIFEST_FILE}
      onReveal={
        agent.kind === 'bare'
          ? undefined
          : () => openPath.mutate({ agentId: agent.id, relPath: MANIFEST_FILE })
      }
    >
      {findings.length === 0 ? (
        <div className="flex items-center gap-1.5 text-xs text-[var(--color-text-secondary)]">
          <CheckCircle2 size={12} className="text-[var(--color-success)]" />
          {agent.kind === 'bare'
            ? 'This folder has what it needs to run.'
            : `This folder validates against kit contract ${agent.manifest.contract_version ?? '(legacy)'}.`}
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
      {infos.length > 0 && (
        <ul className="mt-2 space-y-1 border-t border-[var(--color-border)] pt-2">
          {infos.map((finding, index) => (
            <li key={`${finding.code}:${index}`} className="text-[10px] text-[var(--color-text-muted)]">
              {finding.message}
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
  const bare = agent.kind === 'bare'
  return (
    <AgentCard
      title="Identity"
      // A bare folder has no manifest, so naming one here would point at a file
      // that is not in the folder and offer to reveal it.
      file={bare ? undefined : MANIFEST_FILE}
      onReveal={
        bare ? undefined : () => openPath.mutate({ agentId: agent.id, relPath: MANIFEST_FILE })
      }
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
        {/*
          The Kit row is a manifest reading. On a bare folder it fell through to
          "legacy manifest" — a folder with no manifest at all reported as
          having an *old* one, which is both false and the wrong story: legacy
          means a pre-contract kit folder that Stamp identity can repair.
        */}
        {!bare && (
          <div className="flex gap-2">
            <dt className="w-20 shrink-0 text-[var(--color-text-muted)]">Kit</dt>
            <dd className="min-w-0 flex-1 text-[10px] text-[var(--color-text-secondary)]">
              {agent.manifest.contract_version
                ? `contract ${agent.manifest.contract_version}`
                : 'legacy manifest'}
              {agent.manifest.kit_version ? ` · kit ${agent.manifest.kit_version}` : ''}
            </dd>
          </div>
        )}
      </dl>
      {agent.identity === 'legacy' && (
        <div className={`mt-2 ${EMPTY}`}>
          Renaming or moving this folder starts a new agent. Use Stamp identity in the ⋯ menu to
          give it a durable id.
        </div>
      )}
      {/*
        The same warning the legacy case gets, without the fix it offers: a bare
        agent's id is its path and there is no manifest to stamp one into, which
        is why `identity` is `external` and not `legacy`.
      */}
      {bare && (
        <div className={`mt-2 ${EMPTY}`}>
          This agent is identified by where its folder sits. Moving or renaming the folder starts a
          new agent, and its chats stay with the old one.
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
        {(agent.kind === 'bare' ? BARE_FILES : FILES).map((file) => (
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
      {/*
        Credentials are declared in a manifest and read from `credentials/.env`,
        neither of which a bare folder has. The card rendered "This agent
        declares no credentials" over a file path that does not exist and that
        the desktop never creates for such a folder — an absence presented as a
        configuration the user might fill in. What it needs, it reads itself.
      */}
      {agent.kind !== 'bare' && <CredentialsCard agent={agent} />}
      <FilesCard agent={agent} />
      {/*
        Publishing is a kit operation: it walks the folder against the
        contract's export rules and records a content hash in the manifest. A
        bare folder has no manifest to record one in and no export tree to
        build, so the card could only ever say "not published anywhere" — an
        absence framed as a step the user has not taken yet.
      */}
      {agent.kind !== 'bare' && <PublishedCard agent={agent} />}
      <RunsCard agent={agent} />
    </div>
  )
}
