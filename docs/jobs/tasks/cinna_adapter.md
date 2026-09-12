# cinna-core as a Remote Task Adapter

## Purpose

cinna-core is one of the systems a task can also live on, and `cinnaTaskAdapter` is how the desktop talks to it — the first implementation of the [remote task adapter](remote_adapters.md) seam, and therefore the first evidence that the seam survives a mapping it did not design. Everything cinna-specific in this area is in this one file: its routes, its field names, its status vocabulary, its idea of an ask.

It is **an adapter, not the shape**. Nothing outside `src/main/tasks/adapters/` names the service, the kind-branch ratchet holds that count at zero, and every rule the rest of the app follows is written about "the remote" rather than about this one.

## Core Concepts

- **The world** — `CinnaWorld`, the four things the adapter needs from outside itself: an authenticated JSON request, the profile's server URL, "is this profile linked", and a file upload. The mapping is written against that interface, so it can be driven with no Electron, no database and no credential store
- **The wiring** — `cinnaTaskAdapter.wiring.ts`, the one file that names `cinnaApiFetch`, `cinnaFileService` and the user repository, and the only place `createCinnaTaskAdapter` is given a production world. The same split the agent drivers keep, for the same reason
- **Availability** — answered from the **local user row**, never from the network: a task whose service is unreachable must still open, and "is this profile linked" is a question about what is on this machine. An unlinked profile is an answer (`ready: false` with a sentence), not a failure
- **Binding** — `{adapter: 'cinna', id: the task uuid, key: its short code, url: the deep link, state: opaque}`. The deep link is `<server>/tasks/<short code>`, falling back to the uuid route before a code is minted and to null when the profile has no server at all — a link the app cannot open is a control that does nothing

## What it can do

Everything the seam describes, with one narrowing: a task attachment on cinna-core is a **file** — uploaded bytes with a name and a content type — and a link has no representation there at all. So `writeArtifactKinds` is `['file']` rather than a boolean, and a link artifact is refused rather than quietly posted as a comment, which would be a different capability wearing this one's flag.

| Desktop operation | cinna-core |
|---|---|
| `listAssignees` | `GET /api/v1/agents/` — paginated envelope `data`, nonempty string ids and names mapped to `remote_agent` |
| `create` | `POST /api/v1/tasks/`, or `POST /api/v1/tasks/{parent}/subtasks/` |
| `pushFields` | `PATCH /api/v1/tasks/{id}` — `title`, `current_description`, `priority`, `selected_agent_id` |
| `pushStatus` | `POST /api/v1/tasks/{id}/status`, one step per call |
| `archive` | `POST /api/v1/tasks/{id}/archive` — its own route, which owns the archive timestamp |
| `fetch` | `GET /api/v1/tasks/{id}/detail` |
| `liveSession` | `GET /api/v1/tasks/{id}/sessions` — whether any session has `interaction_status: running` |
| `list` (no cursor) | `GET /api/v1/tasks/?status=active`, paged by offset |
| `list` (cursor) | `GET /api/v1/tasks/?updated_since=…`, paged by advancing the cursor |
| `listSubtasks` | `GET /api/v1/tasks/{id}/subtasks/` |
| `execute` | `POST /api/v1/tasks/{id}/execute` |
| `addComment` / `listComments` | `POST` / `GET /api/v1/tasks/{id}/comments/` |
| `putHandoffNote` | a comment of type `result` |
| `putArtifact` | upload the bytes, then `POST /api/v1/tasks/{id}/files/{fileId}` |
| `listOpenAsks` / `answerAsk` | `GET /api/v1/sessions/{id}/messages`, then `POST /api/v1/sessions/{id}/messages/stream` |

Directory reads reject malformed envelopes and ignore entries without a usable string id. A captured credential session that changes before sending maps to `invalid_request`: no task request was dispatched, so the coordinator must not mistake it for a lost execution acknowledgement. See [remote handoff and recovery](remote_handoff.md).

## Four things about cinna-core a reasonable adapter gets wrong

Each is a real server behaviour with a real cost, and each has a test.

