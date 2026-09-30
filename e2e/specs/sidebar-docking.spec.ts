import type { Page } from '@playwright/test'
import { test, expect, type CinnaApp } from '../fixtures/app'

/**
 * Sidebar docking: right-click the TopBar sidebar button for Fixed / On Hover.
 *
 * In On Hover the wrap is `.is-floating` (width 0, so the chat never reflows)
 * and `.is-collapsed` (opacity 0) until the pointer stays in the invisible
 * band at the window's left edge, below the TopBar — the shell's 8px padding
 * plus half the sidebar's width, ~142px. It then peeks over the
 * chat, stays while the pointer is on it, and hides 300ms after the pointer
 * leaves. Playwright calls a collapsed sidebar visible (opacity 0, still laid
 * out), so visibility is the wrap's class and computed opacity, which
 * `toHaveCSS` polls through the 260ms transition.
 *
 * The choice lives in localStorage (`cinna-sidebar-docking`) and survives a
 * restart; the peek itself does not.
 */

/** Well inside the band, over the chat: the band takes no pointer events. */
const IN_BAND = { x: 60, y: 400 }
const ON_SIDEBAR = { x: 150, y: 400 }
const IN_CHAT = { x: 700, y: 400 }

const wrap = (page: Page) => page.locator('.app-sidebar-wrap')
/** The main area: whatever view is showing is the wrap's next sibling. */
const mainArea = (page: Page) => page.locator('.app-sidebar-wrap + *')

async function mainWidth(page: Page): Promise<number> {
  const box = await mainArea(page).boundingBox()
  expect(box, 'the main area is laid out').not.toBeNull()
  return box!.width
}

async function expectPeeking(page: Page): Promise<void> {
  await expect(wrap(page)).toHaveClass(/\bis-floating\b/)
  await expect(wrap(page)).not.toHaveClass(/\bis-collapsed\b/)
  await expect(wrap(page)).toHaveCSS('opacity', '1')
}

async function expectHidden(page: Page, timeout?: number): Promise<void> {
  await expect(wrap(page)).toHaveClass(/\bis-collapsed\b/, { timeout })
  await expect(wrap(page)).toHaveCSS('opacity', '0')
}

/** Walk the pointer into the edge band and stay there until the sidebar peeks. */
async function peekFromEdge(page: Page): Promise<void> {
  await page.mouse.move(IN_CHAT.x, IN_CHAT.y)
  await page.mouse.move(IN_BAND.x, IN_BAND.y, { steps: 20 })
  await expectPeeking(page)
}

