# Local Agents Are Not Synced

## Purpose

One place to state a product position that four other documents were quietly contradicting, so it does not have to be re-derived — or re-lost — in each of them. **A folder agent lives on one machine. A job bound to one is a local-only job.** The `source: 'folder'` job-dependency descriptor exists so that fact is *visible and blocking* on any other machine, not so the job runs there.

This doc is a position, not a feature. It has no `_tech` sibling because it has no implementation of its own — the mechanisms it governs are documented in [Folder Agents as Counterparties](counterparty.md), [Jobs](../../jobs/jobs/jobs.md) and [Native Client Data Sync](../../sync/data_sync/data_sync.md), which all link here rather than restating it.

## The position

- **A folder agent is a directory on disk, and the desktop's own sync never carries it.** `syncEngine` moves notes and jobs; there is no collection for agent folders, no device-to-device transfer of one, and no "copy this agent to my other machine" flow. (Publishing an agent *to a cinna-server instance* is a different question with its own contract — see [Cinna Core Handover](cinna_core_handover.md) — and it is not a path between two of the user's machines.)
- **A job that depends on one is therefore local-only.** It runs on the machine that holds the folder. On any other machine it is **blocked**, by design, and the app says so.
- **The one legitimate re-resolve is the same machine.** After a re-auth, a profile switch, a reinstall, or a sign-out and back in, a job on *that same machine* re-attaches to *that same folder* if the folder is still where it was. This is the case the manifest id is actually for.
- **Resolving on a *peer* is a mechanism, not a supported workflow.** Two machines that happen to hold folders with the same `cinna-agent.json` `id` will both resolve the descriptor, because the id is the key and the key matches. That is a property of the lookup, not a promise. It is undesigned, untested across a real device pair, and must not be documented as a way to use the product.
- **The undesigned part is *matching*, not syncing.** The open question is not "how do we ship the folder" — it is what it should *mean* for a local agent on machine A to correspond to one on machine B. Same manifest id? Same path? Same content? Until that has an answer, no surface may imply the correspondence exists.

## What the app says, and what it deliberately does not

The blocked-job panel (`src/renderer/src/components/jobs/JobDetail.tsx`) states the condition and stops:

> This job needs an agent that isn't available on this device, so it can't run here.

It gives **no repair instruction**, and this is load-bearing:

- It does **not** say "copy the agent's folder here." That happens to work today, which is exactly what makes promising it dangerous — it would document an unshipped, unmatched, untested workflow as the supported cure.
- It does **not** say "it will run on a device where that agent is set up." That names a device the app cannot know exists. The state is reachable by a **single user on a single machine who has never enabled sync**: `rebuildJobManifest` (`src/main/sync/manifest.ts:108`) runs on job create and on every agent/MCP/mode change, gated on neither sync being active nor the profile being a Cinna one, so attaching a folder agent and then moving or deleting its directory blocks the job on the only machine there is.
- A hedge does not rescue it. "It *may* run on a device where that agent is set up" is still a claim about a device that need not exist; softening a sentence that is false for a whole class of users leaves it false and makes it harder to notice.

The refusal itself lives in main (`src/main/services/jobService.ts` `executeLocal`) and its message names the missing agents. Same discipline: it stops at what is true.

**So the docs and the UI now have to agree.** A doc sentence that promises what this panel refuses to promise is a defect in the doc, not a gap in the panel.

## Why a sentence can be accurate and still wrong

Worth naming, because this position was established *after* the code, and four sentences that were mechanically correct became overclaims the moment it existed:

- `counterparty.md` described "a job's synced dependency list on a second device", a flow called "Depending on a folder agent from a job, on two devices", and a step reading "On a peer that has the workshop, the descriptor resolves to the local row and the job is attached to the real agent."
- `data_sync.md` listed the folder agent among the **portable identities**, beside a remote agent's backend UUID and an MCP's normalized URL.

Every one of those is a true statement about the resolver. Together they describe a cross-device workflow the product does not have. **Nothing in the code changed to make them wrong — someone decided what the feature was for.** That is a distinct category from ordinary drift: there was no commit to notice, no symbol to grep, and no test that could fail. The only thing that catches it is reading a claim against the current product position rather than against the current code.

The repair in each case was to the **framing, not the facts**: the descriptor still exists, still keys on the manifest id, and still resolves wherever the key matches. What changed is what the surrounding sentences say that is *for*.

## Business Rules

- **`unavailable`, not `needs-setup`.** A folder dependency that does not resolve here creates nothing — no shell row, no placeholder. A shell would assert a directory is present on this machine when it is not. `needs-setup` is reserved for the case the app can act on: the row is here and the user switched it off.
- **No "Set up →" button on an unavailable dependency.** There is no page in the app that produces a directory, so the button would lead nowhere. This is a consequence of the position, not a missing feature.
- **The block is recomputed in main, not trusted from the DTO.** `JobData.incompleteSetup` tells the renderer so the Run button can be disabled before the click; `executeLocal` asks the manifest again so a renderer working from a stale list still cannot start a run.
- **Blocking covers agents only.** An MCP or a hand-added local A2A dependency auto-creates a disabled shell the user finishes *inside the app*, so blocking those would break the ordinary sync-then-configure path. See [Folder Agents as Counterparties](counterparty.md) for the full boundary and the one case knowingly left open.

## Integration Points

- [Folder Agents as Counterparties](counterparty.md) — the descriptor, the resolver, the dependency states, and the run refusal
- [Jobs](../../jobs/jobs/jobs.md) — the Run button, the sidebar marker, and the blocked-job panel
- [Native Client Data Sync](../../sync/data_sync/data_sync.md) — the portable-dependency manifest this is the exception inside
- [Agents Home, Scanner & Folder Index](folder_index.md) — what a folder agent *is*, and why it cannot be a row without a directory

## Not verified

- **This position has never been exercised across a real device pair.** No folder-agent job has crossed two real machines. Every claim about peer behaviour is inference from `resolveFolderAgent` plus unit tests against in-memory SQLite (`src/main/sync/resolveFolderAgent.test.ts`).
- **The same-machine re-resolve is likewise reasoned, not observed.** No reinstall-and-reattach has been run in a real app. Checked at `12686f0` on 4 Sep 2026 by reading `resolveFolderAgent` and `agentIdentityKey`; the claim is that the manifest id is stable across those events, which is a property of the file on disk, not of anything the app persists.
