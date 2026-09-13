# Appearance

## Purpose

Let the user choose the app's color theme and whether chat switches and idle surfaces have decorative motion. These preferences apply across local profiles and app windows, so switching accounts does not unexpectedly change the interface.

## Core Concepts

- **Theme preference** — System, Dark or Light. System follows the operating system; Dark and Light remain fixed. Dark is the fallback when no valid preference is saved.
- **Resolved theme** — The current Dark or Light appearance after resolving System. The app surface, dock/window icon and tray popup use this result; the menu-bar glyph follows the OS separately.
- **Extra UI animation** — One default-on preference for quick chat-switch transitions, grid pulses, input/sidebar border glows, secondary-button border glows and header-button background waves. These effects convey no readiness, progress or required action.
- **Quiet interval** — A delay between bursts, including after the user leaves an input they interacted with. Decorative motion must not compete with editing.

## User Stories / Flows

### Choosing appearance

1. Open Settings → Default → Features → Interface.
2. Choose System, Dark or Light. The selected choice applies and saves immediately; System also follows later OS appearance changes.
3. Turn **Extra UI animation** off to remove decorative effects and chat-switch motion, or on to allow them. Appearance controls remain available while service-backed settings are loading or unavailable.
4. Other app windows adopt saved changes, and restarting retains the preference.

### Using the sidebar shortcut

1. Open the sidebar footer's Interface popover and use Theme.
2. The shortcut selects the opposite of the currently displayed theme as a fixed preference. From System showing Light, it selects Dark; from System showing Dark, it selects Light.
3. Choose System again in Features to resume following the OS.

### Working in a composer

1. The expanded sidebar and shared chat inputs can show faint grid pulses with branching, lightning-like trails. The shared input covers new chats, existing chats and folder/external agent pages; the Agents Development entry composer participates too.
2. Input and sidebar borders occasionally receive a traveling highlight. The actual border remains intact, including chat-mode, focus and drag-over colors.
3. Pointer, keyboard, text-input or composition interaction with a textarea immediately starts a short fade of its grid and border artwork. It stays quiet until blur followed by a full quiet interval; autofocus alone does not silence it.
4. Editing one composer does not silence the sidebar or other independent surfaces. Header controls can receive a left-to-right background wave, and at most one eligible secondary button receives its own border glow at a time.

### Switching chats

Switching between chats in the main workspace (including its new-chat screen) sweeps a soft diagonal curtain from the upper left to the lower right: the old layout wipes away and fades first, then the new layout is revealed. Text and layout stay stationary; only the curtain edge moves. The full transition finishes within 260 ms. Selection and input remain immediate; rapid switches replace the current transition. Opening the chat view initially and receiving messages in the same chat do not trigger this effect. Navigating to agent, Notes or settings pages does not add a general page curtain.

## Business Rules

- **The curtain moves; the text does not.** Chat selection updates immediately, then the old layout fades away before the new one reveals. No text translation, duplicate live chat or delayed navigation is introduced. Returning to a composer restores its [session draft](../../chat/conversation_ui/conversation_ui.md#leaving-and-returning-to-a-draft), whether animation is enabled or disabled.

- **Preferences belong to this installation's renderer storage.** They are shared across profiles and same-origin windows, survive restart, and do not enter profile/cloud sync or the main-process app-settings database.
- **Reduced motion takes precedence.** The OS reduced-motion setting suppresses decorative effects and chat-switch motion without changing the saved Extra UI animation preference. Restoring motion or document visibility schedules fresh bursts; elapsed hidden time does not accumulate a queue.
- **Document visibility bounds the schedulers.** A hidden document clears pending effects. Losing window focus alone is not the visibility rule. Collapsing the sidebar disables its decoration; the build composer disables its decoration while inactive or unready.
- **Decorations do not own input or layout.** They sit behind content, ignore pointer events and expose no accessibility content. Only the decorative layer is clipped by the grid implementation; existing popover and border behavior remains owned by the host.
- **Secondary buttons opt in explicitly.** Shared settings buttons, Local Development secondary actions and the neutral Settings action on agent pages are eligible. Selection excludes disabled, hidden, offscreen and center-occluded controls; primary sending actions do not opt in.
- **Header waves affect backgrounds.** The four controls keep their existing glyphs and status indicators; hover or visible keyboard focus suppresses a control's wave layer.
- **Extra animation is not a general motion switch.** Existing sidebar transitions, loading indicators, tray fades and other feature-owned animations keep their own behavior. Theme changes do not change the OS theme or authentication/runtime settings.

## Architecture Overview

Active chat ID change + Extra UI animation + motion/visibility guards → outgoing DOM snapshot → old-layout curtain exit → live-layout curtain reveal.

Features / sidebar Theme shortcut → renderer UI store → localStorage → other app windows.

Theme preference + OS appearance → resolved theme → document colors + existing app-theme IPC → dock/window icon; tray popup resolves the same preference independently.

Extra UI animation + reduced motion + document visibility + host/interaction state → grid / border / secondary-button / header schedulers → decorative CSS layers.

## Integration Points

- [Conversation UI](../../chat/conversation_ui/conversation_ui.md) — independent draft retention, message actions and transcript scrolling; animation never owns message or draft state.

- [Technical details](appearance_tech.md) — storage, scheduler timing, rendering and cleanup contracts.
- [Settings](../settings/settings.md) — Features hosts the theme group and animation switch.
- [App Shell](../app_shell/app_shell.md) — sidebar shortcut, sidebar decoration, header wave and shared chat workspace.
- [Menu-Bar Tray](../tray/tray.md) — separate popup theme resolution and OS-colored menu-bar glyph.
- [Account Build Sessions](../../agents/local_dev/build_sessions.md) — development composer and secondary actions use the same appearance preference.
