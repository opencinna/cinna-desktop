# Team Sharing of Folder Agents

## Purpose

Let a team work on the same folder agent from several machines. A `Local/<slug>/` kit agent can be put in the active Cinna account's **Team library**; a teammate **Gets** it, both of them change it, and the app moves those changes between the machines with three verbs — **Update**, **Share changes**, and, when the two sides do not fit together, a two-button choice. Underneath it is git, and the user never has to know that.

## Core Concepts

- **Shared agent** — A kit agent directly under a root's `Local/` whose folder is **its own** git working tree with an `origin`. That is the whole definition: an agent a developer cloned by hand is recognised exactly like one the app fetched. A folder inside an enclosing repository (the workshop's), a bare agent, and an agent outside `Local/` are never shared
- **Team version** — What the team has: `origin`'s `main`. For a Cinna remote, the team-library listing's `head_sha` says where it is without a fetch
- **Team library** — Every agent shared with the active Cinna account's team, as `GET /api/v1/library` lists it, with the caller's access (`read`, `write`, `maintain`) and maintainers. Shown as a second source of the Agent catalog dialog
- **Remote kind** — `cinna` when `origin` is `…/git/<repo_id>.git` on a git origin that the instance of a Cinna profile on this machine uses: either its own origin or one it named itself (see [An instance's git may live on another origin](#an-instances-git-may-live-on-another-origin)). `external` covers anything else (the user's own GitHub, GitLab or SSH remote, authenticated by their own git setup)
- **Get** — Fetch a library agent into the agents home's `Local/<slug>/`
- **Update** — Bring the team's changes in, when they apply cleanly
- **Share changes** — Record everything this machine changed under one note (pre-filled by an AI summary) and send it to the team
- **Share with the team** — Put a not-yet-shared agent in the Team library, in place, for the people chosen and nobody else
- **Use the team's version** — The answer to a collision: this folder becomes the team's version, and what was here is kept beside it as `<slug>-mine`, named "*Name* (my copy)"
- **Share badge** — A shared agent's state with the team, as the first badge in the agent page's chat-mode row of runtime badges, with **Update** and **Share changes…** beside it when the state allows. A click opens the Sharing tab
- **Sharing tab** — The agent page's Settings tab for a shared agent, and only for one: **Where it's shared**, **People**, **History** and **Remove sharing**
- **People** — Who may get the agent from the Team library, and with what access: **Can use** (`read`), **Can edit** (`write`), **Maintainer** (`maintain`). The library entry's grants, read and written whole
- **Remove sharing** — Disconnect this folder from the team. It stays on this computer as an ordinary agent, history and all; a maintainer may also delete the entry from the library
- **Remove from this computer** — Deleting a shared agent: the folder goes to the Trash, the team's version is untouched

## User Stories / Flows

### Getting an agent from the team

1. On a Cinna account, **Agents → + → Install from catalog** opens the Agent catalog. A source switch above the grid reads **Cinna bundles | Team library**; it exists only while the account has a Team library, so any other account sees the dialog it always had
2. The Team library lists one tile per shared agent — name, description, maintainers — with **Get**, or, when this machine already has it, **Installed** and **Open**, or **Update available**
3. **Get** fetches the agent into `Local/<slug>/`, the dialog closes, and the user lands on the new agent's page. A refusal stays on the tile it came from and closes nothing
4. Opening the dialog re-reads the library, so what the user browses is the team's list as it is now

### Seeing where an agent stands

1. In chat mode, a shared agent's page shows a share badge first in the row of runtime badges under the path. It says one of: **Up to date with the team**, **N changes not shared**, **The team changed this agent**, **You and the team both changed it**, **No longer shared**, **Shared on another account**, or, when the read itself failed, **Couldn't check with the team**. Both changed, no longer shared and a failed read are in the warning colour. The full sentence is its tooltip
2. Beside it sit the buttons that state allows, at the badges' height: **Update** when the team moved and nothing here is in the way of a clean combine, **Share changes…** when there is something of this machine's to send and the account may change the team's version
3. Clicking the badge opens **Settings → Sharing** and moves focus to that tab. There the same state is the full sentence (**N changes you haven't shared**, **Share changes to combine yours with the team's — you both changed this agent**, …), with the same two buttons beside it
4. The sidebar row carries nothing. Sharing is a fact about the agent, read on its page, not something to scan a list for

### The Sharing tab

1. **Where it's shared** — the state and its buttons, then: the server (a Cinna instance's host, which opens it in the browser, or **Your own server** and the remote's address for an `external` remote); for a library agent, its name in the library, its folder name, **Your access**, its maintainers, and **Last shared** *when* **by** *who* when the listing says. Opening the tab re-reads the library, so these are the library's facts as they are now
2. **People** — only for a Cinna team version on the active account that the library still lists. A maintainer sees everyone with access, each with an access select; a grant can also be **Everyone on this server** or **Everyone with the *X* role**, and is listed and removed like a person. Their own row reads **You** and has no remove, so taking themselves off is never one click away. Removing anyone else asks in the row (**Remove *X*'s access?** with **Cancel** and **Remove**), not in a dialog. **Share with a person…** opens a search by name or email: two characters at least, asked once typing settles, people who already have access left out. The person picked joins as **Can use** unless the select says otherwise. Anyone who is not a maintainer sees only the maintainers and **Only a maintainer can change who has access.**
3. **History** — this folder's versions, newest first, at most thirty: each version's note, who recorded it and when. A version recorded here and not on the team version yet carries **Not shared yet**. It is a list to read; nothing in it is clickable
4. **Remove sharing** — last, and asking before it does anything (below)

### Updating

1. **Update** — from the share badge, the Sharing tab, the library tile, or the Inbox card — brings the team's changes in, and the agent's page, sidebar and catalog reflect them at once
2. Edits here that are not shared yet are in the way: Update refuses and says to share them first. Share changes brings the team's version in as part of sending
3. When the team changed this agent too and the two do not combine, the Inbox card and the library tile take the user to the agent page, where the choice lives

### Sharing changes

1. **Share changes…** opens one field, **What changed**, editable from the first frame with "Writing a summary…" as its placeholder. An AI summary of the changes fills it, unless the user has already typed
2. **Share** records everything not ignored, and sends it. If a teammate shared first, the app brings their version in and tries once more
3. If the two sets of changes do not fit together, the share dialog gives way to **The team changed this agent too**: **Use the team's version (keep mine as a copy)** or **Keep working on mine (share later)**. The recoverable one has focus
4. **Use the team's version** replaces this folder with the team's, keeps the old folder as "*Name* (my copy)", and says so in the page's note — naming any per-machine file (a credential, say) that could not be copied over

### Sharing an agent with the team for the first time

1. **⋯ → Share with the team…** on a kit agent that is not shared yet, on a Cinna account whose Team library answered
2. The dialog asks two things: a **Name**, pre-filled from the manifest, and **People**, found by name or email and each added as **Can use** unless changed. The list starts as **Only you, for now.** There is no description field: the manifest's description is sent as it is. **Share** creates the agent in the library, limits who can get it to the sharer (as maintainer) and the people chosen, and only then sends this folder as its first version. The folder stays where it is
3. An agent whose team version was **deleted from the library** is offered Share with the team again. Its badge reads "No longer shared". Main first re-reads the library rather than trusting the cache. The restart goes ahead only when all three hold:
   - that read was a real listing, not a `404`/`403` standing in as empty
   - it does not list the entry
   - the old link is a Cinna remote of the active profile's instance

   The old link (`origin`, and the `shared_remote` link in `desktop.json`) is dropped **only once the new library entry exists**. A refused preflight or a failed create therefore leaves the folder linked to its old team version, exactly as it was. The folder's history stays: each version keeps its note, author and date, and only `credentials/` and `app-data/` are taken out of it (see [never travel](#the-credentials-and-app-data-folders-never-travel-to-a-team-library-whole))
4. A folder that cannot be sent — busy with a turn, or already tracking a file that can hold a secret — is refused **before** the library entry is created, so a refusal leaves nothing on the server

### Removing a shared agent

1. **⋯ → Remove from this computer…** opens a dialog of that title: the folder goes to the Trash, the team's version stays in the Team library, and the user can Get it again any time
2. While this machine has changes the team does not have, main refuses and names up to three of the files: removing would lose them

### Removing sharing

1. **Settings → Sharing → Remove sharing…** opens a confirmation in the danger tone, focused on **Cancel**. It says what stays first: the folder, its files and its history stay on this computer, the agent becomes an ordinary one that can be shared again later, and teammates keep their own copies
2. A maintainer of an entry the library still lists also sees an unchecked **Also delete it from the team library — teammates can no longer get it**
3. **Remove sharing** disconnects the folder; the badge and the Sharing tab go, and the page's note says *X* **is no longer shared with the team.** A refusal stays in the dialog and closes nothing
4. Unshared changes do not stop it, unlike Remove from this computer: nothing on this machine is lost

### A teammate changed something

1. The Inbox lists **The team changed *X*** — who sent it and when, when the library says — with **Update**. The agent's name opens its page
2. After Update the card says **Updated.** and stays until the user leaves the Inbox

### A blocked job needs an agent the team has

1. A job bound to a folder agent this machine lacks is blocked ([Local Agents Are Not Synced](local_only.md)). When the Team library lists an agent with that dependency's manifest id, and this machine has no copy, its row offers **Get *X* from the team library**
2. After the Get the dependency resolves against the new folder and the job unblocks

## Business Rules

### Whether an agent is shared is never stored

Every time, the app reads back from `origin` whether an agent is shared, where its team version lives and which repository it is. The caller's access and the team's latest version come from the cached library listing, and that listing is never persisted. There is no table and no column. A stored "is shared" would disagree with the folder the first time a developer ran `git remote remove` in a terminal, and the folder is what the agent runs from.

Three things are written down, and none of them is the answer to "is this shared":

- **`cinna.server` in the folder's `.git/config`**: the instance a folder was shared through or came from. It is a hint for choosing a profile and never makes a remote trusted (see [below](#an-instances-git-may-live-on-another-origin))
- **The trust file in main**: which git origins each instance has named, and which library entry a first share created but has not yet sent to
- **`shared_remote: {kind, repo_id, clone_url}` in the agent's `app-data/desktop.json`**: the per-machine link that contract 1.8.0 names in `shared_remote.local_state`. It is written on Get and Share with the team, and cleared on a kept copy and when Share with the team starts over. It is there for other hosts that read the folder. The desktop never reads it back to decide anything, because a developer's own clone has `origin` and no such link

### The library is polled, not pushed

Core has no realtime channel for library changes, so main lists the library when a Cinna profile becomes active (and on wake), every five minutes while it stays active, and on demand: when the catalog opens, and after Update, Share changes, Share with the team and Use the team's version. The renderer is told (`sharing:changed`) only when the set of agents, their heads or the caller's grants moved, not on every poll. The Sharing tab's People and History are re-read on that same signal, and after any action that changed them; they have no poll of their own. Polling stops on profile switch, sign-out, sleep and an expired session; re-activation starts it again.

A listing is what lets a shared agent say **The team changed this agent** without a network fetch per folder per screen. For an `external` remote there is no listing, so its page fetches on open — at most once a minute per agent, whatever triggered the read.

### An instance without the library routes is an empty library

A `404` or a `403` from `GET /api/v1/library` is an **empty Team library**, logged once per host, not an error. The first is a Cinna server that does not have the routes yet; the second one that gates them by role. Treating either as a failure would show a broken source to every user of a server that simply does not offer the feature, and treating a `403` as a dead session would raise the re-auth prompt on every poll for a session that is fine.

### Words the user never reads

The sharing surfaces never say branch, commit, push, pull, merge, rebase, remote, repository, conflict or SHA. Every sentence lives in one map, and a test reads all of it against that list. The people this is for share an agent the way they share a document; a dialog that says "rebase failed — resolve conflicts" asks them to learn a tool before they can use the feature. The AI share summary is held to the same words (and "diff") by its system prompt.

### One state, decided in main

The badge and the Sharing tab show one state, with this precedence: **other account**, **no longer shared**, **both changed**, **team changed**, **changes to share**, **up to date**. Main decides it; the renderer only chooses the sentence.

- **Shared on another account** — a Cinna remote on a server the *active* profile is not signed in to. Counts come from disk; no listing is read, no token is minted, nothing reaches the network. A token is only ever sent to the server that issued it, or to a git origin that server named
- **No longer shared** — a real listing for that server loaded and no longer has the repository. A `404`/`403` listing stands in as empty and says nothing about any entry, so it never makes an agent "no longer shared"
- **N changes you haven't shared** — files that differ from what the team has: recorded-but-unsent versions and working-tree edits measured from the **merge base**, so a file only the team changed is never counted as the user's, plus new files the ignore rules do not exclude. A new file is a change to share; `credentials/.env` is not
- **The team changed this agent** — when the listing's head is not in this folder's history. Without a fetch the app may know only that the team moved, not by how much; the sentence is the same either way

### The badge is there from the first paint, or not at all

Whether the badge and the Sharing tab exist is decided from the list of shared agents the sidebar already holds, not from this agent's own status, which arrives later. The badge is there from the first frame for a shared agent and absent for any other, and the agent's own read only changes its words. A badge that appeared once the status landed would push the runtime badges sideways under a user already reading them ([UX Rules](../../development/ui_guidelines/ux_rules.md), rule 1).

It sits **first** in the row, so the runtime label settling and the model and setup badges arriving late never move it. Badge and buttons are one unit that never wraps; the badge's words truncate instead, so a state change on a poll never adds or removes a line.

### The share actions belong to the page, not to the badge

Update and Share changes, and the dialogs they open, are owned by the agent page and shared by the badge and the Sharing tab. Clicking the badge switches to Settings, which unmounts the badge; an Update started from it can still come back a collision afterwards, and the two-button dialog must still open. A dialog owned by the badge would have nowhere to open. A refusal goes to the Sharing tab's own line while the tab is open, otherwise to the page's one-line slot.

### Update never resolves a collision, and never tries

Update is a fast-forward, or — when this machine has versions recorded but not yet sent — a rebase of those onto the team's that applies cleanly, or nothing at all: a rebase that stops is aborted and the folder is exactly as it was. Tracked edits refuse it as **dirty**, and so does an untracked file sitting where an incoming one would land.

The reason is the one [Agents Folder Updates](folder_updates.md) gives for a root: deciding whose work survives, in files an agent will next run from, is not something to do on the user's behalf. What changes here is the answer to "and then what": instead of "sort it out in your own tools", the user is offered **two buttons and never a diff**. Either choice keeps both versions.

### Share changes sends, and retries once

It records with `add -A` (honouring the ignore rules) under the user's note — or "Changes shared from Cinna Desktop" when the field is empty — then sends to `main`. A rejection because a teammate shared first is answered with one clean Update and one more send; a second rejection reads "The team version changed again while sending." **Never a force**: a force would overwrite what the teammate just shared.

A refusal from the server carries the server's own sentence; a `403` reads as "ask a maintainer for edit access". An account with `read` access is not offered Share changes at all.

### A file that can hold a secret is never sent

Before anything is recorded, two things are made true:

- **The kit's agent ignore rules are in the folder's own `.git/info/exclude`**, in one marked block, rewritten only when the kit's rules change. What `add -A` records must not depend on a `.gitignore` a teammate (or a developer's own repository) left in the folder. The same block is written into every clone before it becomes visible
- **No file that can hold a credential is already tracked.** That covers anything the contract's `secret_files` rules call secret, and the desktop-owned `app-data/desktop.json`, which holds a bearer token. For a Cinna team library, a tracked secret under `credentials/` or `app-data/` is not a refusal, because the app takes those folders out itself ([below](#the-credentials-and-app-data-folders-never-travel-to-a-team-library-whole)). An ignore rule cannot untrack a file, so the folder is refused (`secrets_tracked`) when a secret is tracked anywhere else (a `.env` at the agent's root, say), or anywhere at all for an `external` remote. Nothing is recorded or sent, and up to three of the files are named. The sentence asks whoever maintains the agent to remove them, because a non-developer cannot take a file out of the team's version

