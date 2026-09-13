/**
 * Turning an ACP `session/request_permission` into the ask the desktop already
 * renders, parks and remembers — and turning the user's answer back into one of
 * the agent's own option ids.
 *
 * ## The vocabulary is the engine's, and it stays the engine's
 *
 * `LocalPermissionGrant.action` is what an *Always allow* is stored under, and
 * a rule written for OpenCode's `bash` must never silently authorise Claude's
 * `Bash`. Both engines now arrive through one protocol, which makes it very
 * easy to normalise them into one word and very wrong: the grants already on
 * disk were written under the old runners' vocabularies, and a migration of
 * user-approved rules is not something a transport change gets to do. So:
 *
 * - **Claude** keeps its tool names (`Bash`, `Edit`, `WebFetch`) through
 *   {@link toClaudePermissionRequest} — the same function the in-process runner
 *   called, on the same `(toolName, rawInput)` pair the adapter forwards
 *   verbatim.
 * - **OpenCode** keeps its coarse operations (`bash`, `edit`, `webfetch`), now
 *   derived from `toolCall.kind` rather than read off an SSE payload. That
 *   mapping is the one new piece of vocabulary work in this file, and it is
 *   checked against `spike/acp/opencode/recordings/q2-permission.ndjson`.
 *
 * ## What the ACP ask does not carry
 *
 * **A tool name.** OpenCode's ask is `{toolCallId, title, kind, locations,
 * rawInput, content}` and `title` is the *file path* on an edit ask, not the
 * tool. The name has to come from the `tool_call` notification that arrived
 * moments earlier with the same `toolCallId` — which is why the driver passes
 * `AcpMessageStream.toolName(toolCallId)` in here rather than this file
 * guessing from `kind`. The Claude adapter is the opposite: it adds a
 * non-standard `toolCall.name`, and `_meta.claudeCode.toolName` beside it.
 *
 * ## `allow_always` is never selected, by anyone, ever
 *
 * Measured over ACP as well as over HTTP: answering `allow_always` once in one
 * folder silenced every later ask in that folder — including in a **new session
 * in the same process** — because it writes a row into the engine's own
 * user-global store (`opencode_contract.md` §4, and `q2c-always-inprocess`).
 * Claude's `allow_always` writes into `~/.claude/`, shared with the user's
 * personal install. The desktop's *Always allow* is a `desktop.json` row
 * answered here as `allow_once`, which persists nothing anywhere else.
 * {@link pickPermissionOption} cannot return an `allow_always` option: it is
 * filtered before the search, not merely deprioritised.
 */

import type { PermissionOption, RequestPermissionRequest } from '@agentclientprotocol/sdk'
import {
  PERMISSION_ID_PREFIX,
  QUESTION_ID_PREFIX,
  type LocalPermissionRequest
} from '../../../../shared/localAgentRequests'
import { toClaudePermissionRequest } from './claudePermissions'
import type { AcpLauncherId } from './types'

/**
 * OpenCode's `ToolKind` → the coarse action its own permission service used to
 * name on the wire.
 *
 * Recorded pairs (`q2-permission.ndjson`): the `write` tool asked under
 * `kind: 'edit'`, and `bash` under `kind: 'execute'` — which is exactly the
 * coarseness the HTTP payload had, where `write` also asked as `action: 'edit'`
 * (see `LocalPermissionRequest`). So a grant made before this phase still
 * matches an ask made after it, which is the whole reason this table is a
 * translation rather than a rename.
 *
 * `read`, `delete`, `move`, `search`, `think`, `switch_mode` and `other` are
 * deliberately absent: OpenCode's permission profile has no entry for them, so
 * an ask under one is not a shape any stored grant was written against, and
 * falling through to the tool name is the honest answer.
 */
const OPENCODE_ACTION_BY_KIND: Record<string, string> = {
  edit: 'edit',
  execute: 'bash',
  fetch: 'webfetch',
  read: 'read'
}

/**
 * Which `rawInput` field names the thing an OpenCode ask is about.
 *
 * Ordered, first match wins, and `filepath` comes before `filePath` on
 * purpose: the **ask** spells it lower-case (`{filepath, diff}`) while the
 * `tool_call_update` for the same call spells it `filePath`. Both are listed
 * because a reader who only knew one of them would produce an ask with no
 * resources — which is remembered as the *whole action*, the widest grant this
 * app can write, from a mis-read field name.
 */
const OPENCODE_RESOURCE_FIELDS: readonly string[] = [
  'command',
  'filepath',
  'filePath',
  'path',
  'url',
  'pattern',
  'query'
]

let counter = 0

/**
 * A request id the rest of the app already understands.
 *
 * `per_` / `que_` because `isEngineRequestId` gates on them, and the renderer's
 * read-only replay rule depends on it: a persisted block bearing such an id is
 * *not* answerable, because the id is a live address that dies with its turn.
 * The `acp` segment is for the log; nothing parses it.
 */
export function mintAcpRequestId(kind: 'permission' | 'question'): string {
  counter += 1
  const prefix = kind === 'permission' ? PERMISSION_ID_PREFIX : QUESTION_ID_PREFIX
  return `${prefix}_acp_${Date.now().toString(36)}_${counter.toString(36)}`
}

