import { cpSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, type CinnaApp } from '../fixtures/app'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'

/**
 * Dashboards, tuned by hand: a tile's Custom size dragged against the grid, the
 * header's controls, the chat panel as a card sliding in like the sidebar, the
 * focus ring only while it is open, a removed chip brought back by Ask, a narrow
 * window where other tiles stay reachable, and a tile's suggested questions
 * changed in Edit tile. No turn is run.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'dashboards')
const DASHBOARD = 'My dashboard'

async function arrange(cinna: CinnaApp): Promise<void> {
  await cinna.skipOnboarding()
  const root = await addAgentRoot(cinna)
  const agent = await createFolderAgent(cinna, root, 'Sales Desk')
  cpSync(join(FIXTURES, 'open-tasks'), join(agent.path, 'dashboards', 'open-tasks'), { recursive: true })
  const followUps = join(agent.path, 'dashboards', 'follow-ups')
  mkdirSync(join(followUps, 'api'), { recursive: true })
  writeFileSync(join(followUps, 'component.json'), JSON.stringify({
    schema_version: 1, title: 'Follow-ups', view: 'list',
    source: { endpoint: 'items' },
    endpoints: { items: { script: 'api/items.mjs', description: 'Open follow-ups. No params.' } },
    refresh: { max_age: '1h' },
    size: 'm',
    prompts: [{ label: 'Most urgent?', prompt: 'Which follow-up is the most urgent?' }]
  }, null, 2))
  writeFileSync(join(followUps, 'api', 'items.mjs'), "console.log(JSON.stringify({ items: [{ id: 'f1', title: 'Call Priya about the renewal' }] }))\n")
  await cinna.page.evaluate(async ({ agentId, name }) => {
    await window.api.localAgents.rescan()
    const first = await window.api.dashboards.addTile({ newDashboardName: name, agentId, component: 'follow-ups', size: 'm' })
    if (!first.ok) throw new Error(first.message)
    const second = await window.api.dashboards.addTile({ dashboardId: first.dashboard.id, agentId, component: 'open-tasks', size: 'm' })
    if (!second.ok) throw new Error(second.message)
  }, { agentId: agent.id, name: DASHBOARD })
  await openDashboard(cinna)
}

async function openDashboard(cinna: CinnaApp): Promise<void> {
  const page = cinna.page
  await page.getByRole('button', { name: 'Dashboards', exact: true }).click()
  await page.getByRole('button', { name: `${DASHBOARD}, 2 tiles`, exact: true }).click()
  await expect(tile(cinna, 'Follow-ups').getByText('Call Priya about the renewal')).toBeVisible({ timeout: 60_000 })
}

function tile(cinna: CinnaApp, title: string) {
  return cinna.page.getByTestId('dashboard-grid').getByRole('group', { name: title, exact: true })
}
function panel(cinna: CinnaApp) {
  return cinna.page.getByTestId('dashboard-chat-panel')
}
function chip(cinna: CinnaApp) {
  return panel(cinna).getByTestId('dashboard-context-chip')
}
async function chooseInTileMenu(cinna: CinnaApp, title: string, item: string): Promise<void> {
  await tile(cinna, title).hover()
  await tile(cinna, title).getByRole('button', { name: `Actions for ${title}`, exact: true }).click()
  await cinna.page.getByRole('menu', { name: `Actions for ${title}`, exact: true }).getByRole('menuitem', { name: item, exact: true }).click()
}
async function ask(cinna: CinnaApp, title: string): Promise<void> {
  await tile(cinna, title).hover()
  await tile(cinna, title).getByRole('button', { name: `Ask about ${title}`, exact: true }).click()
}
/** The cell count a tile takes, from its grid style. */
async function spanOf(cinna: CinnaApp, title: string): Promise<{ cols: number; rows: number }> {
  return tile(cinna, title).evaluate((el) => {
    const parse = (value: string): number => Number(/span (\d+)/.exec(value)?.[1] ?? 0)
    return { cols: parse((el as HTMLElement).style.gridColumnStart || (el as HTMLElement).style.gridColumn), rows: parse((el as HTMLElement).style.gridRowStart || (el as HTMLElement).style.gridRow) }
  })
}

