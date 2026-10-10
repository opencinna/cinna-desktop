import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  test,
  expect,
  addSkillToAgent,
  buildAgent,
  cachedSkillDir,
  catalogPins,
  expectSlotCheck,
  openCatalog,
  openSkills,
  shareSkill,
  skillItem,
  skillName,
  skillRow,
  slotCheckLine,
  uniqueName
} from '../fixtures/liveCatalog'
import { catalogEntry, findAgent, finishWithWeather, refreshLibrary, shareChanges, shareWithTeam } from '../fixtures/liveTeamSharing'

/**
 * The catalog story (plan README §7), skills: A writes a skill with an
 * `erp-api` credential slot into the shared agent and shares it with B from
 * the Skills section; B's one catalog lists it as a Skill; B adds it to an
 * agent of B's own, which pins it, downloads it and connects the admin's ERP
 * API by slot without asking, so a `/run:` script reading the slot through
 * `core.cinna_api` finds it. Then A shares Version 2 of the skill and a change
 * to the agent; B is offered both updates in the catalog, the Skills row and
 * the Inbox, and takes both. No model runs. Setup: `e2e/fixtures/live-catalog.py`.
 */

test('§7 2, 4–6: A shares a skill from report-bot; B adds it to B’s agent with the ERP credential by slot, then takes Version 2 and the agent’s update', async ({ team }) => {
  test.setTimeout(480_000)
  const { fixture } = team
  const { a: personA, b: personB } = fixture.people
  const name = uniqueName(fixture, 'Report bot')
  const mine = uniqueName(fixture, 'Ledger bot')
  const skill = skillName('erp-lookup')

  const a = await team.open('a')
  const agent = await buildAgent(a, fixture, {
    name,
    slots: true,
    skill: { name: skill, description: 'Look up an order in the ERP.', credentials: [{ slot: 'erp-api', type: 'api_token', description: 'The ERP API token.' }] }
  })
  await shareWithTeam(a, name, [{ person: personB }])

  let packageUuid = ''
  await test.step('4 A: the Skills section lists the skill as Authored, working, needing erp-api', async () => {
    await openSkills(a, name)
    const row = skillRow(a, skill, 'Authored')
    await expect(row.getByRole('img', { name: 'Every engine of this agent gets this skill', exact: true })).toBeVisible()
    await expect(row).toContainText('Needserp-api')
    await expect(row.getByRole('button', { name: `Share ${skill}…`, exact: true })).toBeVisible()
  })

  await test.step('4 A: Share the skill with B; SKILL.md gets its version and publications.json records it', async () => {
    await shareSkill(a, name, skill, { people: [personB], note: 'First version' })
    const row = skillRow(a, skill, 'Authored')
    await expect(row).toContainText('Version 1')
    await expect(row).toContainText('Shared')
    await expect(row.getByRole('button', { name: `Share a new version of ${skill}…`, exact: true })).toBeVisible()
    const item = await skillItem(fixture, personA.token, skill)
    expect(item?.kind).toBe('skill')
    expect(item.access).toBe('maintain')
    expect(item.latest?.revision_number).toBe(1)
    packageUuid = item.uuid
    const ledger = JSON.parse(readFileSync(join(agent.path, 'publications.json'), 'utf8'))
    expect(ledger.skills).toEqual([
      expect.objectContaining({ name: skill, package_uuid: packageUuid, package_id: item.id, revision_number: 1, platform_url: fixture.server })
    ])
    expect(readFileSync(join(agent.path, 'skills', skill, 'SKILL.md'), 'utf8')).toMatch(new RegExp(`^version: ${item.latest.version}$`, 'm'))
    expect((await skillItem(fixture, personB.token, skill))?.access).toBe('use')
    expect(await skillItem(fixture, fixture.people.c.token, skill)).toBeUndefined()
  })

  const b = await team.open('b')
  await test.step('2 B: one catalog — the skill reads Skill and Version 1, A’s agent Runs on your computer', async () => {
    const catalog = await openCatalog(b, 'All')
    const tile = catalog.getByRole('group', { name: skill, exact: true })
    await expect(tile).toContainText('Skill')
    await expect(tile).toContainText('Version 1')
    await expect(tile).toContainText(`by ${personA.name}`)
    await expect(tile.getByRole('button', { name: 'Add to agent…' })).toBeVisible()
    await expect(catalog.getByRole('group', { name, exact: true })).toContainText('Runs on your computer')
    await b.page.keyboard.press('Escape')
    await expect(catalog).toHaveCount(0)
  })

  await test.step('B Gets report-bot and finishes its setup', async () => {
    const catalog = await openCatalog(b, 'Agents')
    await catalog.getByRole('group', { name, exact: true }).getByRole('button', { name: 'Get', exact: true }).click()
    await expect(catalog).toHaveCount(0, { timeout: 60_000 })
    await finishWithWeather(b, name, `weather-b-${fixture.tag}`)
  })

  const ledgerBot = await buildAgent(b, fixture, { name: mine })
  await test.step('5 B: before the skill, B’s own agent finds nothing in the erp-api slot', async () => {
    await expectSlotCheck(b, mine, 'slot-check: erp-api=none')
  })

  await test.step('5 B: Add to agent… offers B’s own agent, and report-bot only as Can use only', async () => {
    const catalog = await openCatalog(b, 'Skills')
    await catalog.getByRole('group', { name: skill, exact: true }).getByRole('button', { name: 'Add to agent…' }).click()
    const menu = b.page.getByRole('menu', { name: `Add ${skill} to an agent` })
    const shared = menu.getByRole('menuitem', { name: new RegExp(`^${name}`) })
    await expect(shared).toBeDisabled()
    await expect(shared).toContainText('Can use only')
    await expect(menu.getByRole('menuitem', { name: new RegExp(`^${mine}`) })).toBeEnabled()
    await b.page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await b.page.keyboard.press('Escape')
    await expect(catalog).toHaveCount(0)
  })

  await test.step('5 B: Add to agent pins Version 1, downloads it, and connects the ERP API by slot', async () => {
    await addSkillToAgent(b, skill, mine)
    expect(catalogPins(ledgerBot.path)).toEqual([expect.objectContaining({ name: skill, package_uuid: packageUuid, revision_number: 1 })])
    expect(existsSync(join(ledgerBot.path, 'skills', skill))).toBe(false)
    await expect.poll(() => cachedSkillDir(b, packageUuid, 1, skill)).not.toBeNull()
    await expect
      .poll(async () => {
        const setup = await b.page.evaluate((id) => window.api.serviceCredentials.setupState(id), ledgerBot.id)
        if (!setup.ok) return setup.message
        return setup.value.skillSlots.map((slot) => `${slot.slot}:${slot.type}:${slot.state}:${slot.attached?.credential.name ?? ''}`)
      }, { timeout: 30_000 })
      .toEqual([`erp-api:api_token:connected:${fixture.credentials.erp.name}`])
    await openSkills(b, mine)
    const row = skillRow(b, skill, 'From the catalog')
    await expect(row).toContainText('Version 1')
    await expect(row.getByRole('img', { name: 'Every engine of this agent gets this skill', exact: true })).toBeVisible()
    await expect(row.getByRole('button', { name: `Remove ${skill} from this agent`, exact: true })).toBeVisible()
  })

  await test.step('5 B: the agent’s script reads the admin’s ERP API through core.cinna_api by slot', async () => {
    await expectSlotCheck(b, mine, slotCheckLine(fixture))
  })

  await test.step('6 A: shares skill Version 2, then a change to report-bot', async () => {
    appendFileSync(join(agent.path, 'skills', skill, 'SKILL.md'), '\nAlso check the invoice.\n')
    await shareSkill(a, name, skill, { note: 'Checks invoices too', newVersion: true })
    await expect.poll(async () => (await skillItem(fixture, personB.token, skill))?.latest?.revision_number).toBe(2)
    writeFileSync(join(agent.path, 'knowledge/erp.md'), '# ERP\n\nOrders and invoices live in the ERP.\n')
    await shareChanges(a, name, 'Invoices too')
  })

  await test.step('6 B: Update available — on the catalog tile, the Skills row and the Inbox', async () => {
    await refreshLibrary(b)
    const catalog = await openCatalog(b, 'Agents')
    await expect(catalog.getByRole('group', { name, exact: true }).getByRole('button', { name: 'Update', exact: true })).toBeVisible()
    await b.page.keyboard.press('Escape')
    await expect(catalog).toHaveCount(0)
    await openSkills(b, mine)
    await expect(skillRow(b, skill, 'From the catalog').getByRole('button', { name: new RegExp(`^Update ${skill} to Version 2`) })).toBeVisible()
    await b.page.getByRole('button', { name: /^Inbox/ }).click()
    await expect(b.page.getByRole('article', { name: `Update available for ${name}` })).toBeVisible({ timeout: 20_000 })
    await expect(b.page.getByRole('article', { name: `Update available for ${skill} in ${mine}` })).toBeVisible({ timeout: 20_000 })
  })

  await test.step('6 B: updates the skill from the Inbox — the pin moves to Version 2 and the new files arrive', async () => {
    const card = b.page.getByRole('article', { name: `Update available for ${skill} in ${mine}` })
    await card.getByRole('button', { name: 'Update', exact: true }).click()
    await expect(card.getByRole('status')).toHaveText(`Updated. This agent now has the latest version of ${skill}.`, { timeout: 60_000 })
    expect(catalogPins(ledgerBot.path)).toEqual([expect.objectContaining({ name: skill, package_uuid: packageUuid, revision_number: 2 })])
    const cached = cachedSkillDir(b, packageUuid, 2, skill)
    expect(cached).not.toBeNull()
    expect(readFileSync(join(cached!, 'SKILL.md'), 'utf8')).toContain('Also check the invoice.')
  })

  await test.step('6 B: updates report-bot from the catalog tile — it fast-forwards to A’s version', async () => {
    const catalog = await openCatalog(b, 'Agents')
    const tile = catalog.getByRole('group', { name, exact: true })
    await tile.getByRole('button', { name: 'Update', exact: true }).click()
    // The button reads Updating… while it runs; Open alone is left once it landed.
    await expect(tile.getByRole('button', { name: /^(Update|Updating…)$/ })).toHaveCount(0, { timeout: 60_000 })
    await expect(tile.getByRole('button', { name: 'Open', exact: true })).toBeVisible()
    const got = await findAgent(b, name)
    const teamHead = (await catalogEntry(fixture, personB.token, agent.slug)).desktop.head_sha
    expect(execFileSync('git', ['-C', got.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(teamHead)
    expect(readFileSync(join(got.path, 'knowledge/erp.md'), 'utf8')).toContain('invoices')
    await b.page.keyboard.press('Escape')
    await expect(catalog).toHaveCount(0)
  })

  await test.step('6 B: no Update left on the Skills row', async () => {
    await openSkills(b, mine)
    const row = skillRow(b, skill, 'From the catalog')
    await expect(row).toContainText('Version 2')
    await expect(row.getByRole('button', { name: new RegExp(`^Update ${skill}`) })).toHaveCount(0)
  })
})
