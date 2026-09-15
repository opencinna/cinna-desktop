import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, type CinnaApp } from '../fixtures/app'

/**
 * The main window's size and the sidebar's open state are remembered across a
 * restart; the view is not, so the app always comes back on the new-chat
 * screen.
 *
 * Main keeps the window's normal bounds in `userData/window-state.json`
 * (debounced 500ms on resize/move, synchronously on the window's `close`); the
 * renderer keeps the sidebar in localStorage. Only the size is asserted, never
 * x/y: the saved position is dropped when it would not land on a display.
 *
 * Two ways out, both a user's: Cmd+Q (`relaunch()` — Playwright's `close()` is
 * `app.quit()`) and closing the window first (the red button / Cmd+W) then
 * quitting. Only the second can prove the save on `close`: Playwright spends
 * more than 500ms tearing down before it calls `app.quit()` (measured: 518ms
 * from the resize to `before-quit`), so by the time a plain quit closes the
 * window the debounced save has always already written the size.
 */

const DEFAULT_SIZE = [1200, 800]
const RESIZED = [1000, 700]
const LAST_SIZE = [1100, 750]
const NEW_CHAT_HEADING = 'What can I help with?'
const SETTINGS_HEADING = 'Chat Modes'

function savedState(cinna: CinnaApp): Record<string, unknown> {
  return JSON.parse(readFileSync(join(cinna.sandbox.userData, 'window-state.json'), 'utf8'))
}

/**
 * The main window's BrowserWindow, found through its page:
 * `BrowserWindow.getAllWindows()[0]` can be the tray panel.
 */
async function mainWindowSize(cinna: CinnaApp): Promise<{ size: number[]; normal: number[] }> {
  const handle = await cinna.electronApp.browserWindow(cinna.page)
  return handle.evaluate((win) => {
    const { width, height } = win.getNormalBounds()
    return { size: win.getSize(), normal: [width, height] }
  })
}

async function expectNewChatScreen(cinna: CinnaApp): Promise<void> {
  await expect(
    cinna.page.getByRole('heading', { level: 1, name: NEW_CHAT_HEADING, exact: true })
  ).toBeVisible()
  await expect(
    cinna.page.getByRole('heading', { level: 1, name: SETTINGS_HEADING, exact: true })
  ).toHaveCount(0)
}

/**
 * The toggle's name is the state; the wrapper's opacity is what the eye sees
 * (a collapsed sidebar is still "visible" to Playwright — opacity 0, width 0).
 */
async function expectSidebar(cinna: CinnaApp, open: boolean): Promise<void> {
  const page = cinna.page
  const shown = open ? 'Collapse sidebar' : 'Open sidebar'
  const absent = open ? 'Open sidebar' : 'Collapse sidebar'
  await expect(page.getByRole('button', { name: shown, exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: absent, exact: true })).toHaveCount(0)
  await expect(page.locator('.app-sidebar-wrap')).toHaveCSS('opacity', open ? '1' : '0')
}

test('window size and a collapsed sidebar survive a relaunch, which opens on the new-chat screen', async ({
  cinna
}) => {
  await test.step('a fresh profile opens at the default size, sidebar open, on the new-chat screen', async () => {
    await cinna.skipOnboarding()
    await expectNewChatScreen(cinna)
    await expectSidebar(cinna, true)
    expect(await mainWindowSize(cinna)).toEqual({ size: DEFAULT_SIZE, normal: DEFAULT_SIZE })
  })

  await test.step('resize the window, open Settings, collapse the sidebar', async () => {
    const handle = await cinna.electronApp.browserWindow(cinna.page)
    await handle.evaluate((win, [width, height]) => win.setSize(width, height), RESIZED)
    await expect
      .poll(async () => (await mainWindowSize(cinna)).size, { message: 'the window took the new size' })
      .toEqual(RESIZED)
    await expect
      .poll(() => cinna.page.evaluate(() => window.innerWidth), {
        message: 'the renderer followed the new width'
      })
      .toBe(RESIZED[0])

    const page = cinna.page
    const user = await page.evaluate(() => window.api.auth.getCurrent())
    expect(user, 'onboarding activated a user').not.toBeNull()
    await page.getByRole('button', { name: user!.displayName, exact: true }).click()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await expect(
      page.getByRole('heading', { level: 1, name: SETTINGS_HEADING, exact: true })
    ).toBeVisible()

    await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Open sidebar', exact: true })).toBeVisible()
    // Still on Settings when the app quits, so "opens on new chat" below means something.
    await expect(
      page.getByRole('heading', { level: 1, name: SETTINGS_HEADING, exact: true })
    ).toBeVisible()
  })

  await test.step('Cmd+Q and relaunch: same size, sidebar collapsed, new-chat screen', async () => {
    await cinna.relaunch()
    await expectNewChatScreen(cinna)
    await expectSidebar(cinna, false)
    expect(await mainWindowSize(cinna)).toEqual({ size: RESIZED, normal: RESIZED })
    expect(savedState(cinna)).toMatchObject({ width: RESIZED[0], height: RESIZED[1], isMaximized: false })
  })

  await test.step('expand the sidebar, resize, close the window at once: the close saves the size', async () => {
    await cinna.page.getByRole('button', { name: 'Open sidebar', exact: true }).click()
    await expectSidebar(cinna, true)

    // Resize and close in one main-process tick, far inside the 500ms debounce:
    // the pending debounced save is cancelled when the window closes, so only
    // the save on `close` can write this size. The file is read in the same
    // tick, before the close, to show it still held the previous size.
    const handle = await cinna.electronApp.browserWindow(cinna.page)
    const beforeClose = await handle.evaluate(
      (win, { size, file }) => {
        win.setSize(size[0], size[1])
        const { width, height } = win.getNormalBounds()
        const saved = JSON.parse(process.getBuiltinModule('node:fs').readFileSync(file, 'utf8'))
        win.close()
        return { normal: [width, height], saved }
      },
      { size: LAST_SIZE, file: join(cinna.sandbox.userData, 'window-state.json') }
    )
    expect(beforeClose.normal).toEqual(LAST_SIZE)
    expect(beforeClose.saved).toMatchObject({ width: RESIZED[0], height: RESIZED[1] })

    await expect.poll(() => cinna.page.isClosed(), { message: 'the main window closed' }).toBe(true)
    expect(savedState(cinna)).toMatchObject({ width: LAST_SIZE[0], height: LAST_SIZE[1], isMaximized: false })
  })

  await test.step('quit and relaunch: sidebar open, last size, new-chat screen', async () => {
    await cinna.relaunch()
    await expectNewChatScreen(cinna)
    await expectSidebar(cinna, true)
    await expect(cinna.page.getByRole('button', { name: 'Chats', exact: true })).toBeVisible()
    expect(await mainWindowSize(cinna)).toEqual({ size: LAST_SIZE, normal: LAST_SIZE })
  })
})