Sharing for the first time also writes the kit's agent ignore files the folder lacks, so an agent made before it was a repository does not send its secrets with the first share. A folder that is already its own repository is checked for tracked secrets **before** the library entry is created: a refusal after the entry existed would leave an empty agent in the team's library.

The AI share summary is held to the same line. Its text is built from the folder's differences with every tracked secret file left out, because the summary goes to whatever backend AI Functions resolves to — and the dialog drafts it *before* Share has had the chance to refuse the folder.

### The credentials and app-data folders never travel to a team library, whole

This applies to **Cinna team libraries only**. An `external` remote, such as a developer's own GitHub, gets the kit's ordinary ignore rules and nothing more: what goes into their repository is theirs to decide.

The contract's `shared_remote.never_travels` (1.8.0) names folders that never go to a shared remote **in full**, not just their secret files. That includes the template's own `credentials/README.md` and `.env.example`. When a workshop's own `.cinna-kit/` predates 1.8.0, the app uses the same two folders, `credentials/` and `app-data/`, because the server enforces them whatever the folder's contract says. The team library's server refuses any send that carries a file under them in **any** new version, not only the latest. A first share once failed on exactly this: the template's `credentials/README.md` went with the first version and the server refused all of it.

- They are in the exclude block as `/credentials/` and `/app-data/`. Before every recording, anything already recorded under them is dropped from what is recorded, and the files stay on disk. Share with the team's preflight only checks and changes nothing, because a preflight that then refuses must leave the folder as it found it
- **Before a send, the versions not yet sent are cleaned, not squashed.** A version may have recorded one of these folders: a first send the server refused, say, or a developer's own history. First the app fetches, so "not yet sent" is measured against the team's version as it is now. Every unsent version then has those paths taken out and keeps its note, author, dates and place. Then, if the team has moved on, the cleaned versions are rebased onto it. Clean first and rebase second, because replaying a version that untracked a file would delete that file from disk. Nothing the team already has is rewritten. The working tree and the index are untouched, and the branch moves only if nothing else moved it meanwhile. A folder on a detached HEAD is refused with a sentence saying to switch to its branch. A fetch that fails refuses the send (`fetch_failed`)
- **Update** cleans the same way before it rebases this machine's unsent versions, for the same reason: otherwise the rebase could delete a credential from disk. A send that is rejected because a teammate shared first is cleaned again after its one Update
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

