# UX Rules

The interaction rules every user-visible change in Cinna Desktop is judged against. [UI Guidelines](ui_guidelines_llm.md) says what things *look like* (tokens, card shells, button classes); this file says how a screen *behaves*. Each rule records the decision that produced it, so a reviewer can tell a rule from a taste.

These rules are enforced by the `cinna-desktop-ux-reviewer` agent, which runs on any change to a user-visible surface (see `CLAUDE.md`). A change that breaks one is a finding, not a style note.

## 1. Nothing jumps while the user is acting

Typing, tabbing between fields, clicking through a wizard, toggling a switch — none of these may change the size or position of what the user is looking at.

- **No per-keystroke hints.** A sentence that appears on the first character and disappears on the second resizes its container twice. Validate on blur or submit, or show the *result* in space that already exists (the live folder-name preview under the Name field shows `1-agent`; the sentence explaining why was removed).
- **Reserve the space only if it is filled in every state.** A status line that has something true to say when things are fine (which binary was found, what a choice resolves to) gets a one-line slot and always shows it. A message that only exists when something is wrong (a save error, a broken credential) is rendered only when it exists, *below* the control and last in its card: it may lengthen the card, it must never move the control or anything above it. Never insert it above controls the user is about to click. A slot that is empty in the healthy state is not a reservation, it is padding, and padding that differs from card to card is what the user sees (rule 12).
- **Wizard steps keep their footprint.** Successive steps of one dialog share a width and change height only when the content genuinely differs, never as a side effect of validation.
- **Async state is inline.** A spinner replaces a label inside the button (`Deleting…`, `Start` → spinner); it does not add a row.

**Origin:** the New agent dialog's slug hint ("Folder names need at least two letters or digits, so this one becomes `1-agent`…") appeared on the first keystroke and vanished on the second. The user read it as the interface "jumping". The slug was never blocking, so the sentence taught nothing the preview did not already show.

## 2. A page is a control surface first

What the user can *do* is above the fold; what they can *know* is discoverable behind tabs, a ⋯ menu or a details section.

- At most two or three visible primary actions (Open in…, Start chat). Occasional actions (Rescan, Reveal, Stamp identity, Delete) go in a **⋯ menu**, last and separated for the destructive one.
- Informational content that is "FYI" — file contents, identity, validation findings, publication history — lives under **tabs**. Tab selection persists across items of the same kind, so someone working through the same tab on several items does not re-select it each time.
- Hidden-but-relevant content is announced with a **count badge** on its tab (Commands `1`, Folder `2`), never with a banner.
- A **banner appears only when something needs attention**. A healthy state is a dot next to the title, not a green strip. Every page that greeted the user with a banner taught them to skip banners.

**Origin:** the local agent page was eleven stacked cards, each a viewer over one file; the one thing the user actually configures (what the agent runs with) was the seventh card down.

## 3. Ask for the minimum at creation

Creating something asks for the one field it cannot invent, creates immediately, and lands the user on the thing created. Everything else is configurable later.

- Optional fields sit under a collapsed **More options**; a sensible default fills each in main (a folder created from a name alone gets the name as its description, because the schema needs one).
- Enter submits. One name, one key.
- A derived value the user might care about (the folder name) is shown as a live preview, editable on demand, never a required confirmation.
- **Create is the last step.** Nothing stands between the user and the thing created — no follow-up step offering to open it somewhere the page it lands on already offers.

**Origin:** the New agent form asked for a sentence, a name, a folder and a root. The agent is built after it exists — in chat on its page, or in the user's own tool — and that is where the description gets written anyway. A later "Build it with…" step after Create offered the same tools as the agent page's Open-in button, one dialog away from it, and was removed for the same reason.

## 4. Remember the last choice, offer an explicit override

Where a user makes the same choice repeatedly (which tool opens a folder), the last pick becomes the default and the primary action uses it in one click. A menu behind a chevron holds the alternatives; picking one rewrites the default. Settings exposes the same value with a way to clear it back to "ask".

- **Auto-use is opt-in.** Skipping a step on the user's behalf needs an explicit choice, offered at the moment the user makes it and visible — and reversible — in Settings afterwards. A folder agent's permission ask offers **Always allow** beside Allow once; the grant it writes is listed on the agent's Permissions tab (under its Settings) with a revoke.
- A remembered choice that is no longer valid (the tool was uninstalled) degrades to "ask", never to a button that fails after the click.

## 5. Destructive actions confirm, and say what is and is not recoverable

