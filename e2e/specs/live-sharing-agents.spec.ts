import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  test,
  expect,
  addCinnaProfile,
  closeSettings,
  buildAgent,
  catalogNames,
  expectAgentNotListed,
  getAgent,
  openCatalog,
  openSettings,
  openSettingsCatalog,
  openSharingTab,
  publishSkill,
  skillItem,
  skillName,
  switchProfile,
  titledSection,
  uniqueName
} from '../fixtures/liveCatalog'
import {
  catalogEntry,
  catalogGrants,
  coreCall,
  findAgent,
  refreshLibrary,
  shareChanges,
  shareWithTeam,
  type PersonApp,
  type SharingPerson
} from '../fixtures/liveTeamSharing'

/**
 * Sharing a desktop agent, Part 2 theme T5: who an agent reaches (named
 * people, everyone), its People list against core's grants, a maintainer
 * other than the sharer, the composer's agent picker and Settings → Catalog
 * (a4271c82), and what the catalog does across profiles and when core cannot
 * be reached. What is already covered elsewhere — Can use / Can edit, a
 * demotion mid-way (live-team-sharing-collab), Remove from this computer and
 * the agent Inbox card (live-team-sharing-lifecycle), the skill Inbox card
 * (live-catalog-skills) — is not repeated.
 *
 * Against the real local cinna-core; setup `e2e/fixtures/live-catalog.py`.
 * No model runs: 0 turns.
 */

const SHOTS = '/tmp/cinna-live/shots'

async function shot(app: PersonApp, file: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true })
  await app.page.screenshot({ path: join(SHOTS, file), animations: 'disabled' })
}

/** What the run saw where the spec records behaviour rather than asserting one answer. */
function observe(description: string): void {
  test.info().annotations.push({ type: 'observed', description })
  console.log(`observed: ${description}`)
}

function people(app: PersonApp) {
  return titledSection(app, 'People')
}

/** Core's visibility of the agent `slug`, as its maintainer A reads it. */
async function visibilityOf(app: PersonApp, slug: string): Promise<string> {
  return (await catalogEntry(app.fixtureRef, app.fixtureRef.people.a.token, slug))?.visibility
}

/** `user:<id>:<access>` for a fixture person. */
const grant = (person: SharingPerson, access: string): string => `user:${person.id}:${access}`

/** The agent page's Sharing tab again: Overview, then Sharing (the tab re-reads People when it mounts). */
async function reopenSharing(app: PersonApp): Promise<void> {
  const tabs = app.page.getByRole('tablist', { name: 'Agent details' })
  await tabs.getByRole('tab', { name: /^Overview/ }).click()
  await tabs.getByRole('tab', { name: 'Sharing', exact: true }).click()
  await expect(people(app)).toBeVisible()
}

