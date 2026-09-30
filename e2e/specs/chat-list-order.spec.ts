import { test, expect, type CinnaApp } from '../fixtures/app'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'

/**
 * The Chats list row menu, the Pinned block and drag reordering
 * (docs/chat/chat_list_order): a right-click on a row offers Pin / Rename /
 * Open Folder (folder agent chats only) / Delete; pinned chats sit flat in a
 * Pinned block above every group, the newest pin on top; an inline rename
 * saves on Enter without moving the row and cancels on Escape; a drag inside
 * one group moves the chat for good, and a drop onto another group's row is
 * refused.
 *
 * Arranged over IPC with no model, engine or credential. Chats are created
 * through `chat:create` / `chat:update` / `chat:add-message`, then their
 * `updated_at` and message times are moved a few seconds apart through a
 * second handle on the sandbox database, so the list's recency order is known.
 * The summaries query is unpolled and a seeded folder agent is invisible to
 * the renderer's queries, so a `relaunch()` follows every arrangement.
 *
 * "Holds after a poll" is proved by sampling the drawn list every 100 ms for
 * 2.5 s — the Chats list refetches every second — and requiring every sample
 * to equal the expected order, alongside main's own `chat.list()` view.
 */

const FOLDER_AGENT = 'Ledger Keeper'
const MODE = 'Research Mode'
const ALPHA = 'E2E alpha chat'
const BRAVO = 'E2E bravo chat'
const CHARLIE = 'E2E charlie chat'
const DELTA = 'E2E delta chat'
const LEDGER = 'E2E ledger chat'
const MODE_ONE = 'E2E mode one chat'
const MODE_TWO = 'E2E mode two chat'

type Seeded = Record<string, string>

interface SeedChat {
  title: string
  kind: 'plain' | 'folder' | 'mode'
}

/**
 * Create the chats newest-first as given (the first one is 1 s old, the next
 * 2 s, …), with a folder agent and a chat mode when a chat needs one, then
 * relaunch so the summaries and the folder agent reach the renderer.
 */
async function seed(cinna: CinnaApp, chats: SeedChat[]): Promise<Seeded> {
  await cinna.skipOnboarding()
  let folderAgentId: string | null = null
  if (chats.some((chat) => chat.kind === 'folder')) {
    const root = await addAgentRoot(cinna)
    folderAgentId = (await createFolderAgent(cinna, root, FOLDER_AGENT)).id
  }
  const ids = await cinna.page.evaluate(async (input) => {
    await window.api.settings.set('autoChatTitles', false)
    const modeId = input.chats.some((chat) => chat.kind === 'mode')
      ? (await window.api.chatModes.upsert({ name: input.mode, colorPreset: 'blue' })).id
      : null
    const out: Record<string, string> = {}
    for (const chat of input.chats) {
      const made = await window.api.chat.create()
      const patch =
        chat.kind === 'folder' ? { agentId: input.folderAgentId, router: 'direct' as const }
          : chat.kind === 'mode' ? { modeId }
            : {}
      await window.api.chat.update(made.id, { title: chat.title, ...patch })
      await window.api.chat.addMessage(made.id, { role: 'user', content: `Hello from ${chat.title}` })
      out[chat.title] = made.id
    }
    return out
  }, { chats, mode: MODE, folderAgentId })

  const now = Math.floor(Date.now() / 1000)
  const stamps = Object.fromEntries(chats.map((chat, i) => [ids[chat.title], now - (i + 1)]))
  await cinna.electronApp.evaluate(({ app }, row) => {
    if (app.getPath('userData') !== row.userData) throw new Error('Not the isolated test profile')
    const requireFromApp = process.getBuiltinModule('node:module').createRequire(`${app.getAppPath()}/package.json`)
    const Database = requireFromApp('better-sqlite3') as typeof import('better-sqlite3')
    const db = new Database(`${row.userData}/cinna.db`, { fileMustExist: true })
    try {
      for (const [chatId, at] of Object.entries(row.stamps)) {
        db.prepare('UPDATE messages SET created_at = ? WHERE chat_id = ?').run(at, chatId)
        db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(at, chatId)
      }
    } finally { db.close() }
  }, { userData: cinna.sandbox.userData, stamps })

  await cinna.relaunch()
  await cinna.skipOnboarding()
  for (const chat of chats) await expect(row(cinna, ids[chat.title])).toBeVisible()
  return ids
}