- Always a confirm dialog, with the object named, the recoverable part first ("the folder can be put back from the Trash") and the consequence stated plainly. Copy must match the schema: if chats survive with a dangling binding, say that, not "chats are removed".
- Prefer the recoverable operation (`shell.trashItem`) over the irreversible one (`rm -rf`).
- **Undismissable while pending.** Escape, outside-click and Cancel are ignored while the action runs; the button reads `Deleting…`. Dismissing would cancel nothing and hide what is happening.
- Own the mutation in a component that outlives the dialog, so a success handler that clears state cannot be dropped with the dialog.
- A refusal because the object is **busy** (a turn in progress) is explained as busy, not as a failure: "nothing was removed".

## 6. Errors close nothing and land where the action was taken

- A dialog or step closes on **success only**. A failed launch, save or create keeps the surface open and shows the reason beside the control that triggered it, so the user can pick something else.
- Every message that crossed IPC goes through `unwrapIpcError` (`src/renderer/src/utils/ipcError.ts`) — the user must never read `Error invoking remote method '…'`.
- Silent failure is the worst outcome: a launch that did not happen, or a "Copied" over a clipboard the browser refused to write, with no message anywhere, is a defect even when everything else worked.

## 7. Copy fits, and sub-lines add information

- Select options and placeholders must fit their control at the narrowest supported width: `Default (none set)`, not `Default chat mode — none configured` truncated to `…none config`.
- A sub-line under a title never repeats the title. When the only description is the name, show nothing (sidebar) or an invitation to add one (page header).
- Labels name the thing, hints name the consequence; neither restates the other.

## 8. Menus and popovers

- Split button for "default action + alternatives": primary half runs the default, chevron half opens the menu. With no valid default, the whole button is the menu (`Open in…`).
- Menus are portaled via `usePopover` and marked `role="menu"` / `role="menuitem"` with an `aria-label`; every test and every E2E spec finds them by that name.
- The current default is marked with a check inside the menu; the menu never explains itself in prose unless it is empty.

## 9. A surface that names a file is asserting that file exists

Every card, tooltip and empty state that names a path is a claim about the thing on disk. When one kind of object has that file and another does not, the claim has to branch with it — and the answer is usually to say something true about the second kind, not to soften the sentence.

- **An absence is not a configuration.** "This agent declares no credentials", over a `credentials/.env` the app never creates for that kind of folder, reads as a step the user has not taken yet rather than a concept that does not apply. Drop the card.
- **Do not fall through to the nearest wrong answer.** A folder with no manifest reported `Kit: legacy manifest` — a value that means something specific and repairable, applied to a folder where neither is true.
- **A guarantee has to survive contact with the feature.** "Cinna writes nothing into this folder" was false the moment the page grew an editor over a file inside it. State the guarantee you actually keep ("Cinna installs nothing here") and name the exception.
- **Fictional examples discredit real ones.** A permissions card listing three things the agent will ask about, two of which named files that do not exist, invites the reader to discount the third — and the third was the one that mattered.
- **`AgentCard.file` is optional.** Where a value genuinely does not come from a file in the folder, pass no file rather than the closest path.

**Origin:** adopting a plain `AGENT.md` folder reused the kit agent page wholesale. Ten separate surfaces each asserted a file that folder shape has never had — the Status card, the Name card, the Runs-with panel's note, the Readme card's "run the agent's scaffold again", the Files list, Identity, Credentials, Published, Runs, and the Settings badge and sub-line. The first two were found before the review started, which is what made it a pattern rather than bad luck.

## 10. A control's accessible name is its visible name

Where the visible name branches, the accessible name branches with it. A hardcoded `aria-label` beside a conditional heading is a control that says one thing to one user and another to the next.

- **The most alarming wording is the one that must not be wrong.** A confirm dialog labelled "Delete agent" while its heading, its menu item and its button all said Remove — for the branch whose default deletes nothing — announced the harsher of the two words to precisely the users who cannot see the heading that would correct it.
- **A test that passes on the wrong name is not coverage.** Two E2E specs found that dialog by "Delete agent" and passed *because* it was hardcoded. Fixing the name should break them; assert the name each kind actually announces.
- **A control must not share a name with a choice inside what it opens.** The sidebar `+` was "New agent" and the dialog's first card was "New agent", so the name identified two different actions one click apart and every locator matched both. A trigger sharing a name with the *surface* it opens is fine — the `+` and the "Add an agent" dialog — because they are one intent at two moments, and only one of them is on screen at a time.

