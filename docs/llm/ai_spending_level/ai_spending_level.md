# AI Spending Level

## Purpose

Tell the user when a chat's context has grown past what they are willing to spend on it, so they can start a new chat or compact before every message re-reads a huge context. A preference, not a limit: nothing is stopped, trimmed or compacted on its own.

## Core Concepts

- **AI spending level** — the installation-wide setting `aiSpendingLevel`: **Eco**, **Mid** (the default) or **Greedy**. Settings → Features → AI Functions, a segmented control after Default multi-agent routing. It is the first of the built-in spend-assistance behaviours; it decides only the budget below
- **Context budget** — how many context tokens a chat may use at that level (`contextBudget`). Eco: the smaller of 250K and 60% of the window. Mid: the smaller of 350K and 80% of the window. Greedy: the whole window. The share exists so a 200K model still gets a budget it can reach (Eco 120K, Mid 160K) rather than a 250K cap it never hits
- **Context health** — the chat's standing against the budget (`contextHealth`): the budget, the fill (`used / budget`, clamped to 0–1) and whether it is **over** (`used >= budget`, so exactly at the budget counts)
- **No data, no assistance** — health exists only when the [session telemetry](../../agents/session_telemetry/session_telemetry.md) reading has an authoritative window size (`sizeAuthoritative`). A size that is the adapter's guess, or no size, gives no budget, so nothing is drawn and nothing is announced. A guessed size would put the line and the toast on a number that the next reading may move

## User Stories / Flows

### The user sees how close a chat is
1. In a chat whose local Claude or Codex agent has reported a confirmed window size, a 2 px line runs along the bottom edge inside the mode badge under the composer (`Local`, `Direct`, `You route`, …). Its width is the fill
2. Its colour is green up to half the budget, mixes to amber by 80% and to red at the budget, continuously and from theme colours only
3. The badge popover's collapsed Context row leads with the same share: `46K | 15% Mid budget | 6% total` — used tokens, the share of the budget, the share of the whole window. The budget share is not clamped (`150% Eco budget` past it, while the line stops full)
4. Expanding the row shows, after the context reading, a **`{Level} budget`** row: the budget in tokens and, as its muted qualifier, the share of it used (`350K`, `42% used`)
5. At **Greedy** the budget is the window, so the row drops its budget part (`46K | 6% total`) and the expanded section has no budget row; the line still draws

### The chat crosses the budget
1. The context grows past the budget during a turn, while the chat is on screen
2. A toast says the context reached the level's budget (naming level and token count) and suggests a new chat or compacting; its link opens **Settings → Features**
3. It is said once. Only a reading back under the budget (a compaction, a new session) re-arms it

### The user changes the level
1. Settings → Features → AI Functions → **AI spending level**. The line, the Context row's budget share, the budget row and the next crossing follow the new budget at once; the change itself never raises the toast

## Business Rules

- **A toast needs a crossing heard live.** It fires only when a reading below the budget is followed by one at or above it, in the same chat, at the same level, both heard by the badge on screen. Everything else only records the reading:
  - **Opening a chat**, or switching to one, that is already over: the first reading for a chat is a baseline. Telling the user on every visit to a long chat would turn a nudge into noise
  - **Coming back to a chat that crossed while away**: readings while the telemetry query is fetching do not count — the cached reading shown on return and the refetch that replaces it. The rise happened while nobody was looking, and announcing it late reads as something that just happened. Without the guard, a cached reading below the budget followed by the refetched one above it would look exactly like a crossing
  - **Changing the level** under a chat already past the new budget: the user just chose that budget and needs no telling
  - **The size becoming authoritative** with usage already over: a reading with no budget also forgets the last one, since "below" was a guess from then on
- **The line never replays on a chat switch.** It is keyed by chat, so another chat's reading appears on a fresh element at its own width instead of animating from the previous chat's. Width and colour animate only with **Extra UI animation** on, and never under reduced motion
- **The Context row and the line say the same thing.** The row's first share is the budget's, the figure the line draws. When the row showed only the window share, a `42%` row sat over a line more than half full and read as a contradiction. The window share stays after it as `total`
- **The line sits inside the pill** (the pill clips it) so the badge's size and the strip beside it do not move ([UX rule 1](../../development/ui_guidelines/ux_rules.md))
- **The setting is validated in main**: anything but `eco`, `mid` or `greedy` is refused (*Choose Eco, Mid or Greedy.*). A renderer with no settings yet reads Mid
- **What it does not do**: it does not cap, stop or compact a chat; it does not toast for a chat not on screen; it says nothing for engines without session telemetry, for job pages (whose badge has no chat), or before a confirmed window size. It does not price anything — cost lives in session telemetry's popover

## Architecture Overview

```
Settings → Features ── settings:set(aiSpendingLevel) ──► appSettingsService (VALUE_CHECKS) ──► app_settings
session-telemetry:changed ──► useSessionTelemetryBlock ──► ChatRouterBadge
                                    │  contextHealth(level, context)
                                    ├──► health line in RouterBadgeView
                                    ├──► useBudgetCrossingToast ──► toast.store (link: Settings → Features)
                                    ├──► Context row budget share (contextRowFigures; not at Greedy)
                                    └──► ContextSection "{Level} budget" row (not at Greedy)
```

## Integration Points

- [Session Telemetry](../../agents/session_telemetry/session_telemetry.md) — the context reading (`used`, `size`, `sizeAuthoritative`), the badge popover and its Context section the budget row sits in
- [Settings](../../ui/settings/settings.md) — the Features tab's AI Functions group hosts the control; the setting is unrelated to the [AI Functions](../ai_functions/ai_functions.md) credential binding beside it
- [App Shell](../../ui/app_shell/app_shell_tech.md) — the single desktop toast and its optional Settings link

## Technical Reference

`src/shared/aiSpendingLevel.ts` holds the levels, labels, `isAiSpendingLevel`, `contextBudget` and `contextHealth`; the key is in `AppSettingsSchema` (`src/shared/appSettings.ts`), its default in `DEFAULTS` (`src/main/db/appSettings.ts`) and its check in `VALUE_CHECKS` (`src/main/services/appSettingsService.ts`). In `src/renderer/src/components/chat/RouterBadge.tsx`, `ChatRouterBadge` computes health and passes `budgetLine` (`{key: chatId, fill}`) to `RouterBadgeView`, and `useBudgetCrossingToast` keeps the last reading (`chatId`, `level`, `over`) in a ref — so it also starts over when the badge remounts; it is given `null` while `SessionTelemetryBlockModel.fetching` (TanStack's `isFetching`). `budgetLineColor(fill)` is exported for its test. In `SessionTelemetryBlock.tsx`, `contextRowFigures(t, level)` builds the Context row's budget share and `ContextSection` the budget row; both skip Greedy. The control is in `FeaturesSettingsSection.tsx`. Tests: `src/shared/aiSpendingLevel.test.ts`, `src/renderer/src/components/chat/RouterBadge.budget.test.tsx` (line, Context row and budget row incl. Greedy and over 100%, colours, every toast case), `SessionTelemetryBlock.test.tsx` (the row's figures and its unconfirmed-size case), `appSettingsService.test.ts`, `FeaturesSettingsSection.test.tsx`.
