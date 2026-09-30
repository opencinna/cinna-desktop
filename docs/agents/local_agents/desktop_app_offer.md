# Detected Desktop Apps — "use the subscription you already have"

## Purpose

A Mac with **Claude Desktop** or the **ChatGPT** app belongs to someone who already pays for Claude or ChatGPT, but who usually has no `claude` or `codex` CLI and has never heard of either. Cinna already downloads the pinned CLIs and runs their logins in-app; this offer joins those pieces into one click on the new-chat screen: *Use Claude* / *Use ChatGPT* installs the engine if needed, signs in if needed, and makes it what chats and agents run on.

## Core Concepts

- **Detected app** — a vendor bundle found under `/Applications` or `~/Applications` whose `Info.plist` carries the vendor's bundle id. Two are known: Claude Desktop (`Claude.app`, engine `claude`) and ChatGPT (`ChatGPT.app` or `Codex.app`, engine `codex`; the current ChatGPT app ships as `com.openai.codex`). Only the id, the display name and the engine leave main — the bundle path does not
- **Connect** — the one sequence *Use …* starts in main: **installing** (ensure the [pinned CLI](../../development/runtime_pins/runtime_pins_llm.md)), **checking** (drop the cached login answer and ask the CLI again), **signing-in** (only when not logged in: the engine's own in-app login, the same one the agent panel runs), then **adopt**
- **Adopt** — make the engine the **Default runtime** (`localAgentsDefaultEngine`) and, when the effective default chat mode names a *different* engine, move the default chat mode onto this one
- **Dismissal** — a per-install list of app ids the user has waved away, by the X or by connecting

## User Stories / Flows

### ChatGPT user
1. The user finishes or skips onboarding and lands on the new-chat screen
2. Above the logo: *"ChatGPT is installed — use your ChatGPT subscription as Cinna's default for chats and agents."*, a **Use ChatGPT** button and an X
3. They press it. The button reads *Installing…* while the pinned Codex downloads, then *Checking…*
4. The ChatGPT app writes `~/.codex/auth.json`, and the `codex` Cinna runs reads it (its environment keeps `HOME`), so the check usually finds a login and **no browser opens**. This was observed on the developer's Mac; it has not been verified on a clean one
5. Codex becomes the Default runtime, the banner goes away and stays away

### Claude Desktop user
1. Same banner, **Use Claude**
2. Claude Desktop's login is **not** shared with Claude Code — it keeps a Keychain item of its own — so the check usually finds no login and the button reads *Sign in in your browser…*, with **Cancel** beside it. The CLI opens the browser; nothing is pasted back
3. On a finished sign-in Claude becomes the Default runtime and the banner goes away. Cancel returns the banner to its offer with no error

### Both installed
One sentence for both — *"Claude Desktop and ChatGPT are installed — use either subscription as Cinna's default for chats and agents."* — and both buttons. Connecting either dismisses **both**: the user has made their choice, and offering the other one on every new chat would be nagging. The X dismisses every app shown, too.

### A connect that fails
The reason appears in red on the button row — for example *"Set a Claude path in Settings: downloading Claude Code is switched off in this environment."* — the offer stays, nothing is dismissed, and the button is live again for another try.

## Business Rules

- **Only the bundle's own `Info.plist` is read.** Never `~/Library/Containers`, another app's Application Support, or the Keychain, and no `mdfind` or `plutil`: any of those can raise a macOS privacy dialog, and a dialog at launch is exactly what the [bare-Mac check](../../development/bare_mac/bare_mac.md) fails on. The bundle id is matched as bytes, which holds for both XML and binary plists
- **macOS only.** Other platforms detect nothing; Windows and Linux are out of scope
- **Detected once per launch, lazily.** The first ask — the banner mounting after first run — scans; the answer is kept for the process's life. An app installed while Cinna runs shows up next launch
- **Never during onboarding.** The banner lives in the app shell's new-chat screen, which `OnboardingGate` does not mount during first run, so the offer comes only once onboarding is completed or skipped. It is on the main new-chat screen only, not on agent pages
- **Hidden when the app is already in use.** An app is offered unless it is dismissed, or its engine is the Default runtime **and** the effective default chat mode either names no engine (it inherits the Default runtime) or names the same one. The Default runtime alone is not enough: the [first-launch settling pass](engine.md#the-machine-default-is-selected-once-and-explicit-agents-keep-their-choice) locks a Mac that has `claude` to Claude, but onboarding's API-key path then creates a "Default" chat mode on `opencode`, so chats spend the key — and *Use Claude* still changes something there. Hiding the offer on the runtime alone was caught in review
- **Nothing shows until both facts are known.** The banner waits for the Default runtime, the chat modes and the settings (account-default precedence) before rendering; a banner that appeared and was then withdrawn once the defaults loaded would be a flash the user cannot act on
- **It never moves the composer.** The banner is absolutely positioned at the top of the new-chat screen, as the hint bar is at the bottom, and renders nothing — no reserved space — when there is nothing to offer ([UX rule 1](../../development/ui_guidelines/ux_rules.md)). A failure goes on the button row, truncated with the full text in its tooltip, rather than under it: on a short window the banner overlays the logo and must not grow
- **Main owns the connect.** A browser sign-in takes minutes; the new-chat screen may be gone by then. The sequence runs to its end in main whether or not a banner is watching, and its renderer follow-up (re-reading the Default runtime, chat modes, agents, credential bindings; dismissing) is registered on the mutation itself, not on a `mutate` call that an unmounting caller would drop. A banner mounted mid-connect asks main what is running and shows that phase
- **One connect at a time.** A second press for the same app joins the running connect; a press for the other app while one runs is refused with *"Another app is being set up. Try again when it finishes."* All buttons, the X included, are disabled while a connect runs
- **Outcomes are data.** `enabled`, `cancelled` or `failed` with a reason, never a thrown error — a thrown error's code does not survive IPC
- **Adopt writes the same setting the Settings picker writes**, through the same validated write, followed by the same agent re-index. It is the one writer of `localAgentsDefaultEngine` outside Settings → Agents and the first-launch settling pass
- **Adopt moves the default chat mode only when it has to.** A chat runs on its mode's engine before the Default runtime, so when the effective default names a different engine explicitly, a local, credential-less mode on this engine becomes the default — an existing one if there is one, otherwise a new **"Claude"** (amber) or **"Codex"** (emerald). A default that names no engine, or no default at all, already follows the Default runtime and is left alone
- **Dismissal is per install, in `localStorage`**, not `app_settings` — a cosmetic flag has no business widening the settings schema, as with [hints](../../ui/hints/hints.md). It does not sync and is not per profile

### Known limits
- **A failure reason is lost if the banner remounts mid-connect.** The phase is recovered from main, but the result belongs to the mutation of the banner that pressed; a new banner shows the offer again with no reason
- **No cancel while installing.** Cancel exists only in the signing-in phase, where it stops the engine login; the CLI download runs to its end
- **An account default that wins by precedence is left alone.** When Settings → Features → *Prioritize ‘Account’ defaults over default profile* is on and a managed default chat mode names another engine, adopt changes the Default runtime but not the mode — that is the account's decision. Chats started from that default still run on its engine

## Architecture Overview

```
ChatWorkspace (new-chat screen, not embedded)
  -> DesktopAppsBanner -> useDesktopApps        -> local-tools:desktop-apps        -> desktopAppsService.list() (memoized scan)
                       -> useDesktopAppConnect  -> local-tools:desktop-app-connect -> desktopAppConnectService.connect()
                                                                                        ensureBinary -> auth probe -> engineLogins -> adoptDesktopEngine
                       -> useDesktopAppRunning  -> local-tools:desktop-app-running (phase, polled while one runs)
                       -> desktopApps.store (localStorage dismissals)
```

## Integration Points

- [The Local Engine](engine.md) — the Default runtime this writes, and the first-launch settling pass that usually sets it first
- [The Claude Engine](claude_engine.md) / [The Codex Engine](codex_engine.md) — the pinned binaries, login probes and in-app logins the connect reuses; Cancel is `local-tools:engine-login-cancel`
- [Chat Modes](../../chat/chat_modes/chat_modes.md) — adopt may make an existing mode the default or create a "Claude"/"Codex" one
- [Onboarding](../../auth/onboarding/onboarding.md) — the offer appears only after first run, and onboarding's API-key mode is the case the visibility rule was widened for
- [Bare-Mac Tests](../../development/bare_mac/bare_mac.md) — detects both apps in a real `/Applications` with no system dialog
- Technical reference: [desktop_app_offer_tech.md](desktop_app_offer_tech.md)
