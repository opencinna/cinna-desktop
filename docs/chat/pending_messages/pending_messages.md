# Pending Messages — Sending While a Turn Runs

## Purpose

A message typed while an agent or model is still answering is neither refused nor lost. Where the running engine can take it, it goes into the turn now; otherwise it waits, visibly, and is sent when the turn ends. A long agent turn — dozens of tool calls and thinking blocks — used to leave the composer offering only Stop, so the user could neither correct the agent nor line up the next instruction until it finished.

## Core Concepts

- **Pending message** — any message sent into a chat whose turn is still running. Main decides what becomes of it; the renderer only learns which outcome it was.
- **Steered message** — a pending message the running engine took into its turn, over the ACP steering extension. It appears in the live output where it landed and is saved there: the turn's assistant output is split into the part before it and the part after.
- **Queued message** — a pending message held in main until the turn ends. Shown as a user bubble below the live turn with a small badge tab under its lower edge.
- **Drain** — sending what is queued once the chat is idle: the leading run of consecutive messages for the same agent, joined with blank lines into one new turn.
- **Held queue** — a queue that must not drain, because the turn before it did not finish or its own start was refused. Its text goes back into the composer.
- **Answerer at queue time** — which agent a queued message is for is resolved when it is queued, never when it drains.

## User Stories / Flows

### Correcting an agent mid-turn

1. A folder agent on Claude Code is working. The composer placeholder reads "Send a follow-up · Esc Esc to stop".
2. The user types "use the staging config instead" and presses Enter. The input clears and the transcript re-pins to the bottom.
3. The engine takes the message. A user bubble appears in the live output after what the agent had streamed so far, and the agent's next words start below it — in compact mode it also splits the run of tool dots in two.
4. When the turn ends the saved transcript has the same order: assistant row, user row, assistant row.

### Lining up the next instruction

1. The running turn cannot take messages — a remote A2A agent, a model chat, a Managed agent, an agent whose engine does not advertise steering, or a message addressed to a different agent than the one answering.
2. Sending shows the message as a user bubble below the live turn with a **Queued** tab. More messages can be queued; each gets its own bubble.
3. The turn completes, or ends waiting for the user's input. The tab slides up under its bubble, the bubble and the ended turn's output stay where they are, and the queued messages start as one new turn. The saved rows replace them in the same render, with no second entry animation. The sidebar shows the chat running from the moment that turn starts.

### Cancelling or editing a queued message

1. The tab's [x] sits on a small chip beside its label. Hovering or focusing it turns the label into a red **Cancel?**; clicking removes the message, whose bubble fades and closes together with the gap above it.
2. ArrowUp in an empty composer walks back through the user's own messages in this chat, newest first, so queued ones come first. Recalling a queued message enters edit mode: the composer's Stop becomes a check-mark **Save**, the bubble's tab reads **Editing**, Enter or Save replaces the queued text, and Esc leaves edit mode and empties the input. In a recalled message of several lines the arrows move the caret; ArrowUp steps on only from the first line, ArrowDown only from the last.
3. Recalling a message that was already delivered just fills the input; sending it sends a new message.
4. If the message being edited leaves the queue before the edit is saved, edit mode ends and the edited text stays in the composer. What else happens depends on why it left:
   - The user cancelled it from its bubble's [x]: nothing else. The text is an ordinary draft.
   - A stop or a failed turn held the queue: the held messages come back into the composer in queue order, the edited one as edited. No notice.
   - Main sent it first — it drained before Save, or Save found it already gone: the composer says "Sent before your edit was saved — your edit is still here." The sentence goes with the next successful send or Save, when the input is emptied, or when a later edit is left with Esc.

### Stopping with messages queued

1. The user presses Stop, or Esc Esc, with two messages queued.
2. The turn ends canceled. The queue is held, and its bubbles leave the transcript.
3. Their text is appended to the composer after anything typed since, separated by blank lines, with the caret at the end. Nothing is sent until the user sends it.
4. If one of them was being edited, the input held that edit: the composer then holds the queued texts in order, with the edit in place of the message it rewrote.

