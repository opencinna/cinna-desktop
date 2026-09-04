# Folder Agents as Counterparties

## Purpose

A **counterparty** is an agent the user picks and then expects an answer from. This slice (Phase 7c of Local Agents) makes a folder agent one of those everywhere the app offers a choice: the composer's `@` picker and `[+]` capability picker, the Jobs agent picker, the `#` example-prompt list, the description an orchestrating model reads about it, and a job's synced dependency list on a second device.

Nothing here builds a new way to run a folder agent — [the runner](agent_turn.md) already existed and [a status tile could already start a chat with one](../agent_status/agent_status.md). What existed was a set of surfaces that refused to offer the agent, and a set of surfaces that offered it while knowing nothing about it.

## Core Concepts

- **Counterparty** — An agent the user picks and expects an answer from. Every **enabled** agent is one; the pickers filter on `enabled` and nothing else. `enabled` means only the user's own choice.
- **Counterparty exclusion** (removed) — The named predicate that kept folder agents out of the two pickers while no local runner existed. Deliberately never expressed by clearing `enabled`, which is why lifting it was a deletion rather than a migration of anyone's saved state.
- **Synthesized metadata** — The `agents.remote_metadata` blob a folder row now carries, built from that folder's `cinna-agent.json` at scan time. Same column as a remote agent's backend-supplied metadata, entirely different provenance.
- **Folder job dependency** — The portable descriptor a job carries for an attached folder agent, keyed on the agent's **manifest id**. Alone among the descriptors that resolve against *this machine's* own resources, it creates nothing when it cannot be resolved.
- **Workshop** — An agents root: the registered directory a folder agent lives under. "The workshop is not on this device" is the thing a folder dependency can fail on, and the repair is copying a directory.

## User Stories / Flows

### Attaching a folder agent to a chat

1. The user types `@` in the composer, or opens `[+]` → **Add agents / MCP**.
2. Every enabled agent is listed — folder agents beside remote and hand-added A2A ones. There is no source filter.
3. Picking one attaches it through the ordinary on-demand path (`chat_on_demand_agents`), so a lone folder agent with no MCPs derives the **A2A** pattern and talks to the local engine directly, while a folder agent alongside anything else is orchestrated and reached as an emulated MCP tool.

**The surface that was missing was not a row — it was the menu.** The `@` popup and the `[+]` menu are gated on the filtered agent list being non-empty. For a user whose only agents are folder agents, that list was empty, so neither control appeared at all. That is the local-only user this whole feature exists for, and the symptom was an absent menu rather than an incomplete one.

### Seeing what a folder agent is for

1. The user selects a folder agent on the new-chat screen. Its example prompts fade in as a tag cloud; clicking one starts a chat with that prompt.
2. Inside any chat bound to it, `#` opens the same prompts as a picker.
3. The hint bar treats the agent as one that has prompts to teach.
4. In an orchestrated chat, the **model** reads the same prompts, appended to the tool description it is given for that agent.

All four read one field. Before it was filled, all four were silently inert for a folder agent — three visibly (nothing rendered) and one invisibly (a thinner tool description, with nothing on screen to say so).

### Depending on a folder agent from a job, on two devices

1. The user attaches a folder agent to a job on the machine that holds the workshop. The job runs normally.
2. The job syncs. Its dependency manifest carries a descriptor naming the agent's **manifest id** — the `id` inside `cinna-agent.json`, which both machines would derive identically if both held the folder.
3. On a peer that has the workshop, the descriptor resolves to the local row and the job is attached to the real agent.
4. On a peer that does not, **nothing is created**. The job's detail view lists the dependency as **unavailable**, with no "Set up" button, because no page in the app can produce a directory.

### Repairing a job after "Stamp identity"

1. The user stamps a legacy folder agent's identity — the app's own recommended cure for a folder that would otherwise lose its chats when renamed. Its row id changes from a positional `folder:legacy:…` to `folder:<uuid>`.
2. Every job that depends on it has its stored dependency manifest repaired in the same action: the descriptor naming the old identity is dropped and the manifest is rebuilt from the join rows.
3. The job keeps working and stops claiming it needs setup.

**This is a repair to behaviour that shipped broken, not a new feature** — before it, stamping left every dependent job permanently claiming an agent needed setup while that agent sat there working, with no action available that would clear it.

## Business Rules

### The exclusion, and why removing it was one line

- The restriction was a **capability gap** — no local runner — and was carried by a predicate of its own rather than by the `enabled` column. Had it borrowed `enabled`, "the user turned this off" and "this could not run yet" would have become indistinguishable at exactly the moment one of them stopped being true, and nothing could have safely turned back on the agents that were only ever off because the feature did not exist.
- The three groups of consumers behaved differently, and only one needed changing. Anything that looks an agent up **by id** for display was always correct for a folder agent. Anything that **runs** one was made correct by the runner. Only the two pickers, which **choose** one, carried the exclusion.
- Removing it does not add a capability; it removes an inconsistency. A folder agent could already be started from a status tile, which resolves the preselected id against the unfiltered list and so never met the exclusion.
- A folder agent files under **"Local"** in the Jobs picker. Not a matter of taste: it is a property of *this machine*, which is also how it is scoped for lookup, while the other groups are all cinna-server target types.
- Its meta tag in that picker reads **`LOCAL-FOLDER`** — the protocol name upper-cased, where a remote agent reads `A2A`. Accurate, ugly, deliberate; recorded here so it does not read as a defect on first sight.

