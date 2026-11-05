import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { repoRoot } from '../playwright.config'
import { answerAgentsFolder, expect, test, type CinnaApp } from '../fixtures/app'
import { noticePanelSettled } from '../fixtures/noticePanel'
import { linkSandboxAccount } from '../fixtures/jobRemoteService'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'
import { scriptAcpEngine, SCRIPT_MODEL, type ScriptAcpEngine } from '../fixtures/scriptAcpEngine'
import { addRevision, fakeCatalogCore, fakeSkill, type FakeCatalogCore, type FakeSkill, type FakeTeamAgent } from '../fixtures/fakeCatalogSkills'

/**
 * Skill links: a catalog skill shared as `https://<core>/get/skill/<package_id>`
 * (or `cinna://skill/<package_id>?server=<core>`) raises an offer row in the
 * composer's notice panel, resolved against a fresh catalog listing, and the
 * row's Add pins the skill into the composer's kit agent.
 *
 * ## What is real and what is not
 *
 * Real: the composer's paste branch (`parseSkillLink` on the paste event's own
 * `text/plain`, never a clipboard read), the offer store and the row
 * (`SkillLinkNotice`), the deep-link funnel from argv (`deepLinkService` →
 * `skillLinkIntentService` → the renderer's pull), `skillLinkService.resolve`
 * (profile match, the fresh `GET /api/v1/catalog/items`, `changeability`, the
 * pin lookup), `catalogSkillService.addToAgent` / `update` (the download with
 * both digest checks, the read-only cache, the manifest write), the Addons tab
 * row and its Copy install link, and the new-agent flow with the pin queued.
 * Faked: cinna-core (`fakeCatalogSkills.ts`: discovery, the listing, the item
 * detail and the revision archive), the profile's sign-in (`linkSandboxAccount`
 * writes the tokens into the sandbox DB), the engine (`scriptAcpEngine`, which
 * never runs a turn here — it and the keyless Ollama mode only make the agent
 * ready, so the panel holds the offer alone), and main's `clipboard.writeText`,
 * replaced so Copy install link never touches the developer's clipboard.
 *
 * A use-only team agent is a kit folder whose `app-data/desktop.json` links it
 * (`shared_remote`, kind `cinna`) to a desktop agent the listing grants `use`:
 * the same link a Get writes, and the input `changeability` reads first.
 *
 * ## What it does not prove
 *
 * A real OS `open-url` (Playwright cannot raise it; the test argv enters the
 * same funnel). A link clicked in a transcript. `other_profile` (needs a second
 * signed-in Cinna profile). Core's own visibility rules. That an engine opens
 * the pinned skill (the live catalog-skill specs do).
 */

const AGENT = 'Ledger Clerk'
const TEAM_AGENT = 'Team Ledger'
const PACKAGE_ID = 'com.acme.invoice-reader'
const TITLE = 'Invoice Reader'
const PUBLISHER = 'Dana Fox'
const DESCRIPTION = 'Reads supplier invoices into ledger rows.'
const SHOTS = join(repoRoot, 'e2e', 'test-results', 'skill-link-shots')

/* -------------------------------------------------------------- helpers */

function newSkill(): FakeSkill {
  return fakeSkill({ packageId: PACKAGE_ID, name: 'invoice-reader', title: TITLE, description: DESCRIPTION, publisher: PUBLISHER })
}

const httpsLink = (core: FakeCatalogCore, packageId = PACKAGE_ID): string => `${core.host}/get/skill/${packageId}`

interface Arranged {
  agentId: string
  agentPath: string
  teamAgentId: string | null
}

/**
 * A ready kit agent (scripted engine, keyless Ollama default mode), optionally
 * a second one linked as a use-only team agent, the profile signed in to the
 * fake core, relaunched (with `relaunchArgs`) so the renderer has the account
 * and the agents.
 */