## Business Rules

### Where a message goes

- **Main owns the queue**, per profile and chat, for the reason it owns the turn: the view that queued a message may be gone when the turn ends — another chat opened, the renderer reloaded. A queue kept in the composer would drain into nothing.
- **The queue is memory only.** A queued message is a moment's intent. A restart that replayed it into a chat the user has since moved on from would be worse than losing it, so there is no table and no recovery.
- **Steer only into the turn the message is for.** The running turn must be an agent turn, its agent must be the one routing would send this message to, and its driver must currently be offering mid-turn delivery. A message for another agent in a `human` chat, and every message during a model or coordinator turn, is queued.
- **Never steer past the queue.** When anything is already queued in the chat, a new message queues behind it even if the turn could take it. Otherwise a later message would reach the agent before an earlier one.
- **Who answers is settled at queue time.** An unaddressed message in a `human` chat follows the last addressed one; by the time it drains, that can be a message queued after it, which would silently re-point it at somebody else.
- **A drain is one turn per agent run.** Consecutive messages for the same agent are joined with blank lines and sent as one message; a message for a different agent waits for that turn to end and drains next. Splitting would cost a full turn per line; merging across agents would hand one agent another's instructions.
- **Only a finished turn drains.** `completed` and `needs_input` drain; `canceled`, `failed` and `budget` hold. Sending the next message into a conversation that just stopped — most of all one the user just stopped — carries forward work nobody asked to continue. Returning the text to the input is also what Claude Code does on an interrupt.
- **A refused drain holds too.** If the drained start throws — the profile changed, a task runner took the chat — the messages go back to the head of the queue and it is held, so the user finds them in the composer rather than behind a queue that silently never sends.
- **Text only.** Files and notes are refused while a turn runs ("Files can be sent once the current turn finishes.") and stay in the draft for a turn of their own. A steered message has no attachment channel, and a queued file would need its ingest scope decided long after the send.
- **Chats something else drives are never queued into.** A chat a task runner owns (autonomous or script), one being handed off, or one with an unresolved handoff receipt goes straight to the ordinary start, which refuses it in its own words.
- **The queue goes with its chat.** Moving a chat to the Trash, deleting it — directly or with its job run — and removing a profile drop its queue. Deleting a running chat is refused, so what would remain is a held queue nothing can reach.

### A steered message

- **It is taken only while the prompt is in flight.** The window opens once the turn's prompt is on the wire and closes, before anything awaits, when the prompt settles or a stop is asked for. A message offered after that is queued for the next turn instead of landing in a turn whose result has already been read. See [The Agent Turn](../../agents/local_agents/agent_turn.md#a-message-sent-mid-turn-is-taken-only-while-the-prompt-is-in-flight).
- **It is the user's, whatever becomes of the turn.** A failed turn still saves each steered message as a user row before its error. A message the engine confirms only after the turn stopped waiting is saved by main as a row of its own, and the send reports that it was saved, so the view re-reads the chat — nothing else would show it.
- **Codex's orphan turn is cancelled.** Codex ignores the request not to start a turn: asked to steer a turn that had already ended underneath, it starts one of its own that nobody is reading. The desktop cancels it and retires the process — unless, by then, another turn holds that process, in which case it is left running and logged rather than killed under that turn — and the message is queued. See [The Codex Engine](../../agents/local_agents/codex_engine.md).
- **Which engines steer is their own answer.** Any ACP agent that advertises the extension at initialize is offered messages — the pinned Claude Code and Codex adapters do. OpenCode, remote A2A agents, Managed agents and model chats have no mid-turn delivery and always queue.

### The composer while a turn runs

