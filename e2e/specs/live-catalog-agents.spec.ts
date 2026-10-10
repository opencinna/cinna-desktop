import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  test,
  expect,
  buildAgent,
  expectSlotCheck,
  openCatalog,
  slotCheckLine,
  uniqueName
} from '../fixtures/liveCatalog'
import {
  catalogEntry,
  coreCall,
  finishDialog,
  finishWithWeather,
  findAgent,
  openAgent,
  shareWithTeam,
  type PersonApp
} from '../fixtures/liveTeamSharing'

/**
 * The catalog story (plan README §7), agents: A shares a desktop agent with
 * B; core lists it as a catalog bundle at Version 1; B's one catalog shows it
 * beside a cloud agent with each kind's badge; B Gets it, finishes setup with
 * the admin's credential connected without asking, and runs it; core counts
 * the install. Then the guards: A cannot delete it from the catalog while B
 * holds it, core refuses a version whose manifest id changed, and a cloud
 * install of a desktop agent is refused. No model runs.
 * Setup: `e2e/fixtures/live-catalog.py`.
 */

function section(app: PersonApp, title: string) {
  return app.page.locator('section').filter({ has: app.page.getByRole('heading', { level: 2, name: title, exact: true }) })
}

test('§7 1–3, 10: A shares report-bot, B sees one catalog, Gets it and runs it; the delete, identity and cloud guards hold', async ({ team }) => {
  test.setTimeout(420_000)
  const { fixture } = team
  const { a: personA, b: personB } = fixture.people
  const name = uniqueName(fixture, 'Report bot')

  const a = await team.open('a')
  const agent = await buildAgent(a, fixture, { name, slots: true })

  let bundleId = ''
  await test.step('1 A: Share with the team → B; core lists kind=agent, runs_on=desktop, a bundle id, Version 1', async () => {
    await shareWithTeam(a, name, [{ person: personB }])
    await expect.poll(async () => (await catalogEntry(fixture, personA.token, agent.slug))?.latest?.revision_number ?? null).toBe(1)
    const entry = await catalogEntry(fixture, personA.token, agent.slug)
    expect(entry.kind).toBe('agent')
    expect(entry.runs_on).toBe('desktop')
    expect(entry.id).toMatch(/^[a-z0-9.-]+\.[0-9a-f]{8}$/)
    expect(entry.desktop.manifest_id).toBe(agent.manifestId)
    bundleId = entry.id
    expect(JSON.parse(readFileSync(join(agent.path, 'app-data/desktop.json'), 'utf8')).shared_remote?.bundle_id).toBe(bundleId)
  })

  const b = await team.open('b')
  await test.step('2 B: one catalog — A’s agent reads Runs on your computer, Version 1; a cloud agent reads Runs in Cinna', async () => {
    const catalog = await openCatalog(b, 'All')
    const tile = catalog.getByRole('group', { name, exact: true })
    await expect(tile).toContainText('Runs on your computer')
    await expect(tile).toContainText('Version 1')
    await expect(tile).toContainText(`by ${personA.name}`)
    await expect(tile.getByRole('button', { name: 'Get', exact: true })).toBeVisible()
    if (fixture.cloudAgent) {
      const cloud = catalog.getByRole('group', { name: fixture.cloudAgent.display_name, exact: true })
      await expect(cloud).toContainText('Runs in Cinna')
      await expect(cloud).not.toContainText('Runs on your computer')
    } else {
      test.info().annotations.push({ type: 'not covered', description: 'no public cloud agent on this instance for the Runs in Cinna badge' })
    }
    await b.page.keyboard.press('Escape')
    await expect(catalog).toHaveCount(0)
  })

  await test.step('3 B: Get → Finish setting up (erp connected automatically) → runs with the admin’s ERP API', async () => {
    const catalog = await openCatalog(b, 'Agents')
    await catalog.getByRole('group', { name, exact: true }).getByRole('button', { name: 'Get', exact: true }).click()
    await expect(catalog).toHaveCount(0, { timeout: 60_000 })
    await expect(b.page.getByRole('heading', { level: 1 })).toHaveText(name)
    const { row } = finishDialog(b, name)
    await expect(row('erp').getByText('Connected automatically', { exact: true })).toBeVisible()
    await expect(row('erp').getByText(fixture.credentials.erp.name, { exact: true })).toBeVisible()
    await finishWithWeather(b, name, `weather-b-${fixture.tag}`)
    expect((await findAgent(b, name)).readiness).toBe('ok')
    await expectSlotCheck(b, name, slotCheckLine(fixture))
  })

  await test.step('3 core: B’s Get is a local install at Version 1; install_count 1', async () => {
    await expect
      .poll(async () => (((await catalogEntry(fixture, personB.token, agent.slug))?.my_installs ?? []) as any[]).map((r) => `${r.where}:${r.revision_number}`))
      .toEqual(['local:1'])
    expect((await catalogEntry(fixture, personA.token, agent.slug)).install_count).toBe(1)
  })

  await test.step('10 A: Remove sharing with delete is refused with core’s sentence while B holds it', async () => {
    await openAgent(a, name)
    await a.page.getByRole('button', { name: 'Settings', exact: true }).click()
    await a.page.getByRole('tablist', { name: 'Agent details' }).getByRole('tab', { name: 'Sharing', exact: true }).click()
    await section(a, 'Remove sharing').getByRole('button', { name: 'Remove sharing…', exact: true }).click()
    const dialog = a.page.getByRole('dialog', { name: 'Remove sharing' })
    await dialog.getByRole('checkbox', { name: 'Also delete it from the catalog — teammates can no longer get it' }).check()
    await dialog.getByRole('button', { name: 'Remove sharing', exact: true }).click()
    await expect(dialog.getByRole('alert')).toHaveText('1 person uses this. It can be removed once nobody does.', { timeout: 60_000 })
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    expect((await catalogEntry(fixture, personB.token, agent.slug))?.id).toBe(bundleId)
  })

  await test.step('10 core: a cloud install of the desktop agent is refused desktop_only', async () => {
    const install = await coreCall(fixture, personB.token, `/catalog/${bundleId}/install`, { method: 'POST', body: {} })
    expect(install.status).toBe(409)
    expect(JSON.stringify(install.body)).toContain('desktop_only')
  })

  await test.step('10 A: a version whose manifest id changed is refused with core’s sentence; core keeps the old head', async () => {
    const before = (await catalogEntry(fixture, personA.token, agent.slug)).desktop.head_sha
    const manifestPath = join(agent.path, 'cinna-agent.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.id = randomUUID()
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    // A new manifest id is a new agent to the app: like a seeded one, it needs a relaunch.
    await a.relaunch()
    await openAgent(a, name)
    await a.page.getByRole('group', { name: 'Runtime summary' }).getByRole('button', { name: 'Share changes…', exact: true }).click()
    const dialog = a.page.getByRole('dialog', { name: 'Share changes' })
    await dialog.getByRole('textbox').fill('A new identity')
    await dialog.getByRole('button', { name: 'Share', exact: true }).click()
    await expect(dialog.getByRole('alert')).toHaveText(
      "Fix what the catalog refused, then share again. This agent's identity changed; share it as a new agent instead.",
      { timeout: 60_000 }
    )
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    const entry = await catalogEntry(fixture, personA.token, agent.slug)
    expect(entry.desktop.head_sha).toBe(before)
    expect(entry.desktop.manifest_id).toBe(agent.manifestId)
    expect(execFileSync('git', ['-C', agent.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).not.toBe(before)
  })
})