async function openSettingsFeatures(cinna: CinnaApp): Promise<void> {
  const page = cinna.page
  const user = await page.evaluate(() => window.api.auth.getCurrent())
  expect(user, 'onboarding activated a user').not.toBeNull()
  await page.getByRole('button', { name: user!.displayName, exact: true }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
}

test('sidebar docking On Hover peeks from the left edge without reflowing the chat, and persists', async ({
  cinna
}) => {
  await cinna.skipOnboarding()

  let dockedWidth = 0
  let floatingWidth = 0

  await test.step('right-click the sidebar button, pick On Hover: the sidebar hides and the chat widens', async () => {
    const page = cinna.page
    await expect(wrap(page)).toHaveCSS('opacity', '1')
    dockedWidth = await mainWidth(page)

    await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click({ button: 'right' })
    const menu = page.getByRole('menu', { name: 'Sidebar docking', exact: true })
    await expect(menu.getByRole('menuitemradio', { name: 'Fixed', exact: true })).toHaveAttribute('aria-checked', 'true')
    await menu.getByRole('menuitemradio', { name: 'On Hover', exact: true }).click()
    await expect(menu).toHaveCount(0)

    await expectHidden(page)
    await expect(page.getByRole('button', { name: 'Dock sidebar', exact: true })).toBeVisible()
    // The wrap's 268px (240 page + 28 tab rail) leaves with the collapse; the flex gap stays.
    await expect.poll(() => mainWidth(page), { message: 'the main area took the sidebar width' })
      .toBeCloseTo(dockedWidth + 268, 0)
    floatingWidth = await mainWidth(page)
  })

  await test.step('rest the pointer at the left edge: the sidebar peeks and the chat keeps its width', async () => {
    const page = cinna.page
    // Record the main area's width every frame from before the move until the
    // peek is fully shown, so a reflow during the slide-in is caught too.
    await page.evaluate(() => {
      const w = window as unknown as { __widths: number[]; __sampling: boolean }
      w.__widths = []
      w.__sampling = true
      const main = document.querySelector('.app-sidebar-wrap + *') as HTMLElement
      const tick = (): void => {
        w.__widths.push(main.getBoundingClientRect().width)
        if (w.__sampling) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    await peekFromEdge(page)
    const widths = await page.evaluate(() => {
      const w = window as unknown as { __widths: number[]; __sampling: boolean }
      w.__sampling = false
      return w.__widths
    })
    expect(widths.length, 'frames were sampled across the peek').toBeGreaterThan(5)
    expect(new Set(widths), 'main area width in every frame of the peek').toEqual(new Set([floatingWidth]))
    expect(await mainWidth(page)).toBe(floatingWidth)
  })

  await test.step('onto the sidebar it stays; into the chat it hides within a second', async () => {
    const page = cinna.page
    await page.mouse.move(ON_SIDEBAR.x, ON_SIDEBAR.y, { steps: 10 })
    // A negative needs a window: watch the wrap's class for well over the
    // 300ms close delay plus a 150ms re-check while the pointer sits on it.
    const collapsedWhileOn = await page.evaluate(
      () =>
        new Promise<boolean>((resolve) => {
          const el = document.querySelector('.app-sidebar-wrap')!
          let collapsed = el.classList.contains('is-collapsed')
          const observer = new MutationObserver(() => {
            if (el.classList.contains('is-collapsed')) collapsed = true
          })
          observer.observe(el, { attributes: true, attributeFilter: ['class'] })
          setTimeout(() => {
            observer.disconnect()
            resolve(collapsed)
          }, 900)
        })
    )
    expect(collapsedWhileOn, 'the sidebar collapsed while the pointer was on it').toBe(false)
    await expectPeeking(page)

    await page.mouse.move(IN_CHAT.x, IN_CHAT.y, { steps: 10 })
    await expectHidden(page, 1_000)
    expect(await mainWidth(page)).toBe(floatingWidth)
  })

  await test.step('Settings → Features → Interface shows On Hover; Fixed docks the sidebar open', async () => {
    const page = cinna.page
    // Settings is reached the way a hover user reaches it: from the peeked sidebar.
    await peekFromEdge(page)
    await openSettingsFeatures(cinna)
    // Settings swaps the sidebar for its own menu; peek again to pick Features.
    await peekFromEdge(page)
    await page.getByRole('button', { name: 'Features', exact: true }).click()

    const group = page.getByRole('group', { name: 'Sidebar docking', exact: true })
    await expect(group.getByRole('button', { name: 'On Hover', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(group.getByRole('button', { name: 'Fixed', exact: true })).toHaveAttribute('aria-pressed', 'false')

    await group.getByRole('button', { name: 'Fixed', exact: true }).click()
    await expect(group.getByRole('button', { name: 'Fixed', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(wrap(page)).not.toHaveClass(/\bis-floating\b/)
    await expect(wrap(page)).not.toHaveClass(/\bis-collapsed\b/)
    await expect(wrap(page)).toHaveCSS('opacity', '1')
    await expect(page.getByRole('button', { name: 'Collapse sidebar', exact: true })).toBeVisible()
    // Docked, it takes its width again, even with the pointer off it.
    await page.mouse.move(IN_CHAT.x, IN_CHAT.y, { steps: 5 })
    await expect.poll(() => mainWidth(page)).toBeCloseTo(dockedWidth, 0)

    // Back to On Hover for the restart.
    await group.getByRole('button', { name: 'On Hover', exact: true }).click()
    await expectHidden(page)
  })

  await test.step('restart: On Hover is still the choice, and the edge still peeks', async () => {
    await cinna.relaunch()
    await cinna.skipOnboarding()
    const page = cinna.page
    await expect(page.getByRole('button', { name: 'Dock sidebar', exact: true })).toBeVisible()
    await expect(wrap(page)).toHaveClass(/\bis-floating\b/)
    await expectHidden(page)
    await peekFromEdge(page)
    await page.getByRole('button', { name: 'Dock sidebar', exact: true }).click({ button: 'right' })
    const menu = page.getByRole('menu', { name: 'Sidebar docking', exact: true })
    await expect(menu.getByRole('menuitemradio', { name: 'On Hover', exact: true })).toHaveAttribute('aria-checked', 'true')
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
  })
})