/**
 * The ask, in the shape the transcript block, the grant store and the answer
 * IPC all already read.
 *
 * `toolName` is what the driver tracked for `toolCall.toolCallId`; it wins over
 * anything derivable from `kind`, because a grant scoped to a tool the user
 * actually saw named is worth more than one scoped to a protocol category.
 */
export function toAcpPermissionRequest(
  launcher: AcpLauncherId,
  params: RequestPermissionRequest,
  toolName: string | undefined
): LocalPermissionRequest {
  const rawInput = asRecord(params.toolCall.rawInput)
  if (launcher === 'claude') {
    // The adapter forwards the CLI's own `(toolName, input)` pair untouched —
    // verified in `spike/acp/claude/recordings` — so the in-process runner's
    // mapping applies unchanged, and a grant written under the SDK runner keeps
    // matching after the transport moved beneath it.
    const name = claudeToolName(params) ?? toolName ?? params.toolCall.kind ?? 'tool'
    const request = toClaudePermissionRequest(name, rawInput ?? {})
    return { ...request, callId: params.toolCall.toolCallId }
  }

  if (launcher === 'codex') {
    const kind = params.toolCall.kind ?? 'other'
    const resources: string[] = []
    if (kind === 'execute' && rawInput) {
      // One indivisible scope: separate command/cwd/privilege resources would let
      // grants from unrelated calls combine into a broader permission than either.
      // SOCKS network host/protocol live only in title/content in the adapter;
      // rawInput alone would let a grant for one host authorize another.
      resources.push(JSON.stringify({
        rawInput,
        title: params.toolCall.title,
        content: params.toolCall.content,
        locations: params.toolCall.locations
      }))
    } else if (kind === 'edit') {
      resources.push(...(params.toolCall.locations ?? []).map((location) => location.path))
    } else if (rawInput) {
      resources.push(JSON.stringify(rawInput))
    }
    return {
      // Keep Codex grants separate when an agent switches engines.
      action: `codex:${kind}`,
      resources: resources.length ? resources : [`Request ${params.toolCall.toolCallId}`],
      savable: [], callId: params.toolCall.toolCallId
    }
  }

  const action = openCodeAction(params, toolName)
  return {
    action,
    resources: openCodeResources(params, rawInput),
    // `savable` is what the *engine's* own "always" would persist, and nothing
    // renders off it any more. Empty here rather than invented: ACP's ask
    // carries no equivalent field, and the desktop derives its own, narrower
    // rule from `resources` (`permissionGrantPatterns`).
    savable: [],
    callId: params.toolCall.toolCallId
  }
}

/**
 * Which of the agent's options to answer with.
 *
 * Takes the *decision*, not an option kind, so the "never always" rule lives in
 * one place rather than at each call site. `allow_always` and `reject_always`
 * are removed before the search: an agent that offered only those two would
 * otherwise have one of them selected by a fallback, and both write a rule into
 * a store this app does not own.
 *
 * Null when the agent offered nothing usable — the caller then answers
 * `cancelled`, which every agent understands as "no decision", rather than
 * picking something on the user's behalf.
 */
export function pickPermissionOption(
  options: readonly PermissionOption[],
  decision: 'allow' | 'reject'
): string | null {
  const usable = options.filter(
    (option) => option.kind === 'allow_once' || option.kind === 'reject_once'
  )
  const want = decision === 'allow' ? 'allow_once' : 'reject_once'
  return usable.find((option) => option.kind === want)?.optionId ?? null
}

/** The Claude adapter's two spellings of the tool name, in the order it sets them. */
function claudeToolName(params: RequestPermissionRequest): string | undefined {
  const meta = asRecord(params.toolCall._meta)
  const claudeCode = asRecord(meta?.claudeCode)
  const fromMeta = claudeCode?.toolName
  if (typeof fromMeta === 'string' && fromMeta !== '') return fromMeta
  // `name` is the adapter's own extra field, absent from the ACP schema, which
  // is why it is read structurally rather than off the type.
  const name = (params.toolCall as { name?: unknown }).name
  return typeof name === 'string' && name !== '' ? name : undefined
}

function openCodeAction(params: RequestPermissionRequest, toolName: string | undefined): string {
  const byKind = params.toolCall.kind ? OPENCODE_ACTION_BY_KIND[params.toolCall.kind] : undefined
  if (byKind) return byKind
  // An MCP tool, or a kind the profile has no entry for. The tool's own name is
  // the only thing that identifies it — `spike-mcp_secret_number` in the MCP
  // probe — and it is what the permissions card will show.
  return toolName ?? params.toolCall.kind ?? 'tool'
}

function openCodeResources(
  params: RequestPermissionRequest,
  rawInput: Record<string, unknown> | undefined
): string[] {
  for (const field of OPENCODE_RESOURCE_FIELDS) {
    const value = rawInput?.[field]
    if (typeof value === 'string' && value.trim() !== '') return [value]
  }
  // `locations` is the protocol's own answer to "what does this touch", and it
  // is populated on an edit ask even when the input field is spelled in a way
  // this build has never seen. Last, not first: a bash ask's location is the
  // *directory* the command runs in, which is a much wider thing to remember
  // than the command line.
  const paths = (params.toolCall.locations ?? [])
    .map((location) => location.path)
    .filter((path): path is string => typeof path === 'string' && path !== '')
  return paths.length > 0 ? [paths[0]] : []
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