### A new agent reaches only the people chosen, never everyone

Share with the team never gives the agent to everyone by default. With nobody picked, only the sharer can get it. The people chosen are sent with the create, and then the entry's whole list of grants is written: whoever the server names as maintainer (the sharer, on a fresh entry) as **Maintainer**, plus each person chosen. **Nothing is sent before that write succeeds.** If the server names no maintainer, or refuses the write, the folder is not sent and the dialog says why. The entry stays pending, so a retry finishes it and writes the grants again.

**Known gap.** cinna-core today ignores `grants` on create and gives every new entry `everyone: read`. Between the create and the desktop's grants write, every user on the instance is notified of the new entry and can see its name and description. If the write fails, the entry stays visible to everyone until a retry. The agent's contents are not exposed, because nothing has been sent. What leaks in that window is the manifest's description, which the dialog does not show. A core change that applies `grants` on create has been requested; until it lands, the grants write is the only thing that restricts access.

### People is the server's list, written whole

The People list is the library entry's grants as the server answers them. A change is the **whole desired list**, written in one `PUT`. After it, the list shown is what the server answered, or a fresh read, and never the list that was sent, which lacks the names. The next edit therefore builds on the server's list. A rule the server enforces, such as keeping at least one maintainer, comes back as the server's own sentence under the list.

