import { test, expect, type CinnaApp } from '../fixtures/app'
import { scriptAcpEngine, type ScriptAcpEngine } from '../fixtures/scriptAcpEngine'

/**
 * A user's own message keeps the line breaks they typed with Shift+Enter —
 * `remark-breaks` on the user bubble only — and Markdown in it still renders.
 *
 * The chat is with a command-line ACP agent running `scriptAcpAgent.mjs`, so no
 * credential or model is involved: the user bubble is the subject, and the
 * agent's prompt is the witness that the newline travelled as typed.
 */

const AGENT = 'Line Keeper'
const IDLE = 'Type a message...'

const composer = (cinna: CinnaApp) => cinna.page.getByRole('combobox', { name: IDLE, exact: true })
/** A transcript bubble (`MessageBubble`'s root) holding `text`. */
const bubble = (cinna: CinnaApp, text: string | RegExp) =>
  cinna.page.locator('div.relative.group').filter({ hasText: text }).last()

let fake: ScriptAcpEngine
test.beforeEach(async () => { fake = await scriptAcpEngine() })
test.afterEach(async () => {
  await fake.close()
  expect(fake.unexpected).toEqual([])
})

async function arrange(cinna: CinnaApp): Promise<void> {
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.settings.set('autoChatTitles', false))
  const saved = await cinna.page.evaluate(async ({ config, name }) => {
    const probe = await window.api.customAgents.test({ config })
    return window.api.customAgents.save({ name, config, testToken: probe.token })
  }, { config: fake.customConfig(cinna), name: AGENT })
  expect(saved.id).toBeTruthy()
  // Agents saved over IPC are invisible to the sidebar's query until a restart.
  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.getByRole('button', { name: 'Agents', exact: true }).click()
  await cinna.page.getByRole('button', { name: AGENT, exact: true }).click()
}

/** Type `lines` with Shift+Enter between them, send, and let the agent answer `reply`. */
async function sendLines(cinna: CinnaApp, lines: string[], reply: string): Promise<void> {
  const input = composer(cinna)
  const index = fake.calls.length
  await input.click()
  for (const [i, line] of lines.entries()) {
    if (i > 0) await input.press('Shift+Enter')
    await input.pressSequentially(line)
  }
  await expect(input).toHaveValue(lines.join('\n'))
  await input.press('Enter')
  await expect.poll(() => fake.calls.length, { timeout: 20_000 }).toBe(index + 1)
  expect(fake.calls[index].text).toBe(lines.join('\n'))
  fake.calls[index].release(reply)
  await expect(cinna.page.getByRole('paragraph').filter({ hasText: new RegExp(`^${reply}$`) })).toBeVisible()
  await expect(composer(cinna)).toBeVisible()
}

test('a two-line message keeps its line break, and a Markdown list in a message is still a list', async ({ cinna }) => {
  test.setTimeout(120_000)
  await arrange(cinna)

  await test.step('Shift+Enter between two lines: the bubble shows two lines', async () => {
    await sendLines(cinna, ['line one', 'line two'], 'Noted both lines.')
    const paragraph = bubble(cinna, 'line one').getByRole('paragraph')
    await expect(paragraph).toHaveCount(1)
    await expect(paragraph.locator('br')).toHaveCount(1)
    // innerText follows layout: a rendered break is a newline, a soft wrap a space.
    expect(await paragraph.evaluate((el) => (el as HTMLElement).innerText)).toBe('line one\nline two')
    // And two line boxes on screen, one per line.
    const lines = await paragraph.evaluate((el) => {
      const range = document.createRange()
      range.selectNodeContents(el)
      return new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top))).size
    })
    expect(lines).toBe(2)
  })

  await test.step('a Markdown list in a message still renders as a list', async () => {
    await sendLines(cinna, ['- apples', '- pears'], 'Two fruits.')
    const list = bubble(cinna, 'apples').getByRole('list')
    await expect(list).toHaveCount(1)
    await expect(list.getByRole('listitem')).toHaveText(['apples', 'pears'])
    await expect(bubble(cinna, 'apples').locator('br')).toHaveCount(0)
  })

  await test.step('reopened after a restart: the same', async () => {
    await cinna.relaunch()
    await cinna.skipOnboarding()
    await cinna.page.getByRole('button', { name: 'Chats', exact: true }).click()
    await cinna.page.getByText(/^line one/).first().click()
    const paragraph = bubble(cinna, 'line one').getByRole('paragraph')
    await expect(paragraph.locator('br')).toHaveCount(1)
    expect(await paragraph.evaluate((el) => (el as HTMLElement).innerText)).toBe('line one\nline two')
    await expect(bubble(cinna, 'apples').getByRole('list').getByRole('listitem')).toHaveText(['apples', 'pears'])
  })
})