test('a tile sized Custom is dragged against the grid and keeps its cells after a restart', async ({ cinna }) => {
  test.setTimeout(180_000)
  await arrange(cinna)
  const page = cinna.page
  expect(await spanOf(cinna, 'Follow-ups')).toEqual({ cols: 6, rows: 2 })
  await expect(tile(cinna, 'Follow-ups').getByTestId('tile-resize-handle')).toHaveCount(0)

  await test.step('Custom in the size menu keeps the cells and gives the tile a corner', async () => {
    await tile(cinna, 'Follow-ups').hover()
    await tile(cinna, 'Follow-ups').getByRole('button', { name: 'Actions for Follow-ups', exact: true }).click()
    const menu = page.getByRole('menu', { name: 'Actions for Follow-ups', exact: true })
    await expect(menu.getByRole('menuitemradio', { name: 'Medium' })).toHaveAttribute('aria-checked', 'true')
    await menu.getByRole('menuitemradio', { name: 'Custom' }).click()
    await expect(menu).toHaveCount(0)
    await tile(cinna, 'Follow-ups').hover()
    await expect(tile(cinna, 'Follow-ups').getByRole('button', { name: 'Resize Follow-ups', exact: true })).toBeVisible()
    expect(await spanOf(cinna, 'Follow-ups')).toEqual({ cols: 6, rows: 2 })
  })

  await test.step('dragging the corner snaps to whole cells, over the neighbour’s frame area too', async () => {
    const handle = await tile(cinna, 'Follow-ups').getByRole('button', { name: 'Resize Follow-ups', exact: true }).boundingBox()
    // A cell plus its gap, as the grid has them now (12 columns, or 6 at this width).
    const cell = await page.getByTestId('dashboard-grid').evaluate((el) => parseFloat(getComputedStyle(el).gridTemplateColumns.split(' ')[0]) + 12)
    const [x, y] = [handle!.x + handle!.width / 2, handle!.y + handle!.height / 2]
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x - cell * 2, y + 122, { steps: 6 })
    expect(await spanOf(cinna, 'Follow-ups')).toEqual({ cols: 4, rows: 3 })
    await page.mouse.up()
    await expect.poll(async () => page.evaluate(async () => {
      const list = await window.api.dashboards.list()
      const tiles = await window.api.dashboards.tiles(list[0].id)
      return tiles.ok ? tiles.tiles.find((t) => t.tile.component === 'follow-ups')?.tile : null
    })).toMatchObject({ size: 'custom', customSpan: { cols: 4, rows: 3 } })
    expect(await spanOf(cinna, 'Follow-ups')).toEqual({ cols: 4, rows: 3 })
  })

  await test.step('after a restart it has those cells, and the size menu says Custom', async () => {
    await cinna.relaunch()
    await cinna.skipOnboarding()
    await cinna.page.evaluate(() => window.api.localAgents.rescan())
    await openDashboard(cinna)
    expect(await spanOf(cinna, 'Follow-ups')).toEqual({ cols: 4, rows: 3 })
    await tile(cinna, 'Follow-ups').hover()
    await tile(cinna, 'Follow-ups').getByRole('button', { name: 'Actions for Follow-ups', exact: true }).click()
    await expect(cinna.page.getByRole('menu', { name: 'Actions for Follow-ups', exact: true }).getByRole('menuitemradio', { name: 'Custom' })).toHaveAttribute('aria-checked', 'true')
    await cinna.page.keyboard.press('Escape')
  })

  await test.step('Edit layout is in the ⋯ menu and gives a preset tile a corner too; Done leaves it', async () => {
    await expect(cinna.page.getByRole('button', { name: 'Edit layout', exact: true })).toHaveCount(0)
    await cinna.page.getByRole('button', { name: `Actions for ${DASHBOARD}`, exact: true }).click()
    const menu = cinna.page.getByRole('menu', { name: `Actions for ${DASHBOARD}`, exact: true })
    await expect(menu.getByRole('menuitem')).toHaveText(['Rename…', 'Edit layout', 'Delete…'])
    await menu.getByRole('menuitem', { name: 'Edit layout', exact: true }).click()
    await expect(tile(cinna, 'Open tasks').getByRole('button', { name: 'Resize Open tasks', exact: true })).toBeVisible()
    await cinna.page.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(tile(cinna, 'Open tasks').getByRole('button', { name: 'Resize Open tasks', exact: true })).toHaveCount(0)
  })
})