A `403` on reading the list means the caller is not a maintainer. The tab then shows only the listing's maintainers and **Only a maintainer can change who has access.**, and never the sign-in prompt, because the session is fine and the list is just not theirs to see. A `403` on a write reads **Only a maintainer can change who has access to this agent.** "You" is the row whose account id matches the subject of the profile's stored token. When that cannot be read, no row is marked: a wrong guess would hide the remove button on someone else's row.

Search goes to the active profile's server and asks for ten people at most. Fewer than two characters asks nothing. A `403` or `404` from the search finds no one, so a server without the route offers an empty search rather than an error.

### History lists versions, it never restores one

History is this folder's own versions, read locally with no network, newest first and at most thirty. A version is **Not shared yet** when it is recorded here and not on the team version (`origin/main..HEAD`). With no team version to measure against, as on a folder never fetched, none is marked. No version identifier reaches the renderer: there is nothing to restore to, and nothing to compare.

### Remove sharing disconnects; deleting from the library comes first

Remove sharing removes `origin`, clears the `shared_remote` link in `desktop.json` and unsets `cinna.server`. The folder, its files and its own `.git` history stay, and the agent becomes an ordinary local one that Share with the team offers again. It takes the turn lock like every verb that writes `.git`, and refuses while a turn runs. Unshared changes do not block it, since nothing is lost. It works for any shared agent, including one shared on another account or with an `external` remote.

