# Team Sharing of Folder Agents

## Purpose

Let a team work on the same folder agent from several machines. A `Local/<slug>/` kit agent can be put in the active Cinna account's **Team library**; a teammate **Gets** it, both of them change it, and the app moves those changes between the machines with three verbs — **Update**, **Share changes**, and, when the two sides do not fit together, a two-button choice. Underneath it is git, and the user never has to know that.

## Core Concepts

- **Shared agent** — A kit agent directly under a root's `Local/` whose folder is **its own** git working tree with an `origin`. That is the whole definition: an agent a developer cloned by hand is recognised exactly like one the app fetched. A folder inside an enclosing repository (the workshop's), a bare agent, and an agent outside `Local/` are never shared
- **Team version** — What the team has: `origin`'s `main`. For a Cinna remote, the team-library listing's `head_sha` says where it is without a fetch
- **Team library** — Every agent shared with the active Cinna account's team, as `GET /api/v1/library` lists it, with the caller's access (`read`, `write`, `maintain`) and maintainers. Shown as a second source of the Agent catalog dialog
- **Remote kind** — `cinna` when `origin` is `https://<host>/git/<repo_id>.git` on the server of a Cinna profile this machine has; `external` for anything else (the user's own GitHub, GitLab or SSH remote, authenticated by their own git setup)
- **Get** — Fetch a library agent into the agents home's `Local/<slug>/`
- **Update** — Bring the team's changes in, when they apply cleanly
- **Share changes** — Record everything this machine changed under one note (pre-filled by an AI summary) and send it to the team
- **Share with the team** — Put a not-yet-shared agent in the Team library, in place
- **Use the team's version** — The answer to a collision: this folder becomes the team's version, and what was here is kept beside it as `<slug>-mine`, named "*Name* (my copy)"
- **Remove from this computer** — Deleting a shared agent: the folder goes to the Trash, the team's version is untouched

## User Stories / Flows

### Getting an agent from the team

1. On a Cinna account, **Agents → + → Install from catalog** opens the Agent catalog. A source switch above the grid reads **Cinna bundles | Team library**; it exists only while the account has a Team library, so any other account sees the dialog it always had
2. The Team library lists one tile per shared agent — name, description, maintainers — with **Get**, or, when this machine already has it, **Installed** and **Open**, or **Update available**
3. **Get** fetches the agent into `Local/<slug>/`, the dialog closes, and the user lands on the new agent's page. A refusal stays on the tile it came from and closes nothing
4. Opening the dialog re-reads the library, so what the user browses is the team's list as it is now

### Seeing where an agent stands

1. A shared agent's sidebar row carries a small people glyph, with a dot in it when there is something to share or to update
2. Its page has one quiet line under the header, saying exactly one of: **Up to date with the team**, **N changes you haven't shared**, **The team changed this agent**, **Share changes to combine yours with the team's — you both changed this agent**, **This agent is no longer shared**, **Shared on another account**
3. Beside it sit the buttons that state allows: **Update** when the team moved and nothing here is in the way of a clean combine, **Share changes…** when there is something of this machine's to send and the account may change the team's version

### Updating

1. **Update** — from the status line, the library tile, or the Inbox card — brings the team's changes in, and the agent's page, sidebar and catalog reflect them at once
2. Edits here that are not shared yet are in the way: Update refuses and says to share them first. Share changes brings the team's version in as part of sending
3. When the team changed this agent too and the two do not combine, the Inbox card and the library tile take the user to the agent page, where the choice lives

### Sharing changes

1. **Share changes…** opens one field, **What changed**, editable from the first frame with "Writing a summary…" as its placeholder. An AI summary of the changes fills it, unless the user has already typed
2. **Share** records everything not ignored, and sends it. If a teammate shared first, the app brings their version in and tries once more
3. If the two sets of changes do not fit together, the share dialog gives way to **The team changed this agent too**: **Use the team's version (keep mine as a copy)** or **Keep working on mine (share later)**. The recoverable one has focus
4. **Use the team's version** replaces this folder with the team's, keeps the old folder as "*Name* (my copy)", and says so in the page's note — naming any per-machine file (a credential, say) that could not be copied over

### Sharing an agent with the team for the first time

1. **⋯ → Share with the team…** on a kit agent that is not shared yet, on a Cinna account whose Team library answered
2. Name and description are pre-filled from the manifest; **Share** creates the agent in the library and sends this folder as its first version. The folder stays where it is
3. A folder that cannot be sent — busy with a turn, or already tracking a file that can hold a secret — is refused **before** the library entry is created, so a refusal leaves nothing on the server

### Removing a shared agent

1. **⋯ → Remove from this computer…** opens a dialog of that title: the folder goes to the Trash, the team's version stays in the Team library, and the user can Get it again any time
2. While this machine has changes the team does not have, main refuses and names up to three of the files: removing would lose them

### A teammate changed something

1. The Inbox lists **The team changed *X*** — who sent it and when, when the library says — with **Update**. The agent's name opens its page
2. After Update the card says **Updated.** and stays until the user leaves the Inbox

### A blocked job needs an agent the team has

1. A job bound to a folder agent this machine lacks is blocked ([Local Agents Are Not Synced](local_only.md)). When the Team library lists an agent with that dependency's manifest id, and this machine has no copy, its row offers **Get *X* from the team library**
2. After the Get the dependency resolves against the new folder and the job unblocks

## Business Rules

### Nothing about sharing is stored

Whether an agent is shared, where its team version lives, and which repository it is are read back from `origin` every time; the caller's access and the team's latest version come from the cached library listing, which is itself never persisted. There is no table, no column, no flag in the agent's desktop state. A stored "is shared" would disagree with the folder the first time a developer ran `git remote remove` in a terminal — and the folder is what the agent runs from.

### The library is polled, not pushed

Core has no realtime channel for library changes, so main lists the library when a Cinna profile becomes active (and on wake), every five minutes while it stays active, and on demand: when the catalog opens, and after Update, Share changes, Share with the team and Use the team's version. The renderer is told (`sharing:changed`) only when the set of agents, their heads or the caller's grants moved, not on every poll. Polling stops on profile switch, sign-out, sleep and an expired session; re-activation starts it again.

A listing is what lets a shared agent say **The team changed this agent** without a network fetch per folder per screen. For an `external` remote there is no listing, so its page fetches on open — at most once a minute per agent, whatever triggered the read.

### An instance without the library routes is an empty library

A `404` or a `403` from `GET /api/v1/library` is an **empty Team library**, logged once per host, not an error. The first is a Cinna server that does not have the routes yet; the second one that gates them by role. Treating either as a failure would show a broken source to every user of a server that simply does not offer the feature, and treating a `403` as a dead session would raise the re-auth prompt on every poll for a session that is fine.

### Words the user never reads

The sharing surfaces never say branch, commit, push, pull, merge, rebase, remote, repository, conflict or SHA. Every sentence lives in one map, and a test reads all of it against that list. The people this is for share an agent the way they share a document; a dialog that says "rebase failed — resolve conflicts" asks them to learn a tool before they can use the feature. The AI share summary is held to the same words (and "diff") by its system prompt.

### One state, decided in main

The status line shows one state, with this precedence: **other account**, **no longer shared**, **both changed**, **team changed**, **changes to share**, **up to date**. Main decides it; the renderer only chooses the sentence.

- **Shared on another account** — a Cinna remote on a server the *active* profile is not signed in to. Counts come from disk; no listing is read, no token is minted, nothing reaches the network. A token is only ever sent to the server that issued it
- **No longer shared** — the listing for that server loaded and no longer has the repository
- **N changes you haven't shared** — files that differ from what the team has: recorded-but-unsent versions and working-tree edits measured from the **merge base**, so a file only the team changed is never counted as the user's, plus new files the ignore rules do not exclude. A new file is a change to share; `credentials/.env` is not
- **The team changed this agent** — when the listing's head is not in this folder's history. Without a fetch the app may know only that the team moved, not by how much; the sentence is the same either way

### Update never resolves a collision, and never tries

Update is a fast-forward, or — when this machine has versions recorded but not yet sent — a rebase of those onto the team's that applies cleanly, or nothing at all: a rebase that stops is aborted and the folder is exactly as it was. Tracked edits refuse it as **dirty**, and so does an untracked file sitting where an incoming one would land.

The reason is the one [Agents Folder Updates](folder_updates.md) gives for a root: deciding whose work survives, in files an agent will next run from, is not something to do on the user's behalf. What changes here is the answer to "and then what": instead of "sort it out in your own tools", the user is offered **two buttons and never a diff**. Either choice keeps both versions.

### Share changes sends, and retries once

It records with `add -A` (honouring the ignore rules) under the user's note — or "Changes shared from Cinna Desktop" when the field is empty — then sends to `main`. A rejection because a teammate shared first is answered with one clean Update and one more send; a second rejection reads "The team version changed again while sending." **Never a force**: a force would overwrite what the teammate just shared.

A refusal from the server carries the server's own sentence; a `403` reads as "ask a maintainer for edit access". An account with `read` access is not offered Share changes at all.

### A file that can hold a secret is never sent

Before anything is recorded, two things are made true:

- **The kit's agent ignore rules are in the folder's own `.git/info/exclude`**, in one marked block, rewritten only when the kit's rules change. What `add -A` records must not depend on a `.gitignore` a teammate (or a developer's own repository) left in the folder. The same block is written into every clone before it becomes visible
- **No file that can hold a credential is already tracked** — anything the contract's `secret_files` rules call secret, and the desktop-owned `app-data/desktop.json`, which holds a bearer token. An ignore rule cannot untrack a file, so such a folder is refused (`secrets_tracked`), nothing is recorded or sent, and up to three of the files are named. The sentence asks whoever maintains the agent to remove them, because a non-developer cannot take a file out of the team's version

