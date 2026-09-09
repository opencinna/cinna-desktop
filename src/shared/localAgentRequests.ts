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
 * **"Always" is answered by the desktop, and never sent to the engine.**
 *
 * Canonical record: `docs/agents/local_agents/opencode_contract.md` §4. If that
 * document and this comment ever disagree, the document is right.
 *
 * OpenCode's own `always` reply is unusable, and the observation that settled
 * it was made against the real binary with a live credential:
 *
 * 1. Folder A raised `permission.v2.asked` for `action: "edit"` on
 *    `resources: ["notes.txt"]`, offering `save: ["*"]`. Answering `always`
 *    wrote one row: `{id: psv_*, projectID: "global", action: "edit",
 *    resource: "*"}`.
 * 2. **That row names no directory, no session and no agent.**
 * 3. Folder B — a different agent folder, never granted anything — then wrote a
 *    file with **no permission event at all**. The row survives an engine
 *    restart, because it lives in `~/.local/share/opencode/opencode.db`, a
 *    user-global store shared with the user's own OpenCode installation.
 *
 * The way out is the one that same observation opened: **replying `once`
 * persists nothing** — `GET /api/permission/saved` stayed empty through
 * repeated `once` replies and gained a row only at the moment `always` was
 * sent. So the desktop makes itself authoritative instead:
 *
 * - the user's *Always allow* is recorded in that agent folder's
 *   `app-data/desktop.json`, keyed by the agent and scoped to the action and
 *   the resource the user actually saw ({@link permissionGrantPatterns});
 * - a later ask that a grant covers is answered `once`, automatically, before
 *   any block reaches the transcript;
 * - `always` is never posted to the engine, so its global store stays empty and
 *   `projectID: "global"` never gets a chance to matter.
 *
 * This is **finer** granularity than OpenCode offers, not merely equivalent:
 * the engine's own `save` only ever offers `["*"]`, while a desktop-held rule
 * names one command, one path or one origin, for one agent.
 *
 * `ALWAYS_GRANTS_ENABLED` used to sit here as the gate that withheld the
 * button. It is deleted rather than flipped, exactly as its own comment
 * required: what replaced it is this model, not a `true`.
 */

/**
 * How widely a stored grant reaches.
 *
 * **This field exists instead of a wildcard character, and the reason is a
 * bug that shipped in the first cut of this feature.** Matching compiled the
 * pattern to a regular expression with `*` left as `.*` — and a resource is
 * very often a command line the *model* wrote. So `rm -rf build/*`, remembered
 * by a user who read exactly that string on the button, silently also covered
 * `rm -rf build/../../Documents`: auto-answered `once`, with no block in the
 * transcript and nothing to see afterwards. Compiling agent-authored text to a
 * regex was a second problem on the same line — `*a*a*a*a*a*` against a long
 * resource is catastrophic backtracking on the main thread.
 *
 * The fix is to stop guessing which asterisks are wildcards. The scope records
 * what the desktop *meant* when it stored the rule, and matching is then string
 * work with no regular expression anywhere:
 *
 * - `exact` — the resource, character for character, `*` included. Everything
 *   the engine named is stored this way.
 * - `origin` — a URL prefix the desktop synthesised (`https://host/*`), which
 *   covers anything under that origin.
 * - `action` — the whole action, from an ask that named no resource at all.
 */
export type PermissionGrantScope = 'exact' | 'origin' | 'action'

/** One remembered decision: this agent may do this action to this resource. */
export interface LocalPermissionGrant {
  /** OpenCode's coarse operation — `bash`, `edit`, `webfetch`, … */
  action: string
  /** The resource it covers, read according to {@link scope}. */
  pattern: string
  /** How widely {@link pattern} reaches. Never inferred from its characters. */
  scope: PermissionGrantScope
  /** Epoch millis, so the agent page can say when it was granted. */
  decidedAt: number
}

