# UX Rules

The interaction rules every user-visible change in Cinna Desktop is judged against. [UI Guidelines](ui_guidelines_llm.md) says what things *look like* (tokens, card shells, button classes); this file says how a screen *behaves*. Each rule records the decision that produced it, so a reviewer can tell a rule from a taste.

These rules are enforced by the `cinna-desktop-ux-reviewer` agent, which runs on any change to a user-visible surface (see `CLAUDE.md`). A change that breaks one is a finding, not a style note.

## 1. Nothing jumps while the user is acting

Typing, tabbing between fields, clicking through a wizard, toggling a switch — none of these may change the size or position of what the user is looking at.

- **No per-keystroke hints.** A sentence that appears on the first character and disappears on the second resizes its container twice. Validate on blur or submit, or show the *result* in space that already exists (the live folder-name preview under the Name field shows `1-agent`; the sentence explaining why was removed).
- **Reserve the space or don't show it.** A status line that comes and goes ("Saving…", a warning) gets a fixed-height slot, is rendered inline in an existing row, or is placed *below* everything that can move. Never insert it above controls the user is about to click.
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

**Origin:** the New agent form asked for a sentence, a name, a folder and a root. Users build the agent in their own tool, where the description gets written anyway.

## 4. Remember the last choice, offer an explicit override

Where a user makes the same choice repeatedly (which tool opens a folder), the last pick becomes the default and the primary action uses it in one click. A menu behind a chevron holds the alternatives; picking one rewrites the default. Settings exposes the same value with a way to clear it back to "ask".

- **Auto-use is opt-in.** Skipping a step on the user's behalf (open the new agent straight in the default tool) needs an explicit checkbox, offered at the moment the user makes the choice ("Open new agents this way without asking") and mirrored in Settings.
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
- Silent failure is the worst outcome: a folder created and no tool opened, with no message anywhere, is a defect even when the folder is fine.

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

## Checklist for a review

1. Type into every field on the changed surface: does anything above or beside the field move?
2. Click through every step: does the dialog's width or height change for a reason other than content?
3. Count the visible primary actions. More than three is a finding.
4. Is there a banner in the healthy state? Finding.
5. Trigger each failure path (uninstalled tool, busy object, refused write): is the surface still open, and does it say why in the user's words?
6. Read every confirm dialog against the schema and the code it describes.
7. Check every select option and placeholder at the narrowest width the layout allows.
8. Sub-lines: any that repeat the title?
9. Every file path on the surface: does that file exist for **every** kind of object this surface renders?
10. Every `aria-label`: does it match the visible text, including on the branch you did not open?
11. Every clickable thing that is not a filled button: read its colour and weight against the static text nearest it. The same? Finding.
