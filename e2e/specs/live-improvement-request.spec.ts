import { existsSync, readFileSync } from 'node:fs'
import { expect } from '../fixtures/app'
import { coreCall, makeTeamTest, type PersonApp, type TeamFixtureBase } from '../fixtures/liveTeamSharing'

/**
 * Improvement request against the **real** local cinna-core, with one real
 * cloud turn (`ImprovementRequestDialog.tsx`, `improvementRequestService.ts`).
 *
 * Setup: `e2e/fixtures/live-improvement.py create` (see its docstring): A
 * publishes the cloud agent `Improve e2e <tag>` as a bundle, B installs it (a
 * consumer install), both environments on `opencode/openai` with the `.env`
 * OpenAI key. `CINNA_IMPROVEMENT_LIVE_FIXTURE` points at the JSON it printed;
 * without it every test skips.
 *
 * Billing: one short model turn per test, run by core's environment
 * (OpenCode's default fast OpenAI model), well under a cent each.
 *
 * What it proves: B's desktop, signed in with real desktop tokens, syncs the
 * install as a bundle agent, chats with it once through core, and the
 * composer's Improvement request reaches core: the pre-flight names A as the
 * recipient, the create lands on A's publisher agent, addressed to A, with B's
 * comment, the session the desktop chatted in and B's memory consent. And the
 * publisher's own install (a bundle agent whose `is_publisher_install` is
 * true) never offers it.
 *
 * What it does not prove: what A sees in core's web UI, the archive download,
 * or the rate limits (the scripted `improvement-request.spec.ts` covers the
 * 429 path against a fake).
 */

interface ImprovementFixture extends TeamFixtureBase {
  cloud: {
    name: string
    publisherAgentId: string
    installId: string
    installEnvId: string
    installSdk: string
    bundleId: string
    bundleUuid: string
  }
}

const fixturePath = (process.env.CINNA_IMPROVEMENT_LIVE_FIXTURE ?? '').trim()

function improvementFixture(): ImprovementFixture | null {
  if (!fixturePath || !existsSync(fixturePath)) return null
  const raw = JSON.parse(readFileSync(fixturePath, 'utf8')) as Omit<ImprovementFixture, 'people'> & {
    people: Record<'a' | 'b', TeamFixtureBase['people']['a']>
  }
  // The team fixture's shape names a third person; this one has two, and C is never opened.
  return { ...raw, people: { ...raw.people, c: raw.people.b } }
}

const test = makeTeamTest(
  improvementFixture,
  'Set CINNA_IMPROVEMENT_LIVE_FIXTURE to the JSON printed by e2e/fixtures/live-improvement.py create (a running local cinna-core)'
)

const PROMPT = 'What is 17 plus 25? Reply with the number only.'
const ANSWER = '42'

/** The product's own sync writes the remote row; a restart lets every store read it. */
async function syncCloudAgent(app: PersonApp, name: string): Promise<{ id: string; metadata: unknown }> {
  const synced = await app.page.evaluate(() => window.api.agents.syncRemote())
  expect(synced).toMatchObject({ success: true })
  const row = (await app.page.evaluate(() => window.api.agents.list())).find((a) => a.name === name)
  expect(row, `${name} was not synced into ${app.label}'s desktop`).toMatchObject({ source: 'remote', remoteTargetType: 'agent' })
  await app.relaunch()
  return { id: row!.id, metadata: row!.remoteMetadata }
}

