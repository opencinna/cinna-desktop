import { test, expect } from '../fixtures/app'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'

test('agent sidebar opens chat first and settings returns to the same agent composer', async ({ cinna }, testInfo) => {
  await cinna.skipOnboarding()
  const root = await addAgentRoot(cinna)
  const agent = await createFolderAgent(cinna, root, 'Landing agent')
  const page = cinna.page
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await page.getByRole('button', { name: 'Landing agent', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Landing agent', level: 1 })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Landing agent', level: 1 }).getByTitle('Local CLI agent')).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Type a message...', exact: true })).toBeVisible()
  await expect(page.getByRole('tablist', { name: 'Agent details' })).toHaveCount(0)
  await expect(page.getByRole('group', { name: 'Runtime summary' })).toBeVisible()
  await expect(page.getByLabel('Runs on', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Remove agent Landing agent' })).toBeVisible()
  await page.getByRole('combobox', { name: 'Type a message...', exact: true }).fill('A draft to keep while changing settings')
  await page.getByRole('status', { name: 'Local agent connection' }).focus()
  await expect(page.getByRole('tooltip')).toContainText('This computer')
  await expect(page.getByRole('tooltip')).toContainText(agent.path)
  await expect(page.getByRole('tooltip').getByRole('group', { name: 'Runtime summary' })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('agent-chat.png') })
  await page.getByRole('combobox', { name: 'Type a message...', exact: true }).hover()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('tablist', { name: 'Agent details' })).toBeVisible()
  await expect(page.getByLabel('Runs on', { exact: true })).toBeVisible()
  await expect(page.getByRole('group', { name: 'Runtime summary' })).toHaveCount(0)
  await expect(page.getByRole('combobox', { name: 'Type a message...', exact: true })).not.toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('agent-settings.png') })
  await page.getByRole('button', { name: 'Start chat', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Type a message...', exact: true })).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Type a message...', exact: true })).toHaveValue('A draft to keep while changing settings')
  // Entering the agent page and changing modes must not create an empty chat.
  const chats = await page.evaluate(() => window.api.chat.list())
  expect(chats.some((chat) => chat.agentId === agent.id)).toBe(false)
})


test('A2A agents use the same chat-first page and structured settings', async ({ cinna }, testInfo) => {
  await cinna.skipOnboarding()
  const page = cinna.page
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await page.getByRole('button', { name: 'Add an agent', exact: true }).click()
  await page.getByRole('button', { name: /^Advanced options/ }).click()
  await page.getByRole('dialog', { name: 'Advanced options', exact: true }).locator('[data-settled="true"]').waitFor()
  await page.getByRole('button', { name: /A2A agent.*Agent Card URL/ }).click()
  await page.getByLabel('Agent Card URL', { exact: true }).fill('https://agent.example.com')
  await page.getByRole('button', { name: 'Save Agent', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Add A2A Agent' })).toBeHidden()
  await page.getByRole('button', { name: /^A2A Agent/ }).click()
  await expect(page.getByRole('heading', { name: 'A2A Agent', level: 1 })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Remove agent A2A Agent' })).toBeVisible()
  await page.getByRole('combobox', { name: 'Type a message...', exact: true }).fill('Keep this external-agent draft')
  await page.getByRole('status', { name: 'Remote agent connection' }).focus()
  await expect(page.getByRole('tooltip')).toContainText('A2A')
  await expect(page.getByRole('tooltip')).toContainText('agent.example.com')
  await page.screenshot({ path: testInfo.outputPath('a2a-connection-tooltip.png') })
  await page.keyboard.press('Escape')
  await expect(page.getByRole('tooltip')).toHaveCount(0)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'About this agent' })).toBeVisible()
  await page.getByRole('tab', { name: 'Connection' }).click()
  await expect(page.getByRole('button', { name: 'Test Connection', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Connection details' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Authentication' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'A2A Agent', level: 1 }).getByTitle('A2A agent')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('a2a-settings.png') })
  await page.getByRole('button', { name: 'More actions', exact: true }).click()
  await page.screenshot({ path: testInfo.outputPath('a2a-actions.png') })
  await expect(page.getByRole('menuitem', { name: 'Disable in Desktop App' })).toHaveCount(0)
  await page.getByRole('menuitem', { name: 'Delete agent…' }).click()
  await expect(page.getByRole('dialog', { name: 'Delete agent' })).toBeVisible()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.getByRole('button', { name: 'Start chat', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Type a message...', exact: true })).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Type a message...', exact: true })).toHaveValue('Keep this external-agent draft')
  expect(await page.evaluate(() => window.api.chat.list())).toEqual([])
  await page.getByRole('button', { name: 'More actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Delete agent…' }).click()
  await page.getByRole('dialog', { name: 'Delete agent' }).getByRole('button', { name: 'Delete agent', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'A2A Agent', level: 1 })).toHaveCount(0)
  await expect.poll(async () => (await page.evaluate(() => window.api.agents.list())).some((agent) => agent.name === 'A2A Agent')).toBe(false)
})


test('dark sidebar uses secondary text for unselected external agents and primary text for selection', async ({ cinna }, testInfo) => {
  await cinna.skipOnboarding()
  await cinna.page.evaluate(async () => {
    for (const name of ['Remote color one', 'Remote color two']) {
      const result = await window.api.agents.upsert({ name, protocol: 'a2a', cardUrl: 'http://127.0.0.1:1/agent-card.json' })
      if (!result.success) throw new Error(result.error)
    }
  })
  await cinna.relaunch()
  await cinna.skipOnboarding()
  const page = cinna.page
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  const first = page.getByRole('button', { name: 'Remote color one', exact: true })
  const second = page.getByRole('button', { name: 'Remote color two', exact: true })
  const firstLabel = first.getByText('Remote color one', { exact: true })
  const secondLabel = second.getByText('Remote color two', { exact: true })
  // Resolve the tokens through the browser so this covers actual inherited text
  // color, not merely the presence of the class that should have supplied it.
  const colors = await page.evaluate(() => {
    const probe = document.createElement('span')
    document.body.append(probe)
    probe.style.color = 'var(--color-text)'
    const primary = getComputedStyle(probe).color
    probe.style.color = 'var(--color-text-secondary)'
    const secondary = getComputedStyle(probe).color
    probe.remove()
    return { primary, secondary }
  })
  expect(colors.primary).not.toBe(colors.secondary)
  await expect(firstLabel).toHaveCSS('color', colors.secondary)
  await expect(secondLabel).toHaveCSS('color', colors.secondary)
  await first.click()
  await expect(firstLabel).toHaveCSS('color', colors.primary)
  await expect(secondLabel).toHaveCSS('color', colors.secondary)
  await second.click()
  await expect(firstLabel).toHaveCSS('color', colors.secondary)
  await expect(secondLabel).toHaveCSS('color', colors.primary)
  await page.screenshot({ path: testInfo.outputPath('external-agent-selection-dark.png') })
})