test('the chat panel is a card that slides in from the right, the ring shows only while it is open, and Ask brings a removed chip back', async ({ cinna }) => {
  test.setTimeout(180_000)
  await arrange(cinna)
  const page = cinna.page
  const chat = page.getByRole('button', { name: 'Chat', exact: true })

  await test.step('with the panel closed, a clicked tile shows no ring and its rows no selection', async () => {
    await tile(cinna, 'Follow-ups').getByText('Call Priya about the renewal').click()
    await expect(tile(cinna, 'Follow-ups')).toHaveAttribute('data-focused', 'true')
    await expect(tile(cinna, 'Follow-ups').locator('[aria-selected="true"]')).toHaveCount(0)
    const shadow = await tile(cinna, 'Follow-ups').evaluate((el) => getComputedStyle(el).boxShadow)
    expect(shadow.replace(/rgba\(0, 0, 0, 0\) 0px 0px 0px 0px,? ?/g, '').trim()).toMatch(/^(none)?$/)
  })

  await test.step('Chat slides the panel in: it starts collapsed at the right, ends as a card off the window’s edges', async () => {
    await expect(chat).toHaveAttribute('aria-pressed', 'false')
    const pressedBefore = await chat.evaluate((el) => getComputedStyle(el).backgroundColor)
    const seen = await page.evaluate(async () => {
      const button = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Chat')!
      button.click()
      const widths: number[] = []
      for (let i = 0; i < 12; i += 1) {
        await new Promise((resolve) => requestAnimationFrame(resolve))
        const wrap = document.querySelector('.dashboard-panel-wrap')
        if (wrap) widths.push(Math.round(wrap.getBoundingClientRect().width))
      }
      return widths
    })
    expect(new Set(seen).size, `the width moves in steps: ${seen.join()}`).toBeGreaterThan(2)
    expect(seen[0]).toBeLessThan(seen[seen.length - 1])
    await expect(panel(cinna)).toBeVisible()
    await expect(chat).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(() => chat.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(pressedBefore)
    await page.mouse.move(5, 300)
    await expect.poll(async () => (await page.locator('.dashboard-panel-wrap').getAttribute('class'))?.includes('is-sliding')).toBe(false)
    const box = (await panel(cinna).boundingBox())!
    const view = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }))
    // The shell's 8 px padding, give or take the bounding box's rounding.
    expect(Math.abs(view.w - (box.x + box.width) - 8)).toBeLessThanOrEqual(1)
    expect(Math.abs(view.h - (box.y + box.height) - 8)).toBeLessThanOrEqual(1)
    // To the top of the space, not level with the sidebar; the top bar's drag strip stops at its left edge, or it would take its buttons' clicks.
    expect(Math.abs(box.y - 8)).toBeLessThanOrEqual(1)
    const strip = await page.locator('.app-drag-strip.z-30').boundingBox()
    expect(strip!.x + strip!.width).toBeLessThanOrEqual(box.x + 1)
    const drag = (selector: string): Promise<string> => panel(cinna).locator(selector).first().evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region'))
    expect(await drag('.app-drag-strip')).toBe('drag')
    expect(await drag('.app-drag-strip button')).toBe('no-drag')
    const style = await panel(cinna).evaluate((el) => ({ radius: getComputedStyle(el).borderTopLeftRadius, right: getComputedStyle(el).borderRightWidth }))
    expect(style).toEqual({ radius: '14px', right: '1px' })
    // The composer's blur would square the card's bottom corners; it takes their radius instead.
    const blur = await panel(cinna).locator('.composer-dock > div').first().evaluate((el) => getComputedStyle(el).borderBottomLeftRadius)
    expect(blur).toBe('13px')
    await expect(tile(cinna, 'Follow-ups').locator('[aria-selected="true"]')).toHaveCount(0)
  })

  await test.step('a removed chip stays while nothing changes, and Ask brings it back', async () => {
    await expect(chip(cinna)).toHaveText('Follow-ups')
    await chip(cinna).getByRole('button', { name: "Don't send Follow-ups", exact: true }).click()
    await expect(chip(cinna)).toHaveText('Not sending Follow-upsSend it')
    await ask(cinna, 'Follow-ups')
    await expect(chip(cinna)).toHaveText('Follow-ups')
  })

  await test.step('in a narrow window the panel lies over the grid at its minimum, and another tile can still be clicked', async () => {
    await page.setViewportSize({ width: 800, height: 600 })
    await expect(panel(cinna)).toHaveAttribute('data-overlay', 'true')
    await expect.poll(async () => (await panel(cinna).boundingBox())?.width).toBe(300)
    await tile(cinna, 'Open tasks').scrollIntoViewIfNeeded()
    await tile(cinna, 'Open tasks').click({ position: { x: 40, y: 10 } })
    await expect(tile(cinna, 'Open tasks')).toHaveAttribute('data-focused', 'true')
    await expect(chip(cinna)).toContainText('Open tasks')
    // A composer popover opens past the 300 px card's edge: the card must not clip it.
    expect(await panel(cinna).evaluate((el) => getComputedStyle(el).overflow)).toBe('visible')
    await page.setViewportSize({ width: 1200, height: 800 })
    await expect(panel(cinna)).not.toHaveAttribute('data-overlay', 'true')
  })

  await test.step('closing slides it away before it goes, and the button lets go', async () => {
    await panel(cinna).getByRole('button', { name: 'Close chat panel', exact: true }).click()
    await expect(chat).toHaveAttribute('aria-pressed', 'false')
    await expect(page.locator('.dashboard-panel-wrap.is-collapsed')).toHaveCount(1)
    await expect(panel(cinna)).toHaveCount(0)
    const strip = await page.locator('.app-drag-strip.z-30').boundingBox()
    const width = await page.evaluate(() => innerWidth)
    expect(width - (strip!.x + strip!.width)).toBeLessThanOrEqual(10)
  })
})

