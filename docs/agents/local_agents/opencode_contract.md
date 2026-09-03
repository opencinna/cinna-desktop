# The OpenCode Engine Contract — what is verified, how, and under what conditions

**Status:** verified against the real binary on **3 September 2026**, `opencode` **1.18.27**,
`darwin-arm64`. Two probe rounds: the first without a model credential (protocol and transport), the
second with a live OpenAI credential (real turns, real tools, real permissions).

This document exists because **the engine contract is the one part of Local Agents that our tests
cannot check.** Every test in `src/main/services/agentTurn/**` and `src/main/engine/**` runs against
a fake at the HTTP boundary. A fake built from the OpenAPI document is faithful to the *document* —
and the document declares at least one endpoint that does not exist and omits nothing about an event
that is never emitted. So a wrong assumption here passes the entire suite and fails in the app.

**Governing rule: an assumption about the engine is unverified until someone has watched the binary
do it.** This file records exactly what has been watched, what has not, and what was believed and
turned out to be false. Rows marked *assumed* are not weaker tests — they are **untested**.

Companion documents: [The Local Engine, Runtimes & Prompt Assembly](engine.md) (what the desktop
builds around this contract) and [Technical Details](engine_tech.md).

---

## 1. Conditions — what was run

Reproduce with these exact conditions or the results do not transfer.

| | |
|---|---|
| Version | `1.18.27` (`opencode --version`), the value pinned in `src/shared/engine.ts` `PINNED_ENGINE_VERSION` |
| Platform | `darwin-arm64` |
| Asset | `opencode-darwin-arm64.zip` from `https://github.com/anomalyco/opencode/releases/download/v1.18.27/…` |
| SHA-256 | `149b0c6d272d0059b8b5ffcd18c84b24f1d6cbf585942b10e60c601211992eb1` — matched byte for byte, twice, on separate downloads. This is the digest recorded in `src/main/engine/binaryResolver.ts` |
| Extraction | `tar -xf` on the `.zip`; the `opencode` binary sits at the **archive root** |
| Launch | `opencode serve --port <N> --hostname 127.0.0.1`, with `OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD` and `OPENCODE_CONFIG` in the environment |
| Model | `openai` / `gpt-4o-mini`, a real service-account key, supplied to the config as `{env:OPENAI_API_KEY}` |
| Agent | one config-defined agent, addressed as `POST /api/session {"agent": "<key>"}` |

The OpenAPI document is served at **`GET /doc`** — 162 paths, OpenAPI 3.1.0. (`/openapi.json`,
`/api/doc` and `/spec` all return a ~2.8 KB SPA fallback, not the spec.) A saved copy is worth
keeping beside any future probe; it is the only machine-readable description of the surface.

**There are two parallel API surfaces** — `/api/*` and a bare legacy one (`/session`, `/permission`,
`/question`, `/event`). Use `/api/*`. Do not mix them: they differ in behaviour, not just in path
(see §3, heartbeats).

---

## 2. Verified — watched, not inferred

### Transport and process

| Behaviour | Evidence |
|---|---|
| `serve --port N --hostname 127.0.0.1` | both flags exist and are spelled exactly so; `--help` confirms `--port` default is **`0`** and `--hostname` default is `127.0.0.1` |
| Loopback only | `lsof` shows `127.0.0.1:PORT` only; the LAN address refuses |
| `GET /api/health` | returns exactly `{"healthy":true}` |
| Basic auth enforced | **401** with no header and with a wrong password, on `/api/health`, `GET /api/event` **and** `POST /api/session` |
| `OPENCODE_CONFIG` honoured **by the v1 reader only** | `GET /config` returns the file's contents — with `{env:…}` **already substituted**, so that response contains **live API keys**. Never log it, never forward it to the renderer. The v2 reader, which is the one that decides what a session can run on, never consults this variable — §9.5.3 |
| Config-defined agents addressable | an `agent` entry in the config is accepted by `POST /api/session {"agent": …}` and its `prompt` and `permission` take effect — **provided the v2 reader has the file and the entry inlines its prompt**; §9.5.3–4. An agent name it does not know is not rejected, it simply runs with no system prompt |
| `--mdns` | defaults the hostname to `0.0.0.0`. **Never pass it.** This is why the `--hostname` assertion in the engine tests is load-bearing rather than decorative |

### Sessions and prompting

- **`POST /api/session`** takes `{id?, agent?, model?, location:{directory, workspaceID?}}` **in the
  body**. Returns `{data:{id:"ses_*", projectID, location, …}}`. (`directory` as a *query* parameter
  belongs to `GET /api/session`, a different call — an easy and costly confusion.)
- **`POST /api/session/{id}/prompt`** takes `{prompt:{text, files?, agents?}, delivery?, resume?}`
  and returns **`{data: SessionInputAdmitted}`** — `{admittedSeq, id:"msg_*", sessionID, …}`. **It is
  an admission acknowledgement, not the answer.** The turn is consumed from a separate SSE
  subscription. This inverts the shape relative to A2A's `sendMessageStream`.
- `agent` and `model` are properties of the **session**, set at creation. A session therefore binds
  to `engineManager.agentKey(agentId)` when it is opened, which is what makes the Phase 5 fix
  (answering from the config the running process *loaded*) load-bearing rather than incidental.
- Ids are prefixed and stable: `ses_*`, `msg_*`, `per_*`, `que_*`, `psv_*`.
- Every response is wrapped in a **`{data: …}`** envelope.

### The event streams

Two streams, **not interchangeable**, and neither is sufficient alone.

