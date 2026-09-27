import { test, expect, type CinnaApp } from '../fixtures/app'

/**
 * Chats owned by the default (guest) profile are listed and openable in every
 * other profile while Settings → Features → Interface → "Show local agents and
 * chats in all profiles" is on (the default), and a profile's own chats never
 * leak back into the default profile. Turning the switch off hides the shared
 * chats at once; turning it back on shows them again.
 *
 * The second profile is a **local** account, made and switched to through the
 * footer user menu (`Add Account` → `Local Account`) — the product treats any
 * non-default profile alike, and a Cinna sign-in cannot be arranged here.
 *
 * The chats themselves are arranged over IPC (`chat.create` / `update` /
 * `addMessage`) with no mode, agent or routing, so each stays owned by the
 * profile that was active when it was made: a chat that picked a local chat
 * mode in the local profile would be handed to the default profile by design
 * (docs/core/settings_scope/settings_scope.md), which is not this scenario.
 * No model runs.
 */

const LOCAL_USER = 'e2elocal'
const GUEST_CHAT = 'E2E guest shared chat'
const GUEST_MSG = 'Message written in the guest profile'
const GUEST_REPLY = 'Reply stored in the guest chat'
const LOCAL_CHAT = 'E2E local-only chat'
const LOCAL_MSG = 'Message written in the local profile'

async function currentName(cinna: CinnaApp): Promise<string> {
  const user = await cinna.page.evaluate(() => window.api.auth.getCurrent())
  if (!user) throw new Error('no current profile')
  return user.displayName
}

/**
 * The footer user menu's trigger is the compact avatar: its accessible name is
 * the avatar's initial for a named profile (`E`), and only its `title` carries
 * the display name — so it is found by title.
 */
const userMenuTrigger = (cinna: CinnaApp, name: string) => cinna.page.getByTitle(name, { exact: true })

async function openUserMenu(cinna: CinnaApp, shown?: string): Promise<void> {
  await userMenuTrigger(cinna, shown ?? (await currentName(cinna))).click()
}