async function arrange(
  cinna: CinnaApp,
  engine: ScriptAcpEngine,
  core: FakeCatalogCore,
  options: { teamAgent?: FakeTeamAgent; relaunchArgs?: string[] } = {}
): Promise<Arranged> {
  await cinna.skipOnboarding()
  await engine.install(cinna)
  await cinna.page.evaluate(async ({ host, model }) => {
    await window.api.settings.set('autoChatTitles', false)
    const provider = await window.api.providers.upsert({ type: 'ollama', name: 'Skill link fixture', baseUrl: host, enabled: true })
    await window.api.chatModes.upsert({ name: 'Default', providerId: provider.id, modelId: model, isDefault: true })
  }, { host: engine.host, model: SCRIPT_MODEL })
  const root = await addAgentRoot(cinna)
  const agent = await createFolderAgent(cinna, root, AGENT, 'Keeps the ledger.')
  let teamAgentId: string | null = null
  if (options.teamAgent) {
    const team = await createFolderAgent(cinna, root, TEAM_AGENT, 'The team’s ledger agent.')
    teamAgentId = team.id
    const appData = join(team.path, 'app-data')
    mkdirSync(appData, { recursive: true })
    const file = join(appData, 'desktop.json')
    const state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
    state.shared_remote = {
      kind: 'cinna',
      repo_id: options.teamAgent.repoId,
      clone_url: `${core.host}/git/${options.teamAgent.repoId}.git`,
      bundle_id: options.teamAgent.bundleId
    }
    writeFileSync(file, JSON.stringify(state, null, 2))
  }
  await linkSandboxAccount(cinna, core.host)
  await cinna.relaunch(options.relaunchArgs ?? [])
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
  return { agentId: agent.id, agentPath: agent.path, teamAgentId }
}

/** Agents → `Start a new chat with <name>`: the start screen with that one agent picked. */
async function startChatWith(cinna: CinnaApp, name: string): Promise<void> {
  const page = cinna.page
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await answerAgentsFolder(cinna)
  await page.getByRole('button', { name: `Start a new chat with ${name}`, exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'What can I help with?' })).toBeVisible()
}

function composer(page: Page): Locator {
  return page.getByRole('combobox', { name: 'Type a message...', exact: true })
}

/**
 * A synthetic paste of `text` into the focused composer (a real ⌘V would read
 * the machine's clipboard). Answers whether the composer took it
 * (`defaultPrevented`); a paste it let through is inserted here, as the
 * browser's default action would.
 */
async function pasteText(page: Page, text: string): Promise<boolean> {
  const input = composer(page)
  await input.click()
  const prevented = await input.evaluate((target, value) => {
    const data = new DataTransfer()
    data.setData('text/plain', value)
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
    target.dispatchEvent(event)
    return event.defaultPrevented
  }, text)
  if (!prevented) await page.evaluate((value) => document.execCommand('insertText', false, value), text)
  return prevented
}

/** The composer's notice panel: "Skill link" while the offer is its only row, "Agent status" beside another. */
const panel = (page: Page): Locator => page.getByRole('status', { name: /^(Skill link|Agent status)$/ })

/** The skill-link row: the panel's one row with a Dismiss skill link ×. */
function offerRow(page: Page): Locator {
  return panel(page).getByRole('listitem').filter({ has: page.getByRole('button', { name: 'Dismiss skill link', exact: true }) })
}

/** The composer box (notice panel + message box), for a screenshot of the row in place. */
function composerArea(page: Page): Locator {
  return page.locator('div').filter({ has: panel(page) }).filter({ has: composer(page) }).last()
}

async function shot(page: Page, name: string, target?: Locator): Promise<void> {
  mkdirSync(SHOTS, { recursive: true })
  const path = join(SHOTS, `${name}.png`)
  if (target) await target.screenshot({ path, animations: 'disabled' })
  else await page.screenshot({ path, animations: 'disabled' })
}

