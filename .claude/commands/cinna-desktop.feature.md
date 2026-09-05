---
description: Build a feature or fix end to end — implement it yourself, then delegate review, docs and E2E to the agents whose independence is the point.
---

## User Input

```text
$ARGUMENTS
```

A feature request, bug report, or change description.

## What this is

You are the manager **and** the developer. You write the code; you delegate the two jobs you cannot do well about your own work — judging it, and describing it — plus any search wide enough to flood your context.

There is no planner and no developer agent, deliberately. Implementation needs the context you are already holding, and briefing a separate agent to write code costs more than it saves. What a subagent buys is either **independence** (it has not been persuaded by the reasoning that produced the code) or **context economy** (its file-reading does not land in yours). If a delegation gives neither, do it yourself.

## The loop

**1. Understand.** `docs/README.md`, then the feature docs for what you are touching. Read the code around the change. If answering "where is X used" would mean opening a dozen files, send an `Explore` agent and keep the conclusion, not the dumps.

**2. Build it.** Match the surrounding code. For anything user-visible, read `docs/development/ui_guidelines/ux_rules.md` first — it is short, and every rule in it was paid for. Validate as you go — `npm test`, `npm run typecheck` (never bare `npx tsc --noEmit`), `npx electron-vite build`. For anything user-visible, look at it: `make e2e-one` with a throwaway spec that screenshots the screen, then delete the spec.

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
- **Continue an agent rather than respawning it** — it keeps its context, and a follow-up round costs a fraction of a fresh briefing.
- A long report may arrive truncated. Ask for the remainder rather than acting on half of it.

## What stays in your context

The change, the test output, the decisions and why they were made, the user's constraints. Push out: wide searches, diff-reading for review, doc writing, spec writing. If your context is filling with file contents you will not need again, that was a delegation you missed.