| | `GET /api/event` (global) | `GET /api/session/{id}/event` (durable) |
|---|---|---|
| Variants | **88** | **28** |
| Deltas (`*.delta`) | yes | **no** |
| `permission.v2.*`, `question.v2.*` | yes | **no** |
| `session.idle`, `session.error` | present in the schema (idle never fires — §3) | **no** |
| **`step.started` / `step.ended` / `step.failed`** | yes | **yes** |
| Resumable | **no — `parameters: []`, no `after`, no query params at all** | yes, `?after=<seq>` |
| Scope | every session on the process | one session |

**The consequence:** token streaming, permissions and questions exist only on the *unresumable*
stream. Global events *carry* `durable:{aggregateID, seq}` — but there is nowhere to send the cursor
back, so carrying it is not the same as resuming.

**But the resumable stream *can* report the end of a turn**, and an earlier draft of this document
said the opposite. `session.next.step.ended` **is one of the 28 durable variants** (verified against
`SessionDurableEvent.oneOf`). The claim "neither stream alone survives a drop" was true of
`session.idle` and false of the event that actually terminates a turn (§3). One `?after=<seq>` replay
therefore carries **both** halves of a recovery — the words that were missed *and* the fact that the
turn ended — which is why the runner needs no separate completion probe after a reconnect.

**Wire format.** `GET /api/event` emits `data: {json}` lines interleaved with `: heartbeat`
**comment** lines. A parser that splits on `data: ` will glue a heartbeat onto the previous payload;
it must tolerate comments and blank lines. **The legacy `/event` differs** — it emits
`server.heartbeat` as a real *data* event rather than an SSE comment.

### Observed event order, for a plain answer

```
session.next.prompt.admitted   seq 1     ← durable.seq == the admittedSeq from POST /prompt
session.next.prompted          seq 2
session.next.step.started      seq 3
session.next.text.started      seq 4     (no text)
session.next.text.delta        (no durable block at all)  'hello'
session.next.text.delta                                   ' from'
session.next.text.delta                                   ' the'
session.next.text.delta                                   ' probe'
session.next.text.ended        seq 5     text: 'hello from the probe'   ← CUMULATIVE
session.next.step.ended        seq 6     finish: 'stop'
```

Three facts in that trace, each load-bearing:

1. **Deltas are true deltas; `text.ended` carries the whole text.** `StreamPartsAccumulator` expects
   each part's *cumulative* text and computes the delta itself, so the runner must accumulate before
   handing it over. Getting this backwards is invisible on a plain sequential stream — see §5.
2. **`session.next.text.delta` carries no `durable` block.** Deltas are not durable events, which is
   why the global stream genuinely cannot replay them, at the event level and not merely the
   endpoint level.
3. **`admittedSeq` equals the `durable.seq` of `prompt.admitted`** (observed as `1`, then `7` on the
   next turn of the same session), so it is a sound `?after=` cursor value.

### Tool calls

```
session.next.tool.input.started   {callID, name:'bash'}
session.next.tool.input.delta     {delta:'{"'} … {delta:'echo'} … {delta:' hi'}     ← JSON, streamed
session.next.tool.input.ended     {text:'{"command":"echo hi"}'}
session.next.tool.called          {callID, tool:'bash', input:{command:'echo hi'}, provider:{executed:false}}
```

A tool-calling turn emits **`step.ended{finish:'tool-calls'}`** and then, after the tool result,
**`step.ended{finish:'stop'}`**. So `finish` discriminates a *step* boundary from a *turn* boundary.

**Tool execution works in headless `serve` mode.** Confirmed by the `write` tool creating a real file
on disk. (This was twice reported as broken during probing; both reports were wrong — see §6.)

### Permissions

`permission.v2.asked`, observed payload:

```json
{ "id": "per_067302566001QS8HG7C1F6LeBj",
  "sessionID": "ses_…",
  "action": "edit",
  "resources": ["notes.txt"],
  "save": ["*"],
  "source": {"type":"tool","messageID":"msg_…","callID":"call_…"} }
```

- Reply: `POST /api/session/{id}/permission/{requestID}/reply` with
  `{"reply":"once"|"always"|"reject", "message"?}`. The enum maps exactly onto the design's
  **Allow once / Always / Deny** — nothing needed inventing.
- **`action` is coarser than the tool**: the `write` tool asked for `action: "edit"`.
- **`resources` is a *relative* path** — it carries no folder scoping.
- **`save` is `["*"]`** — the only savable pattern offered is *everything*.
- Replying **`once` persists nothing**: `GET /api/permission/saved` stayed empty until the moment
  `always` was sent. **This is the hook that makes a correct per-agent policy possible — see §4.**

### Questions

`question.v2.asked` carries `{id:"que_*", sessionID, questions:[{question, header,
options:[{label, description}], multiple?, custom?}], tool:{messageID, callID}}`.

Near-isomorphic to the desktop's own `AskQuestion`
(`src/renderer/src/utils/askUserQuestion.ts`) but **not identical**: OpenCode says `multiple`, the
desktop says `multiSelect`; OpenCode requires `header` and option `description`, the desktop treats
both as optional. A mapping layer, not a cast.

Answers go to `POST /api/session/{id}/question/{requestID}/reply` with **`{answers: string[][]}`** —
one array of selected labels per question. That is structurally different from the A2A relay, where
an answer is simply the next user turn. `POST …/question/{requestID}/reject` takes **no body**, and
is the clean exit that stops a parked question wedging a session.

`GET /api/permission/request` and `GET /api/question/request` return **pending** requests, so one
orphaned by an app restart can be re-fetched rather than lost. Both are scoped by a `location` query
parameter that defaults to the server's cwd — and that filtering proved **unreliable** in probing
(returned `[]` and `null` for locations that definitely had sessions). Do not rely on it.

