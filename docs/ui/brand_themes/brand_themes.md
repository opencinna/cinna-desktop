# Brand Themes

## Purpose

Let a Cinna server give every desktop signed in to it its own look: colours for both modes, a background, a logo and a new-chat heading. The server's admin publishes it once; users get it without doing anything.

## Core Concepts

- **Brand theme** — One document a Cinna server publishes (`cinna.brand-theme/1`, served at `GET /api/v1/brand-theme`, public): a name, 35 named colour roles for Dark and for Light, optionally a logo and a background per mode, and optionally a new-chat heading. Roles are names, never CSS; the desktop maps them onto its own colour variables in one place. The contract and its fixtures belong to cinna-core; the desktop only reads it.
- **Stock Cinna** — The look with no brand: the built-in palette and mesh background. A guest, local or non-Cinna profile always shows it.
- **Origin, not profile** — A theme belongs to a server origin. Two profiles on one server share one cached theme.
- **Last good theme** — The most recent theme that passed the desktop's checks, kept on disk per origin so it applies at once on a profile switch or a restart with the server unreachable.
- **Revision** — A number the server bumps on every publish. Windows compare it to know whether they already show the current theme.

## User Stories / Flows

1. A user signs in to a Cinna server that has published a theme. The app, its sidebar, popovers, modals and the dashboard tiles take the brand's colours for whichever mode is showing (Dark, Light or System as resolved); the body background is the brand's image for that mode or a flat base colour.
2. The new-chat screen shows the brand's logo where the Cinna mark was, and the brand's heading in place of "What can I help with?".
3. The admin publishes a new revision. Within five minutes every open window changes, with no restart.
4. The admin unpublishes the theme. The next refresh sees no theme and the app returns to stock.
5. The user switches to another profile. The new profile's server theme (or stock) is applied before any window shows the new profile's data, so one account's look never sits over another's chats.
6. The user switches to a password-locked profile. The lock screen already looks like that profile's server, from the cache; Cancel or unlock returns to the active profile's look.

## Business Rules

- **No opt-out on the desktop.** The server admin controls the look; the user's only lever is the installation-wide Dark/Light/System choice, which still works inside a brand (see [Appearance](../appearance/appearance.md)). Unpublishing is the way back to stock.
- **Safety is checked on the desktop; taste is not.** Core already judged the theme when it was saved, so the desktop re-checks only what could hurt it: the document's shape, every role present in both modes, each colour exactly lowercase `#rrggbb` (nothing else can reach CSS), each asset's sha256 against its bytes, its type sniffed from the bytes and matching what the server declared, size limits, raster dimensions read from the bytes (at most 4096 px a side), a strict allowlist for SVG, and plain text (no control characters, heading at most 60 characters). It does not re-check contrast or whether colours look good; a theme core tags incompatible still applies. A theme is applied whole or not at all.
- **A failed refresh keeps the last good theme.** Network error, timeout, 429, 5xx, an oversized or malformed response, a missing asset or a theme that fails the checks all leave the cached theme in place and are only logged. Only a 204 or 404 (no theme published, or a core without the feature) forgets it. A broken publish must not unbrand a working install.
- **A cached theme is checked again on the way out.** If it no longer passes (a newer desktop with stricter checks), the app shows stock and announces stock, not the stale revision.
- **Refresh on activation, then every five minutes**, on the same cadence as the team library, while the profile is active. Unchanged documents are revalidated with the ETag. Assets are fetched by their hash from the same server, never from a URL the document names, and only when not already stored.
- **The background never falls back to the stock mesh.** A mode with no background image, or a theme with no background at all, shows the flat base colour. The stock mesh would clash with a brand's palette.
- **Brand wins over stock, utilities win over brand.** The brand sheet sits in its own cascade layer between the stock values and the component styles, so a component's own utility class is never overridden by it. See "Brand layer" in [UI Guidelines](../../development/ui_guidelines/ui_guidelines_llm.md).
- **Glass surfaces take their tint from the brand.** The Light sidebar already reads the colour variables; the Dark sidebar, popovers, the light glass card, the modal panel and the light ask/permission block read the brand's roles instead of the literal near-black or near-white they use in stock. Relative overlays (a low-alpha white or black highlight) and shadows stay as they are, because they lighten or darken whatever is underneath.
- **The new-chat logo takes the Cinna mark's box.** The brand logo is an image 62 px tall and up to 240 px wide, for the mode showing, so the heading and composer sit where they do with the stock mark. It is shown at once: no click-to-reveal, no draw, no sweep. It follows the active profile, never a lock screen's override. A theme with no logo keeps the stock wireframe mark.
- **Heading priority on the new-chat screen:** the guided-build heading when it applies, else the brand's heading, else "What can I help with?".
- **The tray popup gets colours only.** It has no mesh and stays transparent, so the brand's background is never written there.
- **The first-run welcome screen stays stock.** It appears before any server is chosen, so no brand can apply to it.
- **Dashboard pages follow the brand.** An HTML tile's frame gets the app's variables through the host context, and re-reads them when the brand moves, as it does for a theme change.
- **The brand reaches the composer through the Theme Default chat-mode color.** A default chat mode whose color is `theme` is tinted by the accent, so it follows the brand. The first time a profile has a brand (cached is enough, after an account-config sync and when a new revision lands) its default mode adopts that color, once: a color the user picks afterwards is never overwritten, even if the brand is unpublished and republished. A profile with no default at that moment counts as done. See [Chat Modes](../../chat/chat_modes/chat_modes.md).
- **Unlock controls use the brand's on-accent colour.** Under a brand the lock's avatar initial and unlock button draw their text in `accent.on`, not fixed white.

## Architecture Overview

Server (`GET /api/v1/brand-theme` + assets) -> brand theme service (checks, caches per origin) -> database (last good theme, assets) -> `brandTheme:changed` `{origin, revision}` -> each window -> `brandTheme:get` -> style sheet in the brand layer + `data-brand` on the document.

Profile activation -> cached theme for that server -> announced before anything is awaited. Password lock -> `brandTheme:getForProfile` (cache only) -> temporary override in the window.

## Integration Points

- [Technical details](brand_themes_tech.md) — files, channels, store and sheet.
- [Appearance](../appearance/appearance.md) — Dark/Light/System stays installation-wide; the brand supplies colours for each mode, and the new-chat logo and heading.
- [Cinna Accounts](../../auth/cinna_accounts/cinna_accounts.md) — the profile's server URL decides the origin.
- [Dashboards](../dashboards/dashboards.md) — frames re-read host variables when the brand moves.
- [Menu-Bar Tray](../tray/tray.md) — the popup applies the brand's colours.
- [Onboarding](../../auth/onboarding/onboarding.md) — stays stock.
- [Team sharing](../../agents/local_agents/team_sharing.md) — shares the five-minute refresh cadence.
