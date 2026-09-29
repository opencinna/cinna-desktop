import { test, expect, type CinnaApp } from '../fixtures/app'
import { scriptAcpEngine, type ScriptAcpEngine } from '../fixtures/scriptAcpEngine'

/**
 * Compact mode folds an agent turn's tool steps into a row of dots; hovering a
 * dot previews the step behind it (`CollapsibleGroup`'s `useDotPreview`).
 *
 * The agent is a command-line ACP agent running `scriptAcpAgent.mjs`, which
 * sends two Claude-shaped Bash calls: one that completes (a `tool` part and a
 * stdout `tool_result` sharing its `toolId`) and one that fails (its result is
 * a stderr `tool_result`). The real driver, translator, store and transcript
 * handle them; no model and no `claude`. The preview is asserted on the saved
 * turn, after the prompt has returned.
 */

const AGENT = 'Dot Worker'
const IDLE = 'Type a message...'
const PROMPT = 'Check the exports.'
const OK_CALL = 'toolu_e2e_ls'
const OK_COMMAND = 'ls exports'
const OK_OUTPUT = 'march.csv\napril.csv'
const FAIL_CALL = 'toolu_e2e_cat'
const FAIL_COMMAND = 'cat exports/may.csv'
const FAIL_OUTPUT = 'cat: exports/may.csv: No such file or directory'
const ANSWER = 'March and April are exported; May is missing.'

const composer = (cinna: CinnaApp) => cinna.page.getByRole('combobox', { name: IDLE, exact: true })

const bash = (toolCallId: string, command: string) => ({
  sessionUpdate: 'tool_call', toolCallId, status: 'pending', kind: 'execute', title: command,
  rawInput: { command, description: command }, _meta: { claudeCode: { toolName: 'Bash' } }
})
const bashEnd = (toolCallId: string, status: 'completed' | 'failed', text: string) => ({
  sessionUpdate: 'tool_call_update', toolCallId, status,
  content: [{ type: 'content', content: { type: 'text', text } }], _meta: { claudeCode: { toolName: 'Bash' } }
})

let fake: ScriptAcpEngine
test.beforeEach(async () => { fake = await scriptAcpEngine() })
test.afterEach(async () => {
  await fake.close()
  expect(fake.unexpected).toEqual([])
})

