# Improvement Request

## Purpose

From a chat, send one frozen copy of a conversation with a cloud bundle agent to whoever publishes that bundle, with a note on what should change. The publisher sees what the agent actually did and can improve the bundle.

## Core Concepts

- **Improvement request** — a snapshot of one cloud session plus the user's message and an optional copy of the agent's MEMORY files. cinna-core owns the snapshot, the recipient, the limits and the review on the publisher's side; see its `agent_improvement_requests` docs in the cinna-core repo (its `agent_improvement_requests` feature folder). The desktop only chooses *which* session and asks.
- **Eligible agent** — a consumer install of a bundle (`isBundleAgent`: a bundle the user did not publish) whose driver authenticates with the account's own Cinna token (`auth: 'cinna'`). A hand-added A2A agent with a typed token is never one: core would not see the user as the session's owner.
- **Core session** — a Cinna agent's session id is the A2A `task_id` the stream returned, kept per (chat, agent) in `a2a_sessions`. Main resolves it; the renderer names only `{chatId, agentId}` and never sees or supplies the id.
- **Pre-flight (context)** — core's answer before sending: who would receive it, how many messages would be captured, whether this session can be sent at all, and how many requests were already sent for it.
- **Own agent** — when the user is also the bundle's publisher, or core can no longer reach the publisher's install, the request is not shared externally: it is saved on the user's own agent as a note for later improvements. Core decides this; the dialog shows whichever it reports.

## User Stories / Flows

1. In a chat with an eligible agent, the user opens composer **[+] → Actions › → Improvement request…**. The row is disabled with the hint *Available once the agent has finished replying* while a turn runs.
2. The dialog opens on the chat's own agent. With more than one eligible agent in the chat, an **Agent session** picker lists them (the chat's own agent first, each with how long ago it last moved); with one, the name is shown as text.
3. The dialog asks core for the pre-flight and says, in one or two lines, where it goes and how many messages are captured as of now. For an external recipient a warning callout names the bundle and installed version and says *This cannot be undone.*
4. The user writes the **Message** (required) and leaves **Include MEMORY files of this agent** ticked or unticks it; its explanation sits behind the (?) beside it.
5. **Send request** closes the dialog and raises a toast: sent to the recipient, or saved on the user's own agent.

## Business Rules

- **Which agents are offered.** Only agents that are still in the chat — the bound one and the attached ones, the set a coordinator's nested calls and autonomous-task delegations draw from — and have a session row. A session row outlives an agent removed from the chat; that agent is not offered. Works for a direct chat, a human-routed chat and a coordinator's nested call, since all three write the session under the chat's own id.
- **Cinna task delegations are not offered.** A task handed to a cloud agent runs sessions that belong to the core task and are never cached in `a2a_sessions`, so there is nothing to send.
- **No eligible agent, no action.** The Actions row (and the [+] menu itself, if nothing else applies) is hidden. The list is read again whenever a turn in the chat ends, because the first reply is what writes the session id.
- **The message is mandatory and capped.** Core makes the comment optional; the desktop asks for one because a snapshot without a reason is hard to act on. Trimmed, at most 4000 characters (core's own limit).
- **Memory consent is never assumed.** The checkbox starts ticked, but main sends memory only on an explicit `true`; a missing field means not included.
- **The snapshot is core's, taken when the request is created.** The dialog says the count is "as it is right now"; continuing the conversation afterwards does not change what was shared.
- **A session that cannot be sent** says why in place of the disclosure (not the owner, not started from the user's account, no messages yet, agent gone, rate limit), keeps the typed message so it carries over to another agent in the picker, and disables Send with *Can’t be sent* beside it.
- **Refusals close nothing.** The dialog is pinned by its top edge, so an error under the buttons only lengthens it downward. Picking another agent clears a refusal that was about the previous one. Another chat coming on screen closes the dialog.
- **A 401 is a lost sign-in; a 403 is not.** A lost session raises the app-wide sign-in prompt; a 403 is core saying the user does not own the session and surfaces as core's own sentence.
- **Every answer is data.** A thrown error code never reaches the renderer, so refusals return as `{ok: false, code, message}`.
- **Not done here:** reviewing, answering or tracking requests on the publisher's side, and sending a session the user does not own.

## Architecture Overview

```
Composer [+] -> Actions -> Improvement request…
   ChatInput -> useImprovementTargets -> improvement:targets  (no network: a2a_sessions ∩ chat's agents)
   ImprovementRequestDialog -> improvement:context -> GET  core /sessions/{task_id}/improvement-context
                            -> improvement:create  -> POST core /improvement-requests
   success -> toast, dialog closed by the composer-owned mutation
```

## Integration Points

- [Composer `[+]` Menu](../composer_menu/composer_menu.md) — hosts the **Actions** sub-menu and its row.
- [Remote Agents](../../agents/remote_agents/remote_agents.md) — what a bundle install is (`isBundleAgent`) and how a Cinna agent's session is kept.
- [Chat Routing](../chat_routing/chat_routing.md) and [Orchestrated Agents](../orchestrated_agents/orchestrated_agents.md) — which agents are in a chat, and the nested calls that write sessions under the chat's id.
- [Technical details](improvement_requests_tech.md)
