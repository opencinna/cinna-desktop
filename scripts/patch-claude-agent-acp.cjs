const { readFileSync, writeFileSync, renameSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { createHash } = require('node:crypto')
const policy = require('../src/main/agents/drivers/acp/claudeAdapterPatch.json')

// The pinned adapter never exposes the SDK's `query.getContextUsage()`, so the
// split of a session's context by category (system prompt, tools, memory
// files, MCP tools, messages…) cannot be read over ACP. This adds one
// extension request, `_cinna/contextUsage {sessionId}`, registered on the
// adapter's own request builder beside its other extension methods. It answers
// only between turns (a running or queued turn is refused as busy, an ended
// query as closed) and returns a trimmed copy of the SDK's answer — never
// the rendering grid. The desktop asks only
// for a session a prompt has already been answered on in this process: before
// that the SDK stalls on the control request. The user's Claude Code
// executable is never modified.
const METHOD = '_cinna/contextUsage'
const routeAnchor = '        .onRequest(GOAL_CONTROL_METHOD, { parse: parseGoalRequest }, (ctx) => agent.goal(ctx.params))\n'
const route = `        .onRequest("${METHOD}", { parse: cinnaContextUsageParams }, (ctx) => cinnaContextUsage(agent, ctx.params))\n`
const handlerAnchor = 'export function runAcp(logger) {\n'
const handler = `/** Cinna Desktop: \`${METHOD}\` (scripts/patch-claude-agent-acp.cjs). */
function cinnaContextUsageParams(params) {
    if (!params || typeof params !== "object" || typeof params.sessionId !== "string" || params.sessionId.length === 0) {
        throw RequestError.invalidParams(undefined, "${METHOD} params require a non-empty sessionId");
    }
    return { sessionId: params.sessionId };
}
async function cinnaContextUsage(agent, params) {
    const session = agent.sessions[params.sessionId];
    if (!session) {
        throw RequestError.invalidParams({ sessionId: params.sessionId }, "unknown session");
    }
    // The SDK stream ended (the adapter's own \`queryClosed\`): nothing to ask.
    if (session.queryClosed) {
        throw RequestError.internalError({ reason: "closed" }, "closed: this session's query has ended");
    }
    // A running turn, or a prompt enqueued but not yet activated (an unsettled
    // entry in \`turnQueue\`, the adapter's own test for "a turn is running").
    // A prompt still inside \`prompt()\`'s early awaits (provider update,
    // sign-out respawn, subscription guard) has no cheap flag and is not seen
    // here; the desktop discards a measurement a turn started across.
    if (session.activeTurn || (session.turnQueue ?? []).some((turn) => !turn.settled)) {
        throw RequestError.internalError({ reason: "busy" }, "busy: a turn is in progress on this session");
    }
    return cinnaTrimContextUsage(await session.query.getContextUsage());
}
function cinnaTrimContextUsage(usage) {
    const u = usage ?? {};
    const list = (value) => (Array.isArray(value) ? value : []);
    const trimmed = {
        categories: list(u.categories).map((c) => ({ name: c.name, tokens: c.tokens, ...(c.isDeferred !== undefined ? { isDeferred: c.isDeferred } : {}) })),
        totalTokens: u.totalTokens,
        maxTokens: u.maxTokens,
        rawMaxTokens: u.rawMaxTokens,
        percentage: u.percentage,
        model: u.model,
        memoryFiles: list(u.memoryFiles).map((f) => ({ path: f.path, type: f.type, tokens: f.tokens })),
        mcpTools: list(u.mcpTools).map((t) => ({ name: t.name, serverName: t.serverName, tokens: t.tokens, ...(t.isLoaded !== undefined ? { isLoaded: t.isLoaded } : {}) })),
        agents: list(u.agents).map((a) => ({ agentType: a.agentType, source: a.source, tokens: a.tokens })),
        systemTools: list(u.systemTools).map((t) => ({ name: t.name, tokens: t.tokens })),
        systemPromptSections: list(u.systemPromptSections).map((s) => ({ name: s.name, tokens: s.tokens })),
    };
    if (u.skills) {
        trimmed.skills = { totalSkills: u.skills.totalSkills, includedSkills: u.skills.includedSkills, tokens: u.skills.tokens };
    }
    if (u.slashCommands) {
        trimmed.slashCommands = { totalCommands: u.slashCommands.totalCommands, includedCommands: u.slashCommands.includedCommands, tokens: u.slashCommands.tokens };
    }
    return trimmed;
}
`
const digest = (content) => createHash('sha256').update(content).digest('hex')

function adapter(root) {
  const directory = join(root, 'node_modules/@agentclientprotocol/claude-agent-acp')
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  if (manifest.version !== policy.version) throw new Error('Claude ACP patch needs review for this adapter version')
  return join(directory, 'dist/acp-agent.js')
}

function verifyClaudeAgentAcpPatch(root) {
  if (digest(readFileSync(adapter(root))) !== policy.patchedSha256) {
    throw new Error('Claude ACP context-usage patch is missing or changed')
  }
}

function patchClaudeAgentAcp(root) {
  const path = adapter(root)
  const content = readFileSync(path, 'utf8')
  if (digest(content) === policy.patchedSha256) return
  if (digest(content) !== policy.originalSha256) {
    throw new Error('Claude ACP source differs from the reviewed pinned adapter; refusing to patch')
  }
  for (const anchor of [routeAnchor, handlerAnchor]) {
    if (content.split(anchor).length !== 2) throw new Error('Claude ACP context-usage patch target changed')
  }
  const patched = content.replace(routeAnchor, () => routeAnchor + route).replace(handlerAnchor, () => handler + handlerAnchor)
  if (digest(patched) !== policy.patchedSha256) throw new Error('Claude ACP patch output does not match reviewed content')
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, patched, { mode: 0o644 })
  renameSync(temporary, path)
  verifyClaudeAgentAcpPatch(root)
}

module.exports = { patchClaudeAgentAcp, verifyClaudeAgentAcpPatch, CONTEXT_USAGE_METHOD: METHOD, contextUsageHandlerSource: handler, contextUsageRoute: route }
if (require.main === module) patchClaudeAgentAcp(resolve(__dirname, '..'))
