# The Agents Folder Question

## Purpose

Ask the user about the [Agents Home](folder_index.md) before macOS does. Creating `~/Documents/CinnaAgents` is a write into a folder macOS guards, so the first one raises the system's *"Cinna Desktop would like to access files in your Documents folder"* dialog. That dialog says nothing about agents, and the app has no way to make it say anything — so the app says it first, from a button the user pressed, and keeps somewhere to go when the answer is no.

The failure this replaced: `ensureHome` was on every read path that wanted the home, including the one behind `useAgentsHomeHint` — a hook whose whole output is a sentence naming a folder. It was mounted by the `cinna://connect` confirm panel and by the local-development onboarding step, so **reading the folder's name created it**, and the Documents prompt arrived in the middle of signing in, before the app had used the word "agent". People decline dialogs they did not expect, and a decline left the app with nowhere to put an agent and no screen that admitted it.

## Core Concepts

- **Guarded location** — a path macOS puts behind the Files-and-Folders prompt: `Documents`, `Desktop`, `Downloads`, and `Library/Mobile Documents` (iCloud Drive, which is where `~/Documents` actually lives on a Mac with Desktop & Documents syncing on). Both spellings of Documents are listed rather than resolved, because resolving reads the filesystem and the answer is needed before the first read. Removable media is deliberately **not** in the list: an external drive is a folder the user picked in a directory panel, and a path chosen that way already carries its grant. Nothing is guarded off macOS
- **Home access** — the three-valued answer to "can we use the agents home?": `ready` (create it, or it exists), `needs_consent` (nothing has touched it and macOS is about to ask), `denied` (the user said no, or the grant is off). Only ever anything but `ready` on macOS
- **Acknowledgement** — the record that the user has been *told* about one home path, in the `localAgentsHomeAcknowledged` setting. Keyed by path, because the explanation is about a place: pointing the home at a different guarded folder later is a new thing to say, and pointing it somewhere unguarded needs nothing said at all
- **Refusal** — the home this process asked for and was told no about. In memory, for the life of the process, and **never written down**
- **The explainer** — `AgentsHomeModal`, "Where your agents will live": one dialog holding two questions, the second of which is what to do about a refusal

## User Stories / Flows

### First run on a Mac
1. The user opens the **Agents** tab. That is what raises the question — the tab being open is what makes it worth interrupting for
2. The agents list comes back with no roots and `needs_consent`, and the modal opens over it: what an agent folder is, the exact path, and the sentence that makes the next dialog legible — *"macOS will now ask whether Cinna may use your Documents folder. That is this one."*
3. **Create folder** makes the directory. The macOS prompt appears during that call and stays up until it is answered
4. Allowed: the folder is acknowledged, the templates and `.cinna-kit/` copy go in, the root row is registered, and the lists refresh. The question does not come back
5. Declined: the same dialog becomes the second question rather than an error — *"macOS did not let Cinna use that folder"*, the path it refused, and **Choose folder…**

### Recovering from a refusal
1. **Choose folder…** opens the OS directory picker in main. Picking a folder there is itself what grants access to it, so the replacement home never raises a second prompt
2. A folder that still cannot be written to leaves the setting where it was and reports into the dialog the user is looking at, beside the button they pressed
3. **try again**, in the body copy, re-attempts the original folder — for the user who has just flipped the switch in System Settings → Privacy & Security → Files and Folders. A refusal is not remembered across launches either, so restarting the app has the same effect

### The rest of the app while the question stands
1. The sidebar list says *"Your agents need a folder"* with **Set one up** (or **Pick another folder** after a refusal), not "No agents yet" — the two states want different words and a different button
2. The `+` raises the question instead of opening the Add-an-agent dialog, whose New agent card offers to scaffold into the folder that does not exist
3. The empty agent pane says the folder is missing rather than pointing at that `+`
4. Settings → Local Agents shows the home's place in the **Agent Folders** list as a row naming the state and the path, carrying the button that resolves it
5. **Not now** is always available, and every one of those surfaces is a way back in

### An install that has been using the folder for months
Nothing is asked. A registered root row at the home's path, with the folder still on disk, is this install having created it once — which on a guarded path took a grant.

