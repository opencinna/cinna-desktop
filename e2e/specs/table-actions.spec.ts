import { readFileSync } from 'node:fs'
import { test, expect, type CinnaApp } from '../fixtures/app'
import type { Locator, Page } from '@playwright/test'

/**
 * Table actions on tables in a chat reply (`TableActions`, `TablePreviewModal`,
 * `utils/textTable.ts`).
 *
 * A markdown table carries a "Table actions" ⋯ in its last header cell; a
 * fenced block that reads as a table carries one in its top-right corner; a
 * shell pipeline block carries none. The button shows on hover by opacity
 * only. Its menu offers Open as table (the "Table" modal over the File
 * Preview's DataTable, with filters) and Download CSV.
 *
 * The chat and its replies are arranged over IPC (`chat.create` / `update` /
 * `showInList` / `addMessage`), the same path `sticky-table-headers.spec.ts`
 * uses: a stored reply renders through the same markdown components a
 * finished turn does, with no model or engine.
 *
 * Downloads: Electron turns the anchor download into a save dialog. The test
 * hooks `will-download` on the window's session in main and gives the item a
 * save path under the sandbox, so no dialog is shown and the bytes written
 * are the ones a user would get; the file is then read from disk.
 */

const TITLE = 'Table actions chat'
const MD_LEAD = 'Here is the markdown table:'

const MARKDOWN_TABLE = [
  '| Name | City | Note |',
  '|---|---|---|',
  '| Ann | Paris | likes "tea", coffee |',
  '| Bob | Oslo | =1+1 |',
  '| Cleo | Paris | plain |'
].join('\n')

const ALIGNED_BLOCK = [
  '```',
  'Odoo id | name | status',
  '35   Kay Schneider   inactive',
  '1279 Jurek Breunig   ACTIVE',
  '42   Mo Li           ACTIVE',
  '```'
].join('\n')

const BASH_BLOCK = ['```bash', 'ps aux | grep node | head -5', '```'].join('\n')

const REPLY = [
  MD_LEAD,
  '',
  MARKDOWN_TABLE,
  '',
  'And the aligned one:',
  '',
  ALIGNED_BLOCK,
  '',
  'And a command:',
  '',
  BASH_BLOCK,
  '',
  'That is all.'
].join('\n')

const TOKEN = 'y'.repeat(320)
const WIDE_REPLY = [
  'The wide one:',
  '',
  '| Key | Blob | Note |',
  '|---|---|---|',
  `| k1 | ${TOKEN} | fine |`,
  '| k2 | short | ok |',
  '',
  'End of the wide one.'
].join('\n')

async function arrange(cinna: CinnaApp): Promise<void> {
  await cinna.skipOnboarding()
  await cinna.page.evaluate(async ({ title, reply, wide }) => {
    await window.api.settings.set('autoChatTitles', false)
    const chat = await window.api.chat.create()
    await window.api.chat.update(chat.id, { title })
    await window.api.chat.showInList(chat.id)
    await window.api.chat.addMessage(chat.id, { role: 'user', content: 'Show me the tables.' })
    await window.api.chat.addMessage(chat.id, { role: 'assistant', content: reply })
    await window.api.chat.addMessage(chat.id, { role: 'user', content: 'And the wide one?' })
    await window.api.chat.addMessage(chat.id, { role: 'assistant', content: wide })
  }, { title: TITLE, reply: REPLY, wide: WIDE_REPLY })
  await cinna.page.getByText(TITLE, { exact: true }).click()
  await expect(cinna.page.getByText('That is all.', { exact: true })).toBeVisible()
  await expect(cinna.page.getByText('End of the wide one.', { exact: true })).toBeAttached()
}

const markdownTable = (page: Page): Locator =>
  page.getByRole('table').filter({ has: page.getByRole('cell', { name: 'Ann', exact: true }) })
const wideTable = (page: Page): Locator =>
  page.getByRole('table').filter({ has: page.getByRole('cell', { name: 'k1', exact: true }) })
/** A fenced block's wrapper (`table-actions-host`), the button's positioning box and hover target. */
const codeHost = (page: Page, text: string): Locator =>
  page.locator('.table-actions-host').filter({ has: page.locator('pre', { hasText: text }) })

const actionsIn = (scope: Locator): Locator => scope.getByRole('button', { name: 'Table actions', exact: true })
const tableMenu = (page: Page): Locator => page.getByRole('menu', { name: 'Table actions', exact: true })
const modal = (page: Page): Locator => page.getByRole('dialog', { name: 'Table', exact: true })

/** Move the pointer onto the composer, away from every table. */
async function pointerAway(page: Page): Promise<void> {
  await page.getByRole('combobox', { name: 'Type a message...', exact: true }).hover()
}

async function openMenu(page: Page, button: Locator, host: Locator): Promise<void> {
  await host.hover()
  await expect(button).toHaveCSS('opacity', '1')
  await button.click()
  await expect(tableMenu(page)).toBeVisible()
}