### Synthesized metadata: which kind of row you are looking at

- **`remote_metadata` on a folder row is synthesized locally and is not remote anything.** The column was built for agents fetched from a Cinna backend, and for a folder row it holds a reduction of `cinna-agent.json` computed on this machine. Every statement about that column has to say which kind of row it means, because the name is now accurate for only half of them.
- **This is documentation debt, not a live defect, and the difference was checked rather than assumed.** All eleven non-test read sites were swept: every consumer that could infer backend provenance is already gated on `source === 'remote'` before touching the column, the two that are shared read named **fields** rather than testing the object for **presence**, and there is no truthiness test on the column anywhere. A future consumer that adds one would be the first thing to break.
- It is a **cache over the folder's files**, in exactly the sense the `name` and `description` columns beside it are, with the same staleness bound the scanner gives them. That is why it is persisted at scan time rather than derived on read: deriving would create a row that renders a cached name next to live prompts.
- Only `example_prompts` is populated. The other four fields are `null`/`[]` **on purpose**, not for want of a mapping. A folder agent's entrypoint is a *document* already assembled into its system prompt, not the short prefill string this field means on a remote agent; `router_trigger_prompt` is a third concept again; nothing in the manifest corresponds to session mode or colour preset; and a folder agent speaks no A2A protocol version at all. Mapping any of them would hand the first future consumer a silently wrong meaning with nothing to flag it.

### No `cinna_mcp` descriptor is emitted, deliberately

- `cinna_mcp` is the one **optional** field on the metadata shape, and the agents-as-MCP provider already has a better answer when it is absent: the tool slug falls through to the agent's row name, the input schema to the default one, and the description to `fallbackDescription()`, which frames the agent for the orchestrating model *and then* appends its own description and up to three examples.
- **Emitting one would have made that worse.** A descriptor's `description` wins the fallback, so filling it with the manifest's human-facing blurb would replace the model-facing framing with the blurb. The plan asked for the descriptor; building it would have degraded a path that already worked.
- It is also not a special case. The remote write path already omits the key when a backend supplies no descriptor, so a folder agent is stored in exactly the shape that path already produces.

### What bounds the prompts, and why the bound is not about the picker

- At most **20** entries of at most **500** characters each — the manifest schema's own limits, held as shared constants so the two places that enforce them cannot drift.
- **Over-long and malformed entries are dropped, never truncated.** A truncated prompt is a third thing, neither what the author wrote nor absent, and it would arrive in the user's composer as a message they did not write.
- **The cap counts survivors, not raw entries.** A manifest holding twenty blank entries followed by one real prompt yields the real prompt. Both orderings satisfy "at most twenty"; only one of them serves the user.
- The reason the caps exist is the **tool description**, not the `#` list: it takes three examples and caps their length not at all, so three unbounded prompts are spent as model context on every turn of every orchestrated chat, with nothing on screen mentioning example prompts.
- The validator reports all four of these violations, and that is not a substitute. **Reporting is not blocking**: a finding is written into the agent's validation state and the row is indexed anyway. Anything downstream that must not receive junk has to reject it itself.

### A folder dependency is the only *device-local* one that does not auto-create

Stated carefully, because the loose version is wrong in a way that matters. Two descriptor kinds resolve against **this machine's** own resources — an MCP provider and a hand-added local A2A agent — and both auto-create. A folder agent is the third of that group and is the one that does not. A **remote** agent resolves against a *server account* rather than against local state and was never auto-creatable either, so it is not a counter-example to the rule; it is a different question. A **chat mode** falls back to the default mode rather than creating one.

- A **local A2A agent** or an **MCP provider** auto-creates a disabled, not-connected shell in Default Scope, so a miss there is `needs-setup`: the row exists and the user finishes configuring it.
- A **folder agent** creates nothing. It *is* a directory on disk, and a shell row would assert one is present here. A miss is therefore **`unavailable`** — "cannot be resolved on this device" — the same state a remote agent from a server this profile is not on gets, for the same reason.
- `needs-setup` is kept for the one folder case the app can act on: the row is here and the user has switched it off.
- **The two states are not cosmetic**, because the "Set up →" button is gated on the amber `needs-setup` state. Calling a missing workshop `needs-setup` offered a button that could not lead anywhere.
- The button is additionally gated on the dependency having **resolved to a local id**, and routed on whether that id is a folder agent's — a folder agent goes to Settings → **Local Agents**, everything else to Settings → **Agents**, which is correct for the auto-created shells because those are hand-added-A2A-shaped by construction. A folder agent appears on Settings → Agents under no circumstances.
- That local-id gate is **not** folder-specific and was not dead once `unavailable` took the folder case away. The MCP and local-agent arms both resolve without auto-creating, so a shell the sync created and the user later **deleted** comes back amber with nothing to open — the same dead button, in two places that predate all of this work.

