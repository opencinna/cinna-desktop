import { mkdirSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Locator } from '@playwright/test'
import { test, expect, homeDir, type CinnaApp } from '../fixtures/app'
import { scriptAcpEngine, SCRIPT_MODEL, type ScriptAcpEngine } from '../fixtures/scriptAcpEngine'
import {
  HANDOVERS_DIR,
  HANDOVER_BRIEF_FILE,
  HANDOVER_GATE_OPTIONS,
  HANDOVER_REPORT_FILE
} from '../../src/shared/handovers'

/**
 * File handovers — a `brief.md` dropped into a project folder becomes work the
 * desktop asks about, runs, and closes from the `report.md` that comes back
 * (`drafts/file_handovers` §3.2–§3.9).
 *
 * ## What is real here and what is scripted
 *
 * The **files** are the contract, so every arrangement in this spec is a real
 * write into a real adopted folder: no handover IPC exists for seeding one, and
 * there deliberately is none — the feature's whole claim is that anything able
 * to write a file can ask for work. The desktop's reaction is then the real one
 * end to end: the folder watcher, the intake, the Inbox gate, a real
 * `taskExecutionService` turn against the scripted ACP agent
 * (`e2e/fixtures/scriptAcpAgent.mjs`, the same engine `script-runtime.spec.ts`
 * drives), and the task page reading the row back over `handover:for-task`.
 *
 * The one half that is **played by the test** is the executor's file writing:
 * the scripted agent answers with text and cannot touch the disk, so the spec
 * writes `report.md` (and the artifact it names) while the agent's prompt is
 * held. That is honest rather than a shortcut — §3.9 says the desktop must pick
 * a report up whatever wrote it, and the fourth test is exactly that claim with
 * nothing of Cinna's running at all.
 *
 * ## What it does not prove
 *
 * No model and no real agent are involved, so nothing here says an agent
 * *understands* a brief; the witness is that the brief's body reached the
 * agent's prompt. `execution: auto`, the depth cap, the `blocked` return and
 * the agent card's Handovers select are not covered.
 */

const HANDOVER_ID = '20260917-1200-add-retry'
const TITLE = 'Add a retry to the uploader'
/** In the brief body, so the executor's prompt can be proved to carry it. */
const BRIEF_MARKER = 'quartz-5723'
/**
 * Short on purpose: `SystemTurnBlock` caps its header at 80 characters, and
 * `Handover \`<id>\` finished: <summary>` is 79 with this one — so the row's
 * accessible name can be asserted whole rather than against an ellipsis.
 */
const SUMMARY = 'Retry added to the upload client.'
const ARTIFACT = 'RETRY.md'

/** Everything under `dir`, relative and sorted — the "nothing else was written" witness. */
function treeOf(dir: string): string[] {
  return readdirSync(dir, { recursive: true }).map(String).sort()
}

/** Write via a temp file and a rename, as every writer of this contract must (§3.2). */
function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, path)
}

/** A folder that is one bare agent: `CLAUDE.md` is its instructions. */
function writeProject(cinna: CinnaApp, name: string, heading: string): string {
  const dir = homeDir(cinna, name)
  writeFileSync(join(dir, 'CLAUDE.md'), `# ${heading}\n\nYou own this project.\n`)
  writeFileSync(join(dir, 'README.md'), `# ${heading}\n`)
  return dir
}

function handoverDir(folder: string, id = HANDOVER_ID): string {
  const dir = join(folder, HANDOVERS_DIR, id)
  mkdirSync(dir, { recursive: true })
  return dir
}

function writeBrief(
  folder: string,
  options: { origin?: { agentId: string; chatId: string }; id?: string } = {}
): void {
  const dir = handoverDir(folder, options.id)
  const origin = options.origin
    ? ['origin:', `  agent: ${options.origin.agentId}`, `  chat: ${options.origin.chatId}`]
    : []
  atomicWrite(
    join(dir, HANDOVER_BRIEF_FILE),
    [
      '---',
      'cinna_handover: 1',
      `title: ${TITLE}`,
      'status: ready',
      'execution: ask',
      ...origin,
      'depth: 1',
      '---',
      '',
      `Add a retry with exponential backoff to the upload client. Reference ${BRIEF_MARKER}.`,
      ''
    ].join('\n')
  )
}