test('a tile’s suggested questions are turned off, reworded and added in Edit tile, and the tile offers those', async ({ cinna }) => {
  test.setTimeout(180_000)
  await arrange(cinna)
  const page = cinna.page
  const bar = tile(cinna, 'Follow-ups')
  await bar.hover()
  await expect(bar.getByRole('button', { name: 'Most urgent?', exact: true })).toBeVisible()

  await test.step('turning it off takes it off the bar', async () => {
    await chooseInTileMenu(cinna, 'Follow-ups', 'Edit tile…')
    const dialog = page.getByRole('dialog', { name: 'Edit tile', exact: true })
    await dialog.getByRole('switch', { name: 'Offer Most urgent?', exact: true }).click()
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await bar.hover()
    await expect(bar.getByRole('button', { name: 'Most urgent?', exact: true })).toHaveCount(0)
  })

  await test.step('an own question without text is refused, and the dialog stays; with text it is on the bar', async () => {
    await chooseInTileMenu(cinna, 'Follow-ups', 'Edit tile…')
    const dialog = page.getByRole('dialog', { name: 'Edit tile', exact: true })
    await expect(dialog.getByRole('switch', { name: 'Offer Most urgent?', exact: true })).toHaveAttribute('aria-checked', 'false')
    await dialog.getByRole('button', { name: 'Add question', exact: true }).click()
    await dialog.getByLabel('Label', { exact: true }).fill('Whose?')
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(dialog.getByRole('alert')).toContainText('A suggested question needs a label')
    await dialog.getByLabel('Question sent to the agent', { exact: true }).fill('Who owns the follow-up?')
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await bar.hover()
    await expect(bar.getByRole('button', { name: 'Whose?', exact: true })).toBeVisible()
  })

  await test.step('rewording the agent’s question and turning it back on shows the new label', async () => {
    await chooseInTileMenu(cinna, 'Follow-ups', 'Edit tile…')
    const dialog = page.getByRole('dialog', { name: 'Edit tile', exact: true })
    await dialog.getByRole('switch', { name: 'Offer Most urgent?', exact: true }).click()
    await dialog.getByRole('button', { name: 'Edit Most urgent?', exact: true }).click()
    await dialog.getByLabel('Label', { exact: true }).fill('First up?')
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    const stored = await page.evaluate(async () => {
      const list = await window.api.dashboards.list()
      const tiles = await window.api.dashboards.tiles(list[0].id)
      return tiles.ok ? tiles.tiles.find((t) => t.tile.component === 'follow-ups')?.tile.promptOverride : null
    })
    expect(stored).toEqual({
      edited: { 'Most urgent?': { label: 'First up?', prompt: 'Which follow-up is the most urgent?' } },
      added: [{ label: 'Whose?', prompt: 'Who owns the follow-up?' }]
    })
  })
})