---

## 3. Disproven — declared but absent, or documented and false

**These are the ones that pass every test.** Each is in the OpenAPI document or the event schema, so
a fake built from the document implements them faithfully.

| Claim | Reality |
|---|---|
| **`session.idle` ends a turn** | **Never emitted.** Three turns, watched on **both** `/api/event` and the legacy `/event`. Every turn ends at `session.next.step.ended` and nothing follows. It is in the 88-variant schema and does not occur |
| **`POST /api/session/{id}/wait` reports idleness** | **503 in 0.016 s**, body `{"_tag":"ServiceUnavailableError","message":"Session wait is not available yet","service":"session.wait"}`. **Declared in the OpenAPI document, not implemented in this version.** Not a timeout and not a transient outage — do not retry it |
| The durable stream has no `session.idle` / `session.error` | True — but this does **not** mean it cannot complete a turn. `step.ended` is durable, and `step.ended` is the real terminal signal. See the note in §2 |
| `GET /api/event` can resume | `parameters: []` — no `after`, no query parameters at all |
| Saved permissions are scoped per project | `projectID` is **`"global"`** for every session, always — see §4 |
| `{env:…}` substitution is reliable | Observed to **silently fail once**, producing a provider `401 "Missing bearer or basic authentication in header"` — i.e. *no* key sent — with a config that was structurally identical to a working one. Unexplained. If a turn 401s at the provider, suspect substitution before suspecting the credential |

**The turn-completion signal is therefore `session.next.step.ended`**, and nothing else. A runner
that waits for `session.idle`, with `POST /wait` as its backstop, hangs on **every single turn** —
both mechanisms are dead and the fallback chain is circular.

**Do not test `finish === 'stop'`.** `SessionNextStepEnded.data.finish` is a bare `{"type":"string"}`
in the schema — **no enum, no constraint** — so the terminal set cannot be read off the spec and any
list of it is a guess. The two possible rules fail in opposite directions: `=== 'stop'` hangs the turn
forever the moment a real turn ends with `length`, `content-filter` or anything else unenumerated,
which is the same invisible lock-held-forever failure through a narrower door; whereas terminating on
an unrecognised value ends a turn early, which is **visible and recoverable — the user simply asks
again.** So the correct rule inverts the test: **terminate by default, and treat continuation as the
enumerated exception** — currently the single observed value `'tool-calls'`. The vocabulary matches
the AI SDK's `FinishReason`, whose other members are all terminal; that is corroboration, not proof.

---

## 4. The permission scoping defect — proven end to end

**One "Always" click grants every folder agent access to everything, permanently, and the grant is
shared with the user's own OpenCode installation.**

This is not inference. The reproduction, in order:

1. Config sets `write`/`edit` to `ask`. Session A opened with `location.directory` = folder **A**.
   Prompt: write a file. → `permission.v2.asked` fires with `action:"edit"`, `resources:["notes.txt"]`,
   `save:["*"]`.
2. Reply `{"reply":"always"}` → `204`. The file is written in folder A.
3. `GET /api/permission/saved` → `[{ "id":"psv_…", "projectID":"global", "action":"edit", "resource":"*" }]`.
   **No directory. No session. No agent.**
4. Session B opened with `location.directory` = folder **B** — a different agent folder that was
   never granted anything. Same prompt. → **zero permission events**, and the file is written
   silently.
5. The engine process is killed and a **new** one started. `GET /api/permission/saved` still returns
   the grant. It lives in **`~/.local/share/opencode/opencode.db`** — a **user-global** store,
   outside our app data directory, **shared with the user's own OpenCode install**.

Three separate failures compound here:

- **No folder scoping.** `projectID` is `"global"` regardless of the session's directory, regardless
  of whether that directory is a git repository, and regardless of the server's own cwd. All three
  were tested.
- **No resource scoping.** The savable pattern offered is `*`, so the grant is "edit anything". A
  user who believes they are allowing *"edit `notes.txt`"* is allowing *"edit everything"*.
- **No application scoping.** Because the store is user-global and survives restarts, grants leak
  **out** into the user's personal OpenCode usage and **in** from it.

**Consequences for the desktop, and the way out.**

`ALWAYS_GRANTS_ENABLED` in `src/shared/localAgentRequests.ts` is `false`, the Always button is not
rendered, and two tests fail if the constant is flipped. That gate is correct and must stay until a
per-agent policy exists.

The way out is **not** to adopt OpenCode's store. It is the opposite, and it follows directly from
"replying `once` persists nothing":

> **Only ever reply `once` or `reject`. Never send `always`.** Keep durable grants desktop-side,
> per agent, and auto-answer a matching ask with `once`. OpenCode's saved-permission store then
> stays empty forever, and "Always, for this agent" means what it says.

This **reverses** the earlier decision recorded as "OpenCode is authoritative because the desktop
cannot opt out of its store". The desktop can opt out; the premise was wrong. Implementing it is not
Phase 6 work — it is recorded here so the decision is not re-derived from the false premise.

Until it exists, any user-facing string claiming a decision was remembered *"for this agent"* is
false. `permissionDecisionText` says "Allowed, and remembered." for that reason.

### 4.1 Per-folder, per-session permissions *are* achievable — the mechanism

The defect is narrower than it first reads. **Only the saved-grant store is global. The permission
*question* is per-session**, and that is where the decision is made.

Two layers, and the first already works:

| Layer | Scope | Status |
|---|---|---|
| **Static policy** — the `permission` block on each agent entry in the generated engine config (`CONVERSATION_PERMISSIONS`, `configGenerator.ts`) | **per agent entry** | **Verified working**: setting `write: ask` on the agent entry produced an ask; setting it to `allow` did not. *Caveat: differentiation between two agents with different profiles in one config was not A/B tested — only that a per-agent block takes effect.* |
| **Dynamic grants** — "Always" | user-global in OpenCode | Broken (§4). Achievable **desktop-side** |

The desktop-side mechanism, resting only on verified facts:

1. `permission.v2.asked` carries **`sessionID`** *(verified)*.
2. The desktop opened that session itself with `location.directory` = the agent folder, so it holds
   the `sessionID → agentId → folder` mapping *(verified — sessions are created by the runner)*.
3. Therefore **every permission question is attributable to exactly one folder agent at the moment it
   is asked**, with no reliance on `projectID`.
4. Replying **`once` persists nothing** *(verified)*. So:
   - grant matches a desktop-held per-agent rule → auto-reply `once`;
   - no match → render the block; **Once** → `once`, **Deny** → `reject`, **Always** → record the
     rule in `desktop.json` *keyed by agent*, then reply `once`.
5. OpenCode's saved store stays empty, and `projectID: "global"` never gets a chance to matter.

This is **better** granularity than OpenCode offers, not merely equivalent: the engine's `save` only
ever offers `["*"]`, whereas a desktop-held rule can be scoped to the action *and* the resource
pattern the user actually saw.

### 4.2 The hole in that plan — pre-existing grants

The desktop can only gate what it is **asked** about. If `~/.local/share/opencode/opencode.db`
already carries a matching grant — from the user's own OpenCode usage, or from another client
attached to the same `opencode serve` (which **Phase 8 deliberately enables**) — the engine
**allows without asking**, and no desktop-side policy is consulted. Step 4 above never runs.

That store is outside our app data directory and predates our process. So a complete policy needs a
reconciliation step: at engine start, read `GET /api/permission/saved` and either prune rows
(`DELETE /api/permission/saved/{id}`, verified to return 204) or surface them to the user. **Pruning
mutates state the user's own OpenCode install depends on**, so it must be a consented action, not a
silent one — a rule that applies to the app exactly as it applied to the probe that created a grant
and had to remove it.

---

## 5. Why the fakes could not have caught any of this

Worth stating plainly, because it generalises past this feature.

Every finding in §3 and §4 is a case where **the fake was correct and the fake was not the binary.**
`session.idle` is in the schema. `POST /wait` is in the OpenAPI document with a 204 response. A
`projectID` field exists and looks like scoping. A fake built from the document implements all three,
every test passes, and the app hangs on its first turn.

The related trap, one level down, is a test that only exercises the *easy* input. The
cumulative-versus-delta convention is the sharpest instance: handing the accumulator the raw engine
delta instead of the running total **passed 19 of 19 tests**, because for a plain sequential stream
both conventions produce byte-identical output. Two ordinary inputs separate them — a chunk identical
to its predecessor (an LLM emitting `**`, `the `, a double space), where the wrong convention makes
the accumulator skip it as a no-op and the answer is silently one chunk short; and a block-level
`text.ended` after more than one delta, where the whole text is appended twice.

**The rule for anyone adding to `agentTurn/`:** if a behaviour is only in the schema, it is
unverified. Mark it, and prefer a design that degrades visibly when the assumption is wrong.

---

## 6. Corrections — beliefs that were held and were false

Recorded because a confident wrong finding is more expensive than an open question, and three of
these were reported to the team before being caught.

| Believed | Actually |
|---|---|
| "Tool execution fails in headless serve mode — probably the probe sandbox" | **Both halves wrong.** A grandchild process writes and spawns shells fine in that sandbox, and with a correct config OpenCode's `write` tool created a real file. The failing runs had a broken config |
| "The permission ask flow may not work over HTTP; no `permission.v2.asked` was ever seen" | It works. It was never reached because the tool failed first, for the unrelated reason above |
| "The durable cursor is available on the global stream too" | The **seq** is carried; the **resume** is not. `GET /api/event` takes no parameters |
| "'Always' grants persist in `desktop.json`" (original plan) | They persist in OpenCode's user-global SQLite store |
| "OpenCode is authoritative for saved grants; the desktop cannot opt out" | The desktop **can** opt out, by never sending `always` — see §4 |
| "`--port 0` gives an OS-assigned port" | `--help` says default `0`, but `--port 0` really binds **4096**; a second `serve` against a taken 4096 comes up *silently* on an unpredictable port |
| "The config's providers are not available to the v2 runner; cause unknown" (§9, 3 Sep) | The cause was not the providers. `OPENCODE_CONFIG` reaches only the v1 config reader, so the v2 catalog the runner consults had no config at all for a session located in an agent folder — §9.5.3 |
| "An unavailable model fails 50–120 s after the prompt" (§9) | **0.4 s**, in the engine's log, and **never on the wire**. The 50–120 s was time-to-notice — §9.5.5 |
| "Neither stream alone survives a drop — the resumable one cannot see completion" (an earlier draft of **this file**) | True of `session.idle`, **false** of the event that actually ends a turn. `step.ended` is one of the 28 durable variants, so one `?after=` replay carries both the missed content and the turn's end. Caught by the dev agent reading the variant list rather than trusting this document |

---

## 7. Still unverified

Not weaker evidence — **no evidence**. Each is a place to look first when something behaves oddly.