- **One button, in one place.** While a turn runs, the rightmost button is Stop on an empty input. It becomes a blue Send once there is text, or Save while a queued message is being edited, and emptying the input brings Stop back. It stays Stop while the answering agent is refused on readiness, whatever is typed: a disabled Send in its place would leave the keyboard as the only way to stop the turn. That holds for a [`/run:<name>` catalog command](../../agents/local_agents/commands.md) too, which gets through a refusal and still sends with Enter; a button that followed what was typed flipped between Stop and Send on each keystroke of `/run:build`. Stop and Send are the same size in the same place, so typing swaps the button without reflowing the row ([UX rule 1](../../development/ui_guidelines/ux_rules.md#1-nothing-jumps-while-the-user-is-acting)). Blue marks a send that joins the running turn or its queue; green is kept for an idle chat. Esc Esc stops the turn whichever button shows, except while a queued message is being edited, where Esc leaves the edit instead. The new-chat composer keeps Stop alone while it streams, because a pending message needs an existing chat. This layout was the user's choice: a Send slot held invisible to the right of Stop read as a gap in the row.
- **Stop ignores clicks for half a second after a click on Send.** Clicking Send empties the input, so the button under the pointer turns into Stop. Without the pause, the second click of a double-click on Send would stop the turn that click had just started or joined. Only a click on Send can be the first half of that double-click, so a Stop that appears any other way — a turn started with Enter, a queued message draining, a switch to a running chat — takes a click at once, and Esc Esc is never delayed. Clicking Send also puts focus back in the input, so focus is never left on the button that has just become Stop.
- **A turn ending turns Stop into the idle Send.** With nothing to send, or with readiness refusing the send, that Send is disabled, so a click aimed at Stop as the turn ends does nothing. Files or notes left in the draft make it enabled, and that click sends them.
- **No optimistic bubble for a pending send.** The optimistic bubble renders above the live turn and retires by user-row count, so it would sit in the wrong place until the turn ended. The live `user_message` event or the queue shows the message instead. A view that believed a turn was running, and whose send started one after all, shows the ordinary optimistic bubble.
- **Every send re-pins the transcript**, whatever main did with the message: the user just acted, and what they acted on is at the bottom. See [Transcript Scrolling](../conversation_ui/scroll_following.md).

### Editing a queued message

- **Edit mode ends the moment its message leaves the queue**, because there is nothing left for Save to replace. The text stays whatever the reason: an error closes nothing, and what the user typed is not discarded by something they did not do ([UX rule 6](../../development/ui_guidelines/ux_rules.md#6-errors-close-nothing-and-land-where-the-action-was-taken)).
- **Only a message main sent first gets a sentence.** A cancel from the bubble and a stop are the user's own acts, and a notice would describe what they just did. When main sent the message first, what went out is not what the composer holds, and nothing on screen says so. From the queue alone a cancel and a send look the same — the message is gone — so the composer remembers which messages were cancelled from their bubbles.
- **A cancel main answers too late is not a cancel.** The bubble fades on click, but its message counts as cancelled only once main confirms the removal. If main had already sent it, the bubble comes back as sent and hands over to its row, and the composer says "Already sent — it couldn't be cancelled." A silent fade followed by the saved row let the user believe the message was withdrawn when the agent had it.
- **The notice goes when the text it speaks of does:** the next successful send or Save, an emptied input, or Esc out of a later edit. It clears only itself, never another error in the same place.
- **A held edit takes the original's place.** Edit mode ends before the held texts are taken back, because the queue the take empties would otherwise read as main having sent the message, and the edit is swapped in for that message's text. Appending the held texts after the edit, as after any draft, would put the message in the composer twice: once rewritten, once as queued. An edit emptied to nothing was never savable, so the original stands.
- **A recall belongs to its chat.** Switching chats ends edit mode and clears the notice. The recalled message is queued in the chat that was left; read against another chat's queue it would be missing, and the composer would report it sent.

### The queued bubble

- **The tab never resizes.** Queued, Cancel? and Editing share one cell sized by the longest label, so the [x] does not slide out from under the pointer as its label changes.
- **The [x] is a chip at rest.** It has a background of its own before any hover, so it reads as a control beside the label rather than as part of its text ([UX rule 11](../../development/ui_guidelines/ux_rules.md#11-a-control-must-look-like-a-control-not-like-the-text-beside-it)).
- **A cancel closes the gap above the bubble along with the bubble.** The transcript's spacing above the row collapses with it. Collapsing the bubble alone left that 12 px gap behind to snap shut when the row unmounted ([UX rule 1](../../development/ui_guidelines/ux_rules.md#1-nothing-jumps-while-the-user-is-acting)).
- **On a drain the tab goes and the bubble stays** until the saved row renders, and the swap is a single render. A frame with neither read as the message vanishing. When a drained start is refused, main puts the messages back as a held queue with the same IDs; a sent bubble whose message is back in a held queue is dropped at once, so it does not stand in for a message that is now in the composer. Any other bubble whose row never appears stops standing in after 15 s.
- **A sent bubble retires on its own row, not on its words.** When a message leaves the queue as sent it counts the saved user rows with its text, plus the messages with that text the ended turn took in and saves with its rows; it retires once the saved rows with that text outnumber that count. Retiring on text alone let an earlier row with the same words — a steered "yes" — retire a drained "yes" before its own row existed.
- **A drain keeps the ended turn on screen.** The new turn is not shown until the ended turn's saved rows have been read, or for at most 2 s, so its live output and those rows swap in one render. Showing the new turn at once cleared the live output a round trip early: whenever a queue drained, the ended turn's output vanished and the transcript collapsed to the top of the chat for a few frames. What remains is the settle of any turn end, plus one swap when several queued bubbles become one merged row. See [Live Run Attachment and Replay](../messaging/live_runs.md).
- **Loading dots go below a sent bubble**, where they will be once its row takes its place.
- **A held queue is not shown.** Its text is already in the composer, and two copies would be two things to act on.

## What this deliberately does not do

- **No persistence** — see above.
- **No mid-turn files or notes.**
- **No reordering and no "send now".** A queued message cannot be moved ahead or forced into a turn that does not take messages; Stop, then send, is that action.
- **No steering into a remote A2A agent.** The A2A driver offers no mid-turn delivery, so a message for a cinna-core agent always queues rather than opening a second stream beside the one running.
- **No steering for a nested agent** called as a tool: the message would go to the coordinator's turn, which is a model turn.

## Architecture Overview

```
ChatInput (turn running) -> useChatStream.startRun -> run:start
  -> runQueueService.submit
       idle chat, runner-owned chat, handoff    -> runExecutionService.start          -> started
       for the running agent, nothing queued     -> RunHandle.steer -> ACP _session/steering
            injected    -> RunEvent user_message -> live hub -> bubble where it landed
                           turn end: saved between the assistant rows          -> injected
            late        -> main saves the user row                             -> injected, saved
            unavailable -> queue
       otherwise -> queue item -> run:queue-changed -> useRunQueue -> QueuedMessages  -> queued
  RunHandle.completed
       completed / needs_input  -> drain the leading same-agent run -> runExecutionService.start
       canceled / failed / budget -> held -> ChatInput run:queue-take -> composer text
```

## Integration Points

- [Technical Details](pending_messages_tech.md) — services, IPC, renderer state and tests
- [Messaging](../messaging/messaging.md) and [Live Run Attachment and Replay](../messaging/live_runs.md) — the send command and the watch that carries `user_message`
- [Turn Outcomes](../messaging/turn_completion.md) — the outcome states that drain or hold
- [Chat Routing](../chat_routing/chat_routing.md) — the answerer a message is queued for
- [The Agent Turn](../../agents/local_agents/agent_turn.md), [The ACP Engine Contract](../../agents/local_agents/acp_contract.md), [The Claude Engine](../../agents/local_agents/claude_engine.md), [The Codex Engine](../../agents/local_agents/codex_engine.md) — the steering window and what each adapter does with it
- [Conversation UI](../conversation_ui/conversation_ui.md) — the bubbles and the composer row; [Keyboard Shortcuts](../../ui/keyboard_shortcuts/keyboard_shortcuts.md) — Esc Esc, history and edit keys
- [Tasks](../../jobs/tasks/tasks.md) and [Autonomous Tasks](../../jobs/tasks/autonomous_tasks.md) — the runner-owned chats a queue never enters
