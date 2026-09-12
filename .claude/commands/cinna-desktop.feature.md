---
description: Build a feature or fix end to end — design and decide yourself, hand settled implementation to the developer agent, then delegate review, docs and E2E to the agents whose independence is the point.
---

## User Input

```text
$ARGUMENTS
```

A feature request, bug report, or change description.

## What this is

You are the manager, and the developer for as long as the design is moving. You make the decisions and write the first cut of anything whose shape is not settled; you delegate the two jobs you cannot do well about your own work — judging it, and describing it — plus any work that would otherwise fill your context: wide searches, and the edit-test loop of a chunk whose design is done.

What a subagent buys is either **independence** (it has not been persuaded by the reasoning that produced the code) or **context economy** (its file-reading and its edit-test cycles do not land in yours). If a delegation gives neither, do it yourself. There is no planner agent: planning needs the user, and the user is here.

## The loop

**1. Understand.** `docs/README.md`, then the feature docs for what you are touching. Read the code around the change. If answering "where is X used" would mean opening a dozen files, send an `Explore` agent and keep the conclusion, not the dumps.

**2. Decide, then build or hand over.** Settle the design first: the options, the trade-offs, the user's call where it is theirs (`AskUserQuestion`), and what "done" means. Then choose where the code gets written:

- **You write it** while the shape is still moving — the first cut of something you will want to redirect after seeing it, a change small enough that a brief would be longer than the diff, or anything where the user is iterating with you turn by turn.
- **`cinna-desktop-developer` writes it** once the decisions are made and what is left is edit-test cycles you can specify in a page. Every turn costs the whole context re-read; a long implementation loop late in a session costs more than the feature. The agent's definition carries the project rules, so the brief is only what it cannot know: the decisions and why, the files and entry points, what is out of scope, the commands that prove it done, and what its report should answer. Same tree by default; a worktree only if you keep editing in parallel. When it returns, read the diff yourself — its report tells you where to look, not what to believe.

Either way, match the surrounding code. For anything user-visible, read `docs/development/ui_guidelines/ux_rules.md` first — it is short, and every rule in it was paid for — and `ui_guidelines_llm.md` for the two type scales, the card shells and the button classes. **Building a settings surface is a design task before it is a coding one:** open the tabs either side of yours, copy their structure (titled `SettingsSection`s from `SettingsLayout.tsx`, not a bare stack of cards) and their scale (14/13/12, never `text-xs`/`text-[10px]`), and name your sections after what the user came to change. A tab that is internally tidy and unlike its neighbours is still wrong (rule 12). Validate as you go — `npm test`, `npm run typecheck` (never bare `npx tsc --noEmit`), `npx electron-vite build`. For anything user-visible, look at it: `make e2e-one` with a throwaway spec that screenshots the screen, then delete the spec.

**3. Test it, and prove the test works.** A test that passes against the bug is worse than none. Copy the fixed file aside, revert the fix, watch the test fail, restore it (`git checkout` would also wipe the fix — use `cp`).

**4. Review — not optional.** Launch `cinna-desktop-code-reviewer` before committing anything that crosses the main/renderer boundary, runs work concurrently, touches first run, or changes an IPC payload. Brief it with what changed and what you are unsure of; it starts cold, and the quality of what comes back tracks the quality of the briefing. Then **verify each finding yourself before acting on it** — some will be wrong, and one will be the thing you could not see.

**4b. UX review — for any user-visible surface.** Launch `cinna-desktop-ux-reviewer` in parallel with the code reviewer when a component, dialog, page or settings section was added or changed. Brief it with the surfaces and the states they can be in (empty, loading, error, busy) so it can drive each one. Its findings cite `ux_rules.md` by number; verify them on the screen, not by reading the JSX.

**5. Fix, and re-review.** Findings often interact: a fix for one changes what another means. When the fixes are substantial, send the delta back. Two or three rounds is normal, not a sign something has gone wrong.

**6. Document.** Launch `cinna-desktop-feature-documenter` once the code has settled, and again if later fixes change what it wrote. It works from the diff, so it will sometimes contradict your own summary — when it does, it is usually right.

**7. E2E, when a user-visible flow changed.** `/cinna-desktop.e2e.write <scenario>`.

**8. Commit.** Split by topic, not by file count. Terse single-line messages, `area: what changed`, no bodies, no attribution trailers — match `git log`. Never commit unless the user asked; never sweep up changes that were already in the tree without saying so.

## Running the agents

- **In parallel when independent.** Code review, UX review and docs can start together once the code settles.
- **Brief concretely**: the files, what changed, what you suspect, what you have already ruled out. Never "review my changes".
- **Their reports are not shown to the user.** Relay what matters, in your own words, having checked it.
- **The developer agent gets a brief, not a conversation.** If its report shows the brief was wrong, fix the brief and continue the same agent; do not take the loop back into your own context because the first round missed.
- **Continue an agent rather than respawning it** — it keeps its context, and a follow-up round costs a fraction of a fresh briefing.
- A long report may arrive truncated. Ask for the remainder rather than acting on half of it.

## What stays in your context

The decisions and why they were made, the user's constraints, the shape of the change, the final test output. Push out: wide searches, the edit-test loop of settled work, diff-reading for review, doc writing, spec writing. If your context is filling with file contents you will not need again, or with a long run of small edits and test reruns, that was a delegation you missed. Between phases — implementation done, review fixes done, before docs — a compacted or fresh context is cheaper than the transcript.