1. **Whether a `durable.seq` from the *global* stream is a valid `?after=` cursor on the
   *per-session* stream.** The two share the `durable` envelope and `aggregateID`, which is why it
   should hold, but it has not been watched. **This is the highest-value target for the next probe**,
   because being wrong is silent: a replay that starts too early is absorbed by the accumulator's
   never-shrink rule; too late loses content with nothing reporting it.
2. **Whether `?after=` is exclusive or inclusive.** The code is inclusive-tolerant by construction
   (the `length >=` guards in `setText`/`toolResult`/`settleRequest` absorb a re-delivered event), so
   this is robustness rather than a live risk — but it is an assumption.
3. **Whether `text.ended`, `tool.called`, `tool.success` or `tool.failed` ever omits
   `assistantMessageID`.** If any of them does, the part is filed under a different identity from the
   events that built it and the whole block is duplicated into the transcript. All four are durable
   variants that the heal path replays, and the durable stream's own field set on them has never been
   watched. `TurnStream` now defends all four with first-owner-wins (`streamOwner`, keyed by
   `textID` / `reasoningID` / `callID`), so being wrong here is absorbed rather than visible — which
   is precisely why only a probe, and not a test, can settle it.
4. **Whether OpenCode recycles `per_*` / `que_*` ids across restarts.** The pending-request registry
   keys on request id alone, with no session scoping.
5. **Where a permission or question falls relative to the text stream** — whether one can arrive
   before the first `text.started`, and how a parked request interleaves with deltas.
6. **The download sequence as the app runs it** — `downloadToFile` → `extractArchive` → `chmod` →
   `rename`, including the staging rename and the lost-race branch. Every *piece* is hand-verified;
   the sequence has only run against fakes.
7. **The packaged contract path** — `contractStore.ts`'s `process.resourcesPath` branch has never
   executed. One `npm run build:mac:unsigned` settles it.
8. **Every platform except `darwin-arm64`.** The other five assets' digests are recorded and
   unverified.
9. ~~**Which config-file provider entries the v2 runner treats as *available*, and what makes one
   so.**~~ **Settled 3 Sep 2026 — §9.5.** The entries were never the variable: `OPENCODE_CONFIG` is
   read by the v1 config loader only, and the v2 loader the runner consults never saw our file at
   all. `OPENCODE_CONFIG_DIR` is the lever.
10. ~~**What the desktop's event subscription receives when the engine fails to resolve a
    model.**~~ **Settled 3 Sep 2026 — §9.5.4. Nothing.** `prompt.admitted` and `prompted` arrive and
    then the stream is silent; the desktop waits on its own ceiling. A *provider* failure is the
    opposite — `session.next.step.failed` carries it — which is why the two must not be conflated.

---

## 8. Runbook — how to re-verify

Keep this reproducible; the contract will move when the pinned version does.

```bash
# 1. Fetch and check the pinned asset
curl -sSL -o oc.zip \
  https://github.com/anomalyco/opencode/releases/download/v1.18.27/opencode-darwin-arm64.zip
shasum -a 256 oc.zip     # must equal the digest in binaryResolver.ts
tar -xf oc.zip && chmod +x opencode && ./opencode --version

# 2. Serve, authenticated, on loopback, with a config that defines a provider and an agent
cd <agent-folder>
OPENAI_API_KEY="$(cat key.txt)" OPENCODE_CONFIG=<cfg>.json \
OPENCODE_SERVER_USERNAME=c OPENCODE_SERVER_PASSWORD=p \
  ./opencode serve --port 47315 --hostname 127.0.0.1 --print-logs --log-level DEBUG

# 3. Pull the spec, subscribe BEFORE prompting, then prompt
curl -s -u c:p http://127.0.0.1:47315/doc > openapi.json
curl -sN -u c:p http://127.0.0.1:47315/api/event > events.ndjson &
SES=$(curl -s -u c:p -X POST http://127.0.0.1:47315/api/session \
  -H 'content-type: application/json' \
  -d '{"agent":"<key>","model":{"providerID":"openai","id":"gpt-4o-mini"},
       "location":{"directory":"<agent-folder>"}}' | jq -r .data.id)
curl -s -u c:p -X POST "http://127.0.0.1:47315/api/session/$SES/prompt" \
  -H 'content-type: application/json' -d '{"prompt":{"text":"…"}}'
```

**Conditions that matter, learned the hard way:**

- **Subscribe to `/api/event` before `POST /prompt`**, or the opening deltas are lost — the global
  stream cannot replay them.
- **Use `--print-logs --log-level DEBUG`.** Without it the server logs one line and a provider `401`
  is invisible; the tool-execution failure that misled two rounds of probing would have been obvious.
- **A permission test needs a tool that can actually run.** A tool failing for an unrelated reason
  never reaches the permission gate, and the absence of `permission.v2.asked` then looks like a
  missing feature. Prove the tool works with `allow` first, then set it to `ask`.
- **Clean up `~/.local/share/opencode/opencode.db` afterwards.** A probe that replies `always` writes
  a real grant into the user's own OpenCode state. Remove it with
  `DELETE /api/permission/saved/{id}` (204). Sessions left behind are harmless; grants are not.
- **Never commit or echo the credential**, and prefer a short-lived key: `GET /config` returns the
  resolved configuration **with the key substituted in**.

## 9. Model resolution in the v2 session runner — observed 3 Sep 2026, in the desktop's own engine

Found by debugging a live run, not by a probe: every folder-agent turn the desktop had made that day
ran on a model nobody configured. Verified against the engine the app itself spawned (1.18.27,
`OPENCODE_CONFIG` = the generated `opencode.json`, four provider entries with keys), by reading
`~/.local/share/opencode/opencode.db`, `GET /api/session/{id}/message`, the engine log, and the
binary's own resolve function. Nothing in this section is inferred from the OpenAPI document.