/** The modal's body rows, cell by cell. */
async function modalRows(page: Page): Promise<string[][]> {
  return modal(page).locator('tbody tr').evaluateAll((rows) =>
    rows.map((row) => Array.from((row as HTMLTableRowElement).cells, (cell) => (cell.textContent ?? '').trim()))
  )
}

async function modalHeader(page: Page): Promise<string[]> {
  return modal(page).locator('thead tr').first().locator('th').allTextContents().then((cells) => cells.map((c) => c.trim()))
}

interface Saved { state: string; filename: string; path: string }

/** Saves every download of the main window's session under `dir`, with no dialog. */
async function captureDownloads(cinna: CinnaApp, dir: string): Promise<void> {
  await cinna.electronApp.evaluate(({ BrowserWindow }, dir) => {
    const g = globalThis as unknown as { __tableCsv: Saved[] }
    g.__tableCsv = []
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('index.html'))
    if (!win) throw new Error('no main window')
    win.webContents.session.on('will-download', (_event, item) => {
      const path = `${dir}/${g.__tableCsv.length}-${item.getFilename()}`
      item.setSavePath(path)
      item.once('done', (_e, state) => {
        g.__tableCsv.push({ state, filename: item.getFilename(), path })
      })
    })
  }, dir)
}

async function savedDownloads(cinna: CinnaApp): Promise<Saved[]> {
  return cinna.electronApp.evaluate(() => (globalThis as unknown as { __tableCsv: Saved[] }).__tableCsv)
}

test('a markdown table, an aligned code block and a shell block: who gets Table actions, and Open as table', async ({ cinna }) => {
  await arrange(cinna)
  const page = cinna.page

  await test.step('the markdown table: hidden at rest, shown on hover, two items', async () => {
    const table = markdownTable(page)
    const button = actionsIn(table)
    await expect(button).toHaveCount(1)
    // Inside the last header cell.
    await expect(table.getByRole('columnheader').last().getByRole('button', { name: 'Table actions', exact: true })).toHaveCount(1)
    await pointerAway(page)
    await expect(button).toHaveCSS('opacity', '0')
    await table.hover()
    await expect(button).toHaveCSS('opacity', '1')
    await button.click()
    await expect(button).toHaveAttribute('aria-expanded', 'true')
    const menu = tableMenu(page)
    await expect(menu.getByRole('menuitem')).toHaveText(['Open as table', 'Download CSV'])
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
  })

  await test.step('Open as table: the markdown rows and columns, filters narrow them, Escape closes', async () => {
    const table = markdownTable(page)
    await openMenu(page, actionsIn(table), table)
    await tableMenu(page).getByRole('menuitem', { name: 'Open as table', exact: true }).click()
    const dialog = modal(page)
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('3 rows × 3 columns', { exact: true })).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Download CSV', exact: true })).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Close table', exact: true })).toBeVisible()
    expect(await modalHeader(page)).toEqual(['Name', 'City', 'Note'])
    await expect.poll(() => modalRows(page)).toEqual([
      ['Ann', 'Paris', 'likes "tea", coffee'],
      ['Bob', 'Oslo', '=1+1'],
      ['Cleo', 'Paris', 'plain']
    ])

    const toggle = dialog.getByRole('button', { name: 'Toggle column filters and sorting', exact: true })
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await dialog.getByRole('textbox', { name: 'Filter City', exact: true }).fill('Paris')
    await expect.poll(() => modalRows(page)).toEqual([
      ['Ann', 'Paris', 'likes "tea", coffee'],
      ['Cleo', 'Paris', 'plain']
    ])
    await dialog.getByRole('textbox', { name: 'Filter Name', exact: true }).fill('cle')
    await expect.poll(() => modalRows(page)).toEqual([['Cleo', 'Paris', 'plain']])

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  })

  await test.step('the aligned code block: its button in the corner, its columns from the gutters', async () => {
    const host = codeHost(page, 'Odoo id | name | status')
    const button = actionsIn(host)
    await expect(button).toHaveCount(1)
    await pointerAway(page)
    await expect(button).toHaveCSS('opacity', '0')
    await openMenu(page, button, host)
    await expect(tableMenu(page).getByRole('menuitem')).toHaveText(['Open as table', 'Download CSV'])
    await tableMenu(page).getByRole('menuitem', { name: 'Open as table', exact: true }).click()
    const dialog = modal(page)
    await expect(dialog.getByText('3 rows × 3 columns', { exact: true })).toBeVisible()
    expect(await modalHeader(page)).toEqual(['Odoo id', 'name', 'status'])
    await expect.poll(() => modalRows(page)).toEqual([
      ['35', 'Kay Schneider', 'inactive'],
      ['1279', 'Jurek Breunig', 'ACTIVE'],
      ['42', 'Mo Li', 'ACTIVE']
    ])
    // Every table opens without filters, even after the last one had them on.
    const toggle = dialog.getByRole('button', { name: 'Toggle column filters and sorting', exact: true })
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await toggle.click()
    // A case-insensitive substring: "ACTIVE" would keep "inactive" too.
    await dialog.getByRole('textbox', { name: 'Filter status', exact: true }).fill('inact')
    await expect.poll(() => modalRows(page)).toEqual([['35', 'Kay Schneider', 'inactive']])
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  })

  await test.step('the shell pipeline block has no Table actions', async () => {
    const host = codeHost(page, 'ps aux | grep node | head -5')
    await expect(host).toHaveCount(1)
    await host.hover()
    await expect(host.getByRole('button', { name: 'Table actions' })).toHaveCount(0)
    // Exactly the three tables carry one: the markdown table, the aligned block, the wide table.
    await expect(page.getByRole('button', { name: 'Table actions', exact: true })).toHaveCount(3)
  })
})

