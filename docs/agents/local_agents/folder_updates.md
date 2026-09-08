# Agents Folder Updates

## Purpose

Keep a registered agents folder up to date with the repository it came from. If a root is a git working tree, Settings → Local Agents says which branch it is on, whether it is behind, what the missing commits are, and offers one action: **fast-forward**.

The shape this was built for is a team repository of agents — cloned once and then quietly left behind. It applies to a **workshop** root as much as to an [external](bare_agents.md) one; what decides whether the panel exists is whether the folder is a repository, not what kind of root it is.

## Core Concepts

- **Update check** — Reading a root's git state. Cheap and local by default; it reaches the network only when the user presses **Check**
- **Fast-forward** — The only update performed: `git merge --ff-only`, which either replays the remote's commits onto an unchanged tree or refuses and changes nothing
- **Refusal** — A `GitRefusal` code saying why an update cannot be applied, in the user's words. Not an error: the folder is fine, this app just will not be the one to sort it out
- **Incoming commits** — The commits the upstream has and the working tree does not, newest first, capped at 50. Shown as "What is waiting"; after an update, the same list is "What changed"

## User Stories / Flows

### Seeing that a folder is behind

1. Settings → Local Agents lists the registered roots. Under a root that is a git working tree there is one extra line: the branch and its upstream — or, where the repository is **above** the registered folder, the branch and that repository's name, the upstream dropped to make room for it
2. On open the state sentence comes from the **last** fetch — "Up to date as of the last check", or "N updates available" — because nothing has reached the network yet
3. Under a root that is not a repository there is **nothing at all**

### Checking and updating

1. **Check** fetches and re-reads. The sentence now says what is true as of a moment ago
2. When there is something to apply and nothing standing in its way, an **Update** button fills the fixed slot beside Check. A disclosure lists the waiting commits — hash, subject, author. Its tooltip names the repository path when that is not the folder itself, because the button acts on the repository
3. **Update** re-reads *with a fetch first*, fast-forwards, then rescans the root. The line becomes "Updated — N commits pulled", and the same disclosure now says what changed
4. A pull that added an agent folder, removed one or rewrote an `AGENT.md` is visible immediately: the rescan is part of the action, not left to the watcher

### Being told to sort it out yourself

1. Uncommitted changes, local commits the remote does not have, no upstream, an unreachable remote — each is named precisely, each leads with what the user can do about it, and each blames **the repository**, not "here"
2. The Update button is **not** shown. A button that always refuses is a button that teaches the user to expect a refusal
3. For the two refusals a *check* cannot move either — `no_upstream` and `git_missing` — the **Check** button is not shown either. `readGitStatus` returns before it ever fetches in those states, so the button spun and then changed nothing at all, not even the refusal already on screen. Neither can change without the user editing the repository or the machine, and the query refetches on focus when they have

## Business Rules

### It never resolves a conflict, and never tries

No merge, no rebase, no stash, no `--force`, no commit, no push. `merge --ff-only` is the only update, and by construction it either applies cleanly or changes nothing.

That is not caution for its own sake. A desktop that resolves a conflict on the user's behalf has to decide which of two people's work survives, in a repository it knows nothing about, with the answer landing in files an agent will then be run from. **Refusing legibly is the feature**: every state this cannot handle is reported as a reason the user can act on.

| Code | Means |
|---|---|
| `not_a_repo` | The folder is not inside a working tree. The panel renders nothing, and has no sentence for this code |
| `git_missing` | No `git` on this machine's `PATH` |
| `no_upstream` | The branch tracks nothing, or the head is detached |
| `dirty` | Uncommitted changes a fast-forward could overwrite |
| `diverged` | Local commits the remote does not have |
| `fetch_failed` | The remote could not be reached or refused |
| `not_fast_forward` | The merge itself refused — the state changed between the check and the update |

### A refusal is only reported when there is something to apply

A refusal is about *applying an update*, so there is none to state when there is nothing to apply. Without this rule a repository that is up to date but has uncommitted work reads "there are uncommitted changes here, commit or discard them" — a demand, on a folder where nothing is waiting and nothing needs doing.

When there *is* something to apply, `diverged` outranks `dirty`: committing the edits does not help, because the history is still diverged.

### `dirty` counts tracked changes only

`git status --porcelain --untracked-files=no`. A folder of agents almost always has untracked files — caches, a `.venv`, the state an agent wrote on its last run — so counting them would report every repository as dirty and the feature would never be usable once.

### Status is read without fetching; the update fetches anyway

The status query runs for **every** registered root the settings screen renders, so a network round trip per root on every visit is not something the user asked for. The counts are then "as of the last fetch", which the panel says out loud rather than presenting stale numbers as current.

The update does not trust that snapshot: minutes may have passed since the check, and the whole point of refusing on `dirty` and `diverged` is lost if the decision is made from a stale read. It re-reads with a fetch, then merges. The commits reported as applied are the ones the *pre-merge* read listed as incoming — captured before the merge rather than reconstructed from the reflog afterwards.