### 9.1 What the engine actually did

| Session | `model` sent at `POST /api/session` | Model the turn ran on | Outcome |
|---|---|---|---|
| Four desktop-opened sessions (`agent` + `location` only, no `model`) | none | `opencode/muse-spark-1.3-contributor-free` (three), `nano-gpt/google/gemini-3.8-flash` (one) | free model: answered, **every tool call failed in ~3 ms**; nano-gpt: `HTTP 401 … missing_api_key` |
| Probe, `{providerID:"anthropic", id:"claude-sonnet-4-6"}` — the **canonical** config entry, key present | explicit | none | `SessionRunnerModel.ModelUnavailableError: Model unavailable: anthropic/claude-sonnet-4-6`, logged as `Failed to drain Session` **~50–120 s after the prompt** |
| Probe, `{providerID:"anthropic-29e5d862", id:"claude-sonnet-4-6"}` — the custom second-key entry | explicit | none | same error; adding `options.baseURL` to the custom entry (a separate `serve` on another port) changed nothing |
| Probe, `{providerID:"opencode", id:"muse-spark-1.3-contributor-free"}` | explicit | that model | answered; `read cinna-agent.json` → `Unable to read cinna-agent.json`, both from `~/Documents/…` and from a copy under `/private/tmp` |

The agent's configured `model` (`agent.<key>.model = "anthropic-29e5d862/claude-sonnet-4-6"`, and
`GET /agent` confirms the engine parsed it) **was never used**. `GET /provider` (v1) lists all four
config entries under `connected`; that is not the list the runner consults.

### 9.2 The resolve rule, read from the binary

`SessionRunnerModel.resolve` (chunk containing `"SessionRunnerModel.ModelUnavailableError"`),
de-minified:

```
resolve(session):
  if session.model:
      X = model.available().find(providerID == session.model.providerID && id == session.model.id)
      if !X: fail ModelUnavailableError(providerID, modelID)
  else:
      Z = model.default()
      X = supported(Z) ? Z : model.available().find(supported)
      if !X: fail ModelNotSelectedError(sessionID)
  provider = provider.get(X.providerID)
  connection = connection.active(provider.integrationID ?? X.providerID)
  build the SDK model from X, with auth from the connection (or request.body.apiKey / api.settings.apiKey)

supported(m) = m.api.type == "aisdk" && m.api.package in
               { "@ai-sdk/openai", "@ai-sdk/anthropic", "@ai-sdk/openai-compatible" (url required) }
```

Consequences that matter to the desktop:

1. **The session's own `model` is the only per-session input.** The agent's `model` in the config
   is not read on this path. Opening a session with `agent` but no `model` (what
   `localAgentTurnRunner.openSession` does today) means "engine's default, or the first supported
   model in `available()`" — which is how a free OpenCode model, and once a provider with no key,
   got chosen silently.
2. **`available()` is not the config's provider list.** `google/gemini-3.8-flash` from the config
   *was* in `GET /api/model` (`api.type:"aisdk"`, `api.package:"@ai-sdk/google"`,
   `request.body.apiKey` set), so config providers can reach it — yet `anthropic/claude-sonnet-4-6`
   from the same config resolved as unavailable. **Settled in §9.5: it is not the entries that
   differ, it is which config the engine read for that session.** Note `@ai-sdk/google` is not in
   `supported()` at all: a Gemini credential can never be a default here, even when it is
   available.
3. **An unavailable model produces no event.** *(Corrected in §9.5.)* The engine logs
   `Failed to drain Session` about **0.4 s** after `prompt` — not the 50–120 s recorded here, which
   was wall-clock time to notice rather than the engine's own — and emits **nothing** on
   `/api/event` after `session.next.prompted`. The desktop is in its streaming state with nothing
   to show and nothing coming, so what ends it is its own 20-minute ceiling and not the engine.
4. **Model refs use `{providerID, id}`.** `{providerID, modelID}` is rejected at `POST /api/session`
   (the response is not JSON). `POST /api/session/{id}/model {model: ModelRef}` exists to re-point
   a remembered session, alongside the `/agent` re-point the runner already does.

### 9.3 The tool failures on the free model

`read`, `bash` and `glob` all failed within ~3 ms of `tool.called`, with `provider.executed:false`
and error type `unknown`. Not a permission decision (`read` is `allow` in the agent's effective
rules, `GET /agent`, and no `permission.v2.asked` was emitted), not `~/Documents` protection (same
failure from `/private/tmp`). The `read` tool's error mapping in the binary is
``mapError(e => isBinary|Limit|Decode|Size ? e.message : `Unable to read ${path}`)`` — every other
cause collapses to that one string, so the message is not evidence of anything. Whether this is the
same "broken config" failure §6 recorded, a property of the free `opencode` gateway, or something
else, is **not determined**; it was only ever observed on `opencode/muse-spark-*`, which is the
only model that resolved in this engine.

### 9.4 What the desktop should do about it (not yet done)

- **Send `model: {providerID, id}` on `POST /api/session`, from the config the running engine
  loaded** (`engineManager` already records `agentKeys` per process; it needs the agent's
  `provider/model` split the same way), and `POST /api/session/{id}/model` on a remembered session
  next to the existing `/agent` re-point. A wrong model then fails loudly as
  `ModelUnavailableError` instead of running on whatever the engine picked.
- **Surface `Failed to drain Session` / `ModelUnavailableError` as a turn error the moment it
  arrives**, and check what the desktop's `/api/event` subscription actually receives for it — the
  probe sessions show only the user message afterwards, so it may not be a `session.next.*` event.
