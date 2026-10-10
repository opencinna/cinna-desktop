import { appendFileSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  test,
  expect,
  addSkillToAgent,
  buildAgent,
  cachedSkillDir,
  catalogPins,
  dropCachedRevision,
  expectSkillNotListed,
  getAgent,
  openCodeConfigOf,
  openSkills,
  publishSkill,
  removeSkillFromAgent,
  skillDownloadStatus,
  skillItem,
  skillLocalInstalls,
  skillName,
  skillRow,
  skillSlotStates,
  skillsPluginDir,
  slotCheckLine,
  slotCheckScript,
  startAgentChat,
  startOllamaStub,
  storedAttachments,
  uniqueName,
  updateFromCatalog,
  useFakeOpenCode,
  writeSkill,
  type BuiltAgent,
  type CatalogFixture
} from '../fixtures/liveCatalog'
import { coreCall, openAgent, refreshLibrary, runCommand, shareChanges, shareWithTeam, type PersonApp } from '../fixtures/liveTeamSharing'

/**
 * T3 — a catalog skill's life after install, against the real local
 * cinna-core (`e2e/fixtures/live-catalog.py`, people A–D):
 *
 * - T3.1 / T3.2 A withdraws B's access (the grant, then visibility private).
 *   The desktop offers no way to change a skill's people or visibility after
 *   its first share, nor to delete a skill, so A does those over core's REST
 *   (`PUT /catalog/items/{uuid}/grants`, `PATCH /catalog/items/{uuid}`,
 *   `DELETE /catalog/items/{uuid}`) as the web UI would.
 * - T3.3 delete while held: core's guard, then the delete once B removed it.
 * - T3.4 U7 "behind": a teammate whose clone pins a revision no longer the
 *   team's latest cannot fetch it until they Update the agent.
 * - T3.5 Remove detaches what the skill-slot fill attached, never a hand attachment.
 * - T3.6 the next start removes cached revisions no agent pins.
 *
 * No model runs (0 OpenCode, 0 Claude turns): "still linked for engines" is
 * the links folder and `opencode.json` the real launcher writes for a turn on
 * the scripted fake ACP agent behind a keyless Ollama stub.
 */

const MODEL = 'qwen3:8b'
let ollama: Awaited<ReturnType<typeof startOllamaStub>>

test.beforeAll(async () => {
  ollama = await startOllamaStub(MODEL)
})

test.afterAll(async () => {
  await ollama?.close()
})

const READY = 'Every engine of this agent gets this skill'
const NOT_HERE = 'Not on this computer yet.'
/** Try again's 404 on a team-tracked agent whose copy is behind the team's latest (U7). */
const NOT_AVAILABLE = 'This version is not available to you. If the agent is shared, update it to the team’s latest version first.'
/** Try again's 404 on an agent no team tracks: the person's own access went. */
const WITHDRAWN = 'This skill is no longer available to you — its publisher took away your access or removed it from the catalog.'
/** The row's warning once a loaded listing no longer has the package, on an agent no team tracks. */
const NOT_IN_CATALOG = 'This skill is no longer in the catalog for you. The copy on this computer keeps working, but it won’t get updates.'
const SKILL_DESCRIPTION = 'Check which ERP API credential this agent can reach.'

/**
 * A skill that declares the `erp-api` slot and carries a script reading it
 * through `core.cinna_api`. The script has no `.py` suffix on purpose: core's
 * dev server (uvicorn `--reload`) watches its `data/skills/` store, so a
 * published `.py` file restarts the backend mid-test and drops the next request.
 */
const erpSkill = {
  description: SKILL_DESCRIPTION,
  credentials: [{ slot: 'erp-api', type: 'api_token', description: 'The ERP API token.' }],
  body: 'Run `scripts/skill_check` with python3 and reply with its line.\n',
  files: { 'scripts/skill_check': slotCheckScript('skill-check') }
}

/** A's workshop agent holding `skill` (with the ERP slot and script), shared to `people` over main's publish. */
async function shareFromA(a: PersonApp, fixture: CatalogFixture, skill: string, people: CatalogFixture['people']['b'][]) {
  const workshop = await buildAgent(a, fixture, { name: uniqueName(fixture, 'Skill workshop'), skill: { name: skill, ...erpSkill } })
  const item = await publishSkill(a, workshop.id, skill, { people })
  expect(item?.access).toBe('maintain')
  return { workshop, item }
}

