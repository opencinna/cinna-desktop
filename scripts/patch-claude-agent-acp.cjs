const { readFileSync, writeFileSync, renameSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { createHash } = require('node:crypto')
const policy = require('../src/main/agents/drivers/acp/claudeAdapterPatch.json')

// The pinned adapter never exposes the SDK's `query.getContextUsage()` to the
// client (it calls it itself, in the background on session/new and on a model
// switch, only for the context window), so the split of a session's context by
// category (system prompt, tools, memory files, MCP tools, messages…) cannot be
// read over ACP. This adds one extension request, `_cinna/contextUsage
// {sessionId}`, registered as the last link of the adapter's own request
// builder chain beside its other extension methods. It answers only between
// turns (a running or queued turn is refused as busy, an ended query as closed)
// and returns a trimmed copy of the SDK's answer — never the rendering grid.
// The SDK serializes control requests, so a measurement waits behind any the
// adapter has in flight. The desktop asks only for a session a prompt has
// already been answered on in this process: before that the SDK stalls on the
// control request. The user's Claude Code executable is never modified.
const METHOD = '_cinna/contextUsage'
// The goal route ends the chain, so its `;` moves to the end of ours.
const routeAnchor = '        .onRequest(GOAL_CONTROL_METHOD, { parse: parseGoalRequest }, (ctx) => agent.goal(ctx.params));\n'
const route = `        .onRequest(GOAL_CONTROL_METHOD, { parse: parseGoalRequest }, (ctx) => agent.goal(ctx.params))
        .onRequest("${METHOD}", { parse: cinnaContextUsageParams }, (ctx) => cinnaContextUsage(agent, ctx.params));\n`
const handlerAnchor = 'export function runAcp(logger) {\n'

// Cinna declares `_meta.jetbrains.air` (acpActivity.ts `airClientMeta`) only to
// negotiate the `asyncTasks` and `nativeSubagentSessions` capabilities. From
// 0.8x the adapter also reads that declaration as "this client is the JetBrains
// AIR UI" (`toolCallCapabilities.air.client`) and reshapes every tool call for
// AIR's own renderer: Read and path-scoped Grep/Glob results lose their text and
// `rawOutput`, Edit/Write lose `old_string`/`new_string`/`content` from
// `rawInput` (in the transcript and in permission asks), the first `tool_call`
// has no `rawInput`, a permission's `toolCall` loses `name`/`kind`/`content`,
// and repeated `tool_call_update` `_meta` is thinned. Cinna is not AIR and reads
// the plain shapes, so this sets `air.client` back to false right where
// `initialize` decides it, the only place it is decided; every AIR-only branch
// reads it from there. `rawInputRendering`/`planFile` stay as negotiated, and
// the async-task and subagent capabilities are read from the raw
// `clientCapabilities`, so they are untouched.
const airClientAnchor = `        this.toolCallCapabilities = ToolCallClientCapabilities.from(request.clientCapabilities, {
            v2: this.v2,
        });
`
const airClientOff = `${airClientAnchor}        // Cinna Desktop (scripts/patch-claude-agent-acp.cjs): not the AIR UI; keep the plain tool call shapes.
        this.toolCallCapabilities.air = { ...this.toolCallCapabilities.air, client: false };
`
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
    // \`full\` (the SDK default) makes the CLI call the provider's count_tokens per category.
    return cinnaTrimContextUsage(await session.query.getContextUsage({ detail: "full" }));
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

// `dist/native-subagents.js`: a subagent resumed by SendMessage. Its new
// `task_started` names the SendMessage call (`tool_use_id`), but every frame of
// the resumed agent still names the Agent call that first spawned it
// (`parent_tool_use_id`), and so does nothing else. The adapter keyed the new
// generation by the SendMessage call (its comment assumes the resume reuses the
// first call's id; on CLI 2.1.296 it does not), so the first call still led to
// the finished generation: the resumed agent's frames were dropped as late
// updates, and the agents it spawned were announced on the finished
// generation's session. The new generation is keyed by the call its frames
// name, and the SendMessage call is mapped to it as well, because the resume's
// `task_notification` names that call (`finishTask` resolves the child by it).
// Watched live on CLI 2.1.296 with adapter 0.89.1.
const resumeKeyAnchor = '            parentToolUseId: task.toolUseId ?? undefined,\n'
const resumeKey = `            // Cinna Desktop (scripts/patch-claude-agent-acp.cjs): a resume keeps the Agent call its frames name; its own SendMessage call is an alias.
            parentToolUseId: previous?.parentToolUseId ?? task.toolUseId ?? undefined,
            ...(previous?.parentToolUseId && task.toolUseId && task.toolUseId !== previous.parentToolUseId ? { resumeToolUseId: task.toolUseId } : {}),
`
const resumeAliasAnchor = `        if (toolUseId) {
            this.taskByToolUse.set(toolUseId, taskId);
            this.childByParentToolUse.set(toolUseId, child);
            this.controlByToolUse.delete(toolUseId);
        }
`
const resumeAlias = `${resumeAliasAnchor}        // Cinna Desktop (scripts/patch-claude-agent-acp.cjs): the resume's SendMessage call leads to the same generation.
        if (child.resumeToolUseId) {
            this.taskByToolUse.set(child.resumeToolUseId, taskId);
            this.childByParentToolUse.set(child.resumeToolUseId, child);
        }
`
// A resumed generation answers to the first Agent call too (above), so a late
// `task_notification` of the generation before it — which names that call —
// resolved to the resumed generation and ended it while it ran. A generation
// that was resumed is ended only by its own SendMessage call's notification,
// or by a `task_updated` that names no call.
const resumeFinishAnchor = `        if (child && toolUseId && this.taskByToolUse.get(toolUseId) !== taskId)
            return;
`
const resumeFinish = `${resumeFinishAnchor}        // Cinna Desktop (scripts/patch-claude-agent-acp.cjs): the Agent call's notification belongs to the generation before a resume.
        if (child?.resumeToolUseId && toolUseId === child.parentToolUseId)
            return;
`

const digest = (content) => createHash('sha256').update(content).digest('hex')

/** The patched files: where each is, its reviewed digests, and its edits (anchor → replacement). */
const FILES = [
  {
    file: 'dist/acp-agent.js',
    label: 'context usage, AIR client off',
    originalSha256: policy.originalSha256,
    patchedSha256: policy.patchedSha256,
    edits: [[routeAnchor, route], [handlerAnchor, handler + handlerAnchor], [airClientAnchor, airClientOff]]
  },
  {
    file: 'dist/native-subagents.js',
    label: 'resumed subagent routing',
    originalSha256: policy.subagentsOriginalSha256,
    patchedSha256: policy.subagentsPatchedSha256,
    edits: [[resumeKeyAnchor, resumeKey], [resumeAliasAnchor, resumeAlias], [resumeFinishAnchor, resumeFinish]]
  }
]

function adapter(root) {
  const directory = join(root, 'node_modules/@agentclientprotocol/claude-agent-acp')
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  if (manifest.version !== policy.version) throw new Error('Claude ACP patch needs review for this adapter version')
  return directory
}

function verifyClaudeAgentAcpPatch(root) {
  const directory = adapter(root)
  for (const target of FILES) {
    if (digest(readFileSync(join(directory, target.file))) !== target.patchedSha256) {
      throw new Error(`Claude ACP patch (${target.label}) is missing or changed`)
    }
  }
}

function patchClaudeAgentAcp(root) {
  const directory = adapter(root)
  // Every file is checked before any is written, so a refusal leaves the package as it was.
  const writes = []
  for (const target of FILES) {
    const path = join(directory, target.file)
    const content = readFileSync(path, 'utf8')
    if (digest(content) === target.patchedSha256) continue
    if (digest(content) !== target.originalSha256) {
      throw new Error(`Claude ACP source (${target.file}) differs from the reviewed pinned adapter; refusing to patch`)
    }
    for (const [anchor] of target.edits) {
      if (content.split(anchor).length !== 2) throw new Error(`Claude ACP patch target changed (${target.file})`)
    }
    const patched = target.edits.reduce((text, [anchor, replacement]) => text.replace(anchor, () => replacement), content)
    if (digest(patched) !== target.patchedSha256) throw new Error(`Claude ACP patch output does not match reviewed content (${target.file})`)
    writes.push([path, patched])
  }
  for (const [path, patched] of writes) {
    const temporary = `${path}.${process.pid}.tmp`
    writeFileSync(temporary, patched, { mode: 0o644 })
    renameSync(temporary, path)
  }
  verifyClaudeAgentAcpPatch(root)
}

module.exports = { patchClaudeAgentAcp, verifyClaudeAgentAcpPatch, CONTEXT_USAGE_METHOD: METHOD, contextUsageHandlerSource: handler, contextUsageRouteAnchor: routeAnchor, contextUsageRoute: route,
  airClientAnchor, airClientOff, resumeKeyAnchor, resumeKey, resumeAliasAnchor, resumeAlias, resumeFinishAnchor, resumeFinish }
if (require.main === module) patchClaudeAgentAcp(resolve(__dirname, '..'))