/**
 * A grant with the key that addresses it — what the agent page lists and what
 * the revoke button sends back.
 *
 * Shared rather than declared in main because it crosses the bridge: the
 * preload's type surface may not reach into `src/main`, and a second
 * declaration on the renderer side is how a wire contract starts to drift.
 */
export interface StoredPermissionGrant extends LocalPermissionGrant {
  key: string
}

/**
 * The key a grant is stored under in `desktop.json`.
 *
 * `::` rather than `:` because a pattern is very often a URL, which carries a
 * single colon of its own — a key that split ambiguously would make "forget
 * this grant" delete a different one.
 */
export function permissionGrantKey(action: string, pattern: string): string {
  return `${action}::${pattern}`
}

/**
 * What *Always allow* would remember for one ask — one rule per resource.
 *
 * Deliberately not `*`. The whole reason the desktop keeps its own store is
 * that OpenCode's only savable pattern is "everything", so a rule derived here
 * has to stay as narrow as the thing the user was looking at when they clicked:
 *
 * - **A URL** becomes its origin, scope `origin`. A webfetch ask names one URL
 *   with its query string attached, which would never match again; the origin
 *   is the unit the user actually reasons about ("let it read the docs site").
 * - **Anything else** — a path, a command line, a directory — is remembered
 *   verbatim, scope `exact`, *including any `*` it contains*. A command line is
 *   not widened to its first word (`git *` reads as harmless and covers `git
 *   config --global …`), and an asterisk the model wrote is not a wildcard: see
 *   {@link PermissionGrantScope} for the `rm -rf build/*` case that settled it.
 * - **An ask with no resources at all** can only be remembered as the whole
 *   action, scope `action`, and the button says so.
 */
export function permissionGrantPatterns(
  request: LocalPermissionRequest
): { pattern: string; scope: PermissionGrantScope }[] {
  if (request.resources.length === 0) return [{ pattern: '*', scope: 'action' }]
  const byPattern = new Map<string, { pattern: string; scope: PermissionGrantScope }>()
  for (const resource of request.resources) {
    const origin = originPattern(resource)
    const entry: { pattern: string; scope: PermissionGrantScope } = origin
      ? { pattern: origin, scope: 'origin' }
      : { pattern: resource, scope: 'exact' }
    byPattern.set(entry.pattern, entry)
  }
  return [...byPattern.values()]
}