- **Establish how a config-file key becomes an *available* connection in 1.18.27** before Phase 7b
  builds anything else on the engine. Candidates, all untested: the v2 credential surface
  (`POST /api/integration/{id}/connect/key`, `POST/DELETE /api/credential/{id}`, the empty
  `credential(integration_id, method_id, value, …)` table in `opencode.db`); the canonical env
  names each integration advertises (`GET /api/integration` → `methods:[{type:"env",names:[…]}]`,
  e.g. `ANTHROPIC_API_KEY`) — the one attempt at this ran with an empty variable by mistake and
  proves nothing. §8's own recipe passed the key as `{env:OPENAI_API_KEY}` **and** had
  `OPENAI_API_KEY` in the process environment, which may be why that probe resolved at all.

---

## 9.5 Why the config's providers were not "available" — settled 3 Sep 2026

§9 left one question open and everything else in this feature waiting on it: what makes a
config-file provider entry *available* to the v2 session runner. **The entries were never the
variable. The engine has two config readers, our file reached only one of them, and it is the other
one that decides what a session can run on.**

### 9.5.1 Conditions — these differ from §1 and the difference matters

| | |
|---|---|
| Binary | the desktop's own managed copy, `<userData>/engine/opencode-1.18.27/opencode`, `--version` → `1.18.27` |
| Credentials | **none**. Every key below is a dummy (`sk-ant-dummy…`). "Available" and "authenticated" are separable, and every result here was reached without one |
| Isolation | `XDG_DATA_HOME` and `XDG_CONFIG_HOME` pointed at a scratch directory, so nothing touched `~/.local/share/opencode/opencode.db` or the user's own `~/.config/opencode`. `.db` and `.db-wal` mtimes were unchanged afterwards |
| Launch | `serve --port <N> --hostname 127.0.0.1 --print-logs --log-level DEBUG`, cwd = the directory holding the generated config |
| Sessions | `location.directory` deliberately pointed at a directory **outside** the config's own tree, which is what a folder agent's session does |
| Also used | a local HTTP server impersonating an OpenAI-compatible gateway, so the exact request the engine builds — headers and system prompt — could be read off the wire |

### 9.5.2 `GET /api/model` *is* `model.available()`

Read out of the binary: the `server.model` route group handles `model.list` as
`yield* t(i.model.available())`, and `server.provider` handles `provider.list` as
`provider.available()`. So the question "is this model available to the runner" is answerable with
one authenticated GET, with no session, no prompt and no spend. Every result below rests on that.

The filter itself, de-minified from the `CatalogV2` service:

```
providerAvailable(p, integration):
  if p.disabled:                              false
  if typeof p.request.body.apiKey == "string": true
  if integration?.connections.length:          true
  else:  p.integrationID === undefined && !integration

model.available() = model.all().filter(m => providerAvailable(m.providerID) && m.enabled)
```

### 9.5.3 `OPENCODE_CONFIG` is a v1-only variable

The v2 `Config` service (`@opencode/v2/Config`) builds its document set from exactly two places:

```
ct = <the global config directory>                       // Global.config = OPENCODE_CONFIG_DIR ?? ~/.config/opencode
be = up({targets: [".opencode", "opencode.jsonc", "opencode.json"],
         start: <the location's directory>, stop: <the project directory>})
```

**`process.env.OPENCODE_CONFIG` appears nowhere in it.** That variable is read by the *v1* config
service, which is why `GET /config`, `GET /agent` and `GET /provider` all showed our providers and
our agent while the runner could not resolve any of them — §9.1's "`GET /provider` (v1) lists all
four under `connected`; that is not the list the runner consults" was the visible edge of this.

A v1-shaped file is migrated on the way in (`isV1` triggers on any of `provider`, `agent`,
`permission`, `mode`, …), so the shape of our config was never the problem either.

The consequence for the desktop is exact: the engine's cwd is `<userData>/engine`, but a session's
`location.directory` is the **agent's folder**, and the walk goes up from there. Nothing in
`~/Documents/…/invoice-reader`'s ancestry is `<userData>/engine`, so the v2 loader saw an empty
config for every folder-agent session.

**One variable, four runs, one difference:**

| Run | `OPENCODE_CONFIG` | `OPENCODE_CONFIG_DIR` | `opencode.json` in cwd | Session located | Result |
|---|---|---|---|---|---|
| A | yes | — | no | cwd | `/api/model`: only `opencode`'s own 31 models |
| B | yes | — | yes | a **sub**directory of cwd | resolves; real request to Anthropic → **HTTP 401 invalid key** |
| B′ | yes | — | yes | an unrelated tree | `SessionRunnerModel.ModelUnavailableError` |
| D | yes | **yes** | yes | an unrelated tree | resolves; real request to Anthropic → **HTTP 401** |
| F | yes | — | yes | an unrelated tree | `ModelUnavailableError` (D with the one variable removed) |

D versus F is the whole finding: same file, same environment, same cwd, same session — only
`OPENCODE_CONFIG_DIR` differs.

### 9.5.4 The v2 reader substitutes nothing

The v1 loader resolves `{env:VAR}` and `{file:path}` (`ConfigVariable.substitute`). The v2 loader
reads the file, parses JSONC and decodes it. **There is no substitution step**, and both of the
desktop's placeholders were silently wrong because of it:

- `provider.<key>.options.apiKey = "{env:NAME}"` reaches the catalog as those characters. Confirmed
  in `GET /api/model`: `request.body.apiKey` was literally `"{env:PROBE_KEY_ANTHROPIC}"`. It makes
  the provider *available* — it is a string — and then sends the placeholder to the provider as the
  key.