test('a table too wide for the bubble shows its Table actions inside its visible box', async ({ cinna }) => {
  await arrange(cinna)
  const page = cinna.page
  const table = wideTable(page)
  await table.scrollIntoViewIfNeeded()
  await expect(table).toHaveAttribute('data-table-scrolls', '')
  // The in-header button is clipped and hidden; the wrapper's own stands in.
  const host = page.locator('.chat-table-host').filter({ has: table })
  const button = actionsIn(host)
  await expect(button).toHaveCount(1)
  await pointerAway(page)
  await expect(button).toHaveCSS('opacity', '0')
  await table.hover()
  await expect(button).toHaveCSS('opacity', '1')
  await expect(button).toBeInViewport()

  const tableBox = await table.boundingBox()
  const buttonBox = await button.boundingBox()
  if (!tableBox || !buttonBox) throw new Error('no box for the wide table or its button')
  expect(buttonBox.x).toBeGreaterThanOrEqual(tableBox.x)
  expect(buttonBox.y).toBeGreaterThanOrEqual(tableBox.y)
  expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(tableBox.x + tableBox.width)
  expect(buttonBox.y + buttonBox.height).toBeLessThanOrEqual(tableBox.y + tableBox.height)
  // And it is what is drawn at its own centre, not something over it.
  const onTop = await button.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return hit !== null && (hit === el || el.contains(hit))
  })
  expect(onTop).toBe(true)

  await button.click()
  await tableMenu(page).getByRole('menuitem', { name: 'Open as table', exact: true }).click()
  await expect(modal(page).getByText('2 rows × 3 columns', { exact: true })).toBeVisible()
  await expect.poll(() => modalRows(page)).toEqual([
    ['k1', TOKEN, 'fine'],
    ['k2', 'short', 'ok']
  ])
  await page.keyboard.press('Escape')
  await expect(modal(page)).toHaveCount(0)
})

test('Download CSV saves the rows with a BOM, RFC 4180 quoting and the formula guard', async ({ cinna }) => {
  await arrange(cinna)
  const page = cinna.page
  const dir = cinna.sandbox.root
  await captureDownloads(cinna, dir)

  await test.step('from the markdown table menu', async () => {
    const table = markdownTable(page)
    await openMenu(page, actionsIn(table), table)
    await tableMenu(page).getByRole('menuitem', { name: 'Download CSV', exact: true }).click()
    await expect(tableMenu(page)).toHaveCount(0)
    await expect.poll(async () => (await savedDownloads(cinna)).map((d) => d.state)).toEqual(['completed'])
    const [saved] = await savedDownloads(cinna)
    expect(saved.filename).toMatch(/^table-\d{4}-\d{2}-\d{2}-\d{4}\.csv$/)
    const bytes = readFileSync(saved.path)
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(bytes.subarray(3).toString('utf8')).toBe(
      ['Name,City,Note', 'Ann,Paris,"likes ""tea"", coffee"', "Bob,Oslo,'=1+1", 'Cleo,Paris,plain'].join('\r\n')
    )
  })

  await test.step("from the Table modal's own Download CSV, for the aligned code block", async () => {
    const host = codeHost(page, 'Odoo id | name | status')
    await openMenu(page, actionsIn(host), host)
    await tableMenu(page).getByRole('menuitem', { name: 'Open as table', exact: true }).click()
    await modal(page).getByRole('button', { name: 'Download CSV', exact: true }).click()
    await expect.poll(async () => (await savedDownloads(cinna)).map((d) => d.state)).toEqual(['completed', 'completed'])
    const saved = (await savedDownloads(cinna))[1]
    const bytes = readFileSync(saved.path)
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(bytes.subarray(3).toString('utf8')).toBe(
      ['Odoo id,name,status', '35,Kay Schneider,inactive', '1279,Jurek Breunig,ACTIVE', '42,Mo Li,ACTIVE'].join('\r\n')
    )
    // The modal stays open after a download.
    await expect(modal(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(modal(page)).toHaveCount(0)
  })
})