test('A1 named people, then everyone: B and C can Get it and D cannot; made public, D can; the People list matches core and changes back', async ({ team }) => {
  test.setTimeout(420_000)
  const { fixture } = team
  const { a: personA, b: personB, c: personC } = fixture.people
  const personD = fixture.people.d!
  const name = uniqueName(fixture, 'Team digest')

  const a = await team.open('a')
  const agent = await buildAgent(a, fixture, { name })

  await test.step('A shares it with B and C through Share with the team; core: A maintains, B and C use, visibility users', async () => {
    await shareWithTeam(a, name, [{ person: personB }, { person: personC }])
    await expect.poll(async () => (await catalogEntry(fixture, personA.token, agent.slug))?.latest?.revision_number ?? null).toBe(1)
    const entry = await catalogEntry(fixture, personA.token, agent.slug)
    expect(entry.visibility).toBe('users')
    expect(await catalogGrants(fixture, personA.token, entry.uuid)).toEqual(
      [grant(personA, 'maintain'), grant(personB, 'use'), grant(personC, 'use')].sort()
    )
  })

  await test.step('core: B and C list it, D does not', async () => {
    expect((await catalogEntry(fixture, personB.token, agent.slug))?.access).toBe('use')
    expect((await catalogEntry(fixture, personC.token, agent.slug))?.access).toBe('use')
    expect(await catalogEntry(fixture, personD.token, agent.slug)).toBeUndefined()
  })

  const c = await team.open('c')
  await test.step('C: the catalog offers Get, and Get lands on the agent; core records C’s local install', async () => {
    await getAgent(c, name)
    await expect
      .poll(async () => (((await catalogEntry(fixture, personC.token, agent.slug))?.my_installs ?? []) as any[]).map((r) => `${r.where}:${r.revision_number}`))
      .toEqual(['local:1'])
  })

  const b = await team.open('b')
  await test.step('B: the catalog lists it with Get', async () => {
    const catalog = await openCatalog(b, 'Agents')
    await expect(catalog.getByRole('group', { name, exact: true }).getByRole('button', { name: 'Get', exact: true })).toBeVisible()
    await b.page.keyboard.press('Escape')
    await expect(catalog).toHaveCount(0)
  })

  const d = await team.open('d')
  await test.step('D, named nowhere: the catalog does not list it', async () => {
    await expectAgentNotListed(d, name)
  })

  await test.step('A: the Sharing tab’s People lists B and C at Can use, no Everyone row — what core holds', async () => {
    await openSharingTab(a, name)
    await expect(people(a).getByRole('combobox', { name: `Access for ${personB.name}` })).toHaveValue('use')
    await expect(people(a).getByRole('combobox', { name: `Access for ${personC.name}` })).toHaveValue('use')
    await expect(people(a).getByRole('combobox')).toHaveCount(2)
    await expect(people(a).getByText('Everyone on this server', { exact: true })).toHaveCount(0)
  })

  await test.step('A makes it public with People’s Share with everyone; the tab shows Everyone at Can use and drops the button; core: public', async () => {
    const shareWithEveryone = people(a).getByRole('button', { name: 'Share with everyone', exact: true })
    await expect(shareWithEveryone).toBeVisible()
    await shot(a, 'A1-people-share-with-everyone.png')
    await shareWithEveryone.click()
    await expect(people(a).getByText('Everyone on this server', { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(shareWithEveryone).toHaveCount(0)
    await expect(people(a).getByRole('alert')).toHaveCount(0)
    await expect.poll(() => visibilityOf(a, agent.slug)).toBe('public')
    await reopenSharing(a)
    const everyone = people(a).locator('div').filter({ hasText: /^Everyone on this server/ }).last()
    await expect(people(a).getByText('Everyone on this server', { exact: true })).toBeVisible()
    await expect(everyone).toContainText('Can use')
    await expect(people(a).getByRole('button', { name: 'Remove Everyone on this server', exact: true })).toBeVisible()
  })

  await test.step('D: now the catalog lists it, and D Gets it; core records D’s local install', async () => {
    await refreshLibrary(d)
    await getAgent(d, name)
    await expect
      .poll(async () => (((await catalogEntry(fixture, personD.token, agent.slug))?.my_installs ?? []) as any[]).map((r) => `${r.where}:${r.revision_number}`))
      .toEqual(['local:1'])
  })

  await test.step('A removes Everyone in People (asks in the row); core: users again, grants unchanged', async () => {
    await people(a).getByRole('button', { name: 'Remove Everyone on this server', exact: true }).click()
    await expect(people(a).getByText('Remove Everyone on this server’s access?', { exact: true })).toBeVisible()
    await people(a).getByRole('button', { name: 'Remove', exact: true }).click()
    await expect(people(a).getByText('Everyone on this server', { exact: true })).toHaveCount(0, { timeout: 30_000 })
    await expect.poll(() => visibilityOf(a, agent.slug)).toBe('users')
    const entry = await catalogEntry(fixture, personA.token, agent.slug)
    expect(await catalogGrants(fixture, personA.token, entry.uuid)).toEqual(
      [grant(personA, 'maintain'), grant(personB, 'use'), grant(personC, 'use')].sort()
    )
  })

  await test.step('A changes C to Can edit and back to Can use; core follows each, and the reopened tab reads core’s list', async () => {
    const cSelect = people(a).getByRole('combobox', { name: `Access for ${personC.name}` })
    await cSelect.selectOption('edit')
    await expect(cSelect).toBeEnabled({ timeout: 30_000 })
    const uuid = (await catalogEntry(fixture, personA.token, agent.slug)).uuid
    await expect.poll(() => catalogGrants(fixture, personA.token, uuid)).toContain(grant(personC, 'edit'))
    await reopenSharing(a)
    await expect(people(a).getByRole('combobox', { name: `Access for ${personC.name}` })).toHaveValue('edit')
    await people(a).getByRole('combobox', { name: `Access for ${personC.name}` }).selectOption('use')
    await expect.poll(() => catalogGrants(fixture, personA.token, uuid)).toEqual(
      [grant(personA, 'maintain'), grant(personB, 'use'), grant(personC, 'use')].sort()
    )
    await reopenSharing(a)
    await expect(people(a).getByRole('combobox', { name: `Access for ${personB.name}` })).toHaveValue('use')
    await expect(people(a).getByRole('combobox', { name: `Access for ${personC.name}` })).toHaveValue('use')
    await expect(people(a).getByText('Everyone on this server', { exact: true })).toHaveCount(0)
  })

  await test.step('core, as D after Everyone went: not listed any more, though D holds a copy', async () => {
    expect(await catalogEntry(fixture, personD.token, agent.slug)).toBeUndefined()
  })
})

test('A2 A makes B a Maintainer; B adds C from B’s own app and core records it; a list with no maintainer is refused with core’s sentence', async ({ team }) => {
  test.setTimeout(360_000)
  const { fixture } = team
  const { a: personA, b: personB, c: personC } = fixture.people
  const name = uniqueName(fixture, 'Shift planner')

  const a = await team.open('a')
  const agent = await buildAgent(a, fixture, { name })
  await shareWithTeam(a, name, [{ person: personB }])
  await expect.poll(async () => (await catalogEntry(fixture, personA.token, agent.slug))?.latest?.revision_number ?? null).toBe(1)
  const uuid = (await catalogEntry(fixture, personA.token, agent.slug)).uuid

  const b = await team.open('b')
  await test.step('B Gets it; as Can use, B’s People shows only the maintainers and says who can change it', async () => {
    await getAgent(b, name)
    await openSharingTab(b, name)
    await expect(people(b).getByText('Only a maintainer can change who has access.', { exact: true })).toBeVisible()
    await expect(people(b).getByRole('button', { name: 'Share with a person…' })).toHaveCount(0)
  })

  await test.step('A sets B to Maintainer in People; core: A and B maintain', async () => {
    await openSharingTab(a, name)
    await people(a).getByRole('combobox', { name: `Access for ${personB.name}` }).selectOption('maintain')
    await expect.poll(() => catalogGrants(fixture, personA.token, uuid)).toEqual([grant(personA, 'maintain'), grant(personB, 'maintain')].sort())
  })

  await test.step('B, reopening Sharing: People is B’s to change; B adds C at Can use through Share with a person…', async () => {
    await refreshLibrary(b)
    await reopenSharing(b)
    await people(b).getByRole('button', { name: 'Share with a person…' }).click()
    const dialog = b.page.getByRole('dialog', { name: 'Share with a person' })
    await dialog.getByRole('combobox', { name: 'Find a person' }).fill(personC.name)
    await dialog.getByRole('option', { name: `${personC.name} <${personC.email}>` }).click()
    await expect(dialog.getByRole('combobox', { name: 'Access', exact: true })).toHaveValue('use')
    await dialog.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(dialog).toHaveCount(0, { timeout: 30_000 })
    await expect(people(b).getByRole('combobox', { name: `Access for ${personC.name}` })).toHaveValue('use')
  })

  await test.step('core: A and B maintain, C uses; C’s catalog lists it', async () => {
    await expect
      .poll(() => catalogGrants(fixture, personA.token, uuid))
      .toEqual([grant(personA, 'maintain'), grant(personB, 'maintain'), grant(personC, 'use')].sort())
    expect((await catalogEntry(fixture, personC.token, agent.slug))?.access).toBe('use')
  })

  await test.step('a list that leaves no maintainer (B’s own row, which People never shows a maintainer, demoted) is refused: core 409 → its sentence, nothing changes', async () => {
    const result = await b.page.evaluate(async (args) => {
      const saved = await window.api.sharing.setPeople(args.id, [
        { principal: { kind: 'user' as const, userId: args.a }, access: 'use' as const },
        { principal: { kind: 'user' as const, userId: args.b }, access: 'use' as const },
        { principal: { kind: 'user' as const, userId: args.c }, access: 'use' as const }
      ])
      return saved.success ? { done: saved.value.done, refusal: saved.value.refusal, detail: saved.value.detail } : { error: saved.message }
    }, { id: (await findAgent(b, name)).id, a: personA.id, b: personB.id, c: personC.id })
    expect(result).toEqual({ done: false, refusal: 'failed', detail: 'This item needs at least one maintainer.' })
    expect(await catalogGrants(fixture, personA.token, uuid)).toEqual(
      [grant(personA, 'maintain'), grant(personB, 'maintain'), grant(personC, 'use')].sort()
    )
    // Core's own answer to the same PUT, for the record.
    const put = await coreCall(fixture, personB.token, `/catalog/items/${uuid}/grants`, {
      method: 'PUT',
      body: [personA, personB, personC].map((p) => ({ principal: { user_id: p.id }, access: 'use' }))
    })
    expect(put.status).toBe(409)
    expect(put.body?.detail).toBe('This item needs at least one maintainer.')
  })
})

test('A3 the composer’s agent picker offers B a catalog agent not on B’s computer; Get installs and selects it; reopened, it is no longer a catalog card; skills are never offered', async ({ team }) => {
  test.setTimeout(300_000)
  const { fixture } = team
  const { a: personA, b: personB } = fixture.people
  const name = uniqueName(fixture, 'Picker pal')
  const skill = skillName('picker-tip')

  const a = await team.open('a')
  const agent = await buildAgent(a, fixture, { name, skill: { name: skill, description: 'A tip for the picker.' } })
  await shareWithTeam(a, name, [{ person: personB }])
  await expect.poll(async () => (await catalogEntry(fixture, personA.token, agent.slug))?.latest?.revision_number ?? null).toBe(1)
  await publishSkill(a, agent.id, skill, { people: [personB] })

  const b = await team.open('b')
  // The control: both are in B's listing, so the picker leaving the skill out is the picker's doing.
  await expect.poll(() => catalogNames(b)).toEqual(expect.arrayContaining([name, skill]))
  expect((await skillItem(fixture, personB.token, skill))?.kind).toBe('skill')

  const picker = () => b.page.getByRole('dialog', { name: 'Add agents & tools' })
  const openPicker = async (): Promise<void> => {
    await b.page.getByRole('button', { name: 'Add to chat', exact: true }).click()
    await b.page.getByRole('menu', { name: 'Add to chat' }).getByRole('menuitem', { name: 'Add agents / MCP' }).click()
    await expect(picker()).toBeVisible()
  }

  await test.step('B, new chat → Add to chat → Add agents / MCP: A’s agent is a catalog card (Runs on your computer, Version 1, by A) with Get; the skill is not offered', async () => {
    await b.page.getByRole('button', { name: 'Chats', exact: true }).click()
    await expect(b.page.getByRole('heading', { level: 1, name: 'What can I help with?' })).toBeVisible()
    await openPicker()
    const card = picker().getByRole('group', { name, exact: true })
    await expect(card).toContainText('Runs on your computer')
    await expect(card).toContainText('Version 1')
    await expect(card).toContainText(`by ${personA.name}`)
    await expect(card.getByRole('button', { name: 'Get', exact: true })).toBeVisible()
    await expect(picker().getByRole('group', { name: skill, exact: true })).toHaveCount(0)
    await expect(picker().getByText(skill)).toHaveCount(0)
    await card.scrollIntoViewIfNeeded()
    await shot(b, 'picker-catalog-card.png')
  })

  await test.step('Get: the agent is installed in B’s agents home and selected for the chat', async () => {
    await picker().getByRole('group', { name, exact: true }).getByRole('button', { name: 'Get', exact: true }).click()
    await expect(picker().getByRole('group', { name, exact: true })).toHaveCount(0, { timeout: 60_000 })
    await expect.poll(async () => (await b.page.evaluate(() => window.api.localAgents.list())).agents.some((row) => row.name === name)).toBe(true)
    const local = await findAgent(b, name)
    expect(local.path.startsWith(b.rootPath)).toBe(true)
    await b.page.keyboard.press('Escape')
    await expect(picker()).toHaveCount(0)
    await expect(b.page.getByRole('button', { name: `Remove agent ${name}`, exact: true })).toBeVisible()
  })

  await test.step('core: B’s Get from the picker is a local install', async () => {
    await expect
      .poll(async () => (((await catalogEntry(fixture, personB.token, agent.slug))?.my_installs ?? []) as any[]).map((r) => `${r.where}:${r.revision_number}`))
      .toEqual(['local:1'])
  })

  await test.step('reopened: no catalog card for it — it is one of B’s own agents now, selected', async () => {
    await openPicker()
    await expect(picker().getByRole('group', { name, exact: true })).toHaveCount(0)
    await expect(picker().getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible()
    await expect(picker().getByRole('group', { name: skill, exact: true })).toHaveCount(0)
    await b.page.keyboard.press('Escape')
  })
})

test('A4 Settings → Catalog: B Gets an agent there, takes A’s change with Update, and Back from a detail keeps the scroll and focus; a desktop agent’s detail offers no Uninstall', async ({ team }) => {
  test.setTimeout(420_000)
  const { fixture } = team
  const { a: personA, b: personB } = fixture.people
  const name = uniqueName(fixture, 'Settings scout')

  const a = await team.open('a')
  const agent = await buildAgent(a, fixture, { name })
  await shareWithTeam(a, name, [{ person: personB }])
  await expect.poll(async () => (await catalogEntry(fixture, personA.token, agent.slug))?.latest?.revision_number ?? null).toBe(1)
  // A few more items for B, so the Settings list is long enough to scroll.
  for (const extra of ['Ledger one', 'Ledger two', 'Ledger three']) {
    const more = await buildAgent(a, fixture, { name: uniqueName(fixture, extra) })
    await shareWithTeam(a, more.name, [{ person: personB }])
  }

  const b = await team.open('b')
  const tile = () => titledSection(b, 'Agents and skills').getByRole('group', { name, exact: true })

  await test.step('B: Settings → Catalog lists it with Get; Get lands on the agent’s page', async () => {
    await openSettingsCatalog(b)
    await expect(tile()).toContainText('Runs on your computer')
    await expect(tile()).toContainText('Version 1')
    await tile().scrollIntoViewIfNeeded()
    await shot(b, 'settings-catalog-list.png')
    await tile().getByRole('button', { name: 'Get', exact: true }).click()
    await expect(b.page.getByRole('heading', { level: 1 })).toHaveText(name, { timeout: 60_000 })
    await expect
      .poll(async () => (((await catalogEntry(fixture, personB.token, agent.slug))?.my_installs ?? []) as any[]).map((r) => `${r.where}:${r.revision_number}`))
      .toEqual(['local:1'])
  })

  await test.step('A shares a change; B’s Inbox card names it Runs on your computer at Version 2', async () => {
    writeFileSync(join(agent.path, 'knowledge/erp.md'), '# ERP\n\nOrders and invoices live in the ERP.\n')
    await refreshLibrary(a)
    await shareChanges(a, name, 'Invoices too')
    await refreshLibrary(b)
    await b.page.getByRole('button', { name: /^Inbox/ }).click()
    const card = b.page.getByRole('article', { name: `Update available for ${name}` })
    await expect(card).toBeVisible({ timeout: 30_000 })
    await expect(card).toContainText('Version 2')
    await expect(card).toContainText('Runs on your computer')
  })

  await test.step('B: Settings → Catalog offers Update; Update brings A’s version in and leaves Open', async () => {
    await openSettingsCatalog(b)
    await tile().getByRole('button', { name: 'Update', exact: true }).click()
    await expect(tile().getByRole('button', { name: /^(Update|Updating…)$/ })).toHaveCount(0, { timeout: 60_000 })
    await expect(tile().getByRole('button', { name: 'Open', exact: true })).toBeVisible()
    const local = await findAgent(b, name)
    const head = (dir: string): string => execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    expect(head(local.path)).toBe(head(agent.path))
  })

  await test.step('the Inbox card is gone once the update landed', async () => {
    await closeSettings(b)
    await b.page.getByRole('button', { name: /^Inbox/ }).click()
    await expect(b.page.getByRole('article', { name: `Update available for ${name}` })).toHaveCount(0, { timeout: 30_000 })
  })

  await test.step('the detail: facts, Back to catalog, no Uninstall and no Open in Cinna for a desktop agent', async () => {
    const section = await openSettingsCatalog(b)
    await tile().getByRole('button', { name, exact: true }).click()
    await expect(section.getByRole('heading', { level: 3, name, exact: true })).toBeVisible()
    await expect(section.getByRole('button', { name: 'Back to catalog' })).toBeVisible()
    await expect(section.getByRole('button', { name: 'Open', exact: true })).toBeVisible()
    await expect(section.getByRole('button', { name: `Uninstall ${name}` })).toHaveCount(0)
    await expect(section.getByRole('button', { name: `Open ${name} in Cinna` })).toHaveCount(0)
    await shot(b, 'settings-catalog-detail-desktop.png')
    if (fixture.cloudAgent) {
      await section.getByRole('button', { name: 'Back to catalog' }).click()
      const cloud = section.getByRole('group', { name: fixture.cloudAgent.display_name, exact: true })
      await cloud.getByRole('button', { name: fixture.cloudAgent.display_name, exact: true }).click()
      await expect(section.getByRole('heading', { level: 3, name: fixture.cloudAgent.display_name, exact: true })).toBeVisible()
      // Not installed for B (the fixture never installs it): Get, and neither icon.
      await expect(section.getByRole('button', { name: `Uninstall ${fixture.cloudAgent.display_name}` })).toHaveCount(0)
      await shot(b, 'settings-catalog-detail-cloud.png')
    }
    await section.getByRole('button', { name: 'Back to catalog' }).click()
  })

  await test.step('Back from a detail returns to the scroll position it left, with focus on the tile that was opened', async () => {
    await b.page.setViewportSize({ width: 820, height: 480 })
    const section = await openSettingsCatalog(b)
    const scroller = b.page.locator('[data-settings-scroller]')
    await expect.poll(() => scroller.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(150)
    await shot(b, 'settings-scrollbar-gutter.png')
    // The last tile, scrolled into view: the page is scrolled down.
    const last = section.locator('[data-catalog-item]').last()
    const uuid = await last.getAttribute('data-catalog-item')
    await last.scrollIntoViewIfNeeded()
    const before = await scroller.evaluate((el) => el.scrollTop)
    expect(before).toBeGreaterThan(0)
    await last.getByRole('button').first().click()
    await expect(section.getByRole('button', { name: 'Back to catalog' })).toBeFocused()
    await section.getByRole('button', { name: 'Back to catalog' }).click()
    await expect(section.locator(`[data-catalog-item="${uuid}"]`)).toBeVisible()
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(before)
    expect(await b.page.evaluate(() => document.activeElement?.closest('[data-catalog-item]')?.getAttribute('data-catalog-item') ?? null)).toBe(uuid)
  })

  await test.step('the scrollbar gutter is stable: a search that empties the list does not change the page’s width', async () => {
    const scroller = b.page.locator('[data-settings-scroller]')
    await expect(scroller).toHaveCSS('scrollbar-gutter', 'stable')
    const width = await scroller.evaluate((el) => el.clientWidth)
    await titledSection(b, 'Agents and skills').getByRole('textbox', { name: 'Search the catalog' }).fill('zz-nothing-matches-zz')
    await expect(titledSection(b, 'Agents and skills').getByText('Nothing matches your search.', { exact: true })).toBeVisible()
    await expect.poll(() => scroller.evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true)
    expect(await scroller.evaluate((el) => el.clientWidth)).toBe(width)
  })
})

test('A5 profiles and an unreachable core: a local profile has no catalog; A and D each see only their own; a failed refresh keeps the list and says so', async ({ team }) => {
  test.setTimeout(420_000)
  const { fixture } = team
  const { a: personA } = fixture.people
  const personD = fixture.people.d!
  const nameA = uniqueName(fixture, 'Only for A')
  const nameD = uniqueName(fixture, 'Only for D')

  const d = await team.open('d')
  const agentD = await buildAgent(d, fixture, { name: nameD })
  await shareWithTeam(d, nameD, [])
  const a = await team.open('a')
  const agentA = await buildAgent(a, fixture, { name: nameA })
  await shareWithTeam(a, nameA, [])
  await expect.poll(async () => (await catalogEntry(fixture, personA.token, agentA.slug))?.latest?.revision_number ?? null).toBe(1)
  await expect.poll(async () => (await catalogEntry(fixture, personD.token, agentD.slug))?.latest?.revision_number ?? null).toBe(1)
  await d.close()

  await addCinnaProfile(a, personD)
  const localName = `Offline ${fixture.tag}`
  const local = await a.page.evaluate(
    (n) => window.api.auth.register({ accountType: 'local', username: n.toLowerCase().replace(/\s+/g, '-'), displayName: n }),
    localName
  )
  expect(local.success).toBe(true)
  // Registering over IPC activates the new profile in main but not in the
  // window: put A back and restart, so both agree before the UI switches.
  const selfId = (await a.page.evaluate(() => window.api.auth.listUsers())).find((u) => u.username === personA.email)!.id
  expect((await a.page.evaluate((userId) => window.api.auth.login({ userId }), selfId)).success).toBe(true)
  await a.relaunch()
  expect((await a.page.evaluate(() => window.api.auth.getCurrent()))?.username).toBe(personA.email)

  await test.step('(a) a local profile: no Install from catalog, no Settings → Catalog, main has no listing, and the picker has no Catalog section', async () => {
    await switchProfile(a, localName, local.user!.username)
    expect(await catalogNames(a)).toBeNull()
    await a.page.getByRole('button', { name: 'Agents', exact: true }).click()
    await a.page.getByRole('button', { name: 'Add an agent' }).click()
    const add = a.page.getByRole('dialog', { name: 'Add an agent' })
    await expect(add.getByRole('button', { name: /^New agent/ })).toBeVisible()
    await expect(add.getByRole('button', { name: /Install from catalog/ })).toHaveCount(0)
    await a.page.keyboard.press('Escape')
    await openSettings(a)
    await expect(a.page.getByRole('button', { name: 'Catalog', exact: true })).toHaveCount(0)
    await closeSettings(a)
    await a.page.getByRole('button', { name: 'Chats', exact: true }).click()
    const plus = a.page.getByRole('button', { name: 'Add to chat', exact: true })
    if ((await plus.count()) > 0) {
      await plus.click()
      const item = a.page.getByRole('menu', { name: 'Add to chat' }).getByRole('menuitem', { name: 'Add agents / MCP' })
      if ((await item.count()) > 0) {
        await item.click()
        const picker = a.page.getByRole('dialog', { name: 'Add agents & tools' })
        await expect(picker).toBeVisible()
        await expect(picker.getByRole('button', { name: 'Get', exact: true })).toHaveCount(0)
        await a.page.keyboard.press('Escape')
      } else {
        observe('local profile: Add to chat has no Add agents / MCP (nothing to add)')
        await a.page.keyboard.press('Escape')
      }
    } else {
      observe('local profile: no Add to chat button (no destination)')
    }
  })

  await test.step('(b) profile D: the listing, the dialog and Settings → Catalog show D’s agent and not A’s', async () => {
    await switchProfile(a, personD.name, personD.email)
    await expect.poll(() => catalogNames(a)).toEqual(expect.arrayContaining([nameD]))
    expect(await catalogNames(a, false)).not.toContain(nameA)
    const catalog = await openCatalog(a, 'Agents')
    await expect(catalog.getByRole('group', { name: nameD, exact: true })).toBeVisible()
    await expect(catalog.getByRole('group', { name: nameA, exact: true })).toHaveCount(0)
    await a.page.keyboard.press('Escape')
    const section = await openSettingsCatalog(a)
    await expect(section.getByRole('group', { name: nameD, exact: true })).toBeVisible()
    await expect(section.getByRole('group', { name: nameA, exact: true })).toHaveCount(0)
  })

  await test.step('(b) back to A: A’s agent and not D’s, on the same Settings page', async () => {
    await switchProfile(a, personA.name, personA.email)
    await expect.poll(() => catalogNames(a)).toEqual(expect.arrayContaining([nameA]))
    expect(await catalogNames(a, false)).not.toContain(nameD)
    const section = await openSettingsCatalog(a)
    await expect(section.getByRole('group', { name: nameA, exact: true })).toBeVisible()
    await expect(section.getByRole('group', { name: nameD, exact: true })).toHaveCount(0)
  })

  await test.step('(c) core unreachable: Refresh says it couldn’t refresh, and the tiles stay', async () => {
    const section = await openSettingsCatalog(a)
    await expect(section.getByRole('group', { name: nameA, exact: true })).toBeVisible()
    // Every request to core is sent to a closed loopback port instead — the
    // network refusing, as when core is down; nothing about core changes.
    await a.electronApp.evaluate(async ({ net }, server) => {
      const http = process.getBuiltinModule('node:net')
      const port = await new Promise<number>((resolve) => {
        const probe = http.createServer().listen(0, '127.0.0.1', () => {
          const p = (probe.address() as { port: number }).port
          probe.close(() => resolve(p))
        })
      })
      const g = globalThis as unknown as { __realNetFetch?: typeof net.fetch }
      g.__realNetFetch ??= net.fetch
      const real = g.__realNetFetch
      net.fetch = ((input: string, init?: RequestInit) =>
        real(String(input).startsWith(server) ? String(input).replace(server, `http://127.0.0.1:${port}`) : input, init)) as typeof net.fetch
    }, fixture.server)
    await section.getByRole('button', { name: 'Refresh', exact: true }).click()
    const failure = section.getByRole('alert')
    await expect(failure).toContainText('Couldn’t refresh.', { timeout: 30_000 })
    observe(`refresh failure line: ${await failure.textContent()}`)
    await expect(section.getByRole('group', { name: nameA, exact: true })).toBeVisible()
    expect(await catalogNames(a, false)).toContain(nameA)
  })

  await test.step('(c) the dialog opened while core is unreachable: its own read fails, the line says so, the tiles stay', async () => {
    await closeSettings(a)
    const catalog = await openCatalog(a, 'Agents')
    await expect(catalog.getByRole('group', { name: nameA, exact: true })).toBeVisible({ timeout: 30_000 })
    // Opening the dialog lists again; that read fails too, and says so over the kept tiles.
    await expect(catalog.getByRole('alert')).toContainText('Couldn’t refresh.', { timeout: 30_000 })
    await expect(catalog.getByRole('group', { name: nameA, exact: true })).toBeVisible()
    await a.page.keyboard.press('Escape')
  })

  await test.step('(c) core reachable again: Refresh clears the line', async () => {
    await a.electronApp.evaluate(({ net }) => {
      const g = globalThis as unknown as { __realNetFetch?: typeof net.fetch }
      if (g.__realNetFetch) net.fetch = g.__realNetFetch
    })
    const section = await openSettingsCatalog(a)
    await section.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(section.getByRole('alert')).toHaveCount(0, { timeout: 30_000 })
    await expect(section.getByRole('group', { name: nameA, exact: true })).toBeVisible()
  })
})