/**
 * A command `skill-check` on `agent` that runs the cached skill's own script by
 * its absolute path. `uv run python <file>`, not `python3 <file>`: the runner
 * turns `python …` into `uv run …`, which runs only a `.py` file as a script.
 */
async function addSkillCheckCommand(app: PersonApp, agent: BuiltAgent, cached: string): Promise<void> {
  const file = join(agent.path, 'docs/CLI_COMMANDS.yaml')
  writeFileSync(
    file,
    `${readFileSync(file, 'utf8')}  - name: skill-check\n    description: The catalog skill's own script.\n    command: uv run python ${JSON.stringify(join(cached, 'scripts/skill_check'))}\n`
  )
  await app.page.evaluate(() => window.api.localAgents.rescan())
}

/** Every Inbox card's accessible name, as the Inbox shows them now. */
async function inboxCards(app: PersonApp): Promise<string[]> {
  await app.page.getByRole('button', { name: /^Inbox/ }).click()
  await expect(app.page.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible()
  const cards = app.page.getByRole('article')
  const names: string[] = []
  for (let i = 0; i < (await cards.count()); i++) names.push((await cards.nth(i).getAttribute('aria-label')) ?? (await cards.nth(i).innerText()))
  return names
}

/**
 * T3.1 / T3.2: B holds A's skill in B's own agent, A withdraws B's access
 * `how`, and B's cached copy keeps working while a new download is refused.
 */
async function withdrawnWhileHeld(
  team: { fixture: CatalogFixture; open: (label: 'a' | 'b') => Promise<PersonApp> },
  how: 'grant' | 'private'
): Promise<void> {
  const { fixture } = team
  const { a: personA, b: personB } = fixture.people
  const skill = skillName(how === 'grant' ? 'erp-revoked' : 'erp-private')
  const mine = uniqueName(fixture, 'Ledger bot')

  const a = await team.open('a')
  const { item } = await shareFromA(a, fixture, skill, [personB])
  expect((await skillItem(fixture, personB.token, skill))?.access).toBe('use')

  const b = await team.open('b')
  await b.page.evaluate(() => window.api.settings.set('autoChatTitles', false))
  const fake = await useFakeOpenCode(b, ollama.host, MODEL)
  const agent = await buildAgent(b, fixture, { name: mine })
  await addSkillToAgent(b, skill, mine)
  await expect.poll(() => cachedSkillDir(b, item.uuid, 1, skill), { timeout: 30_000 }).not.toBeNull()
  const cached = cachedSkillDir(b, item.uuid, 1, skill)!
  await expect.poll(() => skillSlotStates(b, agent.id), { timeout: 30_000 }).toEqual([`erp-api:api_token:connected:${fixture.credentials.erp.name}`])
  await addSkillCheckCommand(b, agent, cached)

  await test.step(how === 'grant' ? 'A takes B’s grant away (core PUT …/grants: A alone, maintain)' : 'A makes the skill private (core PATCH visibility private)', async () => {
    if (how === 'grant') {
      const put = await coreCall(fixture, personA.token, `/catalog/items/${item.uuid}/grants`, {
        method: 'PUT',
        body: [{ principal: { user_id: personA.id }, access: 'maintain' }]
      })
      expect(put.status, JSON.stringify(put.body)).toBe(200)
    } else {
      const patch = await coreCall(fixture, personA.token, `/catalog/items/${item.uuid}`, { method: 'PATCH', body: { visibility: 'private' } })
      expect(patch.status, JSON.stringify(patch.body)).toBe(200)
      expect((await skillItem(fixture, personA.token, skill))?.visibility).toBe('private')
    }
    expect(await skillItem(fixture, personB.token, skill)).toBeUndefined()
    // A new download of the very revision B holds: core answers 404 to B.
    expect(await skillDownloadStatus(fixture, personB.token, item.uuid, 1)).toBe(404)
  })

  await test.step('B, after a restart and a fresh listing: the catalog no longer lists the skill', async () => {
    await b.relaunch()
    await refreshLibrary(b)
    await expectSkillNotListed(b, skill)
  })

  await test.step('B’s cached copy keeps working: the row warns it is no longer in the catalog, the skill’s script reads the ERP slot', async () => {
    await openSkills(b, mine)
    const row = skillRow(b, skill, 'From the catalog')
    // A warning, not an error: the copy is still delivered (the next steps run it and link it).
    await expect(row.getByRole('img', { name: NOT_IN_CATALOG, exact: true })).toBeVisible()
    await expect(row.getByRole('listitem')).toHaveText([NOT_IN_CATALOG])
    await runCommand(b, mine, 'skill-check')
    await expect(b.page.getByText(slotCheckLine(fixture, 'skill-check'))).toBeVisible({ timeout: 60_000 })
  })

  await test.step('…and is still linked for the engines: OpenCode’s next turn gets the link to the cached revision, allowed by name', async () => {
    const before = fake.received('session/prompt').length
    await startAgentChat(b, mine, `Hello after ${how === 'grant' ? 'the revoke' : 'going private'}.`)
    await expect.poll(() => fake.received('session/prompt').length, { timeout: 60_000 }).toBeGreaterThan(before)
    const links = join(skillsPluginDir(b, agent.id), 'skills')
    expect(readdirSync(links)).toEqual([skill])
    expect(readlinkSync(join(links, skill))).toBe(cached)
    const written = openCodeConfigOf(b, agent.id)
    expect(written?.config.skills.paths).toContain(links)
    expect(written?.entry.permission.skill).toEqual({ '*': 'ask', 'cinna-tasks': 'allow', [skill]: 'allow' })
  })

  await test.step('a new download is refused: with the copy gone, Try again fails on the row in words', async () => {
    dropCachedRevision(b, item.uuid, 1, skill)
    // A copy gone behind the app's back reaches an agent page only on a fresh read: a later start.
    await b.relaunch()
    await openSkills(b, mine)
    const row = skillRow(b, skill, 'From the catalog')
    await expect(row.getByRole('img', { name: NOT_HERE, exact: true })).toBeVisible()
    await row.getByRole('button', { name: `Download ${skill} again`, exact: true }).click()
    // B's own agent, no team behind it: the 404 is B's access gone, not a version B is behind on.
    await expect(row.getByRole('img', { name: WITHDRAWN, exact: true })).toBeVisible({ timeout: 60_000 })
    await expect(row.getByRole('listitem')).toHaveText([WITHDRAWN])
    expect(cachedSkillDir(b, item.uuid, 1, skill)).toBeNull()
  })

  await test.step('the Inbox, as it stands', async () => {
    const cards = await inboxCards(b)
    test.info().annotations.push({ type: `inbox after ${how}`, description: JSON.stringify(cards) })
    // Nothing in the Inbox may offer an update of a skill B can no longer download.
    expect(cards.filter((name) => name.includes(skill) && name.startsWith('Update available'))).toEqual([])
  })
}

test('T3.1 A revokes B’s grant: B’s cached copy keeps working and stays linked; a new download is refused, and the row says so', async ({ team }) => {
  test.setTimeout(480_000)
  await withdrawnWhileHeld(team, 'grant')
})

test('T3.2 A makes the skill private: B’s cached copy keeps working and stays linked; a new download is refused, and the row says so', async ({ team }) => {
  test.setTimeout(480_000)
  await withdrawnWhileHeld(team, 'private')
})

test('T3.3 A cannot delete a skill B holds; once B removes it from their agent (reported to core), A’s delete succeeds', async ({ team }) => {
  test.setTimeout(420_000)
  const { fixture } = team
  const { a: personA, b: personB } = fixture.people
  const skill = skillName('erp-held')
  const mine = uniqueName(fixture, 'Ledger bot')

  const a = await team.open('a')
  const { item } = await shareFromA(a, fixture, skill, [personB])

  const b = await team.open('b')
  const agent = await buildAgent(b, fixture, { name: mine })
  await addSkillToAgent(b, skill, mine)
  await expect.poll(() => skillLocalInstalls(fixture, personB.token, skill), { timeout: 20_000 }).toEqual([`${agent.manifestId.toLowerCase()}@1`])

  await test.step('A deletes the skill while B holds it: core refuses with its guard sentence (the desktop offers no skill delete)', async () => {
    const refused = await coreCall(fixture, personA.token, `/catalog/items/${item.uuid}`, { method: 'DELETE' })
    expect(refused.status).toBe(409)
    expect(refused.body?.detail).toBe('1 person uses this. It can be removed once nobody does.')
    expect((await skillItem(fixture, personA.token, skill))?.install_count).toBe(1)
  })

  await test.step('B removes it from the agent through the Skills row: the pin goes, core hears of the removal', async () => {
    await removeSkillFromAgent(b, mine, skill)
    expect(catalogPins(agent.path)).toEqual([])
    await expect.poll(() => skillLocalInstalls(fixture, personB.token, skill), { timeout: 20_000 }).toEqual([])
    expect((await skillItem(fixture, personA.token, skill))?.install_count).toBe(0)
  })

  await test.step('A’s delete now succeeds; the skill is gone for both', async () => {
    const deleted = await coreCall(fixture, personA.token, `/catalog/items/${item.uuid}`, { method: 'DELETE' })
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(204)
    expect(await skillItem(fixture, personA.token, skill)).toBeUndefined()
    expect(await skillItem(fixture, personB.token, skill)).toBeUndefined()
  })
})

test('T3.4 U7 behind: C, whose clone of A’s agent still pins Version 1, cannot fetch it once the team moved to Version 2; after C updates the agent, Version 2 downloads', async ({ team }) => {
  test.setTimeout(600_000)
  const { fixture } = team
  const { a: personA, c: personC } = fixture.people
  const skill = skillName('erp-behind')
  const name = uniqueName(fixture, 'Report bot')

  const a = await team.open('a')
  // Shared with nobody: C reaches it only through the agent's pin (U7).
  const { workshop, item } = await shareFromA(a, fixture, skill, [])
  const x = await buildAgent(a, fixture, { name })
  await refreshLibrary(a)
  const added = await a.page.evaluate((args) => window.api.catalogSkills.add(args.id, args.uuid), { id: x.id, uuid: item.uuid })
  expect(added.ok, JSON.stringify(added)).toBe(true)
  await shareWithTeam(a, name, [{ person: personC }])

  const c = await team.open('c')
  expect(await skillItem(fixture, personC.token, skill)).toBeUndefined()
  await getAgent(c, name)
  await expect.poll(() => cachedSkillDir(c, item.uuid, 1, skill), { timeout: 30_000 }).not.toBeNull()
  const got = (await c.page.evaluate(() => window.api.localAgents.list())).agents.find((row) => row.name === name)!

  await test.step('A shares Version 2 of the skill, moves the agent’s pin to it and shares the change', async () => {
    appendFileSync(join(workshop.path, 'skills', skill, 'SKILL.md'), '\nVersion two.\n')
    await publishSkill(a, workshop.id, skill, { releaseNotes: 'Two' })
    await refreshLibrary(a)
    const updated = await a.page.evaluate((args) => window.api.catalogSkills.update(args.id, args.name), { id: x.id, name: skill })
    expect(updated, JSON.stringify(updated)).toMatchObject({ ok: true, revisionNumber: 2 })
    await shareChanges(a, name, `Moves ${skill} to Version 2`)
    expect(catalogPins(x.path)).toEqual([expect.objectContaining({ name: skill, revision_number: 2 })])
  })

  await test.step('core: C may fetch Version 2 through the team’s latest, no longer Version 1', async () => {
    expect(await skillDownloadStatus(fixture, personC.token, item.uuid, 1)).toBe(404)
    expect(await skillDownloadStatus(fixture, personC.token, item.uuid, 2)).toBe(200)
  })

  await test.step('C, behind, with Version 1 gone from this computer: Try again says to update the agent first', async () => {
    expect(catalogPins(got.path)).toEqual([expect.objectContaining({ name: skill, revision_number: 1 })])
    dropCachedRevision(c, item.uuid, 1, skill)
    // A copy gone behind the app's back reaches an agent page only on a fresh read: a later start.
    await c.relaunch()
    await openSkills(c, name)
    const row = skillRow(c, skill, 'From the catalog')
    await expect(row.getByRole('img', { name: NOT_HERE, exact: true })).toBeVisible()
    await row.getByRole('button', { name: `Download ${skill} again`, exact: true }).click()
    await expect(row.getByRole('img', { name: NOT_AVAILABLE, exact: true })).toBeVisible({ timeout: 60_000 })
    await expect(row.getByRole('listitem')).toHaveText([NOT_AVAILABLE])
    expect(cachedSkillDir(c, item.uuid, 1, skill)).toBeNull()
  })

  await test.step('C updates the agent from the catalog: the pin moves to Version 2, which downloads, and the row is ready', async () => {
    await refreshLibrary(c)
    await updateFromCatalog(c, name)
    expect(catalogPins(got.path)).toEqual([expect.objectContaining({ name: skill, revision_number: 2 })])
    await expect.poll(() => cachedSkillDir(c, item.uuid, 2, skill), { timeout: 60_000 }).not.toBeNull()
    await openSkills(c, name)
    await expect(skillRow(c, skill, 'From the catalog').getByRole('img', { name: READY, exact: true })).toBeVisible({ timeout: 30_000 })
  })
})

test('T3.5 Remove detaches the ERP credential the skill slot attached by itself, never one B attached by hand', async ({ team }) => {
  test.setTimeout(480_000)
  const { fixture } = team
  const { b: personB } = fixture.people
  const erp = fixture.credentials.erp
  const skill = skillName('erp-detach')
  const auto = uniqueName(fixture, 'Auto bot')
  const hand = uniqueName(fixture, 'Hand bot')

  const a = await team.open('a')
  const { item } = await shareFromA(a, fixture, skill, [personB])

  const b = await team.open('b')
  const autoAgent = await buildAgent(b, fixture, { name: auto })
  const handAgent = await buildAgent(b, fixture, { name: hand })
  await refreshLibrary(b)

  await test.step('Hand bot: B attaches the ERP API by hand first, then adds the skill — the slot keeps B’s choice, unmarked', async () => {
    const attached = await b.page.evaluate(
      async ({ id, cloudId }) => {
        const options = await window.api.serviceCredentials.attachOptions(id)
        if (!options.ok) return options.message
        for (const group of options.value.groups) {
          const found = group.items.find((record) => record.cloudId === cloudId)
          if (found) {
            const result = await window.api.serviceCredentials.attach(id, group.key, found.cloudId!)
            return result.ok ? 'ok' : result.message
          }
        }
        return 'no ERP record offered'
      },
      { id: handAgent.id, cloudId: erp.id }
    )
    expect(attached).toBe('ok')
    const added = await b.page.evaluate((args) => window.api.catalogSkills.add(args.id, args.uuid), { id: handAgent.id, uuid: item.uuid })
    expect(added.ok, JSON.stringify(added)).toBe(true)
    await expect.poll(() => skillSlotStates(b, handAgent.id), { timeout: 30_000 }).toEqual([`erp-api:api_token:connected:${erp.name}`])
    expect(storedAttachments(handAgent.path)).toEqual([`account:${erp.id}`])
  })

  await test.step('Auto bot: adding the skill attaches the ERP API by itself, marked with the slot it filled', async () => {
    const added = await b.page.evaluate((args) => window.api.catalogSkills.add(args.id, args.uuid), { id: autoAgent.id, uuid: item.uuid })
    expect(added.ok, JSON.stringify(added)).toBe(true)
    await expect.poll(() => storedAttachments(autoAgent.path), { timeout: 30_000 }).toEqual([`account:${erp.id} auto:erp-api`])
    await expect.poll(() => skillSlotStates(b, autoAgent.id), { timeout: 30_000 }).toEqual([`erp-api:api_token:connected:${erp.name}`])
  })

  await test.step('B removes the skill from Hand bot, then from Auto bot, on their Skills rows', async () => {
    await removeSkillFromAgent(b, hand, skill)
    await removeSkillFromAgent(b, auto, skill)
    expect(catalogPins(handAgent.path)).toEqual([])
    expect(catalogPins(autoAgent.path)).toEqual([])
  })

  await test.step('Auto bot: the self-attached ERP API is detached — Desktop State and the Credentials tab', async () => {
    await expect.poll(() => storedAttachments(autoAgent.path), { timeout: 30_000 }).toEqual([])
    await openAgent(b, auto)
    await b.page.getByRole('button', { name: 'Settings', exact: true }).click()
    await b.page.getByRole('tablist', { name: 'Agent details' }).getByRole('tab', { name: /^Credentials/ }).click()
    await expect(b.page.getByText('No credentials attached.', { exact: true })).toBeVisible()
    await expect(b.page.getByRole('button', { name: `Detach ${erp.name}`, exact: true })).toHaveCount(0)
  })

  await test.step('Hand bot (removed first): B’s own attachment stays — Desktop State and the Credentials tab', async () => {
    expect(storedAttachments(handAgent.path)).toEqual([`account:${erp.id}`])
    await openAgent(b, hand)
    await b.page.getByRole('button', { name: 'Settings', exact: true }).click()
    await b.page.getByRole('tablist', { name: 'Agent details' }).getByRole('tab', { name: /^Credentials/ }).click()
    await expect(b.page.getByRole('button', { name: `Detach ${erp.name}`, exact: true })).toBeVisible()
    await expect(b.page.getByText(erp.name, { exact: true })).toBeVisible()
  })
})

test('T3.6 the next start removes cached revisions no agent pins: Version 1 after an Update, a removed skill’s revision; the pinned Version 2 stays', async ({ team }) => {
  test.setTimeout(480_000)
  const { fixture } = team
  const { b: personB } = fixture.people
  const kept = skillName('erp-kept')
  const dropped = skillName('erp-dropped')
  const mine = uniqueName(fixture, 'Ledger bot')

  const a = await team.open('a')
  const { workshop, item } = await shareFromA(a, fixture, kept, [personB])
  writeSkill(workshop.path, dropped, { description: 'A skill B will remove.', body: 'Say hello.\n' })
  await a.page.evaluate(() => window.api.localAgents.rescan())
  const droppedItem = await publishSkill(a, workshop.id, dropped, { people: [personB] })

  const b = await team.open('b')
  const agent = await buildAgent(b, fixture, { name: mine })
  await refreshLibrary(b)
  for (const uuid of [item.uuid, droppedItem.uuid]) {
    const added = await b.page.evaluate((args) => window.api.catalogSkills.add(args.id, args.uuid), { id: agent.id, uuid })
    expect(added.ok, JSON.stringify(added)).toBe(true)
  }

  await test.step('A shares Version 2; B updates the row to it and removes the other skill: all three revisions are still cached', async () => {
    appendFileSync(join(workshop.path, 'skills', kept, 'SKILL.md'), '\nVersion two.\n')
    await publishSkill(a, workshop.id, kept, { releaseNotes: 'Two' })
    await refreshLibrary(b)
    await openSkills(b, mine)
    await skillRow(b, kept, 'From the catalog').getByRole('button', { name: new RegExp(`^Update ${kept} to Version 2`) }).click()
    await expect.poll(() => catalogPins(agent.path).find((pin) => pin.name === kept)?.revision_number, { timeout: 60_000 }).toBe(2)
    await removeSkillFromAgent(b, mine, dropped)
    expect(catalogPins(agent.path).map((pin) => `${pin.name}@${pin.revision_number}`)).toEqual([`${kept}@2`])
    expect(cachedSkillDir(b, item.uuid, 1, kept)).not.toBeNull()
    expect(cachedSkillDir(b, item.uuid, 2, kept)).not.toBeNull()
    expect(cachedSkillDir(b, droppedItem.uuid, 1, dropped)).not.toBeNull()
  })

  await test.step('after a restart only the pinned Version 2 is left, and the row is ready', async () => {
    await b.relaunch()
    await expect.poll(() => cachedSkillDir(b, item.uuid, 1, kept), { timeout: 30_000 }).toBeNull()
    await expect.poll(() => cachedSkillDir(b, droppedItem.uuid, 1, dropped), { timeout: 30_000 }).toBeNull()
    expect(cachedSkillDir(b, item.uuid, 2, kept)).not.toBeNull()
    const packages = readdirSync(dirname2(cachedSkillDir(b, item.uuid, 2, kept)!, 3))
    expect(packages).not.toContain(droppedItem.uuid)
    await openSkills(b, mine)
    await expect(skillRow(b, kept, 'From the catalog').getByRole('img', { name: READY, exact: true })).toBeVisible()
  })
})

/** `path` with its last `levels` segments dropped. */
function dirname2(path: string, levels: number): string {
  return path.split('/').slice(0, -levels).join('/')
}