Sharing for the first time also writes the kit's agent ignore files the folder lacks, so an agent made before it was a repository does not send its secrets with the first share. A folder that is already its own repository is checked for tracked secrets **before** the library entry is created: a refusal after the entry existed would leave an empty agent in the team's library.

The AI share summary is held to the same line. Its text is built from the folder's differences with every tracked secret file left out, because the summary goes to whatever backend AI Functions resolves to — and the dialog drafts it *before* Share has had the chance to refuse the folder.

### The credentials and app-data folders never travel, whole

The contract's `shared_remote.never_travels` (1.8.0; until the bundled kit is synced to it, the same `credentials/` and `app-data/` the server enforces) names folders that never go to a shared remote **in full** — not just their secret files: the template's own `credentials/README.md` and `.env.example` included. The team library's server refuses any send carrying a file under them, in **any** new version, not only the latest.

- They are in the exclude block as `/credentials/` and `/app-data/`, and anything already recorded under them is dropped from what is recorded before every recording. The files stay on disk
- Before a send, when a version not yet sent recorded one of them — a first send the server refused, a developer's own history — the unsent versions are **folded into one** on top of the team's version (or as the first version), from what is recorded now. Only history nobody else has is rewritten; the working tree is untouched
- **Get** gives the fetched agent the template's `credentials/` and `app-data/` folders locally, only what is missing, since the team's version never has them