const row = (cinna: CinnaApp, chatId: string) => cinna.page.locator(`[data-chat-row="${chatId}"]`)

/**
 * The Chats list as drawn, top to bottom: a group header as `# <label>`, a row
 * as its title. One array says which block every chat is in and in what order.
 */
const layout = (cinna: CinnaApp): Promise<string[]> =>
  cinna.page
    .locator('button[data-chat-group], [data-chat-row]')
    .evaluateAll((els) => els.map((el) => (el.matches('button') ? `# ${el.textContent}` : el.textContent ?? '')))

/**
 * Samples `read` every 100 ms for 2.5 s (two and a half list polls) and
 * requires every sample to equal `expected`.
 */
async function holds<T>(read: () => Promise<T>, expected: T): Promise<void> {
  const started = Date.now()
  const wrong: T[] = []
  await expect
    .poll(async () => {
      const seen = await read()
      if (JSON.stringify(seen) !== JSON.stringify(expected)) wrong.push(seen)
      return Date.now() - started
    }, { timeout: 10_000, intervals: [100] })
    .toBeGreaterThan(2_500)
  expect(wrong, 'every sample across the list polls').toEqual([])
}

/** What main believes about one chat. */
async function mainRow(cinna: CinnaApp, chatId: string) {
  const list = await cinna.page.evaluate(() => window.api.chat.list())
  const found = list.find((chat) => chat.id === chatId)
  if (!found) throw new Error(`chat ${chatId} is not in chat.list()`)
  return {
    title: found.title,
    pinnedRank: found.pinnedRank ?? null,
    sortKey: found.sortKey ?? null,
    updatedAt: new Date(found.updatedAt).getTime()
  }
}

const menu = (cinna: CinnaApp) => cinna.page.getByRole('menu', { name: 'Chat actions' })

async function openRowMenu(cinna: CinnaApp, chatId: string): Promise<void> {
  await row(cinna, chatId).click({ button: 'right' })
  await expect(menu(cinna)).toBeVisible()
}

/** The menu's children in order: `menuitem:<name>` or `separator`. */
const menuShape = (cinna: CinnaApp): Promise<string[]> =>
  menu(cinna).evaluate((el) =>
    Array.from(el.children).map((child) =>
      child.getAttribute('role') === 'separator' ? 'separator' : `${child.getAttribute('role')}:${child.textContent}`))

async function pick(cinna: CinnaApp, item: 'Pin' | 'Unpin' | 'Rename' | 'Delete'): Promise<void> {
  await menu(cinna).getByRole('menuitem', { name: item, exact: true }).click()
  await expect(menu(cinna)).toHaveCount(0)
}

async function setGrouping(cinna: CinnaApp, name: 'Group by Agent' | 'Group by Date', on: boolean): Promise<void> {
  const page = cinna.page
  await page.getByRole('button', { name: 'Chats list options', exact: true }).click()
  const item = page.getByRole('menuitemcheckbox', { name, exact: true })
  if ((await item.getAttribute('aria-checked')) !== String(on)) await item.click()
  await expect(item).toHaveAttribute('aria-checked', String(on))
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu', { name: 'Chats list options' })).toHaveCount(0)
}

