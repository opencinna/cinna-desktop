# Orchestrated Agents (Runtime Conductors)

## Purpose

Let one Local runtime conduct a chat using attached agents and MCP servers as tools, while the user sees each specialist's work and can answer its requests. Routing decides who conducts; this feature owns how that conductor reaches tools.

## Core Concepts

- **Conductor** — the coordinator chat's Local root: a folder/stdio ACP agent or a hidden chat-owned Default runtime. A direct Local session receives the bridge from its first turn so later attachments need no connection rebuild.
- **Participant** — any attached agent, including remote drivers, exposed through the existing agent-as-tool descriptor. The conductor is excluded from its own tools and nested specialists receive no Cinna bridge, preventing self-locks and recursive delegation.
- **Cinna MCP endpoint** — a main-owned, bearer-authenticated Streamable HTTP endpoint on loopback, injected via ACP session parameters. Real connector tools are proxied through the existing MCP manager so OAuth and connection state have one owner.
- **Dual output** — compact specialist text returns to the runtime; rich parts persist and stream into an expandable agent sub-thread. The runtime is responsible for its own model/tool loop.

## User Stories / Flows

1. Start a coordinated chat using the [routing preference or one-way action](../chat_routing/chat_routing.md).
2. The Local runtime sees attached agent tools plus connected baseline/on-demand MCP tools. Calls to different agents may run concurrently; the same agent's lock serializes its calls.
3. Agent tool calls show the request followed by thinking, tools and text in a sub-thread. Compact view groups consecutive tool steps; verbose view keeps them inline. A finished sub-thread collapses unless verbose is on.
4. A specialist's permission request stays live and can be answered in its sub-thread or the Inbox. A question becomes a durable Inbox request; the conductor ends its turn instead of repeatedly calling the waiting agent — but only once every call running in parallel with it has finished. Ending the turn cancels the session, and with it each sibling specialist still at work.
5. Answer the question in the Inbox. The specialist resumes through its driver. Its completed result returns to the conductor as a new prompt naming the original tool call, rather than pretending the earlier MCP request is still open.
6. Add/remove capabilities during the session: Cinna changes the tool list and emits `tools/list_changed`, preserving endpoint identity. Engine adoption is separate from server fixture coverage: OpenCode 1.18.27 adopted it in the real-adapter/local-fake-model probe; authenticated Claude/Codex behavior remains unverified.

## Business Rules

- Local eligibility follows the shared transport split. A2A, WebSocket ACP and Managed agents remain callable participants, not loopback conductors.
- Synthetic plain-chat modes prohibit native filesystem and shell tools. **No tools** also hides attached connectors; **Connected tools** permits only the bridge's attached capabilities. A specialist keeps its own permission profile. A chat-owned runtime's permission ask is answered only when it is for a Cinna tool, in whichever spelling the engine uses (Claude `mcp__cinna__`, Codex `mcp.cinna.` or a raw server/tool pair, OpenCode `cinna_`); anything else is rejected silently. The gate and the transcript correlation read one shared predicate, because a gate that knew only Claude's spelling rejected the bridge's own tools on the other engines. **Any session conducting a chat** — chat-owned or a user's folder agent — is not asked about Cinna's own tools at all: the ask is allowed with no block and nothing recorded, but only when the adapter-set fields confirm the tool (Codex `rawInput.server`, Claude `_meta.claudeCode.toolName`, OpenCode the opening `tool_call`'s title), never on a title a model can write, and only when Cinna's MCP server listed that tool to the session — OpenCode's `<server>_<tool>` spelling lets a user's own server named `cinna_x` pass for Cinna by prefix. A session without a conductor lease, chat-owned or not, has these asks answered by a standing grant or the user. See [permissions](../../agents/local_agents/permissions.md#a-session-conducting-a-chat-is-not-asked-about-cinnas-own-tools).
- Claude synthetic sessions use explicit empty native tools and isolated settings. OpenCode uses generated deny-by-default native permissions with the Cinna bridge allowed. Codex synthetic plain-chat/AI-function sessions use a version-checked restricted catalog and tool configuration at both process startup and session creation. Unsupported versions/platforms/models or adapter patches refuse before prompting; folder Codex agents retain their ordinary native permissions. See [Codex policy](../../agents/local_agents/codex_engine_tech.md#restricted-chat-and-ai-function-policy).
- Tool descriptors use existing stable slug/collision rules. Driver tokens, session IDs and endpoint credentials are not arguments the model must manage.
- Only a trusted runner coordinator provider can return task controls. MCP content and specialist results cannot grant themselves runner authority.
- Stop on the chat aborts bridge calls and nested work. Stop on one specialist cancels that sub-thread's invocation; the conductor receives a canceled result and may continue. Conductor process death rejects outstanding calls/parks. A call made between turns waits for a follow-up turn to own it; when that follow-up is abandoned the call fails with an error naming the reason, rather than hanging the runtime's tool loop forever.
- Steering is withheld while native tools or bridge calls run; messages queue until an eligible steering window. This avoids intentionally preempting a long specialist call.
- Bridge calls are bounded: ordinary turns allow 100 calls; autonomous turns consume the runner's persisted budget, except for the runner controls `update_task` and `finish`, which do no outside work — a coordinator at its cap must still be able to record progress and finish (they stay bounded by the 100-call per-turn ceiling). A follow-up run the engine opens between turns draws on the same task budget rather than the per-turn ceiling alone — but only while the task's current owner is its coordinator and that coordinator is the agent running; after a handoff to a specialist, a follow-up the coordinator's session starts is capped by the 100-call per-turn ceiling alone. A specialist budget result pauses the conductor rather than retrying the same limited login.
- The endpoint URL/token stay stable only within the running app. A descriptor/config hash is persisted; after restart the new endpoint changes that hash, so the driver creates a fresh session and replays full saved history and attachments. It does not load a session against an obsolete bearer endpoint. The hash is saved only after the session has taken its first prompt — the replay travels in that prompt, so a session that failed before then is replaced and replayed again on the next turn instead of being loaded empty.
- Replacement-session replay is separate from bounded per-agent catch-up and belongs to the chat's answerer root only; an addressed participant gets catch-up alone. Stored error/transition rows are excluded; prior speakers and tool-call IDs are attributed. Current user content is not replayed twice.
- Compatible synthetic runtimes share a process keyed by profile, engine, credential, model, instructions and tool policy. Each chat still has its own cwd, session, tools and transcript. Folder agents retain their per-agent processes. No cross-profile conversation is shared.
- Permanent chat deletion and Empty Trash remove only that chat’s generated runtime row and instruction directory. Moving a chat to Trash retains them for restoration; user-added agents and their folders are never deleted as a side effect.
- Live permission parks expire at turn end/restart; durable questions survive. No sub-sub-thread is rendered.

## Architecture Overview

Composer → run executor → Local ACP session → Cinna loopback MCP server → ToolProvider → MCP manager or specialist driver. Main persists child events/results and Inbox requests; the renderer observes the same run stream.

## Integration Points

- [Technical reference](orchestrated_agents_tech.md) — server security, correlation, persistence and tests.
- [Chat modes](../chat_modes/chat_modes.md) — synthetic runtime profiles.
- [Autonomous tasks](../../jobs/tasks/autonomous_tasks.md) — fixed delegate/handoff/ask_user/update_task/finish controls and durable budgets.
- [AI Functions](../../llm/ai_functions/ai_functions.md) — fresh no-tools utility sessions on pooled runtimes.
- [ACP contract](../../agents/local_agents/acp_contract.md) — measured adapter evidence and remaining authenticated probes.