### The repository may be an ancestor of the folder, and the copy says so

`git rev-parse --show-toplevel` decides where every command runs, and that is the **repository root**, which can sit well above the registered folder — adopting one directory inside a monorepo is an ordinary case. Two consequences the wording has to carry:

- **Refusals blame "this repository", never "here" or "this folder".** A user told their *agents folder* has uncommitted changes, when the edit is elsewhere in a checkout they have never associated with Cinna, goes looking in the wrong directory
- **The panel names the repository** — its basename, after the branch, **in place of the upstream** — whenever `repoRoot` differs from the root's path, with the full path in the line's `title` and in the Update button's tooltip. All three parts needed 332px in the 273px this line gets at the 800px minimum window, and the part that clipped was the tail: the repository name, which is the only reason the line branches. The upstream is the least identifying of the three — `origin/<branch>` on almost every repository there is — so it is the one that goes. The button's own label stays "Update": the slot is a fixed width precisely so that pressing Check cannot move Check, and a label whose width depended on the root would reintroduce that at first paint

Each refusal sentence also leads with the action rather than the diagnosis ("Commit or discard this repository's changes first, then check again"), and each is short enough to fit the two reserved lines at the 800 px minimum window — measured, not estimated, because a refusal that clamps loses its tail.

### It only ever runs in a folder the user registered

`local-agent:git-status` and `:git-update` take a **root id**. Main resolves it through `agentsHomeService.requireNamedRoot` and uses that row's path; a renderer-supplied path is never accepted. `requireNamedRoot` and not `requireRoot`: the latter falls back to the agents home when given nothing, and *creates* it as a side effect — a `git fetch` in a folder the user never named, brought into existence by the request. This spawns a subprocess with a working directory, so the only directories it may run in are ones the user registered — the same rule `local-agent:root-add` and the "open in…" path guard keep.

### How the subprocess is shaped, and why

- **`execFile`, never a shell.** A repository path can contain anything, and there is no interpolation into a command string anywhere
- **Every invocation is bounded.** 20 s for the local reads, 120 s for `fetch`, and a 4 MB output cap
- **`git` is resolved through the login-shell `PATH`.** A Dock-launched macOS app inherits launchd's bare environment and would report "git is not installed" on a machine where it plainly is. See [Shell Environment Resolution](../../development/shell_environment/shell_environment.md)
- **The child gets the narrowed child environment**, which keeps `SSH_AUTH_SOCK` so a private repo over SSH still authenticates through the user's agent, without handing a subprocess the whole shell profile
- **`GIT_TERMINAL_PROMPT=0` and a batch-mode `GIT_SSH_COMMAND`.** A fetch that wants a password or a host-key confirmation has no terminal to ask on and would otherwise hang until the timeout with nothing on screen
- **`LC_ALL=C`**, so porcelain output is parsed in a stable language whatever the user's locale
- **A non-zero exit is an answer, not an exception.** "This is not a repository" and "there is no upstream" arrive that way, and a caller that had to `try`/`catch` each of a dozen probes would end up treating a real failure and an expected one the same
- **Commit lines are unit-separated** (`\x1f`), because a subject can contain a `|` or a tab and a mis-split row shows up as a commit attributed to the wrong person rather than as an error

### The panel is quiet by construction, and nothing it does moves anything

- It renders **nothing** for a folder that is not a repository — the common case, and the reason this is not a banner ([UX Rules](../../development/ui_guidelines/ux_rules.md), rule 2)
- It sits below everything else in the settings row, so a status line arriving after a check cannot move the buttons the user is about to press (rule 1)
- **Whether the panel exists at all is known at first paint**, from `AgentRootDto.isGitRepo` — a cheap synchronous stat walk for a `.git` entry at the folder and up to eight ancestors, done in main while the roots are listed. Discovered from the panel's own query instead, every root drew and then either grew a block or did not, pushing the "Add an agents folder" button and the Agents and AI credential status rows below it down on the first visit. `.git` is a directory in a clone and a *file* in a worktree or submodule, so the entry's type is deliberately not checked
- **That walk is an approximation, and `readGitStatus` stays the authority.** It only decides whether to ask. A false positive costs one `rev-parse` that answers `not_a_repo` and then renders nothing — a collapse of a strip with no control in it, inside a frame. While the real answer is in flight the block holds its settled height, so the rows below it do not move when it lands
- **The Update button lives in a fixed slot beside Check**, wide enough for its longest label. It used to appear next to Check and shift it sideways — putting a freshly rendered **Update** under the pointer that had just clicked Check, where an impatient second click is a `git pull`
- **The disclosure's row is reserved whether or not there is a list**, because it appears in answer to a click on Check, and everything below it — "Add an agents folder", and the Agents and AI credential status rows that close the section — moved down when it did. A blank strip on an up-to-date repository costs nothing; the same strip appearing under a pointer that has just clicked does. Expanding the list *does* grow the block, and that is fine: it is a disclosure the user opened
- **A failed Check is written into the status line's own slot**, not into a row of its own below the block. That slot is already reserved and already clamps to two lines, so the error costs no height and lands on the line the check was about; a separate red row appeared under a pointer that had just clicked and pushed the rest of the settings section down (rule 1)
- **The panel is written at the settings type scale, and its reserved boxes are derived from it.** It renders inside a settings row, so it takes that surface's scale rather than the app-chrome one it was first written in; the two-line status box is `2 × leading` (2rem at 12px/1rem) rather than a measured pixel count, so the box and the type cannot drift apart the next time either moves. The Update slot and the loading frame that stands in for it widened and grew with the type (`5.5rem` → `6.5rem`, `22px` → `27px`): a slot sized for the old scale clips the label at the new one, and a loading frame that no longer matches the settled block is a row that jumps once the status lands
- **Check carries a border and a raised background**, like every other icon-only row action. A muted glyph beside a muted sub-line is the same colour and weight as the prose around it and is not discoverable until it is hovered (rule 11)
- The commit lists are collapsed disclosures, not a changelog

