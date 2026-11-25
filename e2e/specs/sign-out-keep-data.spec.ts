import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test, expect, type CinnaApp } from '../fixtures/app'
import { linkSandboxAccount } from '../fixtures/jobRemoteService'

/**
 * The Sign Out dialog of a Cinna account (`UserMenu.tsx`): the switch
 * "Delete data from this device", on by default, deletes the profile (the old
 * cascade); off signs the account out and keeps the profile, its chats and
 * settings, which then read as signed out — a "Signed out" tag in the profile
 * menu and in Settings → User Accounts, and a "Sign in to Cinna" prompt
 * (`ReauthModal.tsx`) when the user switches back into it.
 *
 * ## What is real, and what is seeded
 *
 * Real: the user menu, the dialog, main's `auth:logout { userId }` and
 * `auth:delete-user` paths, the profile switch, the reauth store and its
 * modal, Settings → User Accounts. Seeded: the Cinna account itself — a local
 * profile made over `auth.register`, then turned into a signed-in
 * `cinna_user` by `linkSandboxAccount` (a token written into the sandbox DB),
 * pointed at a loopback server that answers 404 to everything. Sign-out sends
 * nothing to Core here: sync was never set up, so the final flush and the
 * device revoke are skipped.
 *
 * ## What it does not prove
 *
 * The final sync push before a keep-data sign-out, the server-side device
 * revoke of a sync-active delete, and the OAuth "Sign in" that re-links the
 * profile (never clicked: it opens a browser) — those are unit-tested
 * (`authService.test.ts`, `UserMenu.signOut.test.tsx`, `ReauthModal.test.tsx`).
 */

const PROFILE = 'Alicia'
const USERNAME = 'alicia-e2e'
const CHAT = 'Kept across sign-out'
const PASSWORD = 'e2e-local-pass'

const DELETE_SWITCH = 'Delete data from this device'
const DELETE_TEXT =
  'Your chats and job runs on this device will be permanently deleted — they are not synced and cannot be restored. Your Cinna cloud account is not affected.'
const KEEP_TEXT =
  "You'll be signed out of this Cinna account. Its chats, agents and settings stay on this device, and it stays in your profile list so you can sign back in later. Your Cinna cloud account is not affected."
const NO_PASSWORD_WARNING =
  'Anyone who uses this computer can open this profile and read its chats. Set a local password in Settings → User Accounts to lock it.'
const PASSWORD_STILL_LOCKS = 'Its local password still locks it on this device.'