function writeReport(
  folder: string,
  options: { status: string; artifacts?: string[]; id?: string }
): void {
  const dir = handoverDir(folder, options.id)
  const artifacts = (options.artifacts ?? []).flatMap((path) => [`- ${path}`])
  atomicWrite(
    join(dir, HANDOVER_REPORT_FILE),
    [
      '---',
      'cinna_handover: 1',
      `status: ${options.status}`,
      `summary: ${SUMMARY}`,
      ...(artifacts.length > 0 ? ['artifacts:', ...artifacts] : []),
      '---',
      '',
      'The client now retries three times with exponential backoff.',
      ''
    ].join('\n')
  )
}

/**
 * Adopt `dir` over the same `folder-pick` → `folder-add` pair the dialog uses,
 * with the OS picker stubbed at it (`bare-agent.spec.ts`). The adopt flow
 * itself is that spec's subject; here it is arrangement.
 */
async function adoptFolder(cinna: CinnaApp, dir: string): Promise<string> {
  await cinna.stubDirectoryPicker(dir)
  const pick = await cinna.page.evaluate(() => window.api.localAgents.folderPick())
  if (pick.cancelled) throw new Error('the stubbed directory picker reported cancelled')
  if (pick.refusal !== null) throw new Error(`the folder was refused: ${pick.refusal}`)
  const added = await cinna.page.evaluate(
    (input) => window.api.localAgents.folderAdd(input),
    { path: pick.path, relPaths: pick.found.map((entry) => entry.relPath) }
  )
  if (!added.ok) throw new Error(`folder-add refused: ${added.message}`)
  const agents = await cinna.page.evaluate(() => window.api.localAgents.list())
  const real = realpathSync(dir)
  const agent = agents.agents.find((row) => row.path !== null && realpathSync(row.path) === real)
  if (!agent) throw new Error(`no agent row for ${dir}`)
  return agent.id
}

/**
 * Onboarding, the scripted engine, and the one credential a folder agent's
 * launcher needs before it will spawn anything at all.
 */
async function arrange(cinna: CinnaApp, fake: ScriptAcpEngine): Promise<void> {
  await cinna.skipOnboarding()
  await fake.install(cinna)
  await cinna.page.evaluate(
    async ({ host, model }) => {
      await window.api.settings.set('autoChatTitles', false)
      const provider = await window.api.providers.upsert({
        type: 'ollama',
        name: 'Handover fixture',
        baseUrl: host,
        enabled: true
      })
      await window.api.chatModes.upsert({
        name: 'Default',
        providerId: provider.id,
        modelId: model,
        isDefault: true
      })
    },
    { host: fake.host, model: SCRIPT_MODEL }
  )
}