/**
 * A real HTML5 drag with the mouse: press on `fromId`, move onto the upper
 * (`before`) or lower (`after`) quarter of `toId`, check the drop line — shown
 * on the target, or shown nowhere — and release.
 *
 * Whether the target accepted is read from the browser's own signal: a
 * `dragover` whose default was prevented is a drop target, one that was not
 * is not. A document listener (bubble phase, after React's root listener)
 * records it per row; waiting for the target's `dragover` to have happened is
 * what keeps "no drop line" from passing before the pointer even arrived.
 */
async function dragRow(
  cinna: CinnaApp, fromId: string, toId: string, place: 'before' | 'after', accepted: boolean
): Promise<void> {
  const page = cinna.page
  await page.evaluate(() => {
    const w = window as unknown as { e2eDragOver?: { row: string | null; prevented: boolean }[] }
    if (!w.e2eDragOver) {
      document.addEventListener('dragover', (event) => {
        const over = (event.target as Element | null)?.closest?.('[data-chat-row]')
        w.e2eDragOver?.push({ row: over?.getAttribute('data-chat-row') ?? null, prevented: event.defaultPrevented })
      })
    }
    w.e2eDragOver = []
  })
  const overTarget = (): Promise<boolean[]> =>
    page.evaluate((id) => {
      const w = window as unknown as { e2eDragOver: { row: string | null; prevented: boolean }[] }
      return w.e2eDragOver.filter((entry) => entry.row === id).map((entry) => entry.prevented)
    }, toId)

  const from = await row(cinna, fromId).boundingBox()
  const to = await row(cinna, toId).boundingBox()
  if (!from || !to) throw new Error('a row to drag is not on screen')
  await page.mouse.move(from.x + from.width / 3, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(from.x + from.width / 3, from.y + from.height / 2 + 4, { steps: 2 })
  const y = place === 'before' ? to.y + to.height / 4 : to.y + (to.height * 3) / 4
  await page.mouse.move(to.x + to.width / 3, y, { steps: 8 })
  // The drag is live: its source is faded.
  await expect(row(cinna, fromId)).toHaveClass(/opacity-40/)
  // Chromium throttles `dragover`, and a still pointer sends none: nudge it
  // by a pixel inside the target until the target has heard one.
  let nudge = 0
  await expect.poll(async () => {
    nudge = 1 - nudge
    await page.mouse.move(to.x + to.width / 3 + nudge, y)
    return (await overTarget()).length
  }).toBeGreaterThan(0)
  expect(await overTarget(), accepted ? 'the target takes the drop' : 'the target refuses the drop')
    .toEqual((await overTarget()).map(() => accepted))
  if (accepted) {
    await expect(row(cinna, toId).locator(`[data-drop-indicator="${place}"]`)).toHaveCount(1)
  } else {
    await expect(page.locator('[data-drop-indicator]')).toHaveCount(0)
  }
  await page.mouse.up()
  await expect(page.locator('[data-drop-indicator]')).toHaveCount(0)
}

test('row menu: Pin, Rename, Open Folder only for a folder agent chat, a separator, Delete; Delete moves the chat to the Trash', async ({ cinna }) => {
  const ids = await seed(cinna, [
    { title: ALPHA, kind: 'plain' },
    { title: BRAVO, kind: 'plain' },
    { title: LEDGER, kind: 'folder' }
  ])

  await test.step('a plain chat: no Open Folder', async () => {
    await openRowMenu(cinna, ids[ALPHA])
    expect(await menuShape(cinna)).toEqual(['menuitem:Pin', 'menuitem:Rename', 'separator', 'menuitem:Delete'])
    await cinna.page.keyboard.press('Escape')
    await expect(menu(cinna)).toHaveCount(0)
  })

  await test.step('a folder agent chat: Open Folder between Rename and the separator', async () => {
    await openRowMenu(cinna, ids[LEDGER])
    expect(await menuShape(cinna)).toEqual([
      'menuitem:Pin', 'menuitem:Rename', 'menuitem:Open Folder', 'separator', 'menuitem:Delete'
    ])
    await cinna.page.keyboard.press('Escape')
    await expect(menu(cinna)).toHaveCount(0)
  })

  await test.step('Delete from the menu moves the chat to the Trash', async () => {
    await openRowMenu(cinna, ids[BRAVO])
    await pick(cinna, 'Delete')
    await expect(row(cinna, ids[BRAVO])).toHaveCount(0)
    await expect.poll(() => layout(cinna)).toEqual([ALPHA, LEDGER])
    const trash = await cinna.page.evaluate(() => window.api.chat.trashList())
    expect(trash.map((chat) => chat.title)).toEqual([BRAVO])
    expect(trash[0].deletedAt).not.toBeNull()
    const listed = await cinna.page.evaluate(() => window.api.chat.list())
    expect(listed.map((chat) => chat.id)).not.toContain(ids[BRAVO])
  })
})

test('Pin: a flat Pinned block on top under any grouping, the newest pin first; Unpin puts the chat back', async ({ cinna }) => {
  const ids = await seed(cinna, [
    { title: ALPHA, kind: 'plain' },
    { title: BRAVO, kind: 'plain' },
    { title: CHARLIE, kind: 'plain' },
    { title: DELTA, kind: 'plain' }
  ])
  await expect.poll(() => layout(cinna)).toEqual([ALPHA, BRAVO, CHARLIE, DELTA])

  await test.step('Pin: the chat leaves the list for a Pinned block on top', async () => {
    await openRowMenu(cinna, ids[BRAVO])
    await pick(cinna, 'Pin')
    await expect.poll(() => layout(cinna)).toEqual(['# Pinned', BRAVO, ALPHA, CHARLIE, DELTA])
    expect((await mainRow(cinna, ids[BRAVO])).pinnedRank).not.toBeNull()
  })

  await test.step('with Group by Agent and Group by Date on, Pinned stays flat and the chat is in no group', async () => {
    await setGrouping(cinna, 'Group by Agent', true)
    await setGrouping(cinna, 'Group by Date', true)
    await expect.poll(() => layout(cinna)).toEqual(['# Pinned', BRAVO, '# Chat', '# Today', ALPHA, CHARLIE, DELTA])
  })

  await test.step('a second pin goes to the top of Pinned', async () => {
    await openRowMenu(cinna, ids[DELTA])
    await pick(cinna, 'Pin')
    await expect.poll(() => layout(cinna)).toEqual(['# Pinned', DELTA, BRAVO, '# Chat', '# Today', ALPHA, CHARLIE])
  })

  await test.step('Unpin removes it from Pinned and returns it to its group by recency', async () => {
    await openRowMenu(cinna, ids[BRAVO])
    expect(await menuShape(cinna)).toEqual(['menuitem:Unpin', 'menuitem:Rename', 'separator', 'menuitem:Delete'])
    await pick(cinna, 'Unpin')
    await expect.poll(() => layout(cinna)).toEqual(['# Pinned', DELTA, '# Chat', '# Today', ALPHA, BRAVO, CHARLIE])
    expect((await mainRow(cinna, ids[BRAVO])).pinnedRank).toBeNull()

    await openRowMenu(cinna, ids[DELTA])
    await pick(cinna, 'Unpin')
    await expect.poll(() => layout(cinna)).toEqual(['# Chat', '# Today', ALPHA, BRAVO, CHARLIE, DELTA])
  })
})

test('Rename inline: Enter saves the title without moving the row, Escape cancels', async ({ cinna }) => {
  const ids = await seed(cinna, [
    { title: ALPHA, kind: 'plain' },
    { title: BRAVO, kind: 'plain' },
    { title: CHARLIE, kind: 'plain' }
  ])
  const RENAMED = 'E2E renamed charlie'
  await expect.poll(() => layout(cinna)).toEqual([ALPHA, BRAVO, CHARLIE])
  const before = await mainRow(cinna, ids[CHARLIE])
  const input = cinna.page.getByRole('textbox', { name: 'Chat title', exact: true })

  await test.step('Enter saves; the oldest chat stays at the bottom', async () => {
    await openRowMenu(cinna, ids[CHARLIE])
    await pick(cinna, 'Rename')
    await expect(input).toBeFocused()
    await expect(input).toHaveValue(CHARLIE)
    await input.fill(RENAMED)
    await input.press('Enter')
    await expect(input).toHaveCount(0)
    await expect(row(cinna, ids[CHARLIE])).toHaveText(RENAMED)
    await holds(() => layout(cinna), [ALPHA, BRAVO, RENAMED])
    expect(await mainRow(cinna, ids[CHARLIE])).toEqual({ ...before, title: RENAMED })
  })

  await test.step('Escape cancels: nothing is saved', async () => {
    await openRowMenu(cinna, ids[CHARLIE])
    await pick(cinna, 'Rename')
    await expect(input).toHaveValue(RENAMED)
    await input.fill('E2E should not stick')
    await input.press('Escape')
    await expect(input).toHaveCount(0)
    await expect(row(cinna, ids[CHARLIE])).toHaveText(RENAMED)
    await holds(() => layout(cinna), [ALPHA, BRAVO, RENAMED])
    expect((await mainRow(cinna, ids[CHARLIE])).title).toBe(RENAMED)
  })
})

test('Drag: a chat moved inside the flat list or a group stays there across polls; a drop onto another group is refused', async ({ cinna }) => {
  const ids = await seed(cinna, [
    { title: ALPHA, kind: 'plain' },
    { title: BRAVO, kind: 'plain' },
    { title: CHARLIE, kind: 'plain' },
    { title: MODE_ONE, kind: 'mode' },
    { title: MODE_TWO, kind: 'mode' }
  ])
  await expect.poll(() => layout(cinna)).toEqual([ALPHA, BRAVO, CHARLIE, MODE_ONE, MODE_TWO])

  await test.step('flat list: the oldest chat dragged above the newest', async () => {
    expect((await mainRow(cinna, ids[CHARLIE])).sortKey).toBeNull()
    await dragRow(cinna, ids[CHARLIE], ids[ALPHA], 'before', true)
    const flat = [CHARLIE, ALPHA, BRAVO, MODE_ONE, MODE_TWO]
    await expect.poll(() => layout(cinna)).toEqual(flat)
    await holds(() => layout(cinna), flat)
    const moved = await mainRow(cinna, ids[CHARLIE])
    expect(moved.sortKey).toBeGreaterThan((await mainRow(cinna, ids[ALPHA])).updatedAt)
    // Not activity: the move did not touch the chat's time.
    expect(moved.updatedAt).toBeLessThan((await mainRow(cinna, ids[BRAVO])).updatedAt)
  })

  await test.step('inside a group: the chat mode group reordered, the dragged place kept in the Chat group', async () => {
    await setGrouping(cinna, 'Group by Agent', true)
    await expect.poll(() => layout(cinna)).toEqual([
      '# Chat', CHARLIE, ALPHA, BRAVO, `# ${MODE}`, MODE_ONE, MODE_TWO
    ])
    await dragRow(cinna, ids[MODE_TWO], ids[MODE_ONE], 'before', true)
    const grouped = ['# Chat', CHARLIE, ALPHA, BRAVO, `# ${MODE}`, MODE_TWO, MODE_ONE]
    await expect.poll(() => layout(cinna)).toEqual(grouped)
    await holds(() => layout(cinna), grouped)
    expect((await mainRow(cinna, ids[MODE_TWO])).sortKey).not.toBeNull()
  })

  await test.step('onto a row of another group: no drop line, and nothing moves or is saved', async () => {
    const grouped = await layout(cinna)
    await dragRow(cinna, ids[BRAVO], ids[MODE_TWO], 'before', false)
    await holds(async () => ({ drawn: await layout(cinna), sortKey: (await mainRow(cinna, ids[BRAVO])).sortKey }),
      { drawn: grouped, sortKey: null })
  })
})
