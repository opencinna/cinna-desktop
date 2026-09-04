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
import {
  MAX_EXAMPLE_PROMPTS,
  MAX_EXAMPLE_PROMPT_CHARS,
  type CinnaAgentManifest
} from '../../../shared/kit/manifest'
import type { RemoteAgentMetadata } from '../../../shared/agentMetadata'

/**
 * `example_prompts` is typed `string[]` on the manifest, but `parseManifest`
 * only proves the file is a JSON *object* — every field beyond that is a cast
 * over whatever a person or an assistant last wrote. So the value here can be
 * any JSON at runtime, and a folder whose manifest carries junk is still
 * indexed (only an unreadable *identity* keeps a folder out of the index).
 *
 * The validator reports all four of these violations — and the two bounds are
 * the contract's, imported from the manifest module both sides already read,
 * so the numbers cannot drift. Reporting is not
 * blocking: it writes a finding into `dto.validation` and sets
 * `readiness: 'invalid'`, and the scanner indexes the row anyway. So the shape
 * rules and the *size* rules both have to be enforced here, for the same
 * reason — the earlier version of this function applied that argument to the
 * shape rules only, and the caps are where it actually costs something.
 *
 * What it costs: `A2AAsMcpProvider.fallbackDescription` ends
 * `examples.slice(0, 3).join('; ')`, which bounds the *count* at three and the
 * *length* not at all. Three unbounded entries go into the tool description the
 * orchestrating model reads on every turn — an agent whose manifest holds three
 * 5 000-character prompts spends ~15 KB of context per turn describing itself.
 * The per-item cap is what makes that finite; the count cap bounds the `#` list
 * and the stored row.
 *
 * Over-long and malformed entries are **dropped rather than truncated**: the
 * validator calls them errors, the agent page shows the user why, and a
 * silently truncated prompt would be a third thing — neither what was written
 * nor absent.
 */
function readExamplePrompts(manifest: CinnaAgentManifest): string[] {
  const raw: unknown = manifest.example_prompts
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    // Untrimmed length, matching the validator's own `prompt.length > 500`, so
    // the two cannot disagree about a padded entry sitting on the boundary.
    if (item.length > MAX_EXAMPLE_PROMPT_CHARS) continue
    const trimmed = item.trim()
    if (trimmed) out.push(trimmed)
    if (out.length === MAX_EXAMPLE_PROMPTS) break
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
