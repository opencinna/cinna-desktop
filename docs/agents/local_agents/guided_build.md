# Guided First Build

## Purpose

A blank local agent has nothing to do yet, and a person new to agents does not know what to ask it. The first chat with one is an interview: the agent asks a few questions about the job, proposes how to set it up as a **build brief**, and starts building only when the person says go.

Without it, the first message to a blank agent was a task the agent was not set up for. It either tried the task from an empty workflow prompt or answered as a generic assistant, and both read as the agent not working.

## Core Concepts

- **Unbuilt agent** — a kit agent that is still what the scaffold made: only the scaffold's files in `scripts/` and `skills/` (dotfiles and `__pycache__` ignored), no credential slots, no schedules, and a guided build neither finished nor dismissed. `LocalAgentDto.unbuilt`, computed by the scan. The workflow prompt does not count: a template prompt and an AI-drafted one are both unbuilt, so the [AI draft](agents_tab.md#the-ai-draft) is kept and the interview builds on it. A bare folder, a shared (team or catalog) agent and an agent that could not be read are never unbuilt: the first is the user's own project, the second was built by somebody else, and the third says nothing about its contents.
- **Guided chat** — the first chat with an unbuilt agent, marked once (`chats.guided_build`) and never changed. Its turn header carries the interview's guidance and its agent is offered `build_brief_propose`, both only while the agent is still unbuilt when the turn runs.
- **Guidance offer** — what the new-chat screens show once one unbuilt agent is picked: the example prompts are hidden, the New chat heading asks "What kind of agent will this be?" (the agent page has no heading), and the composer's notice panel gets one accent row, "New agent — this chat starts with guidance, then builds it with you.", with **Skip guidance** at its right. The row has no ×: Skip guidance is the only way to put it away.
- **Build brief** — what the agent ends the interview with: one sentence on the job, the starting build prompt in the person's words, each capability considered (used, maybe or not needed, with a reason), optional skills and credential names, and an effort suggestion. Drawn in the transcript as a card.
- **Guided build done** — a marker kept per agent folder under `userData`, set by **Start building** and **Skip guidance**. It ends the guidance everywhere and makes the agent read as built.

## User Stories / Flows

1. The person picks an unbuilt agent on the New chat screen or its agent page. The example prompts are hidden, the guidance row appears in the composer's notice panel (labelled "Guidance" when it is alone) and the composer's placeholder becomes "Describe what <name> should do for you…".
2. Nothing is offered to click but **Skip guidance**: there are no starters and no capability popover. The person types what the agent is for, or anything, and sends.
3. The first send creates the chat and, in the same step that binds it to the agent, main marks it guided. The agent receives the guidance in its turn header and asks at most one round of up to four questions through its question tool, skipping what the person already said. If the first message is already a task, it says it is not set up for it yet, rewrites it as the job it would be built for, and asks whether to build for that.
4. The agent ends with one call to `build_brief_propose` and stops. The call is drawn as the **Build brief** card: the summary, the starting prompt (editable with **Edit**), the capabilities to set up, those the person may choose to include (a checkbox each) and those not needed, skills and credential names, and a suggested effort with **Apply**. Credentials are named, never asked for in chat; **Add in Credentials** opens the agent's Credentials tab.
5. **Keep talking** returns focus to the chat's composer; a reply makes the agent call the tool again with the revision, and the older card becomes a read-only record.
6. **Start building** opens a **new** chat with the agent whose first message is the starting prompt (as edited) followed by what to set up and what is left for now, then marks the guided build done. That chat is an ordinary chat in building mode, and is not guided.
7. **Skip guidance** on the row marks the guided build done without a chat: the agent reads as built, the row goes (the button reads "Skipping…" until it does, and a failure replaces the sentence), and the heading and example prompts return.

## Business Rules

