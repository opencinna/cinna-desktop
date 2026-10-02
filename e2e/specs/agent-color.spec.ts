import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import type { Locator } from '@playwright/test'
import { test, expect, type CinnaApp } from '../fixtures/app'

/**
 * Agent Color presets (docs/agents/agents/agent_colors.md): an agent's page →
 * Settings → Interface → Color. Picking a preset tints the agent's icon in the
 * sidebar Agents list, puts a dot before its chats in the flat Chats list, and
 * tints its group header icon (with no dots) when the list groups by agent.
 * None clears all of it. The choice is stored per profile in main and
 * survives a restart.
 *
 * Arranged over IPC with no model, engine or credential: two hand-added A2A
 * agents on a closed loopback port (never contacted — no turn runs), one chat
 * each. `Plain` is the control that is never colored. Seeded agents and chat
 * summaries are stale until a `relaunch()`.
 */

const COLORED = 'Painter'
const PLAIN = 'Plain'
const COLORED_CHAT = 'E2E painter chat'
const PLAIN_CHAT = 'E2E plain chat'
/** Teal in AGENT_COLOR_PRESETS (`#44AFB0`) — the raw fill the dot uses. */
const TEAL_HEX = '#44AFB0'
const TEAL_RGB = 'rgb(68, 175, 176)'

/** A loopback port nothing listens on: bound once, then closed. */
async function closedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

const sidebarTab = (cinna: CinnaApp, name: 'Chats' | 'Agents') =>
  cinna.page.getByRole('button', { name, exact: true }).first()

/** The sidebar Agents row (a button named by the agent alone; the chat shortcut beside it is a sibling). */
const agentRow = (cinna: CinnaApp, name: string) => cinna.page.getByRole('button', { name, exact: true })

/** The A2A type icon inside a container (sidebar row, Chats group header). */
const typeIcon = (container: Locator) => container.locator('span[title="A2A agent"]')

const chatRow = (cinna: CinnaApp, title: string) =>
  cinna.page.locator('[data-chat-row]').filter({ hasText: title })

const groupHeader = (cinna: CinnaApp, name: string) =>
  cinna.page.locator('button[data-chat-group]').and(cinna.page.getByRole('button', { name, exact: true }))

const swatches = (cinna: CinnaApp) => cinna.page.getByRole('group', { name: 'Color preset', exact: true })
const swatch = (cinna: CinnaApp, name: string) => swatches(cinna).getByRole('button', { name, exact: true })

/**
 * The colour the icon should be drawn in: Teal's glyph ink, resolved by the
 * browser under the current theme (`agentInk(hex, 'glyph')`). A probe styled
 * with the same expression and inserted beside the icon gives the computed
 * value the icon's own inline colour must equal.
 */
async function expectTealGlyph(icon: Locator): Promise<void> {
  await expect(icon).toHaveAttribute('style', /color/)
  const [actual, expected] = await icon.evaluate((el, hex) => {
    const probe = document.createElement('span')
    probe.style.color = `color-mix(in oklab, ${hex} var(--agent-glyph-strength, 100%), black)`
    el.parentElement!.appendChild(probe)
    const out = [getComputedStyle(el).color, getComputedStyle(probe).color]
    probe.remove()
    return out
  }, TEAL_HEX)
  expect(actual).toBe(expected)
}

/** At None the icon carries no inline colour and keeps the muted class. */
async function expectPlainGlyph(icon: Locator): Promise<void> {
  await expect(icon).not.toHaveAttribute('style', /color/)
  await expect(icon).toHaveClass(/text-\[var\(--color-text-muted\)\]/)
}

async function setGroupByAgent(cinna: CinnaApp, on: boolean): Promise<void> {
  await cinna.page.getByRole('button', { name: 'Chats list options', exact: true }).click()
  const item = cinna.page.getByRole('menuitemcheckbox', { name: 'Group by Agent', exact: true })
  await expect(item).toBeVisible()
  if ((await item.getAttribute('aria-checked')) !== String(on)) await item.click()
  await expect(item).toHaveAttribute('aria-checked', String(on))
  await cinna.page.keyboard.press('Escape')
  await expect(cinna.page.getByRole('menu', { name: 'Chats list options' })).toHaveCount(0)
}

/** Agents tab → the agent's row → Settings → Interface. */
async function openInterfaceTab(cinna: CinnaApp, name: string): Promise<void> {
  await sidebarTab(cinna, 'Agents').click()
  await agentRow(cinna, name).click()
  await expect(cinna.page.getByRole('heading', { name, level: 1 })).toBeVisible()
  await cinna.page.getByRole('button', { name: 'Settings', exact: true }).click()
  await cinna.page.getByRole('tab', { name: 'Interface', exact: true }).click()
  await expect(cinna.page.getByRole('tabpanel').getByText('Color', { exact: true })).toBeVisible()
}

