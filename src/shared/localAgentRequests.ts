/**
 * The two interactive requests a local agent can make mid-turn — a permission
 * ask and an ask-user question — and the reserved tool names that carry them.
 *
 * ## Why these are `tool` parts and not new part kinds
 *
 * The stream vocabulary in `messageParts.ts` is a wire contract shared by the
 * main process, the preload guard and the renderer, and it already has a
 * convention for "a tool call the renderer should render as an interactive
 * widget": Ask-User-Question is detected by pattern-matching a `tool` part
 * whose `cinna.tool_name` normalises to `askuserquestion`. A permission ask is
 * the same thing — a call the agent cannot proceed past until a human answers
 * — so it follows the identical convention with a reserved name, and neither
 * `ContentKind` nor `AgentStreamEvent` gains a variant.
 *
 * ## The request id rides in `cinna.tool_id`
 *
 * A `tool` part's `tool_id` already exists to pair a call with its result. For
 * a local agent's request it is *also* the address the answer is posted back
 * to: `per_*` for `POST /api/session/{id}/permission/{requestID}/reply`, and
 * `que_*` for `.../question/{requestID}/reply`. So the renderer needs no new
 * field to know where to send an answer, and the wire contract is untouched.
 *
 * Pure type-only-plus-constants module: imported from main and renderer alike,
 * so it must pull in no runtime dependency.
 */

/**
 * Reserved tool name for a permission ask.
 *
 * Deliberately not a name any model would emit: OpenCode's permission asks are
 * *about* tools (`bash`, `edit`, `webfetch`) and carry the real tool name in
 * `source`, so naming this one after a tool would make an agent's own call to
 * that tool indistinguishable from a request to run it.
 */
export const PERMISSION_TOOL_NAME = 'cinna_permission_request'

/** Reserved tool name for a question. Matches what the renderer already looks for. */
export const QUESTION_TOOL_NAME = 'askuserquestion'

/** OpenCode id prefixes. Observed on the real binary; also in the OpenAPI patterns. */
export const PERMISSION_ID_PREFIX = 'per'
export const QUESTION_ID_PREFIX = 'que'

/** True when a `tool` part is a local agent's permission ask. */
export function isPermissionRequestTool(toolName?: string): boolean {
  return toolName === PERMISSION_TOOL_NAME
}

/**
 * True when a `tool` part's id is an **engine request id** rather than an
 * ordinary tool call id.
 *
 * This is what separates a local agent's request from a cloud agent's, and the
 * separation is load-bearing on the replay path. A cloud agent's question ends
 * its turn and stays answerable afterwards — that is what `activeQuestionMsgId`
 * encodes, and answering it sends the next user turn. A local agent's request
 * is answerable only while the engine is still parked on it: the id is a
 * live address that dies with the turn, so a persisted block bearing one must
 * render read-only however recent the message is. Whether it is still live is
 * a question only the main process can answer, and it answers it through the
 * pending-request registry.
 */
export function isEngineRequestId(toolId?: string): boolean {
  if (!toolId) return false
  return toolId.startsWith(`${PERMISSION_ID_PREFIX}_`) || toolId.startsWith(`${QUESTION_ID_PREFIX}_`)
}

/**
 * How long a request may sit unanswered before the runner rejects it for the
 * user.
 *
 * The turn holds its per-agent lock while parked, and `applyConfigChange`
 * defers while **any** lock is held — so an abandoned modal blocks every
 * credential change, every default-chat-mode change and the background
 * account-config sync from reaching the engine, for every folder agent, not
 * just this one. Unbounded, that turns one open dialog into an app-wide stall.
 *
 * Ten minutes is chosen to be far longer than a decision takes and far shorter
 * than a lunch break. Expiry posts a real `reject` rather than abandoning the
 * request, so the agent is told "denied" and the session goes idle by the same
 * path a deliberate Deny uses — the wedge this whole mechanism exists to avoid.
 */
export const REQUEST_PARK_TIMEOUT_MS = 10 * 60 * 1000