**Origin:** the same feature. Both the sidebar trigger and the delete dialog carried names written when only one kind of agent existed.

## 11. A control must look like a control, not like the text beside it

An action is discoverable before it is hovered or it is not discoverable. Colour is what carries that here, so a control's colour is not the colour of the prose around it.

- **`--color-text-muted` is the colour of hints and sub-lines, not of actions.** A text button in muted grey, at the same size as the note under it, reads as one more line of explanation; the user never learns it can be pressed. Text actions take the accent colour, or the primary text colour with a weight or an underline that the static text around them does not have.
- **Hover is not an affordance.** A control whose only distinction appears on `:hover` does not exist for anyone who has not already guessed it is there — and does not exist at all on a touchpad user's first pass over the screen.
- **Judge it against its neighbour, not against the palette.** The same muted button is fine in a header of muted metadata and invisible directly above a muted footer note. What the reviewer compares is the control and the nearest static text: if their colour and weight match, that is the finding.

**Origin:** a "Show more" toggle on the bare agent's Readme card, `text-[10px] text-[var(--color-text-muted)]`, sat one line above the card's footer note in the same size and the same colour. Nothing distinguished the control from the sentence below it. The control itself was then removed — the card renders the whole file — but the styling mistake is the general one.

## 12. A settings tab is a stack of titled sections, at the scale of the tab beside it

Settings is the one place where every screen is a sibling of every other: the user reaches them from the same list, one click apart. A tab that is structured differently or set smaller than its neighbours does not read as a variation — it reads as a screen someone forgot to finish.

