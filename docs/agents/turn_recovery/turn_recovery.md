# Interrupted Turn Recovery

## Purpose

A direct-chat agent turn that the app was quit, force-quit or crashed under is never lost without a word. On the next launch the chat shows how the turn really ended when the agent kept working without the desktop (a Cinna A2A agent, a Claude Managed session). Otherwise it says the app closed before the turn finished, so the user knows to send the message again.

## Core Concepts

- **In-flight marker**: a durable row (`inflight_turns`) that says "this chat has an agent turn running". It is written when a direct-chat turn starts and deleted on every ending. A marker found at launch is a turn the app was closed under, because nothing else leaves one behind.
- **Draft row**: one assistant row that a running turn rewrites with what it has streamed so far. A crash or `SIGKILL` skips every quit handler, and the draft is what is left of the turn then.
- **Quit flush**: what `will-quit` saves before it kills agent processes (see [the streaming pipeline](../agents/streaming_pipeline.md#what-a-direct-turn-keeps-when-it-never-returns)). It covers a normal quit. The draft row covers a kill.
- **Boot pass**: runs at launch and settles every marker that no agent can explain. It adds the interrupted error row, records the turn as failed and clears the marker.
- **Recoverer**: the per-driver half of relaunch recovery, which asks a remote agent how a turn ended. Only `a2a` and `managed` have one. A local ACP turn died with its process, so nothing is left to ask.
- **Adopted run**: a recovered turn shown as the chat's running turn, with the sidebar spinner, the live view, Stop and a queue for messages sent meanwhile, even though the user sent nothing.
- **Deferred marker**: a marker left for later because the agent could not be asked yet (no network, or the session needs a sign-in). Nothing is shown for it.
- **Superseded turn**: a killed turn whose chat has moved on, because a later user message follows it. It still gets its rows and its notice. Its sidebar result, job run and task now belong to the later turn.
- **Client message id**: the id of the user's message row, sent as the A2A `messageId`. The Cinna backend echoes it on that message in `tasks/get` history as `cinna.client_message_id`, which is how the desktop finds its turn there.

## User Stories / Flows

### A local agent's turn is cut off
1. The user quits, or the app crashes, while a folder or command-line agent is answering
2. What streamed is kept: the quit flush saves it on a normal quit, and the draft row holds it after a kill
3. On the next launch the turn ends with the error row *"The app closed before this turn finished. Send your message again to retry."*. The sidebar shows a failed result, and a job run the chat belongs to is failed with the same reason
4. The next message resumes the agent's session (see [the agent turn](../local_agents/agent_turn.md#quitting-the-app-mid-turn))

### A Cinna agent kept working while the app was closed
1. The app is killed while a Cinna A2A agent is streaming
2. On the next launch, once the profile is signed in and activated, the chat shows as running again: a spinner in the sidebar, the composer's Stop button, and *"Still running on the agent. The reply will appear here when it finishes."* while the agent is still working. What the kill left stays in view above that line
3. When the agent finishes, the rows the kill left are replaced by the agent's own full record of the turn, and the sidebar result and job run record the real ending. A turn that ended by asking a question opens that question as a next-message ask, and the Inbox shows the agent's real question with its options
4. A turn that had already finished while the app was closed is written at once, without the running line
5. When the backend itself crashed and kept less than the desktop had shown, the rows the kill left stay, with *"The agent's reply was cut off before it finished. Send your message again to retry."* under them (see [which copy is kept](#which-copy-of-a-reply-is-kept))

### The message never reached the agent
1. The app is killed after the session was known but before the agent recorded the new message
2. On relaunch the agent's history has no message with that id, so the desktop sends the same message again, with the same id, on the same task. The user row is not duplicated. The answer streams into the chat like any turn

### An older Cinna backend, or another A2A server
1. The same kill against a backend that does not report turns in `tasks/get`
2. The turn ends with the interrupted error row, exactly like a local agent's. Nothing is polled and nothing is sent again

### The agent cannot be reached yet
1. The app launches offline, the agent's server answers with a gateway or overload error (408, 429 or 5xx), or the Cinna session needs a sign-in
2. Nothing is shown. The rows saved at quit stay as they are, and the marker waits
3. The turn is tried again every two minutes while that profile is active (network only), when the machine wakes, after a re-auth and at the next launch
4. A turn whose agent is still unreachable 24 hours after it started ends with the interrupted error row. A turn waiting for a sign-in keeps waiting

### A Managed (Claude) turn
1. The app is killed while a Managed session is working
2. On relaunch the desktop follows the same session from the message it had sent. Output streams into the chat, a permission the turn is waiting on is offered again, and Stop interrupts the remote session
3. The desktop never sends the message a second time

### Stop, and messages sent during recovery
- Stop on a recovered A2A turn sends `tasks/cancel`, reads the task once more, and keeps the better of what the agent has and what the kill left. Stop on a recovered Managed turn interrupts the session the way a live Stop does
- A message sent while a recovered turn is running waits in the chat's queue behind it, as it would behind any turn

### A stream that drops while the app is running
1. A Cinna agent's stream closes without a final event, the connection drops mid-turn, or the backend or its proxy goes away and answers with nothing or a 408, 429 or 5xx
2. Instead of reporting the drop, the desktop keeps the turn running and shows *"Still running on the agent. The reply will appear here when it finishes."* under what streamed while it polls `tasks/get`. The line is live only and is never saved
3. Polling rides out an agent that cannot be reached, even when the very first read fails, for up to ten minutes. After that, the stream's own ending stands: a drop's error goes under what streamed
4. When the turn ends, the agent's record is saved, or what streamed is kept (see [which copy is kept](#which-copy-of-a-reply-is-kept)). A backend that has the message but lost the reply ends the turn with the cut-off card, even when nothing had streamed
5. A Cinna session that needs a sign-in while the turn is polled ends the turn with the usual re-auth prompt
6. An agent not synced from the Cinna account (a hand-added one, even on a Cinna backend) gets no such patience before its first answer. A server that fails that first `tasks/get`, or answers it with a 408, 429 or 5xx, keeps the drop's ending, so a third-party server never holds a turn open for minutes

### Stop on a live A2A turn
1. The user presses Stop. The desktop sends `tasks/cancel` and waits at most half a second for its answer
2. An answer that reports the task `canceled` or `completed` confirms the stop. An older backend answers with no state at all, so the desktop reads the task once, within one more second, and only `canceled` counts there
3. A confirmed stop saves the task's new state on the session and shows no notice. Otherwise the turn gets *"Stopped waiting locally. The remote agent's stop was not confirmed; check its task before starting more work."*. Reading only the cancel's answer showed that notice after every stop on an older backend, including stops that had worked

## Business Rules

### What gets a marker
- **Every direct-chat agent turn, whatever its driver**: A2A, Managed, folder and command-line ACP, and `/run:` commands, which use the same wrapper
- **Not a turn a task runner owns** (coordinator, script, autonomous tasks). The runtime's own checkpoint is that record, and its `recover()` owns what a kill left
- **Not an agent a coordinator calls as a tool.** It has no wrapper, so it has neither a marker nor a flush
- **Not a resend made by recovery.** The turn being recovered keeps its own marker until it is settled
- **A marker write that fails never fails the turn.** It is logged, and the turn is left without crash recovery
- **A marker this process opened is never settled by this process.** The boot pass and the recovery service both skip markers for turns that are running now, because a marker means "closed under" only once its process is gone

### The draft row
- **Rewritten at most every two seconds, and only when something changed.** An ask opening is written at once, because a turn parked on the user may sit there until the app is closed
- **Parts only.** Notices and steered user messages are saved with the turn's real rows. A user row written mid-turn would show twice beside the live view
- **Dropped in the same transaction as every save of the turn's real rows**, so the transcript never holds both, or neither, and the persist cursor never counts the draft
- **Only for a turn with a marker.** Nothing at launch would ever settle a runner turn's draft
- **Bounded.** A draft of more than about 256 KB is rewritten at most every ten seconds, and one above 4 MB is not written at all. The size is estimated from string lengths and serialised only when the estimate could pass the cap: rewriting and measuring a very large row every two seconds would cost more than the draft protects

### The chat list does not move
- The quit flush, a recovered turn's rows, a resend and the interrupted notice all leave the chat's place in the sidebar alone. At the next launch the list reads as the user left it, not with every running chat moved to the top, and a recovery that lands while the user is pointing at the list does not reorder it under the pointer

### The boot pass
- **Runs after the database, the session and the task runtimes' own recovery.** Task writes need this device's id, and a job run can be judged ownerless only once the runtimes have re-reserved what they own
- **A marker whose driver has a recoverer is left to relaunch recovery.** Every other marker is settled at once
- **The turn is recorded the way a live turn's close records it.** That is the sidebar result, the job run and the task a hand-opened chat owns. A turn left waiting on an answerable next-message ask keeps its task and job run and reads as waiting: the ask is still the way on
- **A superseded turn records nothing.** Its notice goes directly under its own rows instead of at the chat's end, above the conversation that followed
- **Orphaned job runs are swept too.** A kill from before turns had markers could leave a plain chat-turn job run `running` for good. Such a run is failed with *"The app closed before this run finished."*, but only when nothing still owns it. These runs are skipped: coordinator and script runs, `cinna_task` runs, a run whose chat has a marker, an active run, a runner, a next-message ask, a task that runs elsewhere and an unresolved handoff
- **Each marker and each run fails on its own**, so one broken row does not stop the pass

### Relaunch recovery (A2A)
- **The session ids are saved from the first stream event that carries a task id**, not when the turn ends. On Cinna the task id is the session. A first turn killed mid-stream would otherwise leave no session, and the next message would start a new conversation with no memory of this one
- **No task id means interrupted.** A turn killed before its first event cannot be looked up. Sending its first message again without a task id would not be deduplicated and would open a second session
- **The backend has to prove it can answer.** The first `tasks/get` must carry a `cinna.client_message_id` or `cinna.message_state` key in its history. Without either, the backend predates the contract, and a turn on it would read `working` for ever. That turn is settled as interrupted
- **The task is not the turn.** One task holds every turn of the session. A turn is over when the task stops working, or when a later user message follows it and the turn's last agent message is no longer `streaming`. The turn's state comes from that message's `cinna.message_state` (`canceled`, `aborted`), otherwise it is `completed` when a later turn followed, otherwise it is the task's state
- **A cut-off reply is a failure.** `aborted` ends with *"The agent's reply was cut off before it finished. Send your message again to retry."*. A failed or rejected task ends with *"The agent reported that its task failed. Send your message again to retry."*. Only one error card is shown per turn
- **A resend happens only when all of these hold:** the message is not in the history, the history came back shorter than the 50 messages asked for (a full page may simply have cut it off), the turn has no rows (a draft or a flush proves the message arrived), and no later user message follows it. Otherwise the turn is interrupted. A resend placed below a later message would put the answer above its question
- **Each poll resolves the access token again**, and a refused poll is retried once with a fresh token. A second refusal defers a synced Cinna agent's turn until the next sign-in, and settles any other agent's turn as interrupted, as the first read does: a token the user typed will not renew itself. Drops and 408/429/5xx answers that outlast the poll's patience defer the turn after all
- **The endpoint, the token, the card and the first read share a 30-second bound.** A server that hangs is a server that cannot be reached now, and it defers without showing anything
- **A 408, 429 or 5xx means "not now".** From the card or from `tasks/get`, it defers the turn as a dropped connection does. A live turn of a synced Cinna agent reads it the same way and keeps polling. Any other agent's live turn keeps the ending its stream had
- **Rows stay in view while an A2A turn is polled.** Nothing is replayed, so the rows the kill left stay above the running line until the agent's record replaces them, or until the turn settles with them kept
- **A settled turn saves the task's state on the session**, as a live turn's end does, unless the chat has moved on past it: the later turn owns that state then

### Which copy of a reply is kept
The same rules decide between the agent's record and the local copy, which is what streamed in a live turn or what the kill left at relaunch. They apply when a live turn is collected, when a killed turn is recovered, and when Stop ends a recovered turn.
- **A reply that ended normally wins.** A turn that ended with an answer or a question replaces the local copy with the agent's record, which is complete
- **A cut-off reply wins only if it is at least as rich.** A turn that ended any other way (`aborted`, `canceled`, `failed`, …), or whose last agent message is still `streaming`, may hold only what the backend flushed before it died. The local copy stays when it has more: the longer total text wins, then the larger part count, and a tie goes to the agent's record. The turn still takes the agent's state, and its ending (the cut-off card, or the task's failure) goes under the kept rows. A backend that crashed mid-turn used to replace a long streamed answer with its last flush
- **No reply never wins.** When the agent's record has the message and nothing after it, whatever streamed stays. The turn ends as cut off, even with nothing to keep, unless it ended as a stop or an ask, or a later message followed and the agent answered after it (one reply may cover both). That is how a backend whose crash repair closed the turn as `completed` is noticed: without this, the turn ended silently with no reply
- **A question is shown once.** The Cinna backend ends a question turn with an `input-required` status that repeats the question tool part it already streamed. The repeated part is recognised and skipped, and the question the ask opens is built from that tool part, so the Inbox shows the agent's questions, headers and options rather than *"What should the agent do next?"*

### Relaunch recovery (Managed)
- **Followed only from an acknowledged kickoff that belongs to this turn.** The session checkpoint must be `inflight` and carry the kickoff event id stored for this same user row. A kill before the send was acknowledged, or a kickoff an earlier turn left behind, means interrupted
- **Never sent again.** Whether the message reached the session is unknown, and a second copy would be a second turn
- **A confirmation sent just before the kill counts as an answer** even though it is still queued, so the same permission is not asked twice
- **A session that cannot be reached, or that refuses the credential, defers the turn**, whether at the 30-second probe or partway through the follow. The session is left running and its checkpoint untouched. A session that answered but could not be followed saves `uncertain`. Once the history has shown this turn's message, that failure also interrupts the session, as a live turn's does. Before that, nothing is interrupted
- **A replayed turn hides what the kill left.** The follow streams the turn again from its message, so the rows the kill left are hidden from the live view until they are replaced

### Defer and retry
- **A deferred marker shows nothing and saves nothing.** When a defer comes after the turn was already shown as running (the network went away mid-poll), the run ends without an outcome, and messages queued behind it are held as they are after a stop, not sent past a turn nobody settled. A permission ask the follow had offered is expired, and the task no longer reads as waiting on it
- **Unreachable for 24 hours means interrupted.** A pass that finds the agent unreachable for a turn that started more than 24 hours ago settles it with the interrupted row. A turn waiting for its credentials is not given up on. Recovery is not limited to Cinna-synced agents: a hand-added agent on a Cinna backend recovers too
- **Retry triggers**: the profile's activation, a re-auth that stored fresh Cinna tokens for the active profile, wake from sleep, and, for `network` only, one timer per profile, set two minutes after the first marker it defers. The main process has no "back online" event, so the timer is how a returning network is noticed
- **A marker belongs to its profile.** It is recovered only while that profile is the active one, and waits otherwise
- **One chat at a time.** Markers of one chat recover in order, and a recovery waits behind any turn the user started since the launch

### Behaviour on a backend without the contract
Everything above that reads `tasks/get` is gated on the history keys. Against an older Cinna backend or another A2A server:
- A killed turn ends with the interrupted row, as a local agent's does
- A stream that closes without `final`, or drops, keeps its current outcome: the streamed parts above the error row
- Session ids are still saved from the first event, so the next message still continues the conversation

### What this feature does not do
- **It does not restart a local agent's turn.** The process died with the app
- **It does not persist the pending-message queue** (see [pending messages](../../chat/pending_messages/pending_messages.md))
- **It does not replay the live view across a restart.** A recovered A2A turn's live view starts from the transcript as the kill left it, with the running line under it. A Managed turn is replayed by its follow, so its live view starts without the rows the kill left. Either way, those rows are replaced by the agent's record unless the rules above keep them
- **It does not add an IPC channel.** The renderer sees an adopted run exactly as it sees any running turn

## Architecture Overview

```
Turn starts → streamToAgent: open marker → draft row every 2 s → real rows replace draft → delete marker
Quit        → will-quit: saveInFlight (rows only, marker stays)
Kill        → nothing runs; marker + draft stay

Launch → taskRuntimeService.recover()
       → interruptedTurnService.finalizeLeftovers()
           marker without recoverer → error row + turn result, marker deleted
           orphaned chat-turn job runs → failed
       → profile activation / re-auth / wake / 2-min timer
           → remoteTurnRecoveryService.resume(profile)
               → recoverer.plan(marker)  (A2A: card + tasks/get · Managed: session probe)
                   defer → marker stays
                   interrupted → finalizeInterrupted
                   recover → runExecutionService.adopt → recover(io)
                       collected → replaceTurnRows (or keepRows + card) → session state → turn result
                       resent → io.resend → normal send path, same messageId
                       kept / interrupted / defer
```

## Integration Points

- [A2A Streaming Pipeline](../agents/streaming_pipeline.md): early session save, collection from `tasks/get`, the quit flush and the draft row
- [Managed Agents](../managed_agents/managed_agents.md): kickoff checkpoint, follow, session admission
- [The Agent Turn](../local_agents/agent_turn.md): what a quit or kill leaves of an ACP turn
- [Turn Outcomes](../../chat/messaging/turn_completion.md): `recordTurnResult`, shared by the live close and the boot pass
- [Live Runs](../../chat/messaging/live_runs.md): an adopted run uses the same hub and baseline filter
- [Sidebar Session Status](../../chat/session_status/session_status.md): spinner and result for a recovered turn
- [Inbox](../../jobs/tasks/inbox.md): next-message asks opened by a recovered turn; boot expiry of reply asks
- [Jobs](../../jobs/jobs/jobs.md): job runs finalized by the boot pass
- [Technical details](turn_recovery_tech.md)
