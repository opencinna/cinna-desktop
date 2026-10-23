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
 * - A click script and a typer script get their forms from their decorators
 *   and signature: a `--cache/--no-cache` option declared on shows one switch,
 *   on, and turning it off writes `--no-cache` (on again writes nothing); a
 *   typer `bool = False` turned on writes `--dry-run`. Neither is run: click
 *   and typer need not be installed where the suite runs.
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

const CLICK_COMMAND = 'python3 scripts/sync.py italy'
const SYNC_PY = `"""Sync the ledger for a scope."""
import click


@click.command()
@click.argument("scope")
@click.option("--year", type=int, default=2025, help="Fiscal year")
@click.option("--cache/--no-cache", default=True, help="Use the local cache")
def main(scope, year, cache):
    click.echo(f"ARGS {scope} {year} {cache}")


if __name__ == "__main__":
    main()
`

const TYPER_COMMAND = 'python3 scripts/tidy.py notes'
const TIDY_PY = `"""Tidy a folder of notes."""
import typer


def main(folder: str, keep: int = 3, dry_run: bool = False):
    print(folder, keep, dry_run)


if __name__ == "__main__":
    typer.run(main)
`

/** The script the agent's one reply names, and the file the folder holds. */
interface Scenario {
  command: string
  file: string
  source: string
}

const ARGPARSE: Scenario = { command: COMMAND, file: 'report.py', source: REPORT_PY }

function answers(command: string): FakeAcpScript {
  const reply = `Run \`${command}\` to see the report.`
  return {
    newSession: { sessionId: 'ses_e2e_run_script_params' },
    prompt: {
      emit: [{ kind: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } } }]
    }
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

async function arrange(cinna: CinnaApp, scenario: Scenario = ARGPARSE): Promise<void> {
  await cinna.skipOnboarding()
  await installFakeAcpEngine(cinna, answers(scenario.command))
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
  writeFileSync(join(agent.path, 'scripts', scenario.file), scenario.source)

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
  await expect(inlineCode(page, scenario.command)).toBeVisible({ timeout: 30_000 })
}

function inlineCode(page: Page, command = COMMAND): Locator {
  return page.locator('[data-message-id] code').filter({ hasText: command })
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

test('a click script: a --cache/--no-cache option declared on is one switch, on, and turning it off writes --no-cache', async ({ cinna }) => {
  test.setTimeout(120_000)
  await arrange(cinna, { command: CLICK_COMMAND, file: 'sync.py', source: SYNC_PY })
  const page = cinna.page

  await inlineCode(page, CLICK_COMMAND).click()
  const card = runWindow(page)
  await expect(card).toHaveAccessibleName('Run sync.py')
  const form = card.getByRole('complementary', { name: 'Parameters', exact: true })
  await expect(form.getByLabel(/^Scope/)).toHaveValue('italy')
  await expect(form.getByLabel('Year', { exact: true })).toHaveAttribute('placeholder', 'default: 2025')
  const cache = form.getByRole('switch', { name: 'Cache', exact: true })
  await expect(cache).toHaveAttribute('aria-checked', 'true')

  const line = card.getByRole('textbox', { name: 'Command', exact: true })
  await cache.click()
  await expect(cache).toHaveAttribute('aria-checked', 'false')
  await expect(line).toHaveValue(`${CLICK_COMMAND} --no-cache`)
  await cache.click()
  await expect(cache).toHaveAttribute('aria-checked', 'true')
  await expect(line).toHaveValue(CLICK_COMMAND)
})

test('a typer script: a bool parameter off by default is a switch that writes --dry-run', async ({ cinna }) => {
  test.setTimeout(120_000)
  await arrange(cinna, { command: TYPER_COMMAND, file: 'tidy.py', source: TIDY_PY })
  const page = cinna.page

  await inlineCode(page, TYPER_COMMAND).click()
  const card = runWindow(page)
  await expect(card).toHaveAccessibleName('Run tidy.py')
  const form = card.getByRole('complementary', { name: 'Parameters', exact: true })
  await expect(form.getByLabel(/^Folder/)).toHaveValue('notes')
  await expect(form.getByLabel('Keep', { exact: true })).toHaveAttribute('placeholder', 'default: 3')
  const dryRun = form.getByRole('switch', { name: 'Dry run', exact: true })
  await expect(dryRun).toHaveAttribute('aria-checked', 'false')

  const line = card.getByRole('textbox', { name: 'Command', exact: true })
  await dryRun.click()
  await expect(dryRun).toHaveAttribute('aria-checked', 'true')
  await expect(line).toHaveValue(`${TYPER_COMMAND} --dry-run`)
})