### Who a version is from

A repository or global git config that names someone keeps it — a developer's versions stay theirs. Otherwise the active Cinna profile's name and email; a profile without an email gets a no-reply address on the server's own host, built from the profile's local id; anything else an anonymous `.invalid` address. **Never this machine's login or host name**, which git would otherwise fill in and every teammate would then receive. Signing is switched off for versions the app records: a global `commit.gpgsign` would wait on a pinentry the app has no terminal for.

### The Cinna token reaches git only through the environment

A Cinna remote is authenticated with the active profile's access token as an `Authorization: Bearer` header, **minted immediately before each git child** and passed as `GIT_CONFIG_*` environment variables scoped to the remote's origin — never in argv, where any process listing shows it, and never in `.git/config`, where it outlives the operation. **Redirects are switched off** for those children: git's default follows a first-request redirect and then sends the rest of the operation, header included, to the new location. A Cinna git endpoint has no reason to redirect, so one that does fails as unreachable rather than handing over the token. Anything git prints is scrubbed of bearer headers, JWTs and URL passwords before it is logged or shown.

### An instance's git may live on another origin

cinna-core builds `clone_url` from its **backend** address, while a profile is often signed in through the web app's origin that proxies the API — `localhost:5173` against `localhost:8000` in development, an `app.` against an `api.` host in a deployment. So the git origin is **whatever the instance itself says**, and nothing else:

- A `clone_url` from a library listing or from the answer to creating an entry, fetched over that profile's session, teaches this machine that the instance's git lives at that origin. The list is kept **in main**, in `<userData>/team-library-trust.json`, so it holds from the first launch before any listing has loaded — not in the settings store, which the renderer can write, and never read from the folder
- A remote is the instance's (`cinna`), and takes its profile's token, only when its git origin is the instance's own or one that instance named. The header is scoped to that origin
- The folder records its instance in `.git/config` as `cinna.server`, which only **chooses between** instances that already trust the origin. `.git/config` is writable by anything running in the folder — an agent's own turn included — so a remote URL on its word alone would send the token wherever it pointed; such a remote is `external` and gets no token
- **Plain http** carries a token only when the instance itself is on http or the address is this machine (loopback). Anything but http(s) is refused

### A retry finishes the entry this machine left empty

The library entry is created before the folder is first sent, and its id is recorded in the same main-only file until that send succeeds. If the send fails, a retry hits the name already taken (`409`); when the entry with that name is **the one recorded**, still empty and still maintained by this account, the retry sends there. Any other entry under the name — a teammate's, one created elsewhere, one with content — stays a refusal with the server's sentence. An entry left empty by a build of the app before this rule has no record and has to be removed on the server.

### Get refuses anything already here