- `agent.<key>.prompt = "{file:./prompts/<key>.md}"` reaches the model **as those characters, in
  place of the system prompt.** Read off the gateway: `messages[0].role == "system"`, content
  containing `{file:` and not one word of the file. `GET /api/agent` reports the same literal in
  `system`, while the v1 `GET /agent` reports the file's resolved text — the two readers disagreeing
  in the open.

**What does work, both watched end to end:**

- `provider.<key>.env = ["NAME"]`. The v1→v2 migration carries it, and the `config-provider` plugin
  turns it into an integration with an `{type:"env", names:["NAME"]}` method.
  `GET /api/integration` then shows `connections: [{"type":"env","name":"NAME"}]` for that provider
  — for a **canonical** id (`anthropic`) and for a **custom** one (`anthropic-29e5d862`,
  `openai-compatible-<hash>`) alike, which is what the desktop needs since it must carry a second
  credential of the same type. The gateway received `Authorization: Bearer sk-echo-dummy-777`, the
  exact value of the named variable, with no `apiKey` anywhere in the config file.
- `agent.<key>.prompt = "<the text>"`. The gateway received it as the system prompt, ahead of the
  engine's own `<env>` block and its skills block.

Note the migration puts a canonical entry's `apiKey` in `request.body` and a custom entry's in
`request.headers["x-api-key"]` — an asymmetry that matters only if you go back to `options.apiKey`.

### 9.5.5 What `ModelUnavailableError` looks like on the wire — nothing

Subscribed to `GET /api/event` before prompting, session located outside the config's tree:

```
session.next.prompt.admitted
session.next.prompted
<silence>
```

The engine logs `ERROR message="Failed to drain Session" cause="SessionRunnerModel.ModelUnavailableError: …"`
**0.4 s** after the prompt — §9's "50–120 s" was time-to-notice, not the engine's. No
`step.started`, no `step.failed`, no `session.error`, nothing on the durable stream either. So there
is nothing for `turnStream.ts` to map; the desktop has to ask before it prompts, which is what
`awaitEngineReady` in `localAgentTurnRunner.ts` now does.

**A provider failure is the exact opposite and must not be conflated with it.** With the model
resolved and a bad key, the same subscription carries:

```json
{"type":"session.next.step.started","data":{"agent":"probe-agent",
  "model":{"id":"claude-sonnet-4-6","providerID":"anthropic-29e5d862","variant":"default"}}}
{"type":"session.next.step.failed","data":{"error":{"type":"unknown",
  "message":"Provider request failed with HTTP 401: {…\"message\":\"invalid x-api-key\"…}"}}}
```

`step.started` carrying the **resolved** model is the cheapest diagnostic in the whole system: it is
the engine saying out loud what it decided to run on.

### 9.5.6 A healthy engine is not a usable engine for 30–60 seconds

Not looked for; found by a test that failed and then passed unchanged. `GET /api/health` returns
`{"healthy":true}` about a second after spawn. After that, on this machine with a warm
`~/.cache/opencode/models.json`, it took **30 to 60 seconds** before either

- `GET /api/model` returned anything at all — a turn in that window gets `ModelUnavailableError`,
  which is to say silence; or
- a config-defined agent was addressable — a turn in that window runs **with no system prompt**, and
  the model receives only the engine's own `<env>` block. The folder agent then answers as a generic
  assistant, and nothing anywhere says why.

The second one cost an hour of this probe: a config difference was "reproduced" three times before
the variable turned out to be *first turn after start* rather than anything in the file. Any future
probe should run one throwaway turn before measuring, and any future reading of "the agent ignored
its prompt" should check the clock first.

### 9.5.7 Reproducing this

```bash
SP=/tmp/probe; mkdir -p $SP/enginehome $SP/elsewhere
cat > $SP/enginehome/opencode.json <<'JSON'
{ "$schema": "https://opencode.ai/config.json",
  "provider": { "anthropic": { "env": ["MY_KEY"] } },
  "agent": { "a1": { "mode": "primary", "description": "d",
                     "model": "anthropic/claude-sonnet-4-6",
                     "prompt": "SENTINEL. You are a probe." } } }
JSON
XDG_DATA_HOME=$SP/data XDG_CONFIG_HOME=$SP/cfg \
OPENCODE_CONFIG_DIR=$SP/enginehome OPENCODE_CONFIG=$SP/enginehome/opencode.json \
MY_KEY=sk-ant-dummy OPENCODE_SERVER_USERNAME=c OPENCODE_SERVER_PASSWORD=p \
  ./opencode serve --port 47401 --hostname 127.0.0.1 --print-logs --log-level DEBUG &

# wait for the catalog — this is §9.5.6, and it is not optional
until [ "$(curl -s -u c:p localhost:47401/api/model | jq '.data|length')" != "0" ]; do sleep 5; done

SES=$(curl -s -u c:p -X POST localhost:47401/api/session -H 'content-type: application/json' \
  -d '{"agent":"a1","model":{"providerID":"anthropic","id":"claude-sonnet-4-6"},
       "location":{"directory":"'$SP'/elsewhere"}}' | jq -r .data.id)
curl -s -u c:p -X POST localhost:47401/api/session/$SES/prompt \
  -H 'content-type: application/json' -d '{"prompt":{"text":"hi"}}'
```

A `401` from the provider in the log is the pass. `ModelUnavailableError` is the failure this
section is about. Drop `OPENCODE_CONFIG_DIR` to see it come back.