### Local development
The `cinna://connect` confirm screen and the `localdev` onboarding step **name** the agents home in their copy and create nothing. When the reconciler later builds the account workspace it goes through the same preparation as the modal, and treats the folder as already explained: the consent screen the user just read named it, and two modals about one folder is worse than one. A home it cannot create stops local development with `attention / workspace` and a detail naming the folder and the fix — see [Local Development](../local_dev/local_dev.md).

## Business Rules

### Nothing writes to a guarded home until the user has been told

The refusal lives in `ensureHome` — the one function every read and write path to the home goes through — and not at the handful of call sites that happen to be user-facing today. A new caller that forgets the rule gets an error it has to handle, rather than a permission prompt in front of someone who has no idea what it is for. Getting past it means `agentsHomeService.prepare()`, and there is no other way.

### The app has to answer "will macOS prompt?" itself

There is no API for it. Electron exposes permission state for the camera, the microphone and the screen, and nothing for files; reading `TCC.db` needs Full Disk Access, a bigger prompt than the one being avoided; the preflight SPI is private; and any probe that actually reads the folder **is** the trigger. So the answer is assembled from three things the app already knows: the path is not guarded, or the acknowledgement names it, or a root row plus the folder on disk says this install has been through it before.

### On a fresh install, asking the question reads nothing

Resolving where the home is and whether it can be used is pure path work: no `readdir`, no `stat`, nothing inside the folder. That is the invariant everything else rests on — a read inside `~/Documents` is the very thing being deferred, so a query that checked whether the folder was there would raise the prompt it was asked in order to avoid.

It also means **"does the folder exist?" is not the test**, tempting as it looks: a `~/Documents` restored from a backup can hold the folder on a Mac that has never granted this app anything.

There is exactly one filesystem call in the gate, and it is reached only on an install that *already has a root row* at the home's path: an `existsSync` of the folder — a stat of it, not a read inside it. It is what stops a database carried across by Migration Assistant — row present, folder and grant absent — from sending `ensureHome` into a synchronous `mkdir` in `~/Documents` and freezing the window behind an unexplained prompt. It does not cover a `tccutil reset` that leaves the folder in place; that one still prompts unexplained, once, for a user who knows the folder.

### The gate is on the home, not on the list

An unanswered question removes **one row** from the roots list, never the list. An earlier build let the refusal escape as far as `local-agent:list`, which then answered with no roots at all: a user who dismissed the question and adopted their own workshop watched it register successfully and never appear, and repointing the home setting emptied a sidebar that had two roots in it a moment before. Adopting a root does not go through the home at all.

For the same reason the *modal* treats any registered root as an answer. A user who adopted their own workshop has a working app; the home is then a Settings matter, and raising a modal over someone whose agents are right there in the sidebar, about a folder they chose not to use, is the interruption this whole arrangement exists to remove. Settings reads the home's own state instead — reporting where the agents folder is *is* its job.

### The question is raised by demand, never by launch

Main can answer "the folder does not exist yet" from the moment the app starts. A modal that acted on that would explain the agents folder to someone who is still signing in — the same out-of-nowhere interruption the macOS prompt was, only ours. Exactly one surface raises it: the Agents sidebar, whose presence means the user went looking for an agent.

**Not now** is remembered for the window, because the surfaces that raise it do so from an effect that runs whenever the agents list has data, and that list refetches often — a watcher push invalidates it, a second consumer mounting fires the effect again. Without that memory the dialog would come back on its own, over whatever the user had moved on to. A *different* question — refused, having only been unexplained before — is still worth raising, and every surface keeps a button that reopens the one that was put away.

### A refusal is remembered for the process, and never on disk

macOS remembers the refusal itself and answers the next `mkdir` with `EPERM` immediately — no prompt, no wait — so re-attempting costs one failed syscall and works the moment the user flips the switch in System Settings. A stored "denied" would go on reporting a problem they had already fixed. Held in memory instead, so every surface gives the same answer between the refusal and the next launch, and so a grant turned on in System Settings takes effect by restarting the app.

