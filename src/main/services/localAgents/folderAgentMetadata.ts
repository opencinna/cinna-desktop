/**
 * Synthesize the `agents.remoteMetadata` blob for a folder agent from its
 * manifest.
 *
 * The column was built for agents synced from a Cinna backend, and a folder
 * row has always carried `null` there. That null is what makes two surfaces
 * dead for a folder agent: the composer's `#` prompt list, which reads only
 * `agent.remoteMetadata.example_prompts` (`renderer/utils/examplePrompts.ts`),
 * and the "Example tasks: …" clause of the agents-as-MCP tool description
 * (`A2AAsMcpProvider.fallbackDescription`). Both start working the moment the
 * row carries a synthesized object; neither needs any other change.
 *
 * **No `cinna_mcp` descriptor is emitted, deliberately.** It is the one
 * optional field on {@link RemoteAgentMetadata}, and `A2AAsMcpProvider` already
 * has a better answer when it is absent: `getTools()` prefers
 * `fallbackDescription()`, which frames the agent for the orchestrator LLM
 * ("Send a self-contained task … it runs its own model and tools") and *then*
 * appends the agent's own description and up to three examples, while
 * `buildAgentToolProviders` falls back to the row name for the tool slug and
 * `getTools()` to `DEFAULT_AGENT_INPUT_SCHEMA`. Emitting a descriptor whose
 * `description` was the manifest's human-facing blurb would *replace* all of
 * that framing with the blurb, because the descriptor wins the `||`. The
 * `CinnaMcpDescriptor` docstring already names this case: the fallback exists
 * to "also cover non-cinna A2A agents", and a folder agent is exactly that.
 *
 * The result is a cache over `cinna-agent.json`, in the same sense — and with
 * the same staleness bound — as the `name` and `description` columns beside it
 * (Invariant 1: the row is a cache that can be dropped and rebuilt from the
 * folder). It is therefore computed where the manifest is already parsed, at
 * scan time, and carried to the row on {@link FolderIndexEntry} so that every
 * writer of a folder row supplies it rather than one remembering to.
 */
import type { CinnaAgentManifest } from '../../../shared/kit/manifest'
import type { RemoteAgentMetadata } from '../../../shared/agentMetadata'

/**
 * `example_prompts` is typed `string[]` on the manifest, but `parseManifest`
 * only proves the file is a JSON *object* — every field beyond that is a cast
 * over whatever a person or an assistant last wrote. So the value here can be
 * any JSON at runtime, and a folder whose manifest carries junk is still
 * indexed (only an unreadable *identity* keeps a folder out of the index).
 * Anything that is not a non-blank string is dropped.
 */
function readExamplePrompts(manifest: CinnaAgentManifest): string[] {
  const raw: unknown = manifest.example_prompts
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed) out.push(trimmed)
  }
  return out
}

/**
 * Build the metadata blob for one folder agent. Pure: no filesystem, no
 * database, no Electron — the caller has already parsed the manifest.
 *
 * Four of the five required fields are `null`/`[]` on purpose rather than for
 * want of a mapping:
 *
 * - `entrypoint_prompt` — a folder agent's entrypoint is a *document*
 *   (`manifest.prompts.entrypoint`), already assembled into the system prompt
 *   by `promptAssembly`, not the short prefill string this field is on a
 *   remote agent. `router_trigger_prompt` is a router trigger, a third thing
 *   again. The field has no consumer in `src/renderer` or `src/preload` today,
 *   so mapping either candidate would hand the first future consumer a
 *   silently wrong meaning with nothing to flag it.
 * - `session_mode`, `ui_color_preset` — nothing in the manifest corresponds.
 * - `protocol_versions` — a folder agent speaks no A2A version at all; it is
 *   run by the local engine.
 */
export function synthesizeFolderAgentMetadata(manifest: CinnaAgentManifest): RemoteAgentMetadata {
  return {
    entrypoint_prompt: null,
    example_prompts: readExamplePrompts(manifest),
    session_mode: null,
    ui_color_preset: null,
    protocol_versions: []
  }
}