**A 400 is not "not yours".** Both an ownership refusal and a validation failure are 400 there, through one handler — and an illegal transition is a validation failure. Reading the status code alone would unbind a task whose only problem was that the push skipped a step, and no retry could ever re-link it: a bug that would have looked like a network fault would instead have looked like a deletion. So `not_ours` is answered only for a **404**, or for a 400 whose body is *exactly* `Not enough permissions`. Exactly, and not by prefix: a 400 saying `Not enough permissions for this agent` is a refusal about the **assignee**, on a route patching a task the caller owns perfectly well, and unbinding on that would be data loss caused by picking the wrong agent.

**`archived` is a different route.** The status route's allowed set is `open`, `in_progress`, `blocked`, `completed`, `error` and `cancelled`; filing a task away is its own call, which owns its own timestamp. `pushStatus` refuses `archived` before the transport, so the state cannot be reached by a path that records nothing.

**`execute` answers 200 with `success: false`.** A failure to start — no agent selected, no active environment — is not an HTTP error there. An adapter that checked only the status line would report a handover as successful and leave the task sitting on a service that never picked it up.

**An uncursored list is not everything.** It asks for the active set, which excludes everything completed, cancelled and archived. That is the seam's documented meaning for a null cursor, and it is why the reconcile confirms each missing replica instead of deleting whatever the list omits — see [Keeping a Bound Task in Step](remote_sync.md).

## Two costs this mapping pays, deliberately

**`fetch` is one request; liveness is a separate question.** `liveSession(userId, binding)` asks the sessions route when the task page needs to offer Take over, and again when the user presses it. The task's own status cannot answer that: cinna-core recomputes status from its sessions, so a task can sit `in_progress` with nothing live, and can be live before the recompute lands. `fetch` and `list` return snapshots without liveness; polling a task must not pay an extra round trip for an answer the pull discards. The adapter rejects transport failures; the caller turns a failed probe into “cannot tell”.

**Session ids are not cached in the binding.** Both `execute` and `fetch` formerly wrote `remote_state.sessionIds`, although nothing read it. `liveSession` and `listOpenAsks` ask the service afresh, because a session that appeared since the last read is exactly the one that may be working or asking a question. `execute` returns its binding without adding a session id.

**`answerAsk` reads before it writes.** The answer path flips the referenced message to *answered* without reporting what it was before, so the only way to report `{delivered: false}` for an ask somebody already answered is to look first — and the read also supplies the session id, which the ask id alone does not carry. It is a race: an answer landing between the read and the post is reported as delivered by both surfaces. That is the cheaper wrong answer; the alternative is claiming delivery for an ask that was already gone, over a question the user thinks they just decided.

## Paging rules, and what they cost when they are wrong

- **The active set is paged by offset**, safely and only there: with no cursor the sort key is the creation time, which never changes, so a row cannot move between pages
- **The delta is paged by advancing the cursor**, because with `updated_since` the sort key is mutable — a row touched while the next page is in flight moves to the tail, every row below it shifts up one, and the row that was last on the previous page is never returned by any page. The pass then advances past it, and its change is invisible until something touches it again, or for ever if what was missed was the completion
- **Advancing to the last row's timestamp is not enough either.** The only cursor this API accepts is a bare timestamp, filtered strictly, with no tiebreaker — so a composite key is not expressible, and moving to the final row's time silently excludes every *other* row sharing it. Ties are routine rather than exotic: a status change commits the task *and* posts a comment, and both touch the column. The cursor advances to the last **complete** tie group instead, dropping the trailing rows that share the final timestamp so the next request re-reads them, which is cheap and idempotent
- **A session's messages are paged to the end**, oldest first, because an unanswered ask is always the *newest* message. Reading only the default first page finds no ask on any session with a hundred messages behind it — which is every session that has been working a while — so the badge lights over an empty inbox row, or the answer finds no target, reports "no longer waiting", and the agent stays parked for ever. The page count is the length of the page rather than a total, so there is no jumping to the end
- Both loops have a ceiling, and passing it is logged. A caller cannot tell a truncated list from a complete one, which is the other half of why a delete is confirmed rather than inferred from an absence

## Other rules worth knowing

