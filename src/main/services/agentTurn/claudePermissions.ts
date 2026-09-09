/**
 * Turning a Claude `canUseTool` callback into the permission ask the desktop
 * already knows how to render, park and remember.
 *
 * ## Why the SDK's shape is the easier half
 *
 * `canUseTool` is, verbatim:
 *
 * ```
 * (toolName, input, { signal, suggestions }) => Promise<PermissionResult>
 * ```
 *
 * resolving to `{behavior:'allow', updatedInput?}` or `{behavior:'deny',
 * message}`. That is **cleaner** than OpenCode's out-of-band reply-by-request-id:
 * the promise *is* the park, so the turn blocks by awaiting it and nothing has
 * to be POSTed anywhere. The whole of `pendingRequests`, the transcript block
 * and the answer IPC are reused unchanged; only this mapping is new.
 *
 * ## Three things that will bite, and are handled here
 *
 * **1. The id must carry OpenCode's prefix.** `isEngineRequestId` gates on
 * `per_` / `que_`, and the renderer's read-only replay rule depends on it: a
 * persisted block bearing such an id is *not* answerable, because the id is a
 * live address that dies with its turn. Minting `per_`-prefixed ids here is a
 * smaller change than widening that predicate, and it keeps the rule intact.
 *
 * **2. `updatedPermissions` is never returned.** The SDK offers `suggestions`
 * so a host can persist "always allow" into Claude Code's *own* rules. We do
 * not: a rule written into `~/.claude/` would be **user-global**, shared with
 * the user's personal Claude Code, and would authorise agents this app has
 * nothing to do with. *Always allow* stays a `desktop.json` row and resolves as
 * a plain `allow` — the same reason the OpenCode path refuses that engine's
 * `always`.
 *
 * **3. Read-only tools never arrive.** Verified: with no `allowedTools` and
 * `permissionMode: 'default'`, a `Read` ran with no ask at all. The desktop's
 * grants therefore govern the **mutating** surface, not the whole tool surface.
 * That is a limit of the mechanism and is documented rather than papered over;
 * gating everything would need a `PreToolUse` hook.
 *
 * ## The action vocabulary is Claude's, and stays Claude's
 *
 * `LocalPermissionGrant.action` is documented as "OpenCode's coarse operation".
 * Claude's tool names (`Bash`, `Edit`, `WebFetch`) are a different vocabulary,
 * and they are stored **as-is** rather than mapped onto OpenCode's — so a grant
 * written on one engine never silently authorises the other. The grant key
 * gains no engine segment: a grant is already scoped to a folder, and an agent
 * does not change engines between one ask and the next often enough to justify
 * a migration.
 */

import { PERMISSION_ID_PREFIX, type LocalPermissionRequest } from '../../../shared/localAgentRequests'

/**
 * Which input field names the thing a tool is about to touch, per tool.
 *
 * Ordered: the first that is present wins. This is what fills `resources`, and
 * `resources` is what the *Always allow* grant is scoped to — so a tool absent
 * from this table produces an ask the user can only ever remember as the whole
 * action, which is deliberately the widest and least attractive option.
 */
const RESOURCE_FIELDS: Record<string, readonly string[]> = {
  Bash: ['command'],
  Read: ['file_path'],
  Edit: ['file_path'],
  Write: ['file_path'],
  NotebookEdit: ['notebook_path'],
  WebFetch: ['url'],
  WebSearch: ['query'],
  Glob: ['pattern', 'path'],
  Grep: ['pattern', 'path'],
  // Observed as `Agent` on `claude` 2.1.266; `Task` is the name the SDK's own
  // types and docs use. Both are listed rather than guessed at, because the ask
  // a user reads must name what the subagent was told to do.
  Agent: ['description', 'prompt'],
  Task: ['description', 'prompt']
}

/** Fields tried for a tool this table does not know. */
const FALLBACK_FIELDS: readonly string[] = [
  'command',
  'file_path',
  'path',
  'url',
  'pattern',
  'query'
]

let counter = 0

/**
 * A request id the rest of the app already understands.
 *
 * `per_` because `isEngineRequestId` gates on it — see the header. The suffix
 * only has to be unique within a turn; it is never persisted as an identity and
 * never leaves this process except as a transcript `tool_id` that dies with the
 * turn.
 */
export function mintPermissionRequestId(): string {
  counter += 1
  return `${PERMISSION_ID_PREFIX}_claude_${Date.now().toString(36)}_${counter.toString(36)}`
}

/** The resources a tool call is about to touch, for the grant's scope. */
export function claudePermissionResources(
  toolName: string,
  input: Record<string, unknown> | undefined
): string[] {
  const fields = RESOURCE_FIELDS[toolName] ?? FALLBACK_FIELDS
  for (const field of fields) {
    const value = input?.[field]
    if (typeof value === 'string' && value.trim() !== '') return [value]
  }
  return []
}

/**
 * The ask, in the shape the transcript block, the grant store and the answer
 * IPC all already read.
 *
 * `savable` is empty on this path and that is not an oversight. On the OpenCode
 * side it carries what *that engine* would have persisted in its own store, and
 * nothing renders from it any more — the desktop derives the grant from
 * `resources` and writes it beside the folder. There is no equivalent here to
 * report, and inventing one would be claiming knowledge of a store we
 * deliberately never write to.
 */
export function toClaudePermissionRequest(
  toolName: string,
  input: Record<string, unknown> | undefined
): LocalPermissionRequest {
  return {
    action: toolName,
    resources: claudePermissionResources(toolName, input),
    savable: []
  }
}
