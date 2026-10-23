import { createServer, type Server } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Locator, Page } from '@playwright/test'
import type { FakeAcpScript } from '../../src/main/agents/drivers/acp/testSupport/fakeAcp'
import { answerAgentsFolder, test, expect, type CinnaApp } from '../fixtures/app'
import { installFakeAcpEngine } from '../fixtures/fakeAcpEngine'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'

/**
 * The Run Script window's parameters: a click on a command naming the
 * agent's own argparse script opens the window with a form read from the
 * script's source.
 *
 * ## What is real and what is not
 *
 * The agent is the scriptable fake ACP agent, answering one turn with an
 * inline `python3 scripts/report.py italy --year 2026`. The script is a
 * synthetic argparse script written into the folder agent's folder, which
 * prints the arguments it was given. Everything after that is the product:
 * `userCommands:inspect` reading the script in main (never running it), the
 * shared parser, the store holding the window until the spec answers, the
 * form ↔ line sync, `userCommands:run` and the real `$SHELL -c` child.
 *
 * ## What it proves
 *
 * - The click opens the window with a Parameters sidebar pre-filled from the
 *   command (Scope `italy`, Year `2026`), the script's summary as the
 *   terminal's idle hint, and the writing switch Apply last.
 * - Ticking Apply rewrites the line, keeping its start verbatim; Run runs it,
 *   and the script echoes `italy --year 2026 --apply`. A screenshot is
 *   attached as `run-script-params`.
 *
 * ## What it does not
 *
 * - The parser's shapes and refusals, the sync's edge cases, the 150 ms open
 *   timing, the hand-edited state and Choose… (a native dialog) —
 *   `scriptSpec.test.ts`, `scriptArgs.test.ts`, `runScript.store.test.ts`,
 *   `RunScriptModal.test.tsx`, `userCommandService.test.ts` and
 *   `user_commands.ipc.test.ts` cover those.
 */

const AGENT = 'Ledger Helper'
const MODEL = 'qwen3:8b'
const COMMAND = 'python3 scripts/report.py italy --year 2026'

const REPORT_PY = `"""Report the ledger for a scope.

Prints what it was asked to report.
"""
import argparse
import sys

parser = argparse.ArgumentParser()
parser.add_argument("scope", help="Which scope to report")
parser.add_argument("--year", type=int, default=2025, help="Fiscal year")
parser.add_argument("--basis", choices=["month", "week"], default="month")
parser.add_argument("--apply", action="store_true", help="Write the corrections")
args = parser.parse_args()
print("ARGS " + " ".join(sys.argv[1:]))
`

const REPLY = `Run \`${COMMAND}\` to see the report.`

const ANSWERS: FakeAcpScript = {
  newSession: { sessionId: 'ses_e2e_run_script_params' },
  prompt: {
    emit: [{ kind: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: REPLY } } }]
  }
}

function fakeOllama(): Server {
  return createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/api/tags') {
      res.end(JSON.stringify({ models: [{ name: MODEL, model: MODEL, details: { family: 'qwen3', parameter_size: '8.2B' } }] }))
      return
    }
    if (req.url === '/api/version') {
      res.end(JSON.stringify({ version: '0.6.2' }))
      return
    }
    res.statusCode = 404
    res.end('{}')
  })
}

let server: Server
let ollamaHost = ''

test.beforeAll(async () => {
  server = fakeOllama()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  ollamaHost = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

async function arrange(cinna: CinnaApp): Promise<void> {
  await cinna.skipOnboarding()
  await installFakeAcpEngine(cinna, ANSWERS)
  await cinna.page.evaluate(
    async ({ host, model }) => {
      const { id } = await window.api.providers.upsert({ type: 'ollama', name: 'Ollama', baseUrl: host, enabled: true })
      await window.api.chatModes.upsert({ name: 'Default', providerId: id, modelId: model, isDefault: true })
    },
    { host: ollamaHost, model: MODEL }
  )
  const root = await addAgentRoot(cinna)
  const agent = await createFolderAgent(cinna, root, AGENT, AGENT)
  mkdirSync(join(agent.path, 'scripts'), { recursive: true })
  writeFileSync(join(agent.path, 'scripts', 'report.py'), REPORT_PY)

  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())

  const page = cinna.page
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await answerAgentsFolder(cinna)
  await page.getByRole('button', { name: `Start a new chat with ${AGENT}` }).click()
  const input = page.getByRole('combobox', { name: 'Type a message...', exact: true })
  await input.fill('How do I see the report?')
  await input.press('Enter')
  await expect(inlineCode(page)).toBeVisible({ timeout: 30_000 })
}

function inlineCode(page: Page): Locator {
  return page.locator('[data-message-id] code').filter({ hasText: COMMAND })
}

function runWindow(page: Page): Locator {
  return page.getByRole('dialog', { name: /^Run / })
}

test('a click on an argparse script opens the form pre-filled; a switch rewrites the line and the run echoes it', async ({ cinna }, testInfo) => {
  test.setTimeout(120_000)
  await arrange(cinna)
  const page = cinna.page

  await inlineCode(page).click()
  const card = runWindow(page)
  await expect(card).toHaveAccessibleName('Run report.py')
  const form = card.getByRole('complementary', { name: 'Parameters', exact: true })
  await expect(form).toBeVisible()
  await expect(form.getByLabel(/^Scope/)).toHaveValue('italy')
  await expect(form.getByLabel('Year', { exact: true })).toHaveValue('2026')
  await expect(form.getByRole('button', { name: 'month', exact: true })).toHaveAttribute('aria-pressed', 'false')
  const apply = form.getByRole('switch', { name: 'Apply', exact: true })
  await expect(apply).toHaveAttribute('aria-checked', 'false')
  const terminal = card.getByTestId('command-output-terminal').locator('.xterm-rows')
  await expect(terminal).toContainText('Report the ledger for a scope.')

  await apply.click()
  await expect(apply).toHaveAttribute('aria-checked', 'true')
  const line = card.getByRole('textbox', { name: 'Command', exact: true })
  await expect(line).toHaveValue(`${COMMAND} --apply`)
  await expect.poll(() => card.evaluate((element) => element.getAnimations().length)).toBe(0)
  const shot = testInfo.outputPath('run-script-params.png')
  await page.screenshot({ path: shot })
  await testInfo.attach('run-script-params', { path: shot, contentType: 'image/png' })

  await card.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(terminal).toContainText('ARGS italy --year 2026 --apply')
  await expect(card.locator('[data-slot="state"]')).toContainText('Completed')
  // The form reads, and does not edit, while the line is not the user's to change.
  await expect(form.getByLabel(/^Scope/)).toHaveValue('italy')
})