/**
 * **The "Always" answer is withheld. The leak it would cause is proven, not
 * suspected.**
 *
 * Canonical record: `docs/agents/local_agents/opencode_contract.md`. If that
 * document and this comment ever disagree, the document is right.
 *
 * This gate was originally a precaution against a scoping question nobody had
 * settled. The observation has since been done against the real binary with a
 * live credential, and it came back worse than the precaution assumed:
 *
 * 1. Folder A raised `permission.v2.asked` for `action: "edit"` on
 *    `resources: ["notes.txt"]`, offering `save: ["*"]`. Answering `always`
 *    wrote one row: `{id: psv_*, projectID: "global", action: "edit",
 *    resource: "*"}`.
 * 2. **That row names no directory, no session and no agent.**
 * 3. Folder B — a different agent folder, never granted anything — then wrote a
 *    file with **no permission event at all**.
 *
 * So one Always click grants every folder agent edit access to everything,
 * permanently. Three details make it worse than a scoping mistake:
 *
 * - **`save` is `["*"]`.** The only savable pattern the engine offers is
 *   *everything*, so a user who believes they are allowing "edit notes.txt" is
 *   allowing "edit anything". No wording on a button can make that honest.
 * - **`action` is coarser than the tool.** The `write` tool asks under
 *   `action: "edit"`, so a grant covers more tools than the one that prompted.
 * - **The store is user-global.** Grants live in
 *   `~/.local/share/opencode/opencode.db`, survive engine restarts, and are
 *   shared with the user's own OpenCode installation — so a grant can leak
 *   *into* Cinna from the user's personal OpenCode use as readily as out of it.
 *
 * ## The way forward, which is deliberately not built here
 *
 * The desktop is **not** stuck with this, and the earlier claim that it was
 * (see `desktopStateService`) was wrong. Replying `once` persists nothing —
 * verified: `/api/permission/saved` stayed empty until the moment `always` was
 * sent. So a correct per-agent Always is available by making the **desktop**
 * the authoritative store and never sending `always` to the engine at all:
 * remember the grant per agent folder, and auto-answer `once` from it.
 *
 * That is a Phase 7+ design decision and is deliberately not implemented here.
 * Until it is, Allow once and Deny are the honest answers, and both work.
 *
 * **Do not flip this to `true` as a way of shipping Always.** The observation
 * that would have justified flipping it has been done, and its result is that
 * flipping it is wrong. What replaces it is the desktop-authoritative model
 * above, at which point this constant should be deleted rather than set.
 */
export const ALWAYS_GRANTS_ENABLED = false

/**
 * The three answers a permission ask accepts.
 *
 * These are OpenCode's own enum values (`PermissionV2Reply`), not a desktop
 * invention, and they map one-to-one onto the design's Allow once / Always for
 * this agent / Deny — so nothing is translated at the boundary.
 */
export type PermissionReply = 'once' | 'always' | 'reject'

/**
 * A permission ask, as it reaches the renderer in a tool part's `toolInput`.
 *
 * `action` is the operation (`bash`, `edit`, `webfetch`, …) and `resources`
 * the things it wants to touch — a command line, a path, a URL. Note `action`
 * is **coarser than the tool**: the `write` tool was observed asking under
 * `action: "edit"`.
 *
 * `savable` is OpenCode's `save[]`: the patterns an "always" answer would
 * persist. It is empty for an ask that cannot be saved. In practice the only
 * value observed is `["*"]` — *everything* — which is a large part of why
 * {@link ALWAYS_GRANTS_ENABLED} is off; see there for the full observation.
 */
export interface LocalPermissionRequest {
  action: string
  resources: string[]
  savable: string[]
  /** The tool call that raised it, when the engine named one. */
  callId?: string
}

/** Narrow an untyped `toolInput` into a {@link LocalPermissionRequest}. */
export function parsePermissionRequest(
  toolInput?: Record<string, unknown>
): LocalPermissionRequest | null {
  if (!toolInput) return null
  const action = toolInput.action
  if (typeof action !== 'string' || action === '') return null
  const resources = Array.isArray(toolInput.resources)
    ? toolInput.resources.filter((r): r is string => typeof r === 'string')
    : []
  const savable = Array.isArray(toolInput.savable)
    ? toolInput.savable.filter((r): r is string => typeof r === 'string')
    : []
  const callId = typeof toolInput.callId === 'string' ? toolInput.callId : undefined
  return { action, resources, savable, callId }
}