/** The row alone in both themes. The attribute is what the CSS variables follow; put back afterwards. */
async function themeShots(page: Page, prefix: string): Promise<void> {
  const before = await page.evaluate(() => document.documentElement.getAttribute('data-theme'))
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((value) => document.documentElement.setAttribute('data-theme', value), theme)
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await shot(page, `${prefix}-${theme}`, composerArea(page))
  }
  await page.evaluate((value) => {
    if (value) document.documentElement.setAttribute('data-theme', value)
  }, before)
}

function catalogPins(agentPath: string): Array<Record<string, unknown>> {
  const manifest = JSON.parse(readFileSync(join(agentPath, 'cinna-agent.json'), 'utf8')) as Record<string, unknown>
  return (manifest.catalog_skills ?? []) as Array<Record<string, unknown>>
}

/** Agents → the agent → Settings → Addons, and its Addons section. */
async function openAddons(cinna: CinnaApp, name: string): Promise<Locator> {
  const page = cinna.page
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await page.getByRole('button', { name, exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(name)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('tablist', { name: 'Agent details' }).getByRole('tab', { name: /^Addons/ }).click()
  return page
    .getByRole('tabpanel')
    .locator('section')
    .filter({ has: page.getByRole('heading', { level: 2, name: 'Addons', exact: true }) })
}

/* ---------------------------------------------------------------- tests */

let core: FakeCatalogCore
let engine: ScriptAcpEngine
let skill: FakeSkill
const teamAgent: FakeTeamAgent = {
  uuid: randomUUID(),
  bundleId: 'com.acme.team-ledger',
  repoId: 'repo-team-ledger',
  slug: 'team-ledger',
  title: TEAM_AGENT,
  access: 'use'
}

test.beforeEach(async () => {
  skill = newSkill()
  core = await fakeCatalogCore([skill], [teamAgent])
  engine = await scriptAcpEngine()
})

test.afterEach(async () => {
  await core.close()
  await engine.close()
})

test('S1 a pasted https link on the start screen offers the skill, and Add puts it on the picked agent', async ({ cinna }) => {
  test.setTimeout(120_000)
  const { agentPath } = await arrange(cinna, engine, core)
  const page = cinna.page
  await startChatWith(cinna, AGENT)
  const row = offerRow(page)
  const okText = `${TITLE} · Version 1 (1.0.0) · by ${PUBLISHER} on ${core.hostLabel}`

  await test.step('while the fresh listing is held, the row says what it is looking up', async () => {
    core.holdListing(true)
    const reads = core.listingReads()
    expect(await pasteText(page, httpsLink(core))).toBe(true)
    await expect(composer(page)).toHaveValue('')
    // The note follows the sentence on its one line.
    await expect(row.getByRole('paragraph')).toHaveText(`Looking up ${PACKAGE_ID} on ${core.hostLabel}… Nothing is added until you choose.`)
    await expect(row.getByText('Nothing is added until you choose.', { exact: true })).toBeVisible()
    await expect(row.getByRole('button', { name: /^Add to/ })).toHaveCount(0)
    // The lookup reads the listing again rather than answering from the cache.
    await expect.poll(() => core.listingReads()).toBeGreaterThan(reads)
    await shot(page, 'pending', composerArea(page))
  })

  await test.step('the answer names the title, the version and the publisher; the panel is an offer, not a warning', async () => {
    core.holdListing(false)
    core.releaseListings()
    await expect(row.getByRole('paragraph')).toHaveText(okText)
    await expect(row.getByRole('paragraph')).toHaveAttribute('title', okText)
    const add = row.getByRole('button', { name: `Add to ${AGENT}`, exact: true })
    await expect(add).toBeEnabled()
    await expect(row.getByRole('button', { name: 'New agent with this skill', exact: true })).toBeEnabled()
    await expect(panel(page)).toHaveAttribute('data-tone', 'accent')
    await expect(panel(page).getByRole('listitem')).toHaveCount(1)
    await shot(page, 'ok', composerArea(page))
    await themeShots(page, 'ok-row')
  })

  await test.step('Details shows the description', async () => {
    const details = row.getByRole('button', { name: 'Details', exact: true })
    await details.click()
    await expect(details).toHaveAttribute('aria-expanded', 'true')
    await expect(row.getByText(DESCRIPTION, { exact: true })).toBeVisible()
    await details.click()
    await expect(details).toHaveAttribute('aria-expanded', 'false')
  })

  await test.step('Add pins the latest version into the agent and the row goes away', async () => {
    await row.getByRole('button', { name: `Add to ${AGENT}`, exact: true }).click()
    await expect(row).toHaveCount(0)
    await expect.poll(() => catalogPins(agentPath).map((pin) => [pin.package_id, pin.name, pin.revision_number])).toEqual([
      [PACKAGE_ID, 'invoice-reader', 1]
    ])
    expect(core.requests).toContain(`GET /api/v1/skills/packages/${skill.uuid}/revisions/1/download`)
  })

  await test.step('the skill row shows on the agent’s Addons tab, and its Copy install link writes the same link', async () => {
    await cinna.electronApp.evaluate(({ clipboard }) => {
      const copied: string[] = []
      ;(globalThis as unknown as { __skillLinkCopied: string[] }).__skillLinkCopied = copied
      clipboard.writeText = (text: string) => {
        copied.push(text)
      }
    })
    const section = await openAddons(cinna, AGENT)
    const skillRow = section.locator('[data-skill-row="invoice-reader"]')
    await expect(skillRow).toHaveAttribute('data-skill-source', 'catalog')
    await expect(skillRow).toContainText(TITLE)
    await expect(skillRow).toContainText('Version 1 (1.0.0)')
    await expect(skillRow).toContainText('From the catalog')
    await skillRow.getByRole('button', { name: `Copy install link for ${TITLE}`, exact: true }).click()
    await expect
      .poll(() => cinna.electronApp.evaluate(() => (globalThis as unknown as { __skillLinkCopied: string[] }).__skillLinkCopied))
      .toEqual([httpsLink(core)])
  })

  await test.step('the same link again says it is already there; a newer version offers Update, which moves the pin', async () => {
    await startChatWith(cinna, AGENT)
    expect(await pasteText(page, httpsLink(core))).toBe(true)
    await expect(row.getByRole('paragraph')).toHaveText(`${TITLE} is already on ${AGENT} (Version 1)`)
    await expect(row.getByRole('button', { name: /^Update to/ })).toHaveCount(0)
    await expect(row.getByRole('button', { name: /^Add to/ })).toHaveCount(0)
    await row.getByRole('button', { name: 'Dismiss skill link', exact: true }).click()
    await expect(row).toHaveCount(0)

    addRevision(skill, '1.1.0')
    expect(await pasteText(page, httpsLink(core))).toBe(true)
    const update = row.getByRole('button', { name: 'Update to Version 2', exact: true })
    await expect(update).toBeEnabled()
    await update.click()
    await expect(row).toHaveCount(0)
    await expect.poll(() => catalogPins(agentPath).map((pin) => [pin.name, pin.revision_number, pin.version])).toEqual([
      ['invoice-reader', 2, '1.1.0']
    ])
  })
})

test('S1b the row keeps its height when the lookup answers', async ({ cinna }) => {
  // ux_rules rule 1: the row's one line (held by a zero-width NoticeButton
  // strut, ComposerNoticePanel) is one button tall in every state, so the row
  // does not grow when Add / New agent appear at its end.
  await arrange(cinna, engine, core)
  const page = cinna.page
  await startChatWith(cinna, AGENT)
  const row = offerRow(page)
  core.holdListing(true)
  expect(await pasteText(page, httpsLink(core))).toBe(true)
  await expect(row.getByText('Nothing is added until you choose.', { exact: true })).toBeVisible()
  await noticePanelSettled(row)
  const pending = (await row.boundingBox())!.height
  core.holdListing(false)
  core.releaseListings()
  await expect(row.getByRole('button', { name: `Add to ${AGENT}`, exact: true })).toBeEnabled()
  await noticePanelSettled(row)
  const answered = (await row.boundingBox())!.height
  // Sub-pixel layout rounding differs between frames; a jump is a whole line.
  expect(answered).toBeCloseTo(pending, 1)
  // The actions sit at the end of the sentence's line, not on a line under it: their middles align.
  const middle = (box: { y: number; height: number } | null): number => box!.y + box!.height / 2
  const sentence = await row.getByRole('paragraph').boundingBox()
  const add = await row.getByRole('button', { name: `Add to ${AGENT}`, exact: true }).boundingBox()
  expect(Math.abs(middle(add) - middle(sentence))).toBeLessThan(2)
  expect(add!.x).toBeGreaterThan(sentence!.x + sentence!.width - 1)
  // One line: no taller than the button plus the row's padding.
  expect(answered).toBeLessThan(add!.height + 20)
})

test('S2 a cinna://skill deep link from argv raises the offer on the start screen', async ({ cinna }) => {
  test.setTimeout(90_000)
  // The server is known only once the fake listens, so the link rides on the relaunch.
  await arrange(cinna, engine, core, {
    relaunchArgs: [`--cinna-connect-intent=cinna://skill/${PACKAGE_ID}?server=${encodeURIComponent(core.host)}`]
  })
  const page = cinna.page
  const row = offerRow(page)
  // No agent is picked on the start screen a launch opens: Add asks for one, New agent stays.
  // The reason stands after the title in place of the facts, which stay in the tooltip.
  await expect(row.getByRole('paragraph')).toHaveText(`${TITLE} · Pick one agent to add it to, or make a new one.`)
  await expect(row.getByRole('paragraph')).toHaveAttribute('title', new RegExp(`Version 1 \\(1\\.0\\.0\\) · by ${PUBLISHER}`))
  const add = row.getByRole('button', { name: 'Add to agent', exact: true })
  await expect(add).toBeDisabled()
  await expect(add).toHaveAttribute('title', 'Pick one agent to add it to, or make a new one.')
  await expect(row.getByText('Pick one agent to add it to, or make a new one.', { exact: true })).toBeVisible()
  await expect(row.getByRole('button', { name: 'New agent with this skill', exact: true })).toBeEnabled()
  // The skill link went to its own slot, not to the connect confirm step.
  expect(await page.evaluate(() => window.api.connect.getPending())).toBeNull()
  await expect(page.getByText(/^Connect to .*\?$/)).toHaveCount(0)
  await shot(page, 'deep-link-no-agent', composerArea(page))
})

test('S3 a link the listing does not have says so and offers nothing; other servers and an unreachable one say what to do', async ({ cinna }) => {
  test.setTimeout(120_000)
  await arrange(cinna, engine, core)
  const page = cinna.page
  await startChatWith(cinna, AGENT)
  const row = offerRow(page)

  await test.step('no_access: a package the listing does not hold', async () => {
    expect(await pasteText(page, httpsLink(core, 'com.acme.not-shared-with-you'))).toBe(true)
    await expect(row.getByRole('paragraph')).toHaveText(`You don’t have access to this skill on ${core.hostLabel}. Ask whoever shared it.`)
    await expect(row.getByText('Ask whoever shared it.', { exact: true })).toBeVisible()
    // The row's only button is its ×.
    await expect(row.getByRole('button')).toHaveCount(1)
    await expect(row.getByRole('button', { name: /^Add to/ })).toHaveCount(0)
    await expect(row.getByRole('button', { name: 'New agent with this skill', exact: true })).toHaveCount(0)
    await shot(page, 'no-access', composerArea(page))
  })

  await test.step('not_connected: a server this machine has no profile for', async () => {
    expect(await pasteText(page, `https://other.example.test/get/skill/${PACKAGE_ID}`)).toBe(true)
    await expect(row.getByRole('paragraph')).toHaveText('This skill is on other.example.test. Connect to it first.')
    // Not clicked: it opens the connect confirm step, whose Connect opens a real browser.
    await expect(row.getByRole('button', { name: 'Connect…', exact: true })).toBeVisible()
    await shot(page, 'not-connected', composerArea(page))
  })

  await test.step('offline: the listing does not answer; Try again once it does', async () => {
    core.dropListing(true)
    expect(await pasteText(page, httpsLink(core))).toBe(true)
    await expect(row.getByRole('paragraph')).toHaveText(`Couldn’t reach ${core.hostLabel} to look this skill up.`, { timeout: 30_000 })
    const retry = row.getByRole('button', { name: 'Try again', exact: true })
    await expect(retry).toBeVisible()
    await expect(row.getByRole('button', { name: /^Add to/ })).toHaveCount(0)
    await shot(page, 'offline', composerArea(page))
    core.dropListing(false)
    await retry.click()
    await expect(row.getByRole('paragraph')).toHaveText(`${TITLE} · Version 1 (1.0.0) · by ${PUBLISHER} on ${core.hostLabel}`)
    await expect(row.getByRole('button', { name: `Add to ${AGENT}`, exact: true })).toBeEnabled()
  })
})

test('S4 a use-only team agent cannot take the skill; New agent with this skill makes one that has it', async ({ cinna }) => {
  test.setTimeout(120_000)
  await arrange(cinna, engine, core, { teamAgent })
  const page = cinna.page
  await startChatWith(cinna, TEAM_AGENT)
  const row = offerRow(page)
  const reason = `${TEAM_AGENT} is shared with you to use, so its skills can’t be changed here.`

  await test.step('Add is disabled with its reason; New agent with this skill is offered', async () => {
    expect(await pasteText(page, httpsLink(core))).toBe(true)
    await expect(row.getByRole('paragraph')).toHaveText(`${TITLE} · ${reason}`)
    const add = row.getByRole('button', { name: `Add to ${TEAM_AGENT}`, exact: true })
    await expect(add).toBeDisabled()
    await expect(add).toHaveAttribute('title', reason)
    await expect(row.getByText(reason, { exact: true })).toBeVisible()
    await expect(row.getByRole('button', { name: 'New agent with this skill', exact: true })).toBeEnabled()
    await shot(page, 'add-disabled', composerArea(page))
    // A press on the disabled Add installs nothing (aria-disabled: Playwright's click would refuse it).
    await add.dispatchEvent('click')
    await expect(add).toBeDisabled()
    expect(core.requests.some((line) => line.includes('/revisions/'))).toBe(false)
  })

  await test.step('New agent with this skill opens the new-agent flow named after the skill, and the agent it makes has the pin', async () => {
    await row.getByRole('button', { name: 'New agent with this skill', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: `New agent with ${TITLE}`, exact: true })
    await expect(dialog).toBeVisible()
    const name = dialog.getByLabel('Name', { exact: true })
    await expect(name).toHaveValue(TITLE)
    await name.press('Enter')
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(TITLE)
    await expect
      .poll(async () => {
        const list = await page.evaluate(() => window.api.localAgents.list())
        const created = list.agents.find((agent) => agent.name === TITLE)
        return created ? catalogPins(created.path).map((pin) => [pin.package_id, pin.revision_number]) : null
      })
      .toEqual([[PACKAGE_ID, 1]])
  })
})

test('S5 a link inside a sentence pastes as text and offers nothing', async ({ cinna }) => {
  await arrange(cinna, engine, core)
  const page = cinna.page
  await startChatWith(cinna, AGENT)
  // Nothing on the host clipboard may decide this paste (a Finder file copy would).
  await cinna.electronApp.evaluate(({ clipboard }) => {
    clipboard.read = () => ''
    clipboard.readBuffer = () => Buffer.alloc(0)
  })
  const sentence = `Try this skill: ${httpsLink(core)} — it reads invoices.`
  const reads = core.listingReads()
  expect(await pasteText(page, sentence)).toBe(false)
  await expect(composer(page)).toHaveValue(sentence)
  await expect(offerRow(page)).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Dismiss skill link', exact: true })).toHaveCount(0)
  expect(core.listingReads()).toBe(reads)
})
