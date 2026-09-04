import { test, expect, type CinnaApp } from '../fixtures/app'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'

/**
 * Section D of `plans/manual-test-session2.md`: the surfaces Phase 7c lit up
 * for folder agents that were never confirmed live. None of these needs a
 * model — D2, which does, lives in `live.spec.ts`.
 */

const PROMPTS = ['dad-joke: Tell me a dad joke about invoices.', 'Summarise the newest invoice.']

async function seedAgentWithPrompts(cinna: CinnaApp): Promise<string> {
  const root = await addAgentRoot(cinna)
  const agent = await createFolderAgent(cinna, root, 'Invoice Reader')
  const outcome = await cinna.page.evaluate(
    async ({ agentId, prompts }) => {
      const got = await window.api.localAgents.get(agentId)
      if (!got.ok) throw new Error(`get failed: ${got.message}`)
      const expectedStamp = got.value.stamps['cinna-agent.json']
      if (!expectedStamp) throw new Error('the manifest has no stamp')
      return window.api.localAgents.updateField({
        agentId,
        update: { field: 'example_prompts', value: prompts },
        expectedStamp
      })
    },
    { agentId: agent.id, prompts: PROMPTS }
  )
  expect(outcome.ok, 'example prompts saved to the manifest').toBe(true)
  // The composer's agent list is a query with a stale window that nothing
  // invalidates on a folder change; a restart is the honest way to refresh.
  await cinna.relaunch()
  await cinna.skipOnboarding()
  return agent.name
}

test('D1 # lists the folder agent’s example prompts once it is attached', async ({ cinna }) => {
  await cinna.skipOnboarding()
  const name = await seedAgentWithPrompts(cinna)
  const { page } = cinna
  const input = page.getByPlaceholder('Type a message...')

  await input.fill('@')
  const mentions = page.getByRole('listbox', { name: 'Agents and MCP servers' })
  await expect(mentions).toBeVisible()
  const row = mentions.getByRole('option').filter({ hasText: name })
  await expect(row).toContainText('LOCAL-FOLDER')
  await row.click()

  await input.fill('#')
  const prompts = page.getByRole('listbox', { name: 'Example prompts' })
  await expect(prompts).toBeVisible()
  await expect(prompts.getByRole('option')).toHaveCount(PROMPTS.length)
  await expect(prompts.getByRole('option').first()).toContainText('dad-joke')
  await prompts.getByRole('option').first().click()
  await expect(input).toHaveValue('Tell me a dad joke about invoices.')
})

test('D3 the job agent picker groups a folder agent under Local with the LOCAL-FOLDER tag', async ({
  cinna
}) => {
  await cinna.skipOnboarding()
  const root = await addAgentRoot(cinna)
  const agent = await createFolderAgent(cinna, root, 'Invoice Reader')
  await cinna.page.evaluate(() =>
    window.api.jobs.create({ type: 'local', title: 'Pick me', prompt: 'Read the invoices.' })
  )
  // The picker reads the same agent query as the composer; seeded over IPC,
  // the agent is not in it until the renderer starts again.
  await cinna.relaunch()
  await cinna.skipOnboarding()
  const { page } = cinna
  await page.getByRole('button', { name: 'Jobs', exact: true }).click()
  await page.getByText('Pick me', { exact: true }).click()
  await page.getByRole('button', { name: 'Edit job' }).click()
  await page.getByRole('button', { name: 'Add', exact: true }).click()

  const dialog = page.getByRole('dialog', { name: 'Agents & Connectors' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('Local', { exact: true })).toBeVisible()
  const card = dialog.getByRole('button').filter({ hasText: agent.name })
  await expect(card).toBeVisible()
  await expect(card).toContainText('LOCAL-FOLDER')
})

test('D4 the status overlay and the tray panel open on an empty profile without error', async ({
  cinna
}) => {
  await cinna.skipOnboarding()
  const { page, electronApp } = cinna

  await page.getByRole('button', { name: 'Agent status' }).click()
  await expect(page.getByText('No agents have reported status yet.')).toBeVisible()
  await expect(page.getByRole('button', { name: /^Refresh all/ })).toBeVisible()
  await page.getByRole('button', { name: 'Close' }).click()
  await expect(page.getByText('No agents have reported status yet.')).toBeHidden()

  const tray = electronApp.windows().find((w) => w.url().endsWith('trayPanel.html'))
  expect(tray, 'the tray panel window exists at startup').toBeTruthy()
  await expect(tray!.locator('body')).toContainText('No agents have reported status yet.')
  await expect(tray!.getByRole('button')).toHaveCount(0)
})
