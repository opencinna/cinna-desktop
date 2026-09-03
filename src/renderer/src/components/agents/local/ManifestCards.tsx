import { useCallback, useMemo } from 'react'
import { useAgentFileEditor, useOpenAgentPath } from '../../../hooks/useLocalAgents'
import { formatExamplePrompts, parseExamplePrompts } from '../../../utils/localAgents'
import { MANIFEST_FILE } from '../../../../../shared/kit/manifest'
import type { LocalAgentDto } from '../../../../../shared/localAgents'
import { AgentCard } from './AgentCard'
import { InlineFileEditor } from './InlineFileEditor'

/**
 * The cards backed by `cinna-agent.json`.
 *
 * Several cards edit the same file, which is why the editor state machine
 * distinguishes "this file changed" from "the value I own changed": saving the
 * description restamps the manifest under the example-prompts card, and that
 * must not read as a conflict. See `receiveFileSnapshot`.
 */

function useManifestSnapshot(agent: LocalAgentDto, value: string) {
  const stampHash = agent.stamps[MANIFEST_FILE]?.hash
  return useMemo(
    () => ({ text: value, stamp: agent.stamps[MANIFEST_FILE] ?? null }),
    // Rebuilt only when the value or the file's fingerprint moves — not on
    // every render of the page, which would restart the autosave timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [value, stampHash]
  )
}

function SavingHint({ saving }: { saving: boolean }): React.JSX.Element | null {
  if (!saving) return null
  return <span className="text-[10px] text-[var(--color-text-muted)]">Saving…</span>
}

/** What the agent is for, in one sentence. Also the AI draft's only input. */
export function DescriptionCard({ agent }: { agent: LocalAgentDto }): React.JSX.Element {
  const openPath = useOpenAgentPath()
  const snapshot = useManifestSnapshot(agent, agent.description)
  const toUpdate = useCallback(
    (text: string) => ({ field: 'description' as const, value: text }),
    []
  )
  const readBack = useCallback((next: LocalAgentDto) => next.description, [])

  const editor = useAgentFileEditor({
    agentId: agent.id,
    relPath: MANIFEST_FILE,
    snapshot,
    toUpdate,
    readBack
  })

  return (
    <AgentCard
      title="Description"
      file={MANIFEST_FILE}
      onReveal={() => openPath.mutate({ agentId: agent.id, relPath: MANIFEST_FILE })}
      actions={<SavingHint saving={editor.isSaving} />}
    >
      <InlineFileEditor
        editor={editor}
        markdown={false}
        minRows={2}
        placeholder="One sentence: what this agent does, and for whom."
      />
    </AgentCard>
  )
}

/**
 * How this agent is found: the prompts offered in the composer, and the
 * sentence another agent reads when deciding whether to route work here.
 */
export function ExamplePromptsCard({ agent }: { agent: LocalAgentDto }): React.JSX.Element {
  const openPath = useOpenAgentPath()
  const prompts = useMemo(
    () => formatExamplePrompts(agent.manifest.example_prompts),
    [agent.manifest.example_prompts]
  )
  const trigger = agent.manifest.router_trigger_prompt ?? ''

  const promptsSnapshot = useManifestSnapshot(agent, prompts)
  const triggerSnapshot = useManifestSnapshot(agent, trigger)

  // The transform and its edge cases live in `utils/localAgents`, tested
  // alongside the editor state machine — a prompt that contains a newline
  // cannot round-trip through a one-per-line textarea, and that has to be a
  // decision with a test behind it rather than a `split` in a component.
  const promptsUpdate = useCallback(
    (text: string) => ({
      field: 'example_prompts' as const,
      value: parseExamplePrompts(text).prompts
    }),
    []
  )
  const promptsReadBack = useCallback(
    (next: LocalAgentDto) => formatExamplePrompts(next.manifest.example_prompts),
    []
  )
  const triggerUpdate = useCallback(
    (text: string) => ({
      field: 'router_trigger_prompt' as const,
      value: text.trim() === '' ? null : text.trim()
    }),
    []
  )
  const triggerReadBack = useCallback(
    (next: LocalAgentDto) => next.manifest.router_trigger_prompt ?? '',
    []
  )

  const promptsValidate = useCallback((text: string) => parseExamplePrompts(text).error, [])

  const promptsEditor = useAgentFileEditor({
    agentId: agent.id,
    relPath: MANIFEST_FILE,
    snapshot: promptsSnapshot,
    toUpdate: promptsUpdate,
    readBack: promptsReadBack,
    validate: promptsValidate
  })
  const triggerEditor = useAgentFileEditor({
    agentId: agent.id,
    relPath: MANIFEST_FILE,
    snapshot: triggerSnapshot,
    toUpdate: triggerUpdate,
    readBack: triggerReadBack
  })

  return (
    <AgentCard
      title="Example prompts"
      file={MANIFEST_FILE}
      onReveal={() => openPath.mutate({ agentId: agent.id, relPath: MANIFEST_FILE })}
      actions={<SavingHint saving={promptsEditor.isSaving || triggerEditor.isSaving} />}
    >
      <div className="mb-2 text-[10px] text-[var(--color-text-muted)]">
        One per line. These are the <code>#</code> prompts offered when this agent is picked in a
        chat.
      </div>
      <InlineFileEditor
        editor={promptsEditor}
        markdown={false}
        minRows={3}
        placeholder="Add an example prompt a user would actually type."
      />

      <div className="mt-4 border-t border-[var(--color-border)] pt-3">
        <div className="mb-1 text-xs font-medium text-[var(--color-text)]">Router trigger</div>
        <div className="mb-2 text-[10px] text-[var(--color-text-muted)]">
          One sentence saying when work should be handed to this agent. Read by an orchestrating
          agent, not by a person.
        </div>
        <InlineFileEditor
          editor={triggerEditor}
          markdown={false}
          minRows={2}
          placeholder="Route here when…"
        />
      </div>
    </AgentCard>
  )
}
