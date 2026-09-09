import type { Locator } from '@playwright/test'
import { test, expect, type CinnaApp } from '../fixtures/app'
import { stubLlmFetch } from '../fixtures/llmFetch'

/**
 * A credential's on/off switch, and the four surfaces that have to agree it is
 * off.
 *
 * ## What this spec is for
 *
 * Switching an AI credential off is the one settings toggle whose consequence
 * is entirely **somewhere else**: the credential itself looks the same, and
 * what stops is a chat mode on another tab and an agent on another screen.
 * Every piece of that is a separate component reading a separate query, and
 * each of them can be right on its own while the set of them contradicts:
 *
 * 1. **The confirm exists at all, and only when it should.** `handleToggle` in
 *    `LLMProviderCard` opens the dialog on `enabled && dependents > 0`, and
 *    calls the mutation directly otherwise. Both branches are asserted, because
 *    the interesting failure is the confirm becoming universal (the dialog
 *    users learn to dismiss without reading) or disappearing (a switch that
 *    silently stops three things).
 * 2. **The dialog names what stops.** `dependentModes` is a join done in the
 *    renderer between `useChatModes` and this card's id; a join that quietly
 *    matches nothing still renders a dialog, just an empty one — so the
 *    assertion is the **mode's name inside the dialog**, not the dialog's
 *    presence, and that the dialog does not merely count.
 * 3. **The chat mode says why it is inactive, in the collapsed row.** The badge
 *    is one word for three different states (`chatModeStatus.ts`), so the cause
 *    beside it is the thing being asserted; a `title` would not be.
 * 4. **The mode's own credential select still names the credential.** A
 *    switched-off credential is not in `enabledProviders`, so without the
 *    synthetic option the `<select>` value matches nothing and the browser
 *    falls back to the first option — the mode then reads as
 *    "None (use default)", which is both wrong and unfixable, because the card
 *    never admits what it is set to. `— inactive` on the selected option is
 *    what proves the fallback did not happen.
 *
 * Not here, on purpose: the wording tables (`DisableCredentialDialog.test.tsx`
 * and `chatModeStatus.test.ts` cover the plural forms and all three inactive
 * causes far more cheaply), the **agent** half of the dependency list (it needs
 * a folder agent with a resolved runtime, and `local-agent:credential-bindings`
 * is unit-tested; the dialog's agent paragraph is asserted only by its
 * *absence* here), the managed chat-mode card (a Cinna account cannot be
 * arranged in an ordinary spec), and anything that would need the engine or a
 * real model turn — nothing here sends a message.
 */

/** The credential something depends on. Keyed, so `hasApiKey` is true from the row. */
const KEYED = 'Sonnet Work'
/** The credential nothing points at — the branch where the switch is one click. */
const LONELY = 'Spare Key'
/** The chat mode pinned to {@link KEYED}, created through the form. */
const MODE = 'Deep Research'

/**
 * Nothing here reaches a vendor, and it used to.
 *
 * `provider:list-models` is a real network round trip per credential, and this
 * spec asserts nothing about a catalogue — the chat-mode Model select only has
 * to *exist* and carry its label. It used to keep the two fake keys below off
 * the internet by pointing `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` at a closed
 * loopback port. **That guard went inert**: both adapters now pin their base URL
 * so a shell variable cannot redirect a stored key, which is the whole point of
 * the pins, so the requests went to `api.anthropic.com` and `api.openai.com`
 * with a fake key on every run — and the spec passed anyway, because its
 * assertions never touch a catalogue. Nothing failed to say so.
 *
 * There is no base URL left to move: this spec is *about* keyed credentials, and
 * `providerService.upsert` refuses a `baseUrl` on any keyed row. So the stub
 * goes below the adapter instead — see `stubLlmFetch`, which answers both
 * vendors in-process and passes everything else through.
 */

/**
 * Footer user menu → Settings → `tab`.
 *
 * The menu item **toggles** (`activeView === 'settings' ? 'chat' : 'settings'`),
 * so pressing it from inside Settings walks back out to the chat view — where
 * `Chats` is the sidebar tab and not the Chat Modes settings tab, and the next
 * assertion fails somewhere unrelated. So the shell is opened only when a
 * settings-only sidebar item says it is not open already.
 */
