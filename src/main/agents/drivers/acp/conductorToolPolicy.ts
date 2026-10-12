import type { AgentEngine } from '../../../../shared/engine'
import type { AcpLaunchPlan } from './acpLaunchers'
import { ANTIGRAVITY_FILTER_TOOLS } from './antigravityLauncher'

/** The one built-in an Antigravity chat runtime keeps: reading its MCP tools' schema files. */
export const ANTIGRAVITY_CONDUCTOR_TOOLS: readonly string[] = ['view_file']

/** Restrict native coding tools before starting a plain-chat/utility session. */
export function applyConductorToolPolicy(plan: AcpLaunchPlan, engine: AgentEngine): AcpLaunchPlan {
  if (engine === 'claude') {
    const meta = plan.session.meta ?? {}
    const claude = meta.claudeCode as { options?: Record<string, unknown> } | undefined
    return { ...plan, session: { ...plan.session, meta: { ...meta, claudeCode: {
      ...claude, options: { ...claude?.options, tools: [], settingSources: [], strictMcpConfig: true, mcpServers: {}, agents: {} }
    } } } }
  }
  if (engine === 'codex') {
    if (plan.conductorPolicy === 'no-native-tools') return plan
    throw new Error('Codex chat policy was not verified. Choose Claude or OpenCode, or check the installed Codex runtime.')
  }
  if (engine === 'antigravity') {
    // Every built-in off but `view_file`, by both halves of the server's
    // filter, in its own `BuiltinTools` names (`ANTIGRAVITY_FILTER_TOOLS`):
    // the allowlist (which also keeps a built-in a later server adds off) and
    // the denylist, which must name `ask_question` — the server appends it to
    // the allowlist otherwise. `view_file` stays because the
    // server offers MCP tools lazily: the model reads a tool's schema file
    // before `call_mcp_tool`, and without it calls Cinna's tools blind. It
    // reads the workspace and the session's whole home: for a chat runtime its
    // empty, desktop-owned process folder (`sessionCwd`) and its home — which
    // holds the conversations of every chat sharing that process (drafts p7c).
    // MCP tools are not governed by this filter. Verified against the fake
    // gateway (drafts p7/p7b): the request declares `view_file` and the MCP
    // tools alone, and the schema read and the MCP call both succeed.
    const meta = plan.session.meta ?? {}
    const agy = meta.agy as Record<string, unknown> | undefined
    return { ...plan, session: { ...plan.session, meta: { ...meta, agy: {
      ...agy, enabledTools: [...ANTIGRAVITY_CONDUCTOR_TOOLS],
      disabledTools: ANTIGRAVITY_FILTER_TOOLS.filter((tool) => !ANTIGRAVITY_CONDUCTOR_TOOLS.includes(tool))
    } } } }
  }
  // OpenCode's generated agent entry already carries permission {'*':'deny'};
  // its caller owns generation, because the file participates in the spec key.
  if (engine === 'opencode') return plan
  throw new Error('This runtime has no verified chat tool policy.')
}

/**
 * Antigravity titles an MCP call that raises no ask (mode `yolo`) `Running
 * <tool>` with the bare tool name — no server — and `kind: "other"`. Exported
 * for the transcript reader, which must read the same shape.
 */
export const BARE_MCP_TITLE = /^Running (\S+)$/

/**
 * The server and tool an Antigravity MCP call names in its `_meta.mcp` — the
 * shape of a call that raises an ask (mode `default`): titled
 * `<server>_<tool>`, `rawInput: {arguments}`, `_meta: {mcp: {server, tool},
 * is_mcp_tool_call: true}`, on its `tool_call` and on its permission request
 * alike (contract `antigravity.mcp.tool-call-naming`). Set by the server, not
 * written by the model. Null when the call carries none.
 */
export function mcpCallOf(meta: unknown): { server: string; tool: string } | null {
  const mcp = meta && typeof meta === 'object' ? (meta as { mcp?: unknown }).mcp : undefined
  if (!mcp || typeof mcp !== 'object') return null
  const { server, tool } = mcp as { server?: unknown; tool?: unknown }
  return typeof server === 'string' && server !== '' && typeof tool === 'string' && tool !== '' ? { server, tool } : null
}

/**
 * What a bare-named call needs before it counts as Cinna's: the names Cinna's
 * MCP server served this session (its last `tools/list`), and the call's
 * `kind` when known. A bare name alone would match any MCP server's tool of
 * the same name, and a shell call is titled with its command line — so only a
 * served name on an `other` call is Cinna's.
 */
export interface BareToolEvidence {
  offers(name: string): boolean
  kind?: unknown
}

/**
 * The Cinna tool a call names, or null. Every engine spells it differently:
 * Claude `mcp__cinna__<tool>`, Codex `mcp.cinna.<tool>` (or `rawInput`'s
 * server/tool pair), OpenCode `cinna_<tool>`, Antigravity `_meta.mcp`
 * (`meta`, read first: a call that names its server there is Cinna's only when
 * that server is `cinna`) or `Running <tool>` (only with
 * {@link BareToolEvidence}). The permission gate and the call correlation must
 * agree, so both read it here.
 */
export function cinnaToolName(label: string | null | undefined, rawInput?: unknown, bare?: BareToolEvidence, meta?: unknown): string | null {
  const named = mcpCallOf(meta)
  if (named) return named.server === 'cinna' ? named.tool : null
  const raw = rawInput as { server?: unknown; tool?: unknown } | null | undefined
  if (raw?.server === 'cinna' && typeof raw.tool === 'string') return raw.tool
  for (const prefix of ['mcp__cinna__', 'mcp.cinna.', 'cinna_']) if (label?.startsWith(prefix)) return label.slice(prefix.length)
  const running = label ? BARE_MCP_TITLE.exec(label) : null
  if (running && bare && (bare.kind === undefined || bare.kind === 'other') && bare.offers(running[1])) return running[1]
  return null
}

/**
 * OpenCode 2's Code Mode call (probed on 2.0.27): every MCP server a session
 * is given is reached only through one built-in `execute` tool, whose
 * model-written code calls `tools["cinna"].<tool>(…)`. Its `tool_call` is
 * `{name: "execute", title: "execute", kind: "other"}`, `rawInput: {code}`
 * follows, and nothing names the inner calls until the completed update's
 * `rawOutput.metadata.toolCalls` (see {@link codeModeCinnaTools}).
 */
export function isCodeModeCall(update: { name?: unknown; title?: unknown; kind?: unknown }): boolean {
  return (update.name === 'execute' || update.title === 'execute') && update.kind === 'other'
}

/**
 * The Cinna tools a finished Code Mode call ran, in order — its
 * `rawOutput.metadata.toolCalls` entries are `{tool: "cinna.<tool>", status}`
 * — or null when it ran none, or ran anything that was not Cinna's. Set by the
 * engine from the calls it made, not by the model's code.
 */
export function codeModeCinnaTools(rawOutput: unknown): string[] | null {
  const metadata = rawOutput && typeof rawOutput === 'object' ? (rawOutput as { metadata?: unknown }).metadata : undefined
  const calls = metadata && typeof metadata === 'object' ? (metadata as { toolCalls?: unknown }).toolCalls : undefined
  if (!Array.isArray(calls) || calls.length === 0) return null
  const tools: string[] = []
  for (const call of calls) {
    const tool = call && typeof call === 'object' ? (call as { tool?: unknown }).tool : undefined
    if (typeof tool !== 'string' || !tool.startsWith('cinna.') || tool.length === 'cinna.'.length) return null
    tools.push(tool.slice('cinna.'.length))
  }
  return tools
}
