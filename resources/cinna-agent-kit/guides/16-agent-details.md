# 16 — The agent's Details page

## Read this when

The user asks for a Details page: a readable page that tells other people what this
agent is and what it can do. Write one only when the user asks. It is optional, and
it is not a build step.

## What the platform already shows

Every agent gets a generated summary with no work from you. It has these sections,
in this order, and leaves out the empty ones:

1. About (the description)
2. How to start (the entrypoint prompt, quoted)
3. Things you can ask (example prompts)
4. Commands (`/run:<name>` from `docs/CLI_COMMANDS.yaml`)
5. Runs on its own (schedule name and cadence)
6. Skills and plugins
7. Connects to (credential labels and MCP servers)
8. Also offers (webapp, dashboards, agent API, webhooks, handovers)
9. What's new (release notes of the version)

It never shows the workflow prompt or a schedule's prompt text. A custom page is the
pitch, not a copy of this list: say what the agent is for, show an example, answer
what a newcomer wonders. Do not paste prompts, credential values or template data.

## The file

Write one of these two files, relative to the agent root:

- `docs/AGENT_DETAILS.html`, for a designed page with visuals.
- `docs/AGENT_DETAILS.md`, for plain text.

One self-contained UTF-8 file, at most **1 MiB** (1,048,576 bytes). It travels with
the agent: publishing snapshots it, an update replaces it, and a desktop agent
carries it in its git repo. Never write it while acting as the agent; it is a
Builder change.

### HTML rules

- Inline `<style>` only. Images, and fonts if any, are `data:` URIs.
- No `<script>` and no external loads (no remote images, fonts, stylesheets).
- Responsive from 320 px wide up, with a viewport meta tag.
- No `<meta http-equiv="refresh">`: the page must not reload or redirect itself.
- Handle light and dark with `prefers-color-scheme`.
- Links are plain `https:` anchors. Give each one `target="_blank"`: the page is
  shown in a sandboxed frame, and a link without a target tries to navigate that
  frame itself instead of opening outside the app.

The platform adds the Content Security Policy tag and, when missing, the viewport
tag, and removes every `<meta http-equiv="refresh">` tag. Nothing else in your file
changes. The page is shown in a sandboxed frame of
fixed height that scrolls inside, so do not rely on script-driven resizing.

### Markdown rules

CommonMark plus GFM tables and task lists. Raw HTML is not rendered, and images show
only their alt text, so use HTML when you need visuals. Links open outside the app.

## When both files exist

HTML wins, and the platform reports the warning `both_present`. If the winning file
is over 1 MiB or not valid UTF-8, the other file is used. If neither is usable, the
generated summary is shown and the warning is `too_large` or `invalid_encoding`.
A file with only whitespace counts as absent.

## Preview

- Cloud agent: open the agent's **Bundle** tab and use the **Details preview** card.
  It reads the platform's cached copy of the workspace, not the live files. Edits
  reach it after the file watcher fires, or on the next activation, session or cron
  run. Refresh shows the last pulled copy. A file deleted outside a session shows as
  gone only after the next session, cron run or activation. The same answer is
  `GET /api/v1/agents/{agent_id}/details`.
- Desktop agent: the app's Details button on the agent.
- Offline: open the HTML in a browser with the network off. Everything must render.

## Done when

- [ ] The user asked for the page.
- [ ] One file, under 1 MiB, valid UTF-8, at `docs/AGENT_DETAILS.html` or `.md`.
- [ ] HTML: no `<script>`, no remote URL, `data:` images only, viewport meta, dark and light checked, `https:` links with `target="_blank"`.
- [ ] No prompt text, credential value or private data in it.
- [ ] Previewed with no warning, or the warning understood.