The rule covers **any surface built from settings sections**, wherever it lives: an agent-page tab that lists and configures things (the Credentials tab's Attached Credentials) takes the same `SettingsSection` header, the verb beside the title on the right, and the explanation behind the (?). Judge by what the surface is made of, not by its folder.

- **Titled sections, not a stack of cards.** The section title is what the user scans for; a card is one setting inside the answer. Name the sections after what the user came to change (Agent Folders, Runtime, Developer Tools), not after the data model. Two or three per tab; a tab needing seven is really two tabs.
- **One type scale per surface.** Settings runs at 14/13/12 (see [UI Guidelines](ui_guidelines_llm.md) — Typography). `text-xs`, `text-[10px]` and `text-[9px]` are the app-chrome scale, and a settings tab written in them renders two steps smaller than the one beside it. A component shared with a denser surface takes the scale of the surface it renders *into*, and any reserved height it computes is written as a multiple of that scale's leading rather than a measured pixel count, so the two cannot drift apart.
- **A fact lives in the section holding the control that changes it.** A "readiness" card that reports the engine is not running, three rows above the field that decides which binary starts, has separated the diagnosis from the fix. Give the status row the button that resolves it.
- **A section-wide verb belongs beside the section title** (Rescan, Refresh), labelled and bordered — it acts on everything in the section, not on the first card, and a bare muted icon there is invisible until hovered (rule 11).
- **Explanation goes behind the (?) beside the label, not in a paragraph under it.** Prose that says what a setting is for is read once; every visit after the first scrolls past it. It lives in a `SettingsInfoTip` next to the label (`SettingsLabel`'s `info` prop), so a card is a label, a control, and at most one line of live status. `SettingsHint` is for a *value* (the folder path, what a choice currently resolves to), never for standing explanation. A row that is only a label and a switch is a one-liner, and a section of such rows is a `SettingsRows` list, not a stack of bordered cards.
- **Below the control: a filled status line, or nothing.** Rule 1 applied to a settings field. A one-line slot is reserved only where it shows something in every state; a message that exists only on failure renders only then, last in its card, and moves nothing above it. Two-line reservations and empty `min-h` slots are findings: they read as a card with the wrong bottom padding. The copy of any status line fits one line at the 800px minimum; shorten the sentence rather than reserve a second line.

**Origin:** Settings → Local Agents was four unlabelled cards and a loose button, at `text-xs`/`text-[10px]`/`text-[9px]` while Features, Local Development and AI Credentials next to it were titled sections at 14/13/12. Nothing in it was wrong on its own; it was reported as "wrong design" purely because it did not look like the screen one click away. The type scale had moved and the one screen that did not follow was the one nobody had compared side by side.

## 13. The same object looks and acts the same wherever it is listed

A user who meets one kind of record in three places learns it once. Draw it three ways and each place has to be learned again, and the differences read as differences in the record: a credential that shows a green check in one list and "complete" in another looks like two states.

- **One row per object type.** Every list of the same record (a settings list, an agent's attachments, a picker) renders it with the same row component and the same vocabulary. A second row design for the same object is a finding even when it looks fine on its own.
- **Facts are glyphs, badges and code, not a dotted sub-line.** A state is a coloured icon whose accessible name and tooltip are the sentence (check for fine, triangle for needs attention, cross for blocked). A category is a `SettingsBadge`. Ownership is an icon. An identifier (a Service URI, a key) is inline `code`. A raw enum on screen ("not cached", "complete", a `replaceAll('_', ' ')`) is a finding.
- **Compact views show only the problems.** Where the row does not fit a full status (a picker card), show the glyph only when the state is not fine. A green check on every card is the healthy state wearing a badge (rule 2).
- **Anything with a page of its own is reachable from the row,** including a page on a remote server: a record synced from Core has a Manage action that opens that record on Core. A URL shown on screen is a link, never plain text.
- **An account is named in one form: `Name <email> host`.** The name is the person's full name, the email is dropped when it would repeat the name, and the host is a link that opens the server, with the full URL as its tooltip. No brackets, no "Server:" prefix, no bare URL standing in for "who, on which server".
- **An editable collection behaves like its sibling collections.** MCP providers, AI Credentials and Local credentials are the pattern: a collapsible card per item, the header opens the inline edit form, a trash icon in the header opens the confirm inside that card, and a dashed Add button closes the list. A list of Edit/Delete text buttons over a separate confirm card is a different interaction for the same job.
- **Row actions are icons; section actions are labelled.** A verb repeated on every row (Manage, Detach, Delete) is a `SettingsIconButton` with a `title` and an `aria-label` naming the row; a labelled button on each row turns the list into a column of words. A section-wide verb keeps its label (rule 12).
- **An open form is not replaced by another control.** While a form holds input, the controls that would open a different form are disabled, and only the form's own Cancel or its own header closes it. Swapping it out discards what the user typed: that is lost work, and it is graded as high.
- **Every control earns its place.** A control whose effect the user cannot see (Move up, where order has no visible consequence on screen) is removed rather than explained. Report it as a suggestion; it needs the user's decision.

**Origin:** service credentials were listed in three places — Settings → Local and Remote credentials, the agent's Credentials tab and the attach picker — and each drew the record differently: "API token · complete · Owned" as prose in one, "name · ready · slack.com" in another, cards in the third. The server line read "Server: http://localhost:5173" as plain text, remote records had no way back to Core, and every row carried Edit, Delete, Move up and Detach as text buttons. None of it broke rule 12, because each surface matched its own neighbours; the user found it by looking at the same credential in two places.

## Checklist for a review

1. Type into every field on the changed surface: does anything above or beside the field move?
2. Click through every step: does the dialog's width or height change for a reason other than content?
3. Count the visible primary actions. More than three is a finding.
4. Is there a banner in the healthy state? Finding.
5. Trigger each failure path (uninstalled tool, busy object, refused write): is the surface still open, and does it say why in the user's words?
6. Read every confirm dialog against the schema and the code it describes.
7. Check every select option and placeholder at the narrowest width the layout allows.
8. Sub-lines: any that repeat the title? Any paragraph of standing explanation under a label instead of behind its (?)? Finding.
8b. Screenshot the healthy state of every changed card: any space under the last control beyond the card's own `p-4` is an empty reserved slot. Finding, with the pixel height.
9. Every file path on the surface: does that file exist for **every** kind of object this surface renders?
10. Every `aria-label`: does it match the visible text, including on the branch you did not open?
11. Every clickable thing that is not a filled button: read its colour and weight against the static text nearest it. The same? Finding.
12. Open the settings tab **above and below** the changed one and screenshot all three. Different structure (titled sections vs. bare cards) or a different type scale is a finding, even when the changed tab is internally consistent.
13. List every other place the changed object is rendered (grep for its DTO type and its row component). Is it drawn with the same row, the same glyphs and the same wording everywhere? Any raw enum on screen? Finding.
14. Every URL, host and remote record on the surface: is it a link, and does a synced record reach its page on the remote? Every account named: is it `Name <email> host`?
15. An editable list: compare editing, deleting and adding an item with the sibling list in the neighbouring tab. Different pattern: finding.
16. Open a form, type into it, then press every other control that opens a form. Is the input lost? High.
17. Read one row's actions. A labelled verb repeated on every row (rather than an icon button with a title): finding.