/** Pick a row in the menu's Profiles list; the trigger then names that profile. */
async function switchTo(cinna: CinnaApp, row: string | RegExp, name: string, shown?: string): Promise<void> {
  await openUserMenu(cinna, shown)
  await cinna.page.getByRole('button', { name: row }).click()
  await expect(userMenuTrigger(cinna, name)).toBeVisible()
  await expect.poll(() => currentName(cinna)).toBe(name)
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The guest's row reads `<name>Guest` (a `Guest` badge beside the name). */
const guestRow = (guestName: string) => new RegExp(`^${escapeRe(guestName)}`)

/** User menu → Add Account → Local Account → Username → Create. */
async function createLocalProfile(cinna: CinnaApp): Promise<void> {
  await openUserMenu(cinna)
  await cinna.page.getByRole('button', { name: 'Add Account', exact: true }).click()
  await cinna.page.getByRole('button', { name: /^Local Account/ }).click()
  await cinna.page.getByPlaceholder('Username', { exact: true }).fill(LOCAL_USER)
  await cinna.page.getByRole('button', { name: 'Create', exact: true }).click()
  // The renderer takes the new profile at once: the footer names it.
  await expect(userMenuTrigger(cinna, LOCAL_USER)).toBeVisible()
}

async function seedGuestChat(cinna: CinnaApp): Promise<void> {
  await cinna.page.evaluate(async (input) => {
    await window.api.settings.set('autoChatTitles', false)
    const chat = await window.api.chat.create()
    await window.api.chat.update(chat.id, { title: input.title })
    await window.api.chat.addMessage(chat.id, { role: 'user', content: input.msg })
    await window.api.chat.addMessage(chat.id, { role: 'assistant', content: input.reply })
  }, { title: GUEST_CHAT, msg: GUEST_MSG, reply: GUEST_REPLY })
  await expect(chatRow(cinna, GUEST_CHAT)).toBeVisible()
}

/** A Chats row is a div with no role, named by its title text. */
const chatRow = (cinna: CinnaApp, title: string) => cinna.page.getByText(title, { exact: true })

async function openFeatures(cinna: CinnaApp): Promise<void> {
  await openUserMenu(cinna)
  await cinna.page.getByRole('button', { name: 'Settings', exact: true }).click()
  await cinna.page.getByRole('button', { name: 'Features', exact: true }).click()
}

const sharingSwitch = (cinna: CinnaApp) =>
  cinna.page.getByRole('switch', { name: 'Show local agents and chats in all profiles' })

const settingValue = (cinna: CinnaApp) =>
  cinna.page.evaluate(async () => (await window.api.settings.getAll()).showLocalDataInAllProfiles)

async function backToChats(cinna: CinnaApp): Promise<void> {
  await cinna.page.getByRole('button', { name: 'Back', exact: true }).click()
  await cinna.page.getByRole('button', { name: 'Chats', exact: true }).click()
}

test('default-profile chats are shared into a local profile, never the reverse, and the switch hides them', async ({ cinna }) => {
  await cinna.skipOnboarding()
  const guestName = await currentName(cinna)

  await test.step('arrange: a titled chat with messages in the default profile', async () => {
    await seedGuestChat(cinna)
  })

  await test.step('create a local profile and switch to it: the guest chat is listed and opens with its messages', async () => {
    await createLocalProfile(cinna)
    await expect.poll(() => currentName(cinna)).toBe(LOCAL_USER)

    await expect(chatRow(cinna, GUEST_CHAT)).toBeVisible()
    await chatRow(cinna, GUEST_CHAT).click()
    await expect(cinna.page.getByText(GUEST_MSG, { exact: true })).toBeVisible()
    await expect(cinna.page.getByText(GUEST_REPLY, { exact: true })).toBeVisible()
  })

  await test.step('arrange: a chat of the local profile\'s own', async () => {
    // Made while main has the local profile active, with no mode, agent or
    // routing: it stays that profile's own.
    expect(await currentName(cinna)).toBe(LOCAL_USER)
    await cinna.page.evaluate(async (input) => {
      const chat = await window.api.chat.create()
      await window.api.chat.update(chat.id, { title: input.title })
      await window.api.chat.addMessage(chat.id, { role: 'user', content: input.msg })
    }, { title: LOCAL_CHAT, msg: LOCAL_MSG })
    await expect(chatRow(cinna, LOCAL_CHAT)).toBeVisible()
    await expect(chatRow(cinna, GUEST_CHAT)).toBeVisible()
  })

  await test.step('back in the default profile: the guest chat is listed, the local one is not', async () => {
    await switchTo(cinna, guestRow(guestName), guestName)
    await expect(chatRow(cinna, GUEST_CHAT)).toBeVisible()
    await expect(chatRow(cinna, LOCAL_CHAT)).toHaveCount(0)
  })

  await test.step('switch off (it starts on): the local profile lists only its own chat', async () => {
    await openFeatures(cinna)
    await expect(sharingSwitch(cinna)).toBeChecked()
    expect(await settingValue(cinna)).not.toBe(false)
    await sharingSwitch(cinna).click()
    await expect(sharingSwitch(cinna)).not.toBeChecked()
    await expect.poll(() => settingValue(cinna)).toBe(false)
    await backToChats(cinna)

    await switchTo(cinna, LOCAL_USER, LOCAL_USER)
    await expect(chatRow(cinna, LOCAL_CHAT)).toBeVisible()
    await expect(chatRow(cinna, GUEST_CHAT)).toHaveCount(0)
  })

  await test.step('switch back on from the local profile: the guest chat returns without a profile switch', async () => {
    await openFeatures(cinna)
    await expect(sharingSwitch(cinna)).not.toBeChecked()
    await sharingSwitch(cinna).click()
    await expect(sharingSwitch(cinna)).toBeChecked()
    await expect.poll(() => settingValue(cinna)).toBe(true)
    await backToChats(cinna)

    await expect(chatRow(cinna, GUEST_CHAT)).toBeVisible()
    await expect(chatRow(cinna, LOCAL_CHAT)).toBeVisible()
    await chatRow(cinna, GUEST_CHAT).click()
    await expect(cinna.page.getByText(GUEST_MSG, { exact: true })).toBeVisible()
  })
})

test('creating a local profile from the user menu makes it the active profile in main', async ({ cinna }) => {
  // Regression: `auth:register` used to insert the user row without activating
  // it, while `useRegister` switched the renderer — the footer named the new
  // profile and main kept serving the guest, so with sharing off the "new"
  // profile listed the guest's own chats.
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.settings.set('showLocalDataInAllProfiles', false))
  await seedGuestChat(cinna)
  await createLocalProfile(cinna)
  await expect.poll(() => currentName(cinna)).toBe(LOCAL_USER)
  await expect(chatRow(cinna, GUEST_CHAT)).toHaveCount(0)
})