async function openSettings(cinna: CinnaApp, tab: string): Promise<void> {
  const page = cinna.page
  const settingsOnly = page.getByRole('button', { name: 'MCP Providers', exact: true })
  if (!(await settingsOnly.isVisible())) {
    const user = await page.evaluate(() => window.api.auth.getCurrent())
    await page.getByRole('button', { name: user?.displayName ?? 'User', exact: true }).click()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await expect(settingsOnly).toBeVisible()
  }
  await page.getByRole('button', { name: tab, exact: true }).click()
}

/**
 * The New Chat Mode card: the innermost element holding both its title and its
 * submit button, which is the form's own root. Its two selects are labelled, so
 * this scope is only needed to keep them apart from an expanded mode card's.
 */
function modeForm(page: CinnaApp['page']): Locator {
  return page
    .locator('div')
    .filter({ has: page.getByText('New Chat Mode', { exact: true }) })
    .filter({ has: page.getByRole('button', { name: 'Create Mode' }) })
    .last()
}

/** The switch, named for what pressing it does — which is how its state is read. */
function toggle(page: CinnaApp['page'], action: 'on' | 'off', name: string): Locator {
  return page.getByRole('switch', { name: `Switch ${action} ${name}` })
}

test('switching a credential off asks first, names the chat mode it stops, and every surface says so', async ({
  cinna
}) => {
  // Before anything can list a catalogue. Re-installed after the relaunch below,
  // because the stub lives in the app process and a restart is a new one.
  await stubLlmFetch(cinna)
  await cinna.skipOnboarding()

  await test.step('two credentials on the profile', async () => {
    await cinna.page.evaluate(
      async (names) => {
        await window.api.providers.upsert({
          type: 'anthropic',
          name: names.keyed,
          apiKey: 'e2e-anthropic-key',
          enabled: true
        })
        await window.api.providers.upsert({
          type: 'openai',
          name: names.lonely,
          apiKey: 'e2e-openai-key',
          enabled: true
        })
      },
      { keyed: KEYED, lonely: LONELY }
    )
    // Credentials seeded over IPC reach no query — nothing invalidates
    // `['providers']` from outside the renderer — so the pickers below would
    // render as a profile with no credentials at all.
    await cinna.relaunch()
    await stubLlmFetch(cinna)
    await cinna.skipOnboarding()
  })

  await test.step('a chat mode pinned to the first one', async () => {
    const page = cinna.page
    await openSettings(cinna, 'Chats')
    await expect(page.getByRole('heading', { name: 'Chat Modes' })).toBeVisible()
    await page.getByRole('button', { name: 'Add Chat Mode' }).click()

    const form = modeForm(page)
    await form.getByPlaceholder('e.g. Development, Writing, Research...').fill(MODE)
    const credential = form.getByLabel('AI Credentials', { exact: true })
    // Both credentials are offered: `enabledProviders` is the "may be picked"
    // list, and at this point both may be.
    await expect(credential.locator('option')).toHaveText([
      'None (use default)',
      KEYED,
      LONELY
    ])
    await credential.selectOption({ label: KEYED })
    // The Model select only exists once a credential is chosen, and it is the
    // second of the form's two labelled selects.
    await expect(form.getByLabel('Model', { exact: true })).toBeVisible()

    await page.getByRole('button', { name: 'Create Mode' }).click()
    await expect(page.getByText(MODE, { exact: true })).toBeVisible()
    // Nothing is wrong with it yet — the badge has to mean something.
    await expect(page.getByText('Inactive', { exact: true })).toHaveCount(0)
  })

  const dialog = cinna.page.getByRole('dialog', { name: `Switch off ${KEYED}` })

  await test.step('the off switch asks first, and names the mode rather than counting it', async () => {
    const page = cinna.page
    await openSettings(cinna, 'AI Credentials')
    await expect(page.getByRole('heading', { name: 'AI Credentials' })).toBeVisible()
    await expect(toggle(page, 'off', KEYED)).toHaveAttribute('aria-checked', 'true')

    await toggle(page, 'off', KEYED).click()
    await expect(dialog).toBeVisible()
    // The recoverable half, first: this is what makes the confirm a warning
    // rather than a destructive-action gate.
    await expect(dialog).toContainText(
      'Nothing is deleted, and nothing is re-pointed at another credential. Turning it back on puts everything below back exactly as it is now.'
    )
    // The name, which is the whole reason to interrupt: a count would be a
    // number the user has to go and decode, and a renderer-side join that
    // matched nothing would still have rendered a dialog.
    await expect(dialog).toContainText(
      `Chat mode ${MODE} is marked inactive and stops starting chats.`
    )
    await expect(dialog).not.toContainText('1 chat mode')
    // Nothing on this profile resolves an agent to the credential, so the
    // dialog's other paragraph must not be there: it lists what it found, not
    // what it might have found.
    await expect(dialog).not.toContainText('no credential to run on')
  })

  await test.step('Cancel leaves the credential on', async () => {
    const page = cinna.page
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(toggle(page, 'off', KEYED)).toHaveAttribute('aria-checked', 'true')
  })

  await test.step('confirming switches it off, and the card says what it is holding down', async () => {
    const page = cinna.page
    await toggle(page, 'off', KEYED).click()
    await dialog.getByRole('button', { name: 'Switch off', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(toggle(page, 'on', KEYED)).toHaveAttribute('aria-checked', 'false')

    // In the card **header**, and asserted without expanding the card: these
    // cards are collapsed until someone opens one, so a marker that needed a
    // click would be telling the user nothing at the moment they are looking.
    await expect(page.getByText('1 chat mode inactive')).toBeVisible()
  })

  await test.step('the chat mode is inactive, and says which kind of inactive', async () => {
    const page = cinna.page
    await openSettings(cinna, 'Chats')
    await expect(page.getByText(MODE, { exact: true })).toBeVisible()
    await expect(page.getByText('Inactive', { exact: true })).toBeVisible()
    // Beside the badge, in the collapsed header — the state this tab opens in.
    // One word for three situations is only unambiguous with this next to it.
    await expect(page.getByText('credential switched off', { exact: true })).toBeVisible()

    await page.getByText(MODE, { exact: true }).click()
    await expect(
      page.getByText(`“${KEYED}” is switched off. Turn it back on to use this chat mode.`)
    ).toBeVisible()
    // The synthetic option. Without it the select's value matches nothing and
    // the browser shows the first option, so the mode reads as
    // "None (use default)" — a card that will not admit what it is set to.
    await expect(
      page.getByLabel('AI Credentials', { exact: true }).locator('option:checked')
    ).toHaveText(`${KEYED} — inactive`)
  })

  await test.step('switching it back on is one click, with no dialog', async () => {
    const page = cinna.page
    await openSettings(cinna, 'AI Credentials')
    await toggle(page, 'on', KEYED).click()
    // The switch only moves after the write, and the write only happens after a
    // confirm — so a dialog on this path would fail here first.
    await expect(toggle(page, 'off', KEYED)).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByRole('dialog')).toHaveCount(0)

    await openSettings(cinna, 'Chats')
    await expect(page.getByText(MODE, { exact: true })).toBeVisible()
    await expect(page.getByText('Inactive', { exact: true })).toHaveCount(0)
    await expect(page.getByText('credential switched off', { exact: true })).toHaveCount(0)
  })

  await test.step('a credential nothing depends on switches off without asking', async () => {
    const page = cinna.page
    await openSettings(cinna, 'AI Credentials')
    await toggle(page, 'off', LONELY).click()
    await expect(toggle(page, 'on', LONELY)).toHaveAttribute('aria-checked', 'false')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    // And the card has nothing to report, because nothing stopped.
    await expect(page.getByText(/\d+ (chat mode|agent)s? inactive/)).toHaveCount(0)
  })
})