Get refuses when `Local/<slug>/` exists, or when an agent with the same manifest id is already on this machine — checked against the listing first, then against what actually arrived (the listing's id can be missing or stale), and the clone is removed. It clones into a hidden staging folder and renames it into place, so the scanner and the watcher never see half an agent and a failure leaves nothing. What arrives must have a `cinna-agent.json` at its root.

### Use the team's version keeps everything, and leaves one id per folder

- The old folder is renamed to `<slug>-mine` (or `-mine-2`, …), the team's version is cloned at the original path, and the kept copy gets a **fresh manifest id**, "(my copy)" after its name, and no `origin` — it is nobody's team agent. The original id stays with the team's version, so the chats bound to the agent follow the team
- **Per-machine files are carried over**: everything git ignores in the old folder — `credentials/.env`, `credentials.json`, `app-data/` — which no clone brings. Copied, not moved, so the kept copy still runs; only where the team's version has nothing at that path, so nothing that arrived is overwritten. Rebuildable folders (`.venv`, `node_modules`, `__pycache__`) are not carried. What could not be copied is named in the page's note ("Some of this computer's files didn't come across: …"), because the team's version may not run until the user puts, say, a credential back
- **Anything that fails part way puts the folder back** as it was before the click — id, `origin` and all. A clone that already landed is first renamed to a hidden dot-folder and only then deleted, so a delete that fails half way (a file held open) never leaves a partial clone carrying the original id at the agent's path. Two folders with one id is the state never allowed: the scanner would refuse one of them, and which one is a coin toss
- The agent's warm engine process is retired, because its working directory is now the kept copy

### Busy agents are not changed underneath

Update, Share changes, Share with the team and Use the team's version take the agent's turn lock exclusively and refuse while a turn runs ("nothing was changed"). Share with the team takes it too: the first share is an `add -A` of whatever is there. Get writes a folder no agent runs from yet. Update is not followed by a process restart: like a root update it changes files in place, and every turn reads them afresh.

### A shared agent's folder stays out of the workshop's repository

When a `Local/<slug>/` becomes its own repository inside a workshop that is itself one, its path is added to the workshop repository's `.git/info/exclude` — per clone, never committed — so it does not appear there as an untracked directory or, after someone's `git add -A`, a stray nested entry.

### What it deliberately does not do

- **No diff view, no merge tool, no history.** A user who wants those has their own tools, and the folder is an ordinary repository they can open with them
- **No realtime.** A teammate's share reaches this machine at the next five-minute poll, or when the catalog opens
- **No sharing of bare agents** or of agents outside `Local/`: they are not the kit shape the library and Get produce
- **Root-level updates are unchanged.** A whole agents folder that is a git repository still gets only [Agents Folder Updates](folder_updates.md)' fast-forward

## Architecture Overview

```
Catalog (Team library) / status line / ⋯ menu / Inbox card / blocked-job row
  → useSharing hooks → window.api.sharing.* → sharing:* IPC (activation gate, settings scope)
      → sharingService (core: resolves every folder from an agent id)
          → gitService share verbs (execFile git, token env per child)
          → libraryService cache  ← GET /api/v1/library, every 5 min while active
          → POST /api/v1/library/agents (Share with the team)
      → rescan + sharing:changed → renderer invalidates sharing, agents, Inbox
```

## Integration Points

- [Agents Tab & Agent Page](agents_tab.md) — the sidebar glyph, the status line, the ⋯ menu's **Share with the team…** and **Remove from this computer…**
- [Bundles Catalog](../bundles_catalog/bundles_catalog.md) — the Agent catalog dialog the Team library is a source of
- [Agents Folder Updates](folder_updates.md) — the root-level git panel, whose never-write rule still holds for roots
- [Local Agents Are Not Synced](local_only.md) — the product position this is a deliberate exception to, for shared agents only
- [The Inbox](../../jobs/tasks/inbox.md) — the **The team changed *X*** cards
- [Jobs](../../jobs/jobs/jobs.md) — the blocked-job row's **Get *X* from the team library**
- [AI Functions](../../llm/ai_functions/ai_functions.md) — the share summary
- [Kit Contract & Manifest Layer](kit_contract.md) — the agent ignore template and `secret_files` rules sharing enforces
- [Agents Home, Scanner & Folder Index](folder_index.md) — the rescan every action ends with, and the turn lock the writing verbs take
- [Native Client Data Sync](../../sync/data_sync/data_sync.md) — a different thing: profile data, end-to-end encrypted. Team-library agents are not
- Sub-doc: [Technical Details](team_sharing_tech.md)

## Not verified

- **Barely run against a real Cinna server.** The server half — the git host at `/git/<repo_id>.git` and the library API (`GET /api/v1/library`, `POST /api/v1/library/agents`) — was built in parallel against the agreed interface. One run of Share with the team against a local cinna-core found the git-origin mismatch above; the rest of the flow (send, Get, Update, push refusals) has not been observed end to end
- The git verbs are covered by unit tests over real repositories (bare remotes, two clones, the real binary) and a local HTTP server that checks the header scoping and the redirect refusal. The service is tested over real folders with the library and token mocked. No end-to-end spec drives these surfaces yet
- That a `403` from the listing means "this role has no library" rather than "this session is broken" is an assumption about the server's behaviour