/** Agent page → composer → the one real turn; answers the chat id once the reply is in and the turn is over. */
async function oneTurn(app: PersonApp, name: string): Promise<string> {
  const page = app.page
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await page.getByRole('button', { name, exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(name)
  const input = page.getByRole('combobox', { name: 'Type a message...', exact: true })
  await input.fill(PROMPT)
  await input.press('Enter')
  let chatId: string | null = null
  await expect
    .poll(
      async () => {
        const found = await page.evaluate(async (first) => {
          for (const row of await window.api.chat.list()) {
            const chat = await window.api.chat.get(row.id)
            if (chat?.messages.find((m) => m.role === 'user')?.content !== first) continue
            const reply = chat.messages.filter((m) => m.role === 'assistant').map((m) => m.content).join('\n')
            return { id: row.id, reply, running: !!chat.activeRunId }
          }
          return null
        }, PROMPT)
        if (!found) return 'no chat yet'
        chatId = found.id
        if (found.running) return 'turn still running'
        return found.reply
      },
      { timeout: 240_000, intervals: [2_000], message: 'the cloud agent never finished its reply' }
    )
    .toContain(ANSWER)
  // The composer is idle again: the placeholder of a running turn is gone.
  await expect(input).toBeVisible()
  return chatId!
}

test('B’s consumer install: one real turn, then Improvement request reaches A on core with the comment, the session and memory consent', async ({ team }) => {
  test.setTimeout(480_000)
  const { fixture } = team
  const { a: publisher, b: consumer } = fixture.people
  const { cloud } = fixture
  const b = await team.open('b')

  await test.step('sync: the install arrives as a bundle consumer install', async () => {
    const { metadata } = await syncCloudAgent(b, cloud.name)
    expect(metadata).toMatchObject({ bundle_uuid: cloud.bundleUuid, is_publisher_install: false })
  })

  const chatId = await test.step('one real turn through core', () => oneTurn(b, cloud.name))
  const session = await b.page.evaluate((id) => window.api.agents.getSession(id), chatId)
  expect(session?.taskId, 'the desktop kept no core session id for the chat').toMatch(/^[0-9a-f-]{36}$/)
  const sessionId = session!.taskId!

  const dialog = b.page.getByRole('dialog', { name: 'Improvement request', exact: true })
  await test.step('[+] → Actions → Improvement request…: core’s pre-flight names A, the callout says it cannot be undone', async () => {
    await b.page.getByRole('button', { name: 'Add to chat', exact: true }).click()
    const menu = b.page.getByRole('menu', { name: 'Add to chat', exact: true })
    await menu.getByRole('menuitem', { name: 'Actions', exact: true }).click()
    await menu.getByRole('menuitem', { name: 'Improvement request…', exact: true }).click()
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('combobox', { name: 'Agent session' })).toHaveCount(0)
    await expect(dialog.locator('[data-improvement-agent]')).toHaveText(new RegExp(`^${cloud.name} · `))
    const disclosure = dialog.locator('[data-improvement-context]')
    await expect(disclosure).toContainText(`Goes to ${publisher.name}, who publishes the bundle this agent was installed from.`, { timeout: 30_000 })
    await expect(disclosure).toContainText(/\d+ messages will be captured as they are right now\./)
    await expect(dialog.locator('[data-improvement-external]')).toHaveText(
      `Shared outside your account — bundle ${cloud.bundleId}, version 1.0. This cannot be undone.`
    )
    await b.page.screenshot({ path: test.info().outputPath('improvement-dialog.png') })
  })

  const comment = `Answer in words, not digits (e2e ${fixture.tag} run ${Date.now().toString(36)}).`
  await test.step('Send needs a message; memory stays ticked; Send → the toast names A, the dialog closes', async () => {
    const send = dialog.getByRole('button', { name: 'Send request', exact: true })
    await expect(send).toBeDisabled()
    await dialog.getByLabel('Message', { exact: true }).fill(comment)
    await expect(dialog.getByRole('checkbox', { name: 'Include MEMORY files of this agent' })).toBeChecked()
    await expect(send).toBeEnabled()
    await send.click()
    await expect(dialog).toHaveCount(0, { timeout: 60_000 })
    await expect(b.page.getByRole('status').filter({ hasText: 'Improvement request sent to' })).toHaveText(
      `Improvement request sent to ${publisher.name}.`
    )
  })

  await test.step('core: one request on A’s publisher agent, from B to A, with the comment, the session and memory consent', async () => {
    const listed = await coreCall(fixture, publisher.token, `/agents/${cloud.publisherAgentId}/improvement-requests`)
    expect(listed.status).toBe(200)
    // A rerun on the same fixture finds the earlier run's request too: this run's carries its own comment.
    const rows = ((listed.body?.data ?? []) as any[]).filter((r) => r.comment === comment)
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row).toMatchObject({
      session_id: sessionId,
      target_agent_id: cloud.publisherAgentId,
      source_agent_id: cloud.installId,
      requester_email: consumer.email,
      bundle_id: cloud.bundleId,
      is_bundle_install: true,
      comment,
      status: 'new'
    })
    // The prompt and the reply at least, frozen at send time.
    expect(row.snapshot_message_count).toBeGreaterThanOrEqual(2)
    // Addressed to A: the listing is the recipient's only — B, who sent it, is told the agent does not exist.
    expect((await coreCall(fixture, consumer.token, `/agents/${cloud.publisherAgentId}/improvement-requests`)).status).toBe(404)
    const detail = await coreCall(fixture, publisher.token, `/improvement-requests/${row.id}`)
    expect(detail.status).toBe(200)
    // Ticked means consent: core read the memory folder (or found it empty); it did not record a refusal.
    expect(detail.body?.context?.memory?.unavailable_reason ?? null).not.toBe('declined_by_requester')
    // B sees it among their own.
    const mine = await coreCall(fixture, consumer.token, '/improvement-requests/mine')
    expect(((mine.body?.data ?? []) as any[]).map((r) => r.id)).toContain(row.id)
  })
})

test('A’s own publisher install, after a real turn, offers no Actions', async ({ team }) => {
  test.setTimeout(420_000)
  const { fixture } = team
  const a = await team.open('a')
  const { metadata } = await syncCloudAgent(a, fixture.cloud.name)
  expect(metadata).toMatchObject({ bundle_uuid: fixture.cloud.bundleUuid, is_publisher_install: true })
  const chatId = await test.step('one real turn through core', () => oneTurn(a, fixture.cloud.name))
  expect(await a.page.evaluate((id) => window.api.improvementRequests.targets(id), chatId)).toEqual([])
  await a.page.getByRole('button', { name: 'Add to chat', exact: true }).click()
  const menu = a.page.getByRole('menu', { name: 'Add to chat', exact: true })
  await expect(menu.getByRole('menuitem').first()).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Actions', exact: true })).toHaveCount(0)
})