test('a dots group previews the step under the pointer, switches to the stderr step, and yields to Escape, the keyboard and expanding', async ({ cinna }) => {
  test.setTimeout(120_000)
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.settings.set('autoChatTitles', false))
  const saved = await cinna.page.evaluate(async ({ config, name }) => {
    const probe = await window.api.customAgents.test({ config })
    return window.api.customAgents.save({ name, config, testToken: probe.token })
  }, { config: fake.customConfig(cinna), name: AGENT })
  expect(saved.id).toBeTruthy()
  await cinna.relaunch()
  await cinna.skipOnboarding()

  await cinna.page.getByRole('button', { name: 'Agents', exact: true }).click()
  await cinna.page.getByRole('button', { name: AGENT, exact: true }).click()
  await composer(cinna).fill(PROMPT)
  await composer(cinna).press('Enter')
  await expect.poll(() => fake.calls.length, { timeout: 20_000 }).toBe(1)
  fake.calls[0].release({
    updates: [
      bash(OK_CALL, OK_COMMAND), bashEnd(OK_CALL, 'completed', OK_OUTPUT),
      bash(FAIL_CALL, FAIL_COMMAND), bashEnd(FAIL_CALL, 'failed', FAIL_OUTPUT)
    ],
    text: ANSWER
  })
  await expect(composer(cinna)).toBeVisible()
  await expect(cinna.page.getByRole('paragraph').filter({ hasText: ANSWER })).toHaveText(ANSWER)

  // Main's own record: call, stdout result, call, stderr result, paired by id.
  const [chat] = await cinna.page.evaluate(() => window.api.chat.list())
  const savedSteps = () => cinna.page.evaluate(async (id) => {
    const detail = await window.api.chat.get(id)
    const assistant = (detail?.messages ?? []).filter((m) => m.role === 'assistant')
    return assistant.flatMap((m) => (m.parts ?? []).flatMap((p, idx) =>
      p.kind === 'tool' || p.kind === 'tool_result'
        ? [{ step: `${p.kind}:${p.toolId}:${p.toolStream ?? ''}`, key: `${m.id}-${idx}` }]
        : []))
  }, chat.id)
  await expect.poll(() => savedSteps().then((steps) => steps.map((s) => s.step)), { timeout: 20_000 }).toEqual([
    `tool:${OK_CALL}:`, `tool_result:${OK_CALL}:stdout`, `tool:${FAIL_CALL}:`, `tool_result:${FAIL_CALL}:stderr`
  ])
  const keys = (await savedSteps()).map((s) => s.key)

  const header = cinna.page.locator('button[data-group-header]')
  await expect(header).toHaveCount(1)
  await expect(header).toHaveAccessibleName('Expand 4 steps')
  await expect(header).toHaveAttribute('aria-expanded', 'false')
  const dots = header.locator('[data-step-dot]')
  // The saved message's dots, not the stream's (`stream-tool-<i>`): a preview
  // open when the transcript swaps one for the other closes with its step.
  await expect.poll(() => dots.evaluateAll((els) => els.map((el) => el.getAttribute('data-step-dot'))), { timeout: 20_000 })
    .toEqual(keys)
  const tooltip = cinna.page.getByRole('tooltip')
  const marked = (): Promise<boolean[]> =>
    dots.evaluateAll((els) => els.map((el) => el.hasAttribute('data-previewed')))

  await test.step('hovering the call’s dot opens the preview after the open delay, marking the pair', async () => {
    await expect(tooltip).toHaveCount(0)
    const started = Date.now()
    await dots.nth(0).hover()
    await expect(tooltip).toBeVisible()
    expect(Date.now() - started).toBeGreaterThanOrEqual(300)
    await expect(tooltip).toHaveCount(1)
    await expect(cinna.page.locator('[role="tooltip"][data-dot-preview]')).toHaveCount(1)
    await expect(header).toHaveAttribute('aria-describedby', (await tooltip.getAttribute('id'))!)
    await expect(tooltip.getByText('Bash', { exact: true })).toBeVisible()
    await expect(tooltip.locator('pre')).toHaveText([OK_COMMAND, OK_OUTPUT])
    await expect(tooltip.getByText('Output', { exact: true })).toBeVisible()
    await expect(tooltip.getByText('stderr', { exact: true })).toHaveCount(0)
    await expect.poll(marked).toEqual([true, true, false, false])
  })

  await test.step('resting on the stderr step’s output dot switches the preview to that step', async () => {
    await dots.nth(3).hover()
    await expect(tooltip.locator('pre')).toHaveText([FAIL_COMMAND, FAIL_OUTPUT])
    await expect(tooltip.getByText('stderr', { exact: true })).toBeVisible()
    await expect(tooltip.getByText('Output', { exact: true })).toHaveCount(0)
    await expect(tooltip).toHaveCount(1)
    await expect.poll(marked).toEqual([false, false, true, true])
  })

  await test.step('Escape closes the preview', async () => {
    await cinna.page.keyboard.press('Escape')
    await expect(tooltip).toHaveCount(0)
    await expect.poll(marked).toEqual([false, false, false, false])
    await expect(header).not.toHaveAttribute('aria-describedby')
  })

  await test.step('ArrowRight on the focused header opens the preview for the first dot', async () => {
    // Off the dots first, so the pointer resting on one is not what opens it.
    await cinna.page.mouse.move(0, 0)
    await header.focus()
    await expect(header).toBeFocused()
    await expect(tooltip).toHaveCount(0)
    await header.press('ArrowRight')
    await expect(tooltip).toBeVisible()
    await expect(tooltip.locator('pre')).toHaveText([OK_COMMAND, OK_OUTPUT])
    await expect(tooltip.getByText('Output', { exact: true })).toBeVisible()
    await expect.poll(marked).toEqual([true, true, false, false])
  })

  await test.step('clicking the header expands the group and the preview goes', async () => {
    // On the header's padding, left of the chevron: not on a dot.
    await header.click({ position: { x: 3, y: 3 } })
    await expect(header).toHaveAttribute('aria-expanded', 'true')
    await expect(header).toHaveAccessibleName('Collapse 4 steps')
    await expect(tooltip).toHaveCount(0)
    await expect(cinna.page.locator('[data-dot-preview]')).toHaveCount(0)
    await expect.poll(marked).toEqual([false, false, false, false])
  })
})
