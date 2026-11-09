# Brand Themes — Technical Details

Implementation companion to [Brand Themes](brand_themes.md).

## File Locations

### Shared

- `src/shared/brandTheme/roles.ts` — the `cinna.brand-theme/1` types, the 35 roles in core's order, `BRAND_THEME_COLOR_RE`, `ResolvedBrandTheme`, `BrandThemeChangedPayload`, channel names.
- `src/shared/brandTheme/roleMap.ts` — `BRAND_ROLE_MAP`: role to `--color-*` variables. The only place the mapping lives; `roleMap.test.ts` checks it against `main.css`.
- `src/shared/brandTheme/servedAssets.ts` — `servedAssetShas`: the hashes a served document references, read without trusting it.
- `src/shared/brandTheme/fixtures/` — core's test data, copied; not edited here.

### Main process

- `src/main/services/brandTheme/brandThemeService.ts` — `createBrandThemeService`, `brandThemeService`: `get`, `resolveForProfile`, `applyForProfile`, `refresh`, `brandingChanged`, `start`, `stop`. `deps.brandingEnabled()` (reads `serverBranding`) makes `get`, `resolveForProfile` and the cached payload of activation/refresh answer null, and stops a refresh from publishing.
- `src/main/services/brandTheme/parse.ts` — `parseBrandTheme`, `toResolvedBrandTheme`, `BRAND_ASSET_LIMITS`: the safety checks. Pure.
- `src/main/services/brandTheme/svgCheck.ts` — `checkSvg`: accepts exactly core's canonical SVG serialisation and rejects anything else instead of repairing it.
- `src/main/services/brandTheme/imageFacts.ts` — `sniffMime`, `rasterSize`: type and pixel size from the bytes.
- `src/main/db/brandThemes.ts` — `brandThemeRepo`: `get`, `assets`, `save` (one synchronous transaction, then prunes orphan assets), `delete`.
- `src/main/db/migrations/brand-themes.ts` — `brand_themes` and `brand_theme_assets` (creation only); `schema.ts` mirrors them.
- `src/main/ipc/brandTheme.ipc.ts` — `registerBrandThemeHandlers`.
- `src/main/auth/activation.ts` — calls `applyForProfile` right after `setCurrentUser` (and for the guest on close), `start` after activation, `stop` on close.
- `src/main/services/libraryService.ts` — exports `REFRESH_INTERVAL_MS`, which the brand service reuses.

### Preload

- `src/preload/index.ts` — `window.api.brandTheme.get`, `getForProfile`, `onChanged`.

### Renderer

- `src/renderer/src/stores/brandTheme.store.ts` — `useBrandThemeStore` (`active`, `override`, `theme`, `key`), `initBrandTheme`, `handleBrandThemeChanged`, `applyBrandTheme`, `useBrandThemeForProfile`.
- `src/renderer/src/utils/brandThemeCss.ts` — `buildBrandThemeCss`, `brandBackgroundRules`: the generated sheet.
- `src/renderer/src/assets/main.css` — the `@layer` order at the top and the static `@layer brand` block at the end.
- `src/renderer/src/main.tsx`, `src/renderer/src/trayPanel.tsx` — call `initBrandTheme` before mounting React.
- `src/renderer/src/components/layout/ChatWorkspace.tsx` — new-chat logo and heading.
- `src/renderer/src/components/auth/PasswordUnlockForm.tsx` — `useBrandThemeForProfile`; `accent.on` text.
- `src/renderer/src/components/dashboards/views/WebView.tsx` (`useComponentBridge`) — re-sends host context when the store's `key` moves.

## Database Schema

- `brand_themes` — primary key `origin`; `revision`, `etag`, `theme_json` (the served document as sent), `fetched_at`.
- `brand_theme_assets` — primary key `sha256`; `mime` (sniffed), `bytes`. One row per hash, shared between origins, deleted when no stored document references it. No foreign key: a cache that the next refresh rebuilds.

## IPC Channels

- `brandTheme:get` — invoke, no arguments; returns `ResolvedBrandTheme | null` for the profile in view. Not gated on activation: windows ask before first paint, and before activation it answers for the profile the app is starting into (even a password-locked one). Themes are public data. Never throws; any failure is `null`.
- `brandTheme:getForProfile` — invoke `(userId)`; the cached theme of that profile's server, whether or not it is active. Cache only, never fetches. `null` for a non-string or empty id, a guest, local or unknown profile, no cache, or any error. Used by password-lock surfaces.
- `brandTheme:changed` — main to every window, payload `{ origin, revision } | null`. Carries no theme: a multi-megabyte background never rides an event. A window calls `brandTheme:get` unless it already shows that `origin#revision`. `null` means stock.