/** `https://example.com/a?b=c` → `https://example.com/*`, or null when not a URL. */
function originPattern(resource: string): string | null {
  if (!/^https?:\/\//i.test(resource)) return null
  try {
    return `${new URL(resource).origin}/*`
  } catch {
    return null
  }
}

/**
 * True when `grant` covers `resource`.
 *
 * String work only, and that is the point — see {@link PermissionGrantScope}.
 * No regular expression, and no character with a special meaning, so a resource
 * the model wrote cannot widen the rule the user agreed to and nothing here can
 * backtrack on a hostile pattern.
 */
export function permissionGrantMatches(
  grant: Pick<LocalPermissionGrant, 'pattern' | 'scope'>,
  resource: string
): boolean {
  switch (grant.scope) {
    case 'action':
      return true
    case 'origin': {
      // `https://host/*` covers everything under the origin, the origin with a
      // bare trailing slash, and the origin with no path at all — which is how
      // a URL typed without one arrives.
      const withSlash = grant.pattern.slice(0, -1)
      return resource.startsWith(withSlash) || resource === withSlash.slice(0, -1)
    }
    default:
      return grant.pattern === resource
  }
}

/**
 * True when the desktop has already been told to allow this exact ask.
 *
 * **Every** resource has to be covered, not any: an ask naming two paths is one
 * decision about both, and allowing it because one of them was granted earlier
 * would let a second resource ride in on the first one's grant.
 */
export function isPermissionGranted(
  request: LocalPermissionRequest,
  grants: readonly LocalPermissionGrant[]
): boolean {
  const forAction = grants.filter((grant) => grant.action === request.action)
  if (forAction.length === 0) return false
  if (request.resources.length === 0) {
    return forAction.some((grant) => grant.scope === 'action')
  }
  return request.resources.every((resource) =>
    forAction.some((grant) => permissionGrantMatches(grant, resource))
  )
}

/**
 * The engine's coarse action name as a phrase a person can read.
 *
 * `action` is OpenCode's vocabulary — `bash`, `webfetch`, `external_directory`
 * — and it leaks into two surfaces a non-developer reads: the permission block
 * in the transcript and the permissions card on the agent page. "The agent is
 * asking to run external_directory" is not a question anyone can answer.
 *
 * An unknown action falls back to itself rather than to something vague: a
 * newer engine asking about a tool this table has never heard of must still
 * name it, because the resource list underneath is the only other clue the user
 * gets.
 */
export function describePermissionAction(action: string): string {
  switch (action) {
    // OpenCode's coarse operations.
    case 'bash':
      return 'run a command'
    case 'edit':
      return 'edit a file'
    case 'write':
      return 'write a file'
    case 'read':
      return 'read a file'
    case 'webfetch':
      return 'fetch from the web'
    case 'external_directory':
      return 'use a folder outside its own'
    // **Claude's tool names, which are a different vocabulary and stay one.**
    // The engines are not mapped onto each other — a grant is stored under the
    // action the engine that raised it actually named, so a rule written on one
    // never silently authorises the other. What is shared is only this
    // sentence, because the user reads the same block either way and "The agent
    // is asking to Bash" is not English.
    case 'Bash':
      return 'run a command'
    case 'Edit':
      return 'edit a file'
    case 'Write':
      return 'write a file'
    case 'Read':
      return 'read a file'
    case 'NotebookEdit':
      return 'edit a notebook'
    case 'WebFetch':
      return 'fetch from the web'
    case 'WebSearch':
      return 'search the web'
    // `Agent` is what `claude` 2.1.266 actually emits; `Task` is the name in
    // the SDK's types. Both, because a tool name this table misses renders as
    // itself — "The agent is asking to Agent" is not a sentence.
    case 'Agent':
    case 'Task':
      return 'run a subagent'
    case 'Glob':
      return 'search for files'
    case 'Grep':
      return 'search file contents'
    default:
      return action
  }
}

/**
 * What the *Always allow* button promises, in the user's words.
 *
 * The button has to name its own scope. A grant is wider than the ask that
 * produced it exactly once — a URL becomes its origin — and that is the case a
 * user would otherwise not see coming.
 */
export function describeGrantScope(
  action: string,
  patterns: { pattern: string; scope: PermissionGrantScope }[]
): string {
  // The blanket case, and the only one where the grant is not tied to a
  // resource: an ask that names nothing can only be remembered as the whole
  // action. It says so in words — "any request to fetch from the web" — rather
  // than in the engine's own vocabulary, which is what `describePermissionAction`
  // exists to keep off the screen, and it is the one scope a user has to read
  // as broad before clicking.
  if (patterns.length === 1 && patterns[0].scope === 'action') {
    return `any request to ${describePermissionAction(action)}`
  }
  return patterns.map((entry) => entry.pattern).join(', ')
}

/**
 * The three answers a permission ask accepts.
 *
 * These are OpenCode's own enum values (`PermissionV2Reply`), not a desktop
 * invention, so nothing is translated at the boundary — with one deliberate
 * exception. **`always` is answered by the desktop and never posted to the
 * engine:** the runner records the grant against the agent folder and replies
 * `once` in its place, for the reasons above. So the value travels from the
 * renderer to the main process and stops there.
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
 * `savable` is OpenCode's `save[]`: the patterns *its own* "always" answer
 * would persist, and in practice the only value observed is `["*"]` —
 * everything. **Nothing renders off it.** The Always allow button used to be
 * gated on it being non-empty, which was right while the engine was the store
 * and wrong now that the desktop is: a grant is derived from `resources` by
 * {@link permissionGrantPatterns} and saved here, so an ask the engine
 * considers unsavable is still one this app can remember — more precisely than
 * the engine would have. Kept because it is on the wire and says what the
 * engine would have done.
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