That record is also why there is exactly **one** answer to "is the folder usable?". Without it, the list could only ever report `needs_consent` after a refusal — nothing is acknowledged when macOS says no — and the renderer had to keep a second, contradicting latch of its own.

### The prompt must not block the main thread

The directory is created with async `fs`, and that is the reason the create step exists separately from the scaffolding it precedes. The system dialog blocks the calling thread until it is answered; a synchronous `mkdirSync` on the main process means the window stops redrawing and every other IPC call queues behind a dialog the user is still reading. Only the directory is made that way — templates, `.cinna-kit/` and the root row run afterwards with the grant in hand, so their synchronous writes never wait on anything.

### A refusal is an answer, not an error

Being told no is the answer to a question the app asked, and what follows is a different question — where else the agents should live. So `prepare` reports `denied` rather than throwing it, and the modal turns into the next question rather than an alert to acknowledge. The one place it *is* thrown is the folder the user just picked in the OS panel: that is a failure of *that* click, and it belongs in the dialog's message slot beside the button they pressed rather than as a new state describing a home that has just been rolled back underneath them.

Changing the home is move-try-restore for exactly that reason: `prepare` reads the setting to know which folder to make, so the value has to move first — but a folder that could not be created must not stay the configured home, or the next `ensureHome` takes its "the home moved" branch and repoints the home root at a folder that does not exist.

### `denied` is not always macOS

A write can be refused on any platform — a read-only mount, a root-owned folder — and only the *guarded* flag says which story to tell. Blaming macOS where macOS is not the reason names a cause the user does not have and a remedy their machine does not offer, so the copy branches on `guarded`, not on `denied` and not on the platform. Off macOS the explainer never appears at all: there is no prompt to warn about, and a modal explaining one that will not arrive is worse than no modal.

### The system dialog gets the best sentence available

`NSDocumentsFolderUsageDescription` in `electron-builder.yml` is the only explanation the user gets if the system prompt ever arrives ahead of the app's own, so it names the folder and says why it exists. It is a fallback, not the mechanism — the in-app explainer is what normally comes first.

## Architecture Overview

```
Agents sidebar mounts
      │  (list resolves: roots empty, homeAccess = needs_consent)
      ▼
agentsHome.store  ──►  AgentsHomeModal ──► local-agent:home-grant
      ▲                      │                     │
      │                      │                     ▼
Settings row / list  ────────┘        agentsHomeService.prepare()
empty state / +                          │
(reopen)                                 ├─ homeAccessService.grant()  async mkdir → macOS prompt
                                         │        └─ EPERM → denied (remembered in memory)
                                         └─ ensureHome()  templates, .cinna-kit/, root row

local-agent:list ──► tryEnsureHome() ──► 'ready' | 'needs_consent' | 'denied'
                            │                    (carried on the list as homeAccess)
                            └─ ensureHome() refuses while the question stands
```

## Integration Points

- [Agents Home, Scanner & Folder Index](folder_index.md) — owns the home, the roots and `ensureHome` itself; this doc is the gate in front of it
- [Agents Tab & Agent Page](agents_tab.md) — the sidebar list, the `+`, the empty pane and the Settings → Local Agents row that report and resolve the question
- [Local Development](../local_dev/local_dev.md) — creates its account workspace under the home, and acknowledges the folder its own consent screen named
- [The `cinna://connect` Link](../../auth/onboarding/connect_link.md) and [Onboarding](../../auth/onboarding/onboarding.md) — the two first-run surfaces that name the folder and must not create it
- [Settings Scope](../../core/settings_scope/settings_scope.md) — the acknowledgement is default-scoped, like the home itself: it is a fact about the machine, not about whoever is signed in
- [UX Rules](../../development/ui_guidelines/ux_rules.md) — rules 1 (nothing moves under the pointer), 9 (a surface that names a folder is asserting that folder exists), 10 (a control's accessible name is its visible name, and a trigger does not share a name with a choice inside what it opens) and 12 (the status row carries the button that resolves it) are the ones this surface is built against

Technical reference: [The Agents Folder Question — Technical Details](home_access_tech.md).