## Architecture Overview

```
Settings → Local Agents → AgentsRootGit (one per root)
   root.isGitRepo (from :roots-list)   ← looksLikeGitRepo, a stat walk in main
   useGitStatus(rootId)        ─► local-agent:git-status  {rootId, fetch:false}
   useCheckForUpdates()        ─► local-agent:git-status  {rootId, fetch:true}
   useUpdateFromGit()          ─► local-agent:git-update  rootId
                                     │
                                     ▼
                            agentsHomeService.requireNamedRoot(rootId)  ← never a renderer path,
                                                                        never the home by default
                                     │
                            gitService.readGitStatus(dir, fetch)
                              rev-parse --show-toplevel · --abbrev-ref HEAD
                              [fetch --quiet] · @{upstream}
                              status --porcelain --untracked-files=no
                              rev-list --left-right --count HEAD...@{upstream}
                              log HEAD..@{upstream}
                            gitService.updateGitRepo(dir)
                              readGitStatus(fetch) → merge --ff-only → readGitStatus
                                     │
                            localAgentService.rescan(root) + engineManager.applyConfigChange
```

## Technical Details

### Files

- `src/main/services/localAgents/gitService.ts` — `readGitStatus()`, `updateGitRepo()`, `looksLikeGitRepo()` (the synchronous first-paint probe, `GIT_ANCESTOR_DEPTH` 8), and the private `run()` that shapes every invocation
- `src/main/services/localAgents/agentsHomeService.ts` — calls `looksLikeGitRepo` when building each `AgentRootDto`
- `src/shared/agentGit.ts` — `GitCommit`, `GitRefusal`, `GitStatus`, `GitUpdateResult`. Shared because the preload bridge and the settings panel both name them and neither may import from `src/main`
- `src/main/ipc/local_agent.ipc.ts` — the two channels
- `src/renderer/src/components/settings/AgentsRootGit.tsx` — the panel, and `REFUSAL_TEXT`: the code → sentence map, so the tests never assert on prose
- `src/renderer/src/components/settings/AgentsRootGit.test.tsx` — the repository named only when it is above the folder, nothing rendered for a non-repository, the reserved block, refusals blaming the repository, and Update and Check each hidden where they could only refuse
- `src/renderer/src/hooks/useLocalAgents.ts` — `useGitStatus`, `useCheckForUpdates`, `useUpdateFromGit`

### IPC Channels

| Channel | Type | Signature |
|---|---|---|
| `local-agent:git-status` | invoke | `({rootId, fetch?}) → GitStatus` — `fetch` is the caller's explicit choice |
| `local-agent:git-update` | invoke | `(rootId) → GitUpdateResult` — fast-forward, then rescan the root |

`GitUpdateResult` carries the status **after** the attempt, so the panel needs no refetch. `useUpdateFromGit` invalidates the agents list, the roots and the merged agents query on a successful update, because a pull can add an agent, remove one and rewrite an `AGENT.md` in the same commit.

### Testing

`src/main/services/localAgents/gitService.test.ts` drives **real repositories**: a bare origin and two clones, and the real binary. There is no useful way to fake this — every interesting behaviour is a fact about `git`'s own output, and a stubbed subprocess would only prove that the strings in the test file were parsed by the parser written for them. `git` is assumed present; `git_missing` is the one branch that cannot be exercised on a machine that has it.

## Integration Points

- [Bare Agents & External Roots](bare_agents.md) — the feature this was built beside: a repository of agents is exactly what an external root usually is, and it is why the whole picked folder becomes the root
- [Agents Home, Scanner & Folder Index](folder_index.md) — the roots this reads, and the rescan an update ends with
- [Agents Tab & Agent Page](agents_tab.md) — the Settings → Local Agents section the panel lives in
- [Shell Environment Resolution](../../development/shell_environment/shell_environment.md) — where `git` is found and what environment the child gets
- [The Local Engine](engine.md) — an update that changes the agents calls `applyConfigChange`, the same way create and delete do