### The cross-device gap was a silent wrong run, not a limitation

- Before the folder descriptor existed, a folder agent's dependency could not be encoded at all: the descriptor builder ends on a card-or-endpoint URL and a folder row has both null. The dependency was **dropped from the manifest entirely**, so the peer reported the job as fully set up, rebuilt it with no agent, derived the plain-LLM pattern from an empty agent list, ran it, and recorded a success. **A wrong run reported as a success is worse than a job that refuses to start.**
- The descriptor is emitted even for an **unstamped** folder agent, whose id is positional (`legacy:<rootId>:<name>`) and names a directory on one machine. It resolves on the device it came from and cannot match on a peer — which is the point: an unresolvable dependency the user can see beats an invisible one.
- **A dropped field in a sync layer is not a local loss — it replicates.** A peer that cannot resolve a dependency re-encodes the job from what it has, so without a carry-forward it would hand a third device the job one dependency lighter. The carry-forward now covers folder descriptors as well as remote ones, which is what stops the original defect from copying itself onward.
- The manifest is also where a **stamped** identity used to strand a job. See the flow above; the repair drops the one descriptor naming the agent's previous identity, at the only place that identity is still knowable.

### What is still true after all of this

- **The silent wrong run is still live, and 7c did not close it.** Running a local job reads the `job_agents` join rows and nothing else — never the manifest, never the dependency states, never the `needsSetup` flag. On a device without the workshop the join row is *absent* rather than dangling, so the missing-dependency error does not fire, the plain-LLM pattern is derived, and the run completes and is recorded as a success. What changed is that the condition is now **visible on two surfaces** if the user looks. Whether to block the run, warn and confirm, or annotate the run as degraded is a product decision.
- The sidebar's amber warning glyph shares its slot with the run button and is **hidden while hovering** — which is exactly when the user is reaching for Run.
- The stamp repair is **outbound only**. It corrects this device's manifests and does not mark the job edited, so it does not propagate until the job is next changed. A peer that already received the stale descriptor keeps it, and if that peer edits the job first its own carry-forward sends the ghost back.
- The one place a folder dependency silently leaves a job on a peer now **logs** it, matching the local-agent arm beside it, which had always logged its auto-create. The equivalent drop inside the descriptor builder is unreachable today — every producer of a folder row id builds it from the prefix — and is logged as a latent trap rather than left silent.

## Architecture Overview

```
Manifest → row (one field, four surfaces)

  cinna-agent.json
    → scanner / watcher rescan  (manifest already parsed here)
      → synthesizeFolderAgentMetadata
        → FolderIndexEntry.remoteMetadata   (required field: all three writers carry it)
          → agents.remote_metadata
            ├─ composer '#' popup            \
            ├─ new-chat tag cloud             |  extractExamplePrompts
            ├─ hint context                  /
            └─ A2AAsMcpProvider.getTools() → the description the orchestrating model reads

Picking a counterparty

  useAgents() (unfiltered)
    → filter(a.enabled)   ← the only filter left
      ├─ composer '@' popup
      ├─ '[+]' capability picker      → chat_on_demand_agents → derivePattern → runner or orchestrator
      └─ Jobs agent picker            → job_agents

A job's folder dependency, across devices

  origin:  job_agents row → agentRowToDescriptor → {source:'folder', manifestId} → jobs.sync_deps
  peer:    sync_deps → resolveFolderAgent (settings scope, point lookup, no auto-create)
             ├─ hit  → job_agents row rebuilt
             └─ miss → nothing created, descriptor kept, logged,
                       dependency listed as 'unavailable' (no button)
```

## Integration Points

- [The Agent Turn Runner](agent_turn.md) — what actually answers once a folder agent is picked. This slice adds no dispatch of its own; jobs inherit the resolver by not dispatching at all.
- [Agents Home, Scanner & Folder Index](folder_index.md) — where the synthesized metadata is computed and which writers carry it, and the `enabled` rule that made the exclusion removable in one line.
- [Agents Tab & Agent Page](agents_tab.md) — the page whose chat controls were disabled for the same reason, and the "Stamp identity" action whose job repair is described above.
- [Example Prompts](../../chat/example_prompts/example_prompts.md) — the three renderer surfaces the synthesized field lights up.
- [Orchestrated Agents](../../chat/orchestrated_agents/orchestrated_agents.md) — the fourth: the emulated-MCP tool description, and the fallback that made emitting a descriptor the wrong move.
- [Composer `[+]` Menu](../../chat/composer_menu/composer_menu.md) — the second door onto the same on-demand path, opened by the same deletion.
- [Jobs](../../jobs/jobs/jobs.md) — attaching a folder agent, and the dependency states the detail view renders.
- [Native Client Data Sync](../../sync/data_sync/data_sync.md) — the portable-dependency model this adds a variant to, and the auto-create rule this is the exception to.
- [Agent Status](../agent_status/agent_status.md) — the status tile that could start a chat with a folder agent before either picker would offer one.

Sub-doc: [Technical Details](counterparty_tech.md)