/** A stand-in Cinna server: every request is recorded and answered 404, none with 401. */
async function silentCore(): Promise<{ host: string; server: Server; paths: string[] }> {
  const paths: string[] = []
  const server = createServer((req, res) => {
    paths.push(`${req.method} ${new URL(req.url ?? '/', 'http://localhost').pathname}`)
    res.statusCode = 404
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ detail: 'No fixture route for this request' }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return { host: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server, paths }
}

let core: Awaited<ReturnType<typeof silentCore>>
test.beforeEach(async () => {
  core = await silentCore()
})
test.afterEach(async () => {
  await new Promise<void>((resolve) => core?.server.close(() => resolve()))
})

const users = (cinna: CinnaApp) => cinna.page.evaluate(() => window.api.auth.listUsers())
const currentId = async (cinna: CinnaApp) => (await cinna.page.evaluate(() => window.api.auth.getCurrent()))?.id

/** A local profile `Alicia`, made a signed-in Cinna account, current after a restart, owning one titled chat. */
async function arrange(cinna: CinnaApp): Promise<string> {
  await cinna.skipOnboarding()
  const made = await cinna.page.evaluate(
    (input) => window.api.auth.register({ accountType: 'local', username: input.username, displayName: input.name }),
    { username: USERNAME, name: PROFILE }
  )
  expect(made, JSON.stringify(made)).toMatchObject({ success: true })
  const userId = made.user!.id
  await expect.poll(() => currentId(cinna)).toBe(userId)
  await linkSandboxAccount(cinna, core.host)
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await expect.poll(() => currentId(cinna)).toBe(userId)
  expect((await users(cinna)).find((u) => u.id === userId)).toMatchObject({ type: 'cinna_user', hasCinnaTokens: true })
  await cinna.page.evaluate(async (title) => {
    await window.api.settings.set('autoChatTitles', false)
    const chat = await window.api.chat.create()
    await window.api.chat.update(chat.id, { title })
  }, CHAT)
  await expect(cinna.page.getByText(CHAT, { exact: true })).toBeVisible()
  return userId
}

/** The footer trigger is named by its `title`, the profile's display name (the guest's is generated). */
async function openUserMenu(cinna: CinnaApp): Promise<void> {
  const me = await cinna.page.evaluate(() => window.api.auth.getCurrent())
  await cinna.page.getByTitle(me!.cinnaFullName ?? me!.displayName, { exact: true }).click()
}

/** User menu → Sign Out: the confirmation, titled `Sign Out — Alicia`. */
async function openSignOut(cinna: CinnaApp): Promise<void> {
  await openUserMenu(cinna)
  await cinna.page.getByRole('button', { name: 'Sign Out', exact: true }).click()
  await expect(cinna.page.getByText(`Sign Out — ${PROFILE}`, { exact: true })).toBeVisible()
}

const deleteSwitch = (cinna: CinnaApp) => cinna.page.getByRole('switch', { name: DELETE_SWITCH, exact: true })
const passwordField = (cinna: CinnaApp) => cinna.page.getByPlaceholder('Password', { exact: true })

/** The dialog's confirm button (the menu item of the same name is gone once the dialog is open). */
async function confirmSignOut(cinna: CinnaApp): Promise<void> {
  await cinna.page.getByRole('button', { name: 'Sign Out', exact: true }).click()
  await expect(cinna.page.getByText(`Sign Out — ${PROFILE}`, { exact: true })).toHaveCount(0)
}

/** The profile menu's row: the avatar initial, then the name (and its tags). */
const profileRow = (cinna: CinnaApp) => cinna.page.getByRole('button', { name: new RegExp(`^A ${PROFILE}`) })
/**
 * Settings → User Accounts: the card's header button, named like the menu row —
 * signed out it reads `A Alicia Signed out Signed out alicia-e2e` (the tag, then
 * the CloudOff icon's `aria-label`). Only one of the two is on screen at a time.
 */
const accountCard = (cinna: CinnaApp) => cinna.page.getByRole('button', { name: new RegExp(`^A ${PROFILE}`) })

test('switch on (the default): Sign Out deletes the Cinna profile from this device', async ({ cinna }) => {
  test.setTimeout(120_000)
  const userId = await arrange(cinna)

  await openSignOut(cinna)
  await expect(deleteSwitch(cinna)).toHaveAttribute('aria-checked', 'true')
  await expect(cinna.page.getByText(DELETE_TEXT, { exact: true })).toBeVisible()
  await expect(cinna.page.getByText(KEEP_TEXT, { exact: true })).toHaveCount(0)
  await expect(passwordField(cinna)).toHaveCount(0)
  await confirmSignOut(cinna)

  await expect.poll(() => currentId(cinna)).toBe('__default__')
  await openUserMenu(cinna)
  await expect(cinna.page.getByText('Profiles', { exact: true })).toBeVisible()
  await expect(cinna.page.getByRole('button', { name: new RegExp(PROFILE) })).toHaveCount(0)
  expect((await users(cinna)).some((u) => u.id === userId)).toBe(false)
})

test('switch off: Sign Out keeps the profile and its chat, marks it signed out, and switching back asks to sign in', async ({ cinna }) => {
  test.setTimeout(120_000)
  const userId = await arrange(cinna)

  await test.step('flip the switch: the keep-data explanation and the no-password warning', async () => {
    await openSignOut(cinna)
    await deleteSwitch(cinna).click()
    await expect(deleteSwitch(cinna)).toHaveAttribute('aria-checked', 'false')
    await expect(cinna.page.getByText(KEEP_TEXT, { exact: true })).toBeVisible()
    await expect(cinna.page.getByText(NO_PASSWORD_WARNING, { exact: true })).toBeVisible()
    await expect(cinna.page.getByText(DELETE_TEXT, { exact: true })).toHaveCount(0)
    await expect(cinna.page.getByText(PASSWORD_STILL_LOCKS, { exact: true })).toHaveCount(0)
    await expect(passwordField(cinna)).toHaveCount(0)
  })

  await test.step('Sign Out: Guest is current, the profile stays, with no tokens', async () => {
    await confirmSignOut(cinna)
    await expect.poll(() => currentId(cinna)).toBe('__default__')
    await expect(cinna.page.getByText(CHAT, { exact: true })).toHaveCount(0)
    expect((await users(cinna)).find((u) => u.id === userId)).toMatchObject({ type: 'cinna_user', hasCinnaTokens: false })
  })

  await test.step('the profile menu tags it Signed out', async () => {
    await openUserMenu(cinna)
    await expect(profileRow(cinna)).toHaveCount(1)
    await expect(profileRow(cinna).getByText('Signed out', { exact: true })).toBeVisible()
  })

  await test.step('Settings → User Accounts tags it Signed out', async () => {
    // The menu is still open: its Settings item opens Settings.
    await cinna.page.getByRole('button', { name: 'Settings', exact: true }).click()
    await cinna.page.getByRole('button', { name: 'User Accounts', exact: true }).click()
    const card = accountCard(cinna)
    await expect(card).toHaveCount(1)
    await expect(card.getByText('Signed out', { exact: true })).toBeVisible()
    // The menu's Settings item toggles back to the chat shell.
    await openUserMenu(cinna)
    await cinna.page.getByRole('button', { name: 'Settings', exact: true }).click()
    await expect(cinna.page.getByRole('button', { name: 'Chats', exact: true })).toBeVisible()
  })

  await test.step('switching back opens "Sign in to Cinna"; Not now leaves the profile current, its chat listed', async () => {
    await openUserMenu(cinna)
    await profileRow(cinna).click()
    await expect.poll(() => currentId(cinna)).toBe(userId)
    await expect(cinna.page.getByText('Sign in to Cinna', { exact: true })).toBeVisible()
    await expect(cinna.page.getByText('Cinna session expired', { exact: true })).toHaveCount(0)
    await expect(cinna.page.getByText(/is signed out on this device\./)).toHaveText(
      `${PROFILE} on ${new URL(core.host).host} is signed out on this device. Sign in again to use this account's agents and credentials.`
    )
    await expect(cinna.page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
    await cinna.page.getByRole('button', { name: 'Not now', exact: true }).click()
    await expect(cinna.page.getByText('Sign in to Cinna', { exact: true })).toHaveCount(0)
    await expect(cinna.page.getByText(CHAT, { exact: true })).toBeVisible()
    expect((await users(cinna)).find((u) => u.id === userId)).toMatchObject({ hasCinnaTokens: false })
  })
})

test('a profile with a local password: on asks for it, off does not and says it still locks the profile', async ({ cinna }) => {
  test.setTimeout(120_000)
  const userId = await arrange(cinna)

  await test.step('arrange: Settings → User Accounts → Set Local Password', async () => {
    await openUserMenu(cinna)
    await cinna.page.getByRole('button', { name: 'Settings', exact: true }).click()
    await cinna.page.getByRole('button', { name: 'User Accounts', exact: true }).click()
    await accountCard(cinna).click()
    await cinna.page.getByRole('button', { name: 'Set Local Password', exact: true }).click()
    await cinna.page.getByPlaceholder('New password', { exact: true }).fill(PASSWORD)
    await cinna.page.getByPlaceholder('Confirm new password', { exact: true }).fill(PASSWORD)
    await cinna.page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(async () => (await users(cinna)).find((u) => u.id === userId)?.hasPassword).toBe(true)
    await cinna.page.keyboard.press('Escape')
    await expect(cinna.page.getByRole('button', { name: 'Change Local Password', exact: true })).toBeVisible()
  })

  await test.step('switch on: the password is asked for', async () => {
    await openSignOut(cinna)
    await expect(deleteSwitch(cinna)).toHaveAttribute('aria-checked', 'true')
    await expect(passwordField(cinna)).toBeVisible()
  })

  await test.step('switch off: no password field, the lock sentence instead of the warning', async () => {
    await deleteSwitch(cinna).click()
    await expect(deleteSwitch(cinna)).toHaveAttribute('aria-checked', 'false')
    await expect(passwordField(cinna)).toHaveCount(0)
    await expect(cinna.page.getByText(KEEP_TEXT, { exact: true })).toBeVisible()
    await expect(cinna.page.getByText(PASSWORD_STILL_LOCKS, { exact: true })).toBeVisible()
    await expect(cinna.page.getByText(NO_PASSWORD_WARNING, { exact: true })).toHaveCount(0)
  })

  await test.step('Sign Out with no password: Guest is current, the profile stays locked and signed out', async () => {
    await confirmSignOut(cinna)
    await expect.poll(() => currentId(cinna)).toBe('__default__')
    expect((await users(cinna)).find((u) => u.id === userId)).toMatchObject({
      type: 'cinna_user', hasCinnaTokens: false, hasPassword: true
    })
  })
})