- **A create carries the desktop's own task id as an external reference**, so a create retried after a lost response returns the first task rather than making a second one, and a reinstall can re-bind by reference instead of by matching titles. The subtask route ignores it — a retried subtask create makes a second subtask, recorded here rather than papered over
- **A subtask is never sent without its parent's binding.** A subtask posted to the top-level route would be created at top level and look like a success
- **A pushed assignee is always a remote agent.** `selected_agent_id` is one of the service's own agent ids; a desktop agent's id means nothing there, and sending it would either be refused or — worse — match somebody else's agent. An assignee of any other kind is `invalid_request`, and a pulled assignee is always `remote_agent` for the same reason in reverse
- **The handoff note is re-posted, not edited.** Comment streams are append-only there, and a note's history is worth keeping
- **What goes out is this app's vocabulary; what comes back is the service's.** A comment type on the way in is an open string, because refusing a word cinna's own agents chose would be the desktop arguing with the system doing the work
- **A declined question still posts a sentence saying so.** There is no "reject" for a tool question, and the flag is what the agent is waiting on — leaving it unanswered parks the session for ever. The same reasoning the local runner uses when it records a real refusal on expiry rather than abandoning the request
- **An answer with nothing in it still says something.** An empty body is refused by the message route, and the ask would stay open for ever
- **A permission resolution has nowhere to go.** cinna-core parks on questions and nothing else, so a permission reply arriving at `answerAsk` is a call site that mixed up two asks, not a service that cannot take it
- **A timestamp with no zone is UTC.** The service serialises naive UTC datetimes, and JavaScript reads a zoneless string as *local* time — which on a machine east of Greenwich makes every pulled task look hours older than it is and, through the cursor, hides the change that produced it
- **`action_required_count` is a probe, not a quantity.** It is profile-wide, it raises two rows per ask, and it is gated on a read flag only the web clears. It is still the right answer to "is anything waiting over there" — one cheap call, with none of the cursor's blind spot for comment-only changes — but it is not a count any surface can print beside its own rows

## Transport and Inbox Delivery

The production JSON transport in `src/main/services/cinnaApiService.ts` aborts each request after thirty seconds, including proxy resolution and a stalled response body. GET/HEAD use Electron fetch. Mutations use `src/main/services/cinnaWriteFetch.ts` and the pinned production `undici` dependency: each call owns an Agent or ProxyAgent with pipelining disabled and `idempotent: false`. Only decompression is installed as an interceptor, including for error responses. Redirects are refused; the complete body and HTTP status/headers are retained before the private dispatcher is destroyed. No shared dispatcher or Electron connection pool is reset.

Electron's buffered writes replayed a complete POST after a dropped warm connection. Its chunked alternative prevented that replay but crashed Chromium Network Service and broke later reads. Mutations therefore use Node's HTTP stack. Proxy routing still comes from Electron's `defaultSession.resolveProxy`: only the first DIRECT, PROXY or HTTPS route is supported. An unsupported route, including SOCKS, fails before dispatch rather than bypassing the proxy or trying a later route. Node default and system CA certificates supply the private TLS trust set; TLS verification stays enabled. Chromium's cached proxy authentication, integrated NTLM/Kerberos and client-certificate callbacks are not inherited by this transport.

The credential-session generation and profile URL are checked again immediately before dispatch, after asynchronous proxy resolution. Preparation failures use `CinnaApiError('request_not_sent')`, mapped by the adapter to `invalid_request`; a dispatched network failure remains potentially accepted and follows handoff uncertainty rules. Proxy authentication failure does not retry directly. The Inbox has a separate ten-second user-facing deadline and retains its underlying operation until it settles; it does not assume a timed-out answer was never delivered. See [the Inbox](inbox.md) for binding-scoped request identities, identical-answer coalescing and conflicting-answer refusals.

## Classifying a failure

The whole taxonomy turns on `not_ours` (unbind for ever) against `rejected` (keep the binding), and on cinna-core both arrive as 400. Telling them apart needs two pieces of evidence the transport did not used to carry, so `CinnaApiError` now holds the **HTTP status** and the server's own **detail** sentence alongside its code. `status` is undefined only for a failure that never became a response — no profile, no server URL, a dead socket, an unparseable body — and that distinction is the point: "the request was refused" and "the request did not happen" are different answers. Both Cinna transports (`cinna-http.ts` and `cinnaApiService.ts`) set it, because an invariant documented on the class and true for only half the traffic is worse than no invariant.