**Also delete it from the team library** is offered only to a maintainer of an entry the library still lists. The delete is done **first**: if the server refuses it (a `403` reads **Only a maintainer can delete it from the team library.**, anything else carries the server's sentence), nothing on this machine changes. An entry already gone (`404`) counts as deleted. If the delete succeeded and the local disconnect then failed, the folder reads "No longer shared", and Remove sharing again finishes the disconnect (the delete is no longer offered, and would count as done). Teammates' copies are untouched either way. After a delete, their folders read "No longer shared" at their next poll.

### Get refuses anything already here

Get refuses when `Local/<slug>/` exists, or when an agent with the same manifest id is already on this machine — checked against the listing first, then against what actually arrived (the listing's id can be missing or stale), and the clone is removed. It clones into a hidden staging folder and renames it into place, so the scanner and the watcher never see half an agent and a failure leaves nothing. What arrives must have a `cinna-agent.json` at its root.

### Use the team's version keeps everything, and leaves one id per folder

- The old folder is renamed to `<slug>-mine` (or `-mine-2`, …), the team's version is cloned at the original path, and the kept copy gets a **fresh manifest id**, "(my copy)" after its name, and no `origin` — it is nobody's team agent. The original id stays with the team's version, so the chats bound to the agent follow the team
- **Per-machine files are carried over**: everything git ignores in the old folder — `credentials/.env`, `credentials.json`, `app-data/` — which no clone brings. Copied, not moved, so the kept copy still runs; only where the team's version has nothing at that path, so nothing that arrived is overwritten. Rebuildable folders (`.venv`, `node_modules`, `__pycache__`) are not carried. What could not be copied is named in the page's note ("Some of this computer's files didn't come across: …"), because the team's version may not run until the user puts, say, a credential back
- **Anything that fails part way puts the folder back** as it was before the click — id, `origin` and all. A clone that already landed is first renamed to a hidden dot-folder and only then deleted, so a delete that fails half way (a file held open) never leaves a partial clone carrying the original id at the agent's path. Two folders with one id is the state never allowed: the scanner would refuse one of them, and which one is a coin toss
- The agent's warm engine process is retired, because its working directory is now the kept copy

### Busy agents are not changed underneath

Update, Share changes, Share with the team, Use the team's version and Remove sharing take the agent's turn lock exclusively and refuse while a turn runs ("nothing was changed"). Share with the team takes it too: the first share is an `add -A` of whatever is there. Get writes a folder no agent runs from yet. Update is not followed by a process restart: like a root update it changes files in place, and every turn reads them afresh.

### A shared agent's folder stays out of the workshop's repository

When a `Local/<slug>/` becomes its own repository inside a workshop that is itself one, its path is added to the workshop repository's `.git/info/exclude` — per clone, never committed — so it does not appear there as an untracked directory or, after someone's `git add -A`, a stray nested entry.

### What it deliberately does not do

- **No diff view, no merge tool, no restore.** History is a read-only list of versions: no version opens, compares or comes back. A user who wants those has their own tools, and the folder is an ordinary repository they can open with them
- **No sidebar marker.** A shared agent's row looks like any other; its state is on its page
- **No realtime.** A teammate's share reaches this machine at the next five-minute poll, or when the catalog opens
- **No sharing of bare agents** or of agents outside `Local/`: they are not the kit shape the library and Get produce
- **Root-level updates are unchanged.** A whole agents folder that is a git repository still gets only [Agents Folder Updates](folder_updates.md)' fast-forward

## Architecture Overview

```
Catalog (Team library) / share badge / Sharing tab / ⋯ menu / Inbox card / blocked-job row
  → useSharing hooks → window.api.sharing.* → sharing:* IPC (activation gate, settings scope)
      → sharingService (core: resolves every folder from an agent id)
          → gitService share verbs (execFile git, token env per child)
          → libraryService cache  ← GET /api/v1/library, every 5 min while active
          → POST /api/v1/library/agents, then PUT …/agents/<repo_id>/grants (Share with the team)
          → GET / PUT …/grants (People), GET /api/v1/users/search (the people picker)
          → DELETE …/agents/<repo_id> (Remove sharing, when asked)
      → rescan + sharing:changed → renderer invalidates sharing, agents, Inbox
```

## Integration Points

- [Agents Tab & Agent Page](agents_tab.md) — the share badge in the chat-mode runtime row, the **Sharing** settings tab, the ⋯ menu's **Share with the team…** and **Remove from this computer…**
- [Bundles Catalog](../bundles_catalog/bundles_catalog.md) — the Agent catalog dialog the Team library is a source of
- [Agents Folder Updates](folder_updates.md) — the root-level git panel, whose never-write rule still holds for roots
- [Local Agents Are Not Synced](local_only.md) — the product position this is a deliberate exception to, for shared agents only
- [The Inbox](../../jobs/tasks/inbox.md) — the **The team changed *X*** cards
- [Jobs](../../jobs/jobs/jobs.md) — the blocked-job row's **Get *X* from the team library**
- [AI Functions](../../llm/ai_functions/ai_functions.md) — the share summary
- [Kit Contract & Manifest Layer](kit_contract.md) — the agent ignore template, the `secret_files` rules and `shared_remote` (`never_travels`, `local_state`) that sharing enforces
- [Agents Home, Scanner & Folder Index](folder_index.md) — the rescan every action ends with, and the turn lock the writing verbs take
- [Native Client Data Sync](../../sync/data_sync/data_sync.md) — a different thing: profile data, end-to-end encrypted. Team-library agents are not
- Sub-doc: [Technical Details](team_sharing_tech.md)

## Not verified

- **Only Share with the team has been run against a real Cinna server**, a local cinna-core, and that run predates its grants write: the `PUT …/grants` it now makes before sending has not been seen to succeed against core. Its server half, the git host at `/git/<repo_id>.git` and the library API (`GET /api/v1/library`, `POST /api/v1/library/agents`), was built in parallel against the agreed interface. That run found two failures, both now fixed. The first was the git origin: `clone_url` was on the backend origin and was refused as another server's. The second was the server refusing the template's `credentials/` folder. **Get, Update, Share changes, Use the team's version and the Inbox's *The team changed X* card have not been observed end to end against core.** Their field names and the server's push refusals are still what was agreed, not what was seen
- Three paths are tested only against fakes: the retry that finishes an entry left empty (it relies on core answering `409` with an empty `head_sha` for the taken name), the restart of an agent whose entry was deleted, and the cleaning of unsent versions before a send or an Update
- The git verbs are covered by unit tests over real repositories (bare remotes, two clones, the real binary) and a local HTTP server that checks the header scoping and the redirect refusal. The service is tested over real folders with the library and token mocked. No end-to-end spec drives these surfaces yet
- **People, the people search and Remove sharing's delete from the library have only unit tests** (the service with `cinnaFetch` mocked, the tab and dialogs in component tests). None has been run against a real cinna-core, so the grants body's shape (`principal` as `{user_id}`, `{role}` or `"everyone"`), the search route's `data` rows and the delete's answers are what was agreed, not what was seen. The grants reader accepts a bare array or one under `grants` or `data` for that reason
- The window in which a new entry is visible to everyone (see [A new agent reaches only the people chosen](#a-new-agent-reaches-only-the-people-chosen-never-everyone)) is core's current behaviour as reported from its side. Nothing in this repository can show it
- That a `403` from the listing means "this role has no library" rather than "this session is broken" is an assumption about the server's behaviour
