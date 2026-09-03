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
| `OPENCODE_CONFIG` honoured | `GET /config` returns the file's contents — with `{env:…}` **already substituted**, so that response contains **live API keys**. Never log it, never forward it to the renderer |
| Config-defined agents addressable | an `agent` entry in the config is accepted by `POST /api/session {"agent": …}` and its `prompt` and `permission` take effect |
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
3. **Whether `text.ended` ever omits `assistantMessageID`.** If it does, the part is filed under a
   different identity from its deltas and the whole block is duplicated into the transcript. The heal
   path replays `text.ended` from the durable stream, whose field set nobody has watched.
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