| What arrived | Adapter code |
|---|---|
| no profile, no server URL, re-auth required | `unavailable` |
| 404, or a 400 whose body is exactly `Not enough permissions` | `not_ours` |
| any other 4xx | `rejected` — understood and refused; the task is still there |
| 5xx, or anything that never became a response | `unavailable` |

Uploads are classified in the wiring rather than in the adapter, because they do not go through the JSON transport at all: `cinnaFileService` throws its own error type with its own codes, and importing that type into the mapping would put a service dependency in the one file that must not have one. So `CinnaWorld.uploadFile` is contracted to reject with the seam's own error. An unreadable path is `invalid_request` — the service was never asked, and asking again will not help — while a 4xx from the upload route is `rejected`, since neither an unsupported type nor an oversized file improves on a retry, and everything else stays retryable. `CinnaFileError` carries a `status` for exactly this split: mapping the whole code one way means either a proxy hiccup loses the user's file, or a rejected file type becomes work every later push redoes first.

## What this deliberately does not do

- **It does not subscribe.** The answer endpoint returns a JSON stream-start result; later conversation events are emitted over the service’s WebSocket. The adapter posts the answer and never subscribes to those events
- **It does not model refinement.** `refining` is cinna's own flow, and the desktop does not drive it — which is one of the ways `taskStatusPath` can answer "there is no path"
- **It does not read attachments back.** The seam has no read half for artifacts, so a task's remote files are invisible here
- **It does not decide what a failure costs.** It classifies and rejects; whether that means a retry, a dropped marker or an unbind is [the sync service's](remote_sync.md) decision
- **It does not walk a status path.** It sends one step per call. Walking belongs one layer up, where the desktop's own view of the task is
- **Scheduling belongs to the coordinator.** The active-profile scheduler, job execution/run refresh and watched task pages call this adapter through [the sync service](remote_sync.md). The adapter owns mapping and transport behavior, not activation or timers.

## Architecture Overview

```
taskSyncService  ->  adapterFor('cinna')  ->  cinnaTaskAdapter.wiring.ts
                                                    |
                              createCinnaTaskAdapter(world)   <- the mapping
                                                    |
       world.request  -> cinnaApiFetch  -> cinna-core REST (bearer in main only)
       world.uploadFile -> cinnaFileService (multipart)  -> RemoteTaskError
       world.linked   -> userRepo (local row, never the network)
       world.serverUrl-> the profile's server, for the deep link
```

## Where it lives

- `src/main/tasks/adapters/cinnaTaskAdapter.ts` — `createCinnaTaskAdapter(world)`, `CinnaWorld`, `CINNA_ADAPTER_ID`, and every cinna field name in this repo outside the task-view feature
- `src/main/tasks/adapters/cinnaTaskAdapter.wiring.ts` — the production world, and the upload-failure translation
- `src/main/tasks/adapters/index.ts` — the registration, one import and one line at the foot of the registry
- `src/main/services/cinnaApiService.ts`, `src/main/services/cinna-http.ts` — the two transports, both of which now attach the status and the server's detail to `CinnaApiError`; `extractErrorDetail` is exported from the second and imported by the first rather than written twice
- `src/main/errors.ts` — `CinnaApiError.status`
- `src/main/services/cinnaFileService.ts` — `CinnaFileError.status`
- `src/main/tasks/adapters/testSupport/fakeCinnaServer.ts` — cinna-core in memory: the real routes, the real refusals, and the three behaviours the contract suite needs to provoke
- Tests: `src/main/tasks/adapters/cinnaTaskAdapter.test.ts` (the mapping), `cinnaTaskAdapter.wiring.test.ts` (the world), and two rows in `adapterContract.test.ts` — the real adapter over the fake server, linked and unlinked

## Integration Points

- [Remote Task Adapters](remote_adapters.md) — the seam, its capability set, and the contract suite this adapter is a subject of
- [Keeping a Bound Task in Step](remote_sync.md) — scheduled push/pull/reconcile, watched refresh, job handover and take-over checks
- [The Handoff Note, Exported](handoff_note_export.md) — the local half of the same note
- [Cinna Task Run View](../cinna_task_view/cinna_task_view.md) — the older, read-only path to the same server for a `cinna_task` job run
- [Cinna Accounts](../../auth/cinna_accounts/cinna_accounts.md) — where the bearer and the server URL come from
