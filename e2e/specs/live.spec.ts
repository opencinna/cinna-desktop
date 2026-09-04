import { test, expect, type CinnaApp } from '../fixtures/app'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'
import type { Page } from '@playwright/test'
import { OPENAI_API_KEY, requireLiveKey } from '../fixtures/live'

/**
 * @live — needs OPENAI_API_KEY in `.env`. Skipped otherwise.
 *
 * These are the only specs that leave the machine. Keep each to one short
 * model turn: the point is that the key path works end to end, not the answer.
 */

test.beforeEach(() => requireLiveKey())

const NOT_READY = /^Can't send message — no agent, chat mode, or AI credentials are configured/

/**
 * Send on the new-chat screen. For the first moment after launch the composer
 * accepts input before the renderer's model list has loaded, and a send in
 * that window is refused with "no chat mode configured" (the text is dropped).
 * No user types that fast; a test does, so retry that one refusal.
 */
async function sendFirstMessage(page: Page, text: string): Promise<void> {
  const input = page.getByPlaceholder('Type a message...')
  await expect(page.getByRole('button', { name: 'Add to chat' })).toBeVisible()
  await expect
    .poll(
      async () => {
        await input.fill(text)
        await input.press('Enter')
        const alert = page.getByRole('alert')
        await page.waitForTimeout(300)
        const refused = (await alert.count()) > 0 && NOT_READY.test(await alert.innerText())
        return refused ? 'not ready' : 'sent'
      },
      { timeout: 10_000, intervals: [500, 1000, 2000] }
    )
    .toBe('sent')
  await expect(page.getByRole('alert')).toHaveCount(0)
}

test('@live onboarding accepts a real key through the API key screen', async ({ cinna }) => {
  const { page } = cinna
  await page.getByRole('button', { name: /^API key/ }).click()
  await page.getByRole('button', { name: /^OpenAI/ }).click()
  await page.getByPlaceholder('Paste your API key').fill(OPENAI_API_KEY)
  await page.getByRole('button', { name: 'Test', exact: true }).click()
  await expect(page.getByText(/^Key valid — \d+ models available/)).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Save & start' }).click()
  await expect(page.getByRole('button', { name: 'Chats', exact: true })).toBeVisible()

  const providers = await page.evaluate(() => window.api.providers.list())
  expect(providers.map((p) => [p.type, p.hasApiKey])).toEqual([['openai', true]])
})

/**
 * A provider with the real key and a default chat mode on one of the models
 * the app lists for it — the state onboarding leaves behind, seeded over IPC.
 */
async function seedOpenAiDefaultMode(cinna: CinnaApp): Promise<string> {
  return cinna.page.evaluate(async (apiKey) => {
    const { id } = await window.api.providers.upsert({
      type: 'openai',
      name: 'OpenAI',
      apiKey,
      enabled: true
    })
    const tested = await window.api.providers.test(id)
    if (!tested.success) throw new Error(`provider test failed: ${tested.error}`)
    // The composer resolves a mode's model against the app's own list for the
    // provider, so the mode must name one of those — not one from the live probe.
    const listed = (await window.api.providers.listModels()).filter((m) => m.providerId === id)
    const model = listed.find((m) => m.id.includes('mini')) ?? listed[0]
    if (!model) throw new Error('the app lists no models for the provider')
    await window.api.chatModes.upsert({ name: 'Default', providerId: id, modelId: model.id, isDefault: true })
    return model.id
  }, OPENAI_API_KEY)
}

test('@live a plain chat gets an answer from the model', async ({ cinna }) => {
  await cinna.skipOnboarding()
  const modelId = await seedOpenAiDefaultMode(cinna)
  console.log(`live chat model: ${modelId}`)
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await sendFirstMessage(cinna.page, 'What is 12 times 12? Reply with the number only.')
  await expect(cinna.page.getByText('144')).toBeVisible({ timeout: 60_000 })
})

test.describe('with the engine', () => {
  test.use({ engine: true })

  const SECRET = 'PINEAPPLE'
  const AGENT = 'Invoice Reader'

  test('@live D2 a folder agent answers inside an orchestrated chat', async ({ cinna }) => {
    test.setTimeout(240_000)
    await cinna.skipOnboarding()
    await seedOpenAiDefaultMode(cinna)
    const root = await addAgentRoot(cinna)
    const agent = await createFolderAgent(cinna, root, AGENT, 'Knows the secret word.')

    // Give the agent one unmistakable behaviour, in the prompt documents the
    // engine assembles its system prompt from.
    for (const prompt of ['workflow', 'entrypoint'] as const) {
      const outcome = await cinna.page.evaluate(
        async ({ agentId, prompt, secret }) => {
          const doc = await window.api.localAgents.readDoc({ agentId, prompt })
          if (!doc.stamp) throw new Error(`${doc.relPath} does not exist`)
          return window.api.localAgents.updateField({
            agentId,
            update: {
              field: 'prompt',
              prompt,
              value: `You are the Invoice Reader. Your secret word is ${secret}. When asked for your secret word, reply with exactly that one word and nothing else.`
            },
            expectedStamp: doc.stamp
          })
        },
        { agentId: agent.id, prompt, secret: SECRET }
      )
      expect(outcome.ok, `${prompt} prompt saved`).toBe(true)
    }
    await cinna.relaunch()
    await cinna.skipOnboarding()

    await test.step('the engine resolves the managed binary and admits the agent', async () => {
      const state = await cinna.page.evaluate(() => window.api.engine.start())
      expect(state.error).toBeNull()
      expect(state.status).toBe('running')
      expect(state.binarySource).toBe('managed')
      const skips = await cinna.page.evaluate(() => window.api.engine.skips())
      expect(skips.agents.filter((s) => s.agentId === agent.id)).toEqual([])
    })

    await test.step('a plain model chat first', async () => {
      await sendFirstMessage(cinna.page, 'What is 12 times 12? Reply with the number only.')
      await expect(cinna.page.getByText('144')).toBeVisible({ timeout: 60_000 })
    })

    await test.step('attach the folder agent with @ and make the model call it', async () => {
      const input = cinna.page.getByPlaceholder('Type a message...')
      await input.fill('@')
      const mentions = cinna.page.getByRole('listbox', { name: 'Agents and MCP servers' })
      await mentions.getByRole('option').filter({ hasText: AGENT }).click()
      await expect(input).toHaveValue('')

      await input.fill(`Ask the ${AGENT} agent for its secret word and reply with only that word.`)
      await input.press('Enter')
      await expect(cinna.page.getByText(SECRET).first()).toBeVisible({ timeout: 150_000 })
    })
  })
})