async function openInbox(cinna: CinnaApp): Promise<void> {
  await cinna.page.getByRole('button', { name: /^Inbox/ }).click()
  await expect(cinna.page.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible()
}

/** The gate card for `folder`, once the scan has found the brief. */
function gateCard(cinna: CinnaApp, folder: string): Locator {
  return cinna.page
    .getByRole('article')
    .filter({ hasText: `Run the handover “${TITLE}” in ${basename(folder)}?` })
}

/** The value beside a `Details` label on the task page. */
function detailValue(cinna: CinnaApp, label: string): Locator {
  return cinna.page
    .getByRole('complementary', { name: 'Details' })
    .locator('dt')
    .filter({ hasText: new RegExp(`^${label}$`) })
    .locator('xpath=following-sibling::dd[1]')
}

function section(cinna: CinnaApp, heading: string): Locator {
  return cinna.page
    .locator('section')
    .filter({ has: cinna.page.getByRole('heading', { level: 2, name: heading, exact: true }) })
}

/** Open the gate's question modal and press one of its options, then send. */
async function answerGate(cinna: CinnaApp, card: Locator, option: string): Promise<void> {
  await card.getByRole('button', { name: 'Answer', exact: true }).click()
  const modal = cinna.page.getByLabel('Question', { exact: true })
  await expect(modal).toBeVisible()
  await expect(modal.getByText(`Run the handover “${TITLE}” in`)).toBeVisible()
  // All three, because the folder is not a git repository at all — which is one
  // of the two states in which the standing permission may even be offered.
  for (const label of Object.values(HANDOVER_GATE_OPTIONS)) {
    await expect(modal.getByRole('button', { name: label, exact: true })).toBeVisible()
  }
  await modal.getByRole('button', { name: option, exact: true }).click()
  await modal.getByRole('button', { name: 'Send answer', exact: true }).click()
  await expect(modal).toHaveCount(0)
}

async function taskOf(cinna: CinnaApp, taskId: string): Promise<unknown> {
  return cinna.page.evaluate((id) => window.api.tasks.get(id), taskId)
}

/** The one Inbox entry this spec's brief produced, once the scan has run. */
async function awaitGateEntry(cinna: CinnaApp): Promise<{ requestId: string; taskId: string }> {
  await expect
    .poll(
      async () => {
        const list = await cinna.page.evaluate(() => window.api.inbox.list())
        return list.entries.filter((entry) => entry.deliveryOwner === 'handover').length
      },
      { message: 'the folder watcher records the brief and opens a gate', timeout: 90_000 }
    )
    .toBe(1)
  const entries = await cinna.page.evaluate(async () => (await window.api.inbox.list()).entries)
  const gate = entries.find((entry) => entry.deliveryOwner === 'handover')!
  expect(gate.requestId).toMatch(/^handover:/)
  return { requestId: gate.requestId, taskId: gate.taskId }
}

test.describe('file handovers', () => {
  let fake: ScriptAcpEngine

  test.beforeEach(async () => {
    fake = await scriptAcpEngine()
  })

  test.afterEach(async () => {
    await fake.close()
  })

  test('a brief becomes a gate, Run starts the agent, and report.md completes the task', async ({
    cinna
  }) => {
    test.setTimeout(180_000)
    await arrange(cinna, fake)
    const folder = writeProject(cinna, 'parcel-uploader', 'Parcel Uploader')
    await adoptFolder(cinna, folder)
    const before = treeOf(folder)

    await openInbox(cinna)
    writeBrief(folder)
    const { taskId } = await awaitGateEntry(cinna)

    const card = gateCard(cinna, folder)
    await expect(card).toBeVisible()
    await expect(card).toContainText(TITLE)

    await test.step('Run sends the brief to the folder agent', async () => {
      await answerGate(cinna, card, HANDOVER_GATE_OPTIONS.run)
      await expect
        .poll(() => fake.calls.length, { message: 'the executor was prompted', timeout: 60_000 })
        .toBe(1)
      // The brief's body is what travelled — a fake that answers a constant
      // would prove a turn happened and nothing about what was handed over.
      expect(fake.calls[0].text).toContain(BRIEF_MARKER)
      expect(realpathSync(fake.calls[0].cwd)).toBe(realpathSync(folder))
      await expect.poll(() => taskOf(cinna, taskId)).toMatchObject({ status: 'in_progress' })
    })

    await test.step('the report closes the task, whoever wrote it', async () => {
      // The executor's half: the scripted agent answers text and cannot write
      // files, so the spec writes what it would have written.
      writeFileSync(join(folder, ARTIFACT), '# Retry\n\nExponential backoff.\n')
      writeReport(folder, { status: 'done', artifacts: [ARTIFACT] })
      fake.calls[0].release('Done — the retry is in.')
      await expect
        .poll(() => taskOf(cinna, taskId), { timeout: 60_000 })
        .toMatchObject({ status: 'completed' })
    })

    await test.step('the task page reads the handover back', async () => {
      await card.getByRole('button', { name: 'Open the task', exact: true }).click()
      await expect(cinna.page.getByRole('heading', { level: 1 })).toHaveText(TITLE)
      // Lower case in the DOM: the capitals on the pill are CSS.
      await expect(detailValue(cinna, 'Status')).toHaveText('completed')
      await expect(detailValue(cinna, 'Handover')).toHaveText('Done')
      await expect(detailValue(cinna, 'Requested by')).toHaveText('Outside the app')
      // One line, the handover id intact; the whole path is on hover.
      await expect(detailValue(cinna, 'Folder')).toHaveText(HANDOVER_ID)
      await expect(
        detailValue(cinna, 'Folder').getByTitle(join(folder, HANDOVERS_DIR, HANDOVER_ID))
      ).toBeVisible()
      await expect(section(cinna, 'Handoff note')).toContainText(SUMMARY)
      const artifacts = section(cinna, 'Artifacts')
      await expect(artifacts.getByRole('listitem')).toHaveText([ARTIFACT])
      await expect(artifacts.getByTitle(join(folder, ARTIFACT))).toBeVisible()
    })

    await test.step('the folder holds the handover files and nothing of Cinna’s', async () => {
      const added = treeOf(folder).filter((path) => !before.includes(path))
      expect(added).toEqual(
        [
          '.cinna',
          '.cinna/handovers',
          `.cinna/handovers/${HANDOVER_ID}`,
          `.cinna/handovers/${HANDOVER_ID}/${HANDOVER_BRIEF_FILE}`,
          `.cinna/handovers/${HANDOVER_ID}/${HANDOVER_REPORT_FILE}`,
          ARTIFACT
        ].sort()
      )
    })
  })

  test('Skip cancels the task and leaves the folder alone', async ({ cinna }) => {
    test.setTimeout(180_000)
    await arrange(cinna, fake)
    const folder = writeProject(cinna, 'ledger-service', 'Ledger Service')
    await adoptFolder(cinna, folder)

    await openInbox(cinna)
    writeBrief(folder)
    const { taskId } = await awaitGateEntry(cinna)

    const card = gateCard(cinna, folder)
    await answerGate(cinna, card, HANDOVER_GATE_OPTIONS.skip)

    await expect.poll(() => taskOf(cinna, taskId), { timeout: 30_000 }).toMatchObject({
      status: 'cancelled'
    })
    // Nothing was started: Skip is a decision, not a deferral.
    expect(fake.calls).toEqual([])

    await card.getByRole('button', { name: 'Open the task', exact: true }).click()
    await expect(cinna.page.getByRole('heading', { level: 1 })).toHaveText(TITLE)
    await expect(detailValue(cinna, 'Status')).toHaveText('cancelled')
    await expect(detailValue(cinna, 'Handover')).toHaveText('Skipped')
  })

  test('a report written outside the app claims the brief: no gate, no executor', async ({
    cinna
  }) => {
    test.setTimeout(180_000)
    await arrange(cinna, fake)
    const folder = writeProject(cinna, 'billing-service', 'Billing Service')
    await adoptFolder(cinna, folder)

    await openInbox(cinna)
    // The claim first, then the brief: whichever scan wins, the desktop must
    // never find a brief without the `in_progress` report beside it (§3.9).
    writeReport(folder, { status: 'in_progress' })
    writeBrief(folder)

    const taskId = await test.step('the task is recorded as already running', async () => {
      await expect
        .poll(
          async () => {
            const tasks = await cinna.page.evaluate(() => window.api.tasks.list({}))
            return tasks.filter((task) => task.title === TITLE).map((task) => task.status)
          },
          { message: 'the brief is taken in', timeout: 90_000 }
        )
        .toEqual(['in_progress'])
      const tasks = await cinna.page.evaluate(() => window.api.tasks.list({}))
      return tasks.find((task) => task.title === TITLE)!.id
    })

    // No card, and nothing spawned: the claim is what stands between a terminal
    // executor and a second one on the same brief.
    expect(await cinna.page.evaluate(async () => (await window.api.inbox.list()).entries)).toEqual(
      []
    )
    await expect(cinna.page.getByRole('article')).toHaveCount(0)
    expect(fake.calls).toEqual([])

    await cinna.page
      .getByRole('region', { name: 'Recent tasks', exact: true })
      .getByRole('button', { name: TITLE })
      .click()
    await expect(cinna.page.getByRole('heading', { level: 1 })).toHaveText(TITLE)
    await expect(detailValue(cinna, 'Status')).toHaveText('in progress')
    await expect(detailValue(cinna, 'Handover')).toHaveText('Outside the app')
    expect(taskId).toMatch(/.+/)
  })

  test('a finished handover is reported back into the chat that asked for it', async ({
    cinna
  }) => {
    test.setTimeout(180_000)
    await arrange(cinna, fake)
    const manager = writeProject(cinna, 'delivery-manager', 'Delivery Manager')
    const worker = writeProject(cinna, 'shipping-service', 'Shipping Service')
    const managerId = await adoptFolder(cinna, manager)
    await adoptFolder(cinna, worker)

    const chatId = await cinna.page.evaluate(async (agentId) => {
      const chat = await window.api.chat.create()
      await window.api.chat.update(chat.id, {
        agentId,
        router: 'direct',
        title: 'Delivery coordination'
      })
      return chat.id
    }, managerId)

    // A chat created over IPC is as stale to the sidebar as an agent is; the
    // restart is arrangement, not part of what is under test.
    await cinna.relaunch()
    await cinna.skipOnboarding()
    await cinna.page.evaluate(() => window.api.localAgents.rescan())

    await openInbox(cinna)
    writeBrief(worker, { origin: { agentId: managerId, chatId } })
    const { taskId } = await awaitGateEntry(cinna)

    const card = gateCard(cinna, worker)
    await answerGate(cinna, card, HANDOVER_GATE_OPTIONS.run)
    await expect
      .poll(() => fake.calls.length, { message: 'the executor was prompted', timeout: 60_000 })
      .toBe(1)

    writeFileSync(join(worker, ARTIFACT), '# Retry\n\nExponential backoff.\n')
    writeReport(worker, { status: 'done', artifacts: [ARTIFACT] })
    fake.calls[0].release('Done — the retry is in.')
    await expect
      .poll(() => taskOf(cinna, taskId), { timeout: 60_000 })
      .toMatchObject({ status: 'completed' })

    await test.step('the manager is prompted with the packet', async () => {
      await expect
        .poll(() => fake.calls.length, { message: 'the origin chat got a turn', timeout: 90_000 })
        .toBe(2)
      expect(fake.calls[1].text).toContain(`Handover \`${HANDOVER_ID}\` finished`)
      expect(fake.calls[1].text).toContain(SUMMARY)
      fake.calls[1].release('Noted.')
    })

    await test.step('the chat shows it as a desktop row, collapsed', async () => {
      await cinna.page.getByRole('button', { name: 'Chats', exact: true }).click()
      await cinna.page.getByText('Delivery coordination', { exact: true }).first().click()
      const row = cinna.page.getByRole('button', {
        name: `Cinna Desktop · Handover \`${HANDOVER_ID}\` finished: ${SUMMARY}`,
        exact: true
      })
      await expect(row).toBeVisible({ timeout: 30_000 })
      await expect(row).toHaveAttribute('aria-expanded', 'false')
      await row.click()
      // Not exact: the packet's `Project:` and `Task:` lines are one Markdown
      // paragraph, so the rendered node holds both.
      await expect(cinna.page.getByText(`Project: ${worker}`)).toBeVisible()
    })
  })
})