test('an agent Color preset tints its sidebar icon, dots its chats, colours its group header, survives a restart, and None clears it', async ({ cinna }) => {
  await cinna.skipOnboarding()
  const host = `http://127.0.0.1:${await closedPort()}`

  const ids = await cinna.page.evaluate(async (input) => {
    await window.api.settings.set('autoChatTitles', false)
    const agent = async (name: string): Promise<string> => {
      const made = await window.api.agents.upsert({ name, protocol: 'a2a',
        cardUrl: `${input.host}/.well-known/agent-card.json`, endpointUrl: `${input.host}/a2a` })
      if (!made.success || !made.id) throw new Error(`Could not create agent ${name}`)
      return made.id
    }
    const chat = async (title: string, agentId: string): Promise<string> => {
      const created = await window.api.chat.create()
      await window.api.chat.update(created.id, { title, agentId, router: 'direct' })
      await window.api.chat.addMessage(created.id, { role: 'user', content: `Hello from ${title}` })
      return created.id
    }
    const colored = await agent(input.colored)
    const plain = await agent(input.plain)
    await chat(input.coloredChat, colored)
    await chat(input.plainChat, plain)
    return { colored, plain }
  }, { host, colored: COLORED, plain: PLAIN, coloredChat: COLORED_CHAT, plainChat: PLAIN_CHAT })

  await cinna.relaunch()
  await cinna.skipOnboarding()

  await test.step('at rest: no color anywhere', async () => {
    expect(await cinna.page.evaluate(() => window.api.agents.listColors())).toEqual([])
    await sidebarTab(cinna, 'Chats').click()
    await expect(chatRow(cinna, COLORED_CHAT)).toBeVisible()
    await expect(chatRow(cinna, PLAIN_CHAT)).toBeVisible()
    await expect(cinna.page.locator('[data-agent-color-dot]')).toHaveCount(0)

    await openInterfaceTab(cinna, COLORED)
    await expect(swatch(cinna, 'None')).toHaveAttribute('aria-pressed', 'true')
    await expect(swatch(cinna, 'Teal')).toHaveAttribute('aria-pressed', 'false')
    await expectPlainGlyph(typeIcon(agentRow(cinna, COLORED)))
  })

  await test.step('pick Teal: the swatch is pressed, main stores it, the sidebar icon takes it', async () => {
    await swatch(cinna, 'Teal').click()
    await expect(swatch(cinna, 'Teal')).toHaveAttribute('aria-pressed', 'true')
    await expect(swatch(cinna, 'None')).toHaveAttribute('aria-pressed', 'false')
    await expect(swatches(cinna).locator('[aria-pressed="true"]')).toHaveCount(1)
    await expect(cinna.page.getByRole('tabpanel').getByRole('alert')).toHaveCount(0)
    await expect.poll(() => cinna.page.evaluate(() => window.api.agents.listColors()))
      .toEqual([{ agentId: ids.colored, preset: 'teal' }])

    await expectTealGlyph(typeIcon(agentRow(cinna, COLORED)))
    await expectPlainGlyph(typeIcon(agentRow(cinna, PLAIN)))
  })

  await test.step('flat Chats list: a Teal dot on its chat, none on the uncolored agent\'s chat', async () => {
    await sidebarTab(cinna, 'Chats').click()
    const dot = chatRow(cinna, COLORED_CHAT).locator('[data-agent-color-dot]')
    await expect(dot).toHaveCount(1)
    await expect(dot).toHaveCSS('background-color', TEAL_RGB)
    await expect(chatRow(cinna, PLAIN_CHAT).locator('[data-agent-color-dot]')).toHaveCount(0)
    await expect(cinna.page.locator('[data-agent-color-dot]')).toHaveCount(1)
  })

  await test.step('grouped by agent: no dot on the row, the group header icon is tinted instead', async () => {
    await setGroupByAgent(cinna, true)
    await expect(groupHeader(cinna, COLORED)).toBeVisible()
    await expect(groupHeader(cinna, PLAIN)).toBeVisible()
    await expect(chatRow(cinna, COLORED_CHAT)).toBeVisible()
    await expect(cinna.page.locator('[data-agent-color-dot]')).toHaveCount(0)
    await expectTealGlyph(typeIcon(groupHeader(cinna, COLORED)))
    await expectPlainGlyph(typeIcon(groupHeader(cinna, PLAIN)))

    // Back to the flat list, so the restart below lands where the dot shows.
    await setGroupByAgent(cinna, false)
    await expect(groupHeader(cinna, COLORED)).toHaveCount(0)
    await expect(chatRow(cinna, COLORED_CHAT).locator('[data-agent-color-dot]')).toHaveCount(1)
  })

  await test.step('the choice survives a restart', async () => {
    await cinna.relaunch()
    await cinna.skipOnboarding()
    await sidebarTab(cinna, 'Chats').click()
    const dot = chatRow(cinna, COLORED_CHAT).locator('[data-agent-color-dot]')
    await expect(dot).toHaveCount(1)
    await expect(dot).toHaveCSS('background-color', TEAL_RGB)
    await expect(chatRow(cinna, PLAIN_CHAT).locator('[data-agent-color-dot]')).toHaveCount(0)

    await openInterfaceTab(cinna, COLORED)
    await expect(swatch(cinna, 'Teal')).toHaveAttribute('aria-pressed', 'true')
    await expect(swatch(cinna, 'None')).toHaveAttribute('aria-pressed', 'false')
    await expectTealGlyph(typeIcon(agentRow(cinna, COLORED)))
  })

  await test.step('choose None: the icon goes muted, the dot goes, main forgets it', async () => {
    await swatch(cinna, 'None').click()
    await expect(swatch(cinna, 'None')).toHaveAttribute('aria-pressed', 'true')
    await expect(swatch(cinna, 'Teal')).toHaveAttribute('aria-pressed', 'false')
    await expect.poll(() => cinna.page.evaluate(() => window.api.agents.listColors())).toEqual([])
    await expectPlainGlyph(typeIcon(agentRow(cinna, COLORED)))

    await sidebarTab(cinna, 'Chats').click()
    await expect(chatRow(cinna, COLORED_CHAT)).toBeVisible()
    await expect(cinna.page.locator('[data-agent-color-dot]')).toHaveCount(0)
  })
})