- **The flag is decided by main, once, at binding.** The renderer only asks. `chatService.update` marks the chat guided when: it was asked, the setting is on, the chat is not guided already and has no message or file, it is a direct chat with exactly one agent and none attached, and that agent, read fresh from its folder, is a kit agent that is unbuilt right now. A new chat is bound by that update, not by `chat:create`, which is why the decision lives there. A chat keeps the flag it was created with; turning the setting off later does not unguide existing chats, but their guidance still ends the moment the agent is built.
- **Guidance lasts exactly as long as the agent is unbuilt.** The turn header section and the tool are each re-checked against the folder on every turn. The chat's own work counts: once it adds a script, a credential slot or a schedule, the next turn has no guidance and no tool. Start building and Skip guidance end it from outside. Any failure to read the agent means no guidance rather than a failed turn.
- **The guidance travels in the turn header, never in the system prompt.** The system prompt must stay chat-independent because Codex pools processes by prompt bytes; a per-chat paragraph there would start one process per guided chat. It is sent on every turn of a guided chat, so it survives resumed sessions.
- **The guidance overrides building mode until the person says go.** [Building mode](engine.md#the-desktop-context-block-and-building-mode) switches an agent to editing on the person's request to change how it works. A guided chat tells the agent not to build and not to edit the folder until the brief is accepted, so a first message such as "check my inbox" is not read as a request to change the agent.
- **Every question goes through the question tool, never plain text.** A guided interview that asked in prose left the person typing answers to what should be a click, and on Codex it could not do otherwise (see the next rule). The guidance says so, and a first message that is a task gets its "I am not set up for that yet" as a question with options, with no reply text before it.
- **An area start is worked into a role.** "Help me with my expenses" or "fix my mailbox" names an area, not a job. The agent works out where the person manages it (the app, service or files), what exactly they want done there, and how (when asked or on a schedule; suggest or act), and names the role in the brief's summary ("An expense assistant that…").
- **The brief holds only what the person said or chose, and it is the plan.** A detail they did not give (a time, a format, an extra feature) is a `maybe` capability or a question, never written into the starting prompt as theirs; the card adds what they include. The agent does not write a plan of its own for approval beside it.
- **Codex asks in Plan collaboration mode while a chat is guided.** Codex answers `request_user_input` "unavailable in Default mode", so in its normal mode a guided interview could only ask in plain text. A guided turn therefore sets the session's mode to Plan. Once that chat's agent is built, each later turn of that chat sets Default again, because a resumed session keeps the mode it was left in; a `/plan` the person types there afterwards lasts one message. A chat that was never guided is left alone, so a person's own `/plan` lasts as Codex means it to. The other engines have no such mode and are untouched.
- **Codex's plan review is declined unseen in a guided turn.** Plan mode ends with Codex's "Implement this plan?" card; approving it would switch to Default and build the agent inside the guided chat, past the brief and Start building. In a guided turn it is answered "revise" without being shown. Outside guided chats the card still asks.
- **OpenCode reads the workshop kit without an ask.** The guidance and the agent's own `AGENTS.md` send it to the kit copy beside the agents (`.cinna-kit`, two folders above the agent). Reading it is allowed, so building does not stop on a permission click per guide (found live: one ask per kit file). Edits there through the file tools still ask, because the copy is managed and a refresh replaces it whole; the shell is not stopped by this. Detail in [Permissions](permissions.md).
- **No secrets in chat.** The guidance forbids asking for a password, token or key; if one is pasted, the agent says so and suggests replacing it. The tool's schema takes credential names only.
- **Capabilities are named by what they give the person in the app** (Credentials tab, Schedules tab, status on the agent, `/run:` commands, skills, handing work to another agent, published dashboards), never by file or manifest field. They follow the workshop kit's capability ladder and its rule against over-engineering: a capability appears only when the answers call for it.
- **The brief tool validates and nothing else.** It does not park the turn and writes nothing; its result tells the agent to stop and wait. A call that fails validation comes back as an error naming the field, and is shown as the plain tool row, not a card. The card is drawn from the persisted tool call, so it survives a reload.
- **Only the latest brief has controls**, and only while no user message follows it and the agent is still unbuilt. Every other brief is a muted record. A stale Start building could otherwise build the same agent twice.
- **The marker is machine-local.** It lives under `userData`, keyed by the folder's real path, never in the folder: it records this person's answer, and a shared agent must not carry it to somebody else. A moved folder asks again.
- **The setting** is **Guide the first build of new agents**, in Settings → Features → AI Functions, default on. Off, a blank agent's first chat starts like any other and the example prompts show. It is read by main when the chat is bound and by the new-chat screen.
- **Nothing moves under the person.** Creating an agent puts it into the folder list and loads the settings before the page opens, so the first paint already shows the offer; while the picked folder agent or the setting is still unknown, the prompt slot is drawn empty at the example prompts' size rather than painting one state and then the other. Guided or not, the slot keeps the prompts' footprint, so Skip guidance bringing them back changes no height. On the main New chat screen the question takes the generic heading's place in the same box, so picking the agent with `@` changes text, not layout.
- **The box being typed in never moves.** On the empty screens the composer is held at the column's middle by two equal halves. The notice panel is drawn out of the flow above the box, and `ChatInput` reports its height so the upper half reserves it: a row coming or going (picking an agent with `@`, Skip guidance, a readiness fix) moves the heading and prompts, never the box, and the panel covers neither (ux_rules rule 1). The send error banner sits just above that reserve.

## What it does not do

- It does not build. Building is the ordinary chat Start building opens, in building mode.
- It does not touch an agent that has anything built, a shared agent or a bare folder.
- It does not run for a coordinated or multi-agent chat, or for a task, schedule or delegation turn: only the chat main of a direct chat with one agent.
- It does not stop Codex's plan review for anyone but a guided turn, and it does not change the mode of a chat that was never guided.
- It does not persist the brief outside the transcript; Start building only carries its text into the new chat's first message.

## Architecture Overview

```
scan -> LocalAgentDto.unbuilt  (guidedBuild.isUnbuiltKitAgent, marker via desktopStateService)
New chat screen -> GUIDED_BUILD_HEADING + useGuidedBuildNotice (composer notice row, placeholder)
first send -> chat:update {guidedBuild: true} -> chatService.update -> decideGuidedChat -> chats.guided_build
every turn -> runExecutionService.turnHeaderFor -> buildTurnHeader + guidedBuildSection   (if still unbuilt)
          -> conductorBridge providers -> BuildBriefToolProvider  (if still unbuilt)
agent calls build_brief_propose -> persisted tool_call -> MessageStream -> BuildBriefCard
Start building -> new unguided chat (composed brief) -> local-agent:mark-guided-build-done
```

## Integration Points

- [Agents Tab & Agent Page](agents_tab.md) — creation flow, the AI draft that stays, and the empty composer the guidance row sits in
- [The Local Engine](engine.md) — building mode, which the guidance holds back until go
- [Codex engine](codex_engine_tech.md) — the collaboration mode a guided chat asks in
- [Permissions](permissions.md) — the OpenCode read allow for the workshop kit
- [Example Prompts](../../chat/example_prompts/example_prompts.md) — hidden while the guidance is offered
- [Ask User Question](../../chat/ask_user_question/ask_user_question.md) — the interview's questions use the agent's question tool
- [Turn completion](../../chat/messaging/turn_completion.md) — the turn header the guidance rides in
- [Settings](../../ui/settings/settings.md) — the Features toggle
- [Agent Task Tools](../../jobs/tasks/agent_task_tools.md) — the `cinna` MCP server the brief tool joins
- [Technical details](guided_build_tech.md)