## Services & Key Methods

- `brandThemeService.ts:refresh` — per-origin, de-duplicated while in flight; never throws. Conditional GET with the stored ETag, 60 s timeout, document capped at 1 MB, assets at the larger background limit. 304 and every failure keep the cache; 204 and 404 delete it and announce `null`. A successful save announces only when the revision changed, and only if that origin is still the active one (re-checked after each await).
- `brandThemeService.ts:applyForProfile` — announces the cached theme of the profile's server before anything is awaited. A cache that cannot be read, or a row that no longer resolves, announces `null`.
- `brandThemeService.ts:start` / `stop` — one timer at a time; `start` refreshes at once and then every `REFRESH_INTERVAL_MS` (five minutes).
- `brandThemeService.ts:resolve` — re-runs `parseBrandTheme` on the stored document and assets, memoised per origin by revision and fetch time.
- `brandThemeService.ts:adoptDefaultMode` — if the profile resolves a brand, calls `deps.themeAvailable`, which runs `chatModeService.applyThemeDefaultOnce` and publishes `providers:account-config-synced` when a row changed. Called from `refresh` on a changed revision for the active origin, and from `account-config-sync.ts`. Never throws. Flag in `brandedDefaultModeProfiles`; see [Chat Modes tech](../../chat/chat_modes/chat_modes_tech.md).
- `brandThemeService.ts:serverOf` — origin and API base from the user's `cinnaServerUrl`; none unless the user is a `cinna_user`.
- `parse.ts:parseBrandTheme` — returns `{ ok }` or one `{ error }` reason for the log, never containing a URL. Unknown keys are ignored. It never re-judges contrast.

## Renderer Components

- Applying is two DOM writes: `<style id="brand-theme">` and `data-brand` on `<html>`. With no theme (or a theme the builder refuses) both are removed.
- The sheet has one `@layer brand` block with, per mode, the `--color-*` variables keyed on `[data-brand][data-theme="…"]`, and (only where `background: true`) the body `background-image` as the brand's data URL or `none`. The tray popup passes `background: false`.
- `buildBrandThemeCss` checks colours and data URLs again and refuses the whole sheet rather than write an unexpected value.
- The static `@layer brand` rules in `main.css` cover surfaces whose stock colour is a literal: `.app-sidebar` (Dark; the Light one already reads `--color-bg-secondary`/`--color-border`), `.app-popover-surface`, `.app-glass-card` (Light), `.app-modal-panel`, `.ambient-block` (Light). Add a static override there when a new surface hard-codes a colour; the rules are in [UI Guidelines](../../development/ui_guidelines/ui_guidelines_llm.md).
- The store's `active` is main's current theme, kept current even while an override shows. `useBrandThemeForProfile(userId)` sets an `override` while the lock is mounted and clears it on unmount; a late answer for a stale mount is dropped. If `brandTheme:changed` names the revision the override already shows (the profile was just unlocked), it becomes active with no round trip, so nothing flashes.
- `ChatWorkspace.tsx` reads `active` only (not the override): logo `logo[<resolved mode>]`, heading `copy.newChatHeading`.

## Configuration

App setting `serverBranding` (boolean, default true; only an explicit `false` turns it off), set from Settings → Features → Interface → Branding. `settings.ipc.ts` calls `brandThemeService.brandingChanged()` after saving it: that publishes null (off) or the cached revision (on) so every window re-resolves, and, when on with a brand and after activation, runs `adoptDefaultMode` for the active profile. It never throws; the setting is saved either way. The endpoint path is `BRAND_THEME_PATH`; asset URLs are built from the hash, not taken from the document.

## Security

- The server is untrusted input. Colours are restricted to lowercase `#rrggbb`, assets are verified against their hash and sniffed type, SVGs are strictly allowlisted, and only `data:` URLs of the four image types reach CSS.
- Assets are fetched by hash from the profile's own server through the host HTTP client.
- No credentials are sent: the endpoint is public, and the cache is keyed by origin, not user.
- A check failure never applies part of a theme.
