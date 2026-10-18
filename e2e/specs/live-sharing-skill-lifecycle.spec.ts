import { appendFileSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  test,
  expect,
  addSkillToAgent,
  addToWhoCanUse,
  buildAgent,
  cachedSkillDir,
  catalogPins,
  dropCachedRevision,
  expectSkillNotListed,
  getAgent,
  openCodeConfigOf,
  openSkills,
  openWhoCanUse,
  publishSkill,
  removeFromWhoCanUse,
  removeSkillFromAgent,
  searchSkills,
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
import { catalogGrants, coreCall, openAgent, refreshLibrary, runCommand, shareChanges, shareWithTeam, type PersonApp } from '../fixtures/liveTeamSharing'

/**
 * T3 — a catalog skill's life after install, against the real local
 * cinna-core (`e2e/fixtures/live-catalog.py`, people A–D):
 *
 * - T3.1 / T3.2 A withdraws B's access through A's own Who can use dialog
 *   (the authored Skills row's `Who can use <skill>…`): T3.1 promotes B to Can
 *   edit, then removes B; T3.2 shares with everyone, then removes B and
 *   Everyone. B's copy turns Disconnected (row warning, Inbox card). T3.1
 *   then dismisses the card, has A share with B again (connected, the
 *   dismissal forgotten), removes B once more (a new card) and removes the
 *   pin from the card. The dialog never writes `visibility: private` — with
 *   Everyone gone it asks for `users` — so T3.2 ends at `users` with A alone.
 *   A still deletes a skill over core's REST (`DELETE /catalog/items/{uuid}`):
 *   the desktop has no skill delete.
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
const SHOTS = '/tmp/cinna-live/shots'

/** A screenshot for a human to look at, outside the repository. */
async function shot(app: PersonApp, file: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true })
  await app.page.screenshot({ path: join(SHOTS, file), animations: 'disabled' })
}
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
/** The row's Disconnected warning once a loaded listing no longer has the package, on an agent no team tracks. */
const NOT_IN_CATALOG =
  'Disconnected — this skill is no longer in the catalog for you. The copy on this computer is now a local version: it keeps working but no longer syncs or gets updates.'
/** The row once a download of a pin with no copy here was refused as not available, where the Inbox card applies too. */
const DISCONNECTED_NOT_CACHED =
  'Disconnected — this skill is no longer in the catalog for you, so this agent can’t download it. Ask a maintainer for access, or remove it.'
/** The Disconnected card's body, with the copy still on this computer… */
const CARD_CACHED =
  'It is no longer in the catalog for you. The copy on this computer keeps working as a local version, but it no longer syncs or gets updates.'
/** …and with none, its download refused. */
const CARD_NOT_CACHED = 'It is no longer in the catalog for you, so this agent can’t download it. Ask a maintainer for access, or remove it.'
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
  await openInbox(app)
  const cards = app.page.getByRole('article')
  const names: string[] = []
  for (let i = 0; i < (await cards.count()); i++) names.push((await cards.nth(i).getAttribute('aria-label')) ?? (await cards.nth(i).innerText()))
  return names
}

/**
 * The Inbox, freshly mounted: leaving for the Agents tab first, since a card
 * acted on keeps its place until the view is left.
 */
async function openInbox(app: PersonApp): Promise<void> {
  await app.page.getByRole('button', { name: 'Agents', exact: true }).click()
  await app.page.getByRole('button', { name: /^Inbox/ }).click()
  await expect(app.page.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible()
}

/** The Inbox's "Disconnected" card for `skill` in `agent`: its title leads with the state. */
function disconnectedCard(app: PersonApp, skill: string, agent: string) {
  return app.page.getByRole('article', { name: `Disconnected: ${skill} in ${agent}`, exact: true })
}

/** Main's own Inbox read (what the view's poll runs): the Disconnected cards it answers, as `<skill>@<agent>`. */
async function disconnectedRead(app: PersonApp): Promise<string[]> {
  const read = await app.page.evaluate(() => window.api.inbox.list())
  return (read.disconnected ?? []).map((item) => `${item.skillName}@${item.agentName}`)
}

/**
 * T3.1 / T3.2: B holds A's skill in B's own agent, A withdraws B's access
 * `how` through A's own Who can use dialog, and B's cached copy keeps
 * working, Disconnected, while a new download is refused.
 */
async function withdrawnWhileHeld(
  team: { fixture: CatalogFixture; open: (label: 'a' | 'b') => Promise<PersonApp> },
  how: 'grant' | 'everyone'
): Promise<void> {
  const { fixture } = team
  const { a: personA, b: personB } = fixture.people
  const skill = skillName(how === 'grant' ? 'erp-revoked' : 'erp-unshared')
  const mine = uniqueName(fixture, 'Ledger bot')
  const grants = () => catalogGrants(fixture, personA.token, item.uuid)
  const onlyA = [`user:${personA.id}:maintain`]

  const a = await team.open('a')
  const { workshop, item } = await shareFromA(a, fixture, skill, [personB])
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

  if (how === 'grant') {
    await test.step('B, who can only use it, has no Who can use on their row', async () => {
      await openSkills(b, mine)
      await expect(skillRow(b, skill, 'From the catalog').getByRole('img', { name: READY, exact: true })).toBeVisible({ timeout: 30_000 })
      await expect(b.page.getByRole('button', { name: `Who can use ${skill}…`, exact: true })).toHaveCount(0)
    })

    await test.step('A promotes B to Can edit from the Skills row’s Who can use (core grants: edit)', async () => {
      const dialog = await openWhoCanUse(a, workshop.name, skill)
      const access = dialog.getByRole('combobox', { name: `Access for ${personB.name}`, exact: true })
      await expect(access).toHaveValue('use')
      await expect(dialog.getByRole('button', { name: 'Share with everyone', exact: true })).toBeVisible()
      await shot(a, 'who-can-use-people.png')
      await access.selectOption('edit')
      await expect.poll(grants, { timeout: 30_000 }).toEqual([`user:${personA.id}:maintain`, `user:${personB.id}:edit`].sort())
      await expect(access).toHaveValue('edit')
      await dialog.getByRole('button', { name: 'Close', exact: true }).click()
      await expect(dialog).toHaveCount(0)
    })
  }

  await test.step(
    how === 'grant' ? 'A removes B in Who can use (core: A alone)' : 'A shares with everyone, removes B, then removes Everyone (core: public, then users with A alone)',
    async () => {
      const dialog = await openWhoCanUse(a, workshop.name, skill)
      if (how === 'everyone') {
        await dialog.getByRole('button', { name: 'Share with everyone', exact: true }).click()
        await expect(dialog.getByRole('button', { name: 'Remove Everyone on this server', exact: true })).toBeVisible({ timeout: 30_000 })
        await expect(dialog.getByRole('button', { name: 'Share with everyone', exact: true })).toHaveCount(0)
        await expect.poll(async () => (await skillItem(fixture, personA.token, skill))?.visibility, { timeout: 30_000 }).toBe('public')
        await removeFromWhoCanUse(dialog, personB.name)
        await expect.poll(grants, { timeout: 30_000 }).toEqual(onlyA)
        // Still public: B keeps it through Everyone.
        expect((await skillItem(fixture, personB.token, skill))?.access).toBe('use')
        await removeFromWhoCanUse(dialog, 'Everyone on this server')
        // The dialog never writes `private`: with Everyone gone it asks for `users`, where only grants count.
        await expect.poll(async () => (await skillItem(fixture, personA.token, skill))?.visibility, { timeout: 30_000 }).toBe('users')
        await expect(dialog.getByText('No one else has access yet.', { exact: true })).toBeVisible()
      } else {
        await removeFromWhoCanUse(dialog, personB.name)
        await expect(dialog.getByText('No one else has access yet.', { exact: true })).toBeVisible()
      }
      expect(await grants()).toEqual(onlyA)
      await dialog.getByRole('button', { name: 'Close', exact: true }).click()
      await expect(dialog).toHaveCount(0)
      expect(await skillItem(fixture, personB.token, skill)).toBeUndefined()
      // A new download of the very revision B holds: core answers 404 to B.
      expect(await skillDownloadStatus(fixture, personB.token, item.uuid, 1)).toBe(404)
    }
  )

  await test.step('B, after a restart and a fresh listing: the catalog no longer lists the skill', async () => {
    await b.relaunch()
    await refreshLibrary(b)
    await expectSkillNotListed(b, skill)
  })

  await test.step('B’s cached copy keeps working: the row says Disconnected, the skill’s script reads the ERP slot', async () => {
    await openSkills(b, mine)
    const row = skillRow(b, skill, 'From the catalog')
    // A warning, not an error: the copy is still delivered (the next steps run it and link it).
    await expect(row.getByRole('img', { name: NOT_IN_CATALOG, exact: true })).toBeVisible()
    await expect(row.getByRole('listitem')).toHaveText([NOT_IN_CATALOG])
    if (how === 'grant') await shot(b, 'disconnected-row.png')
    await runCommand(b, mine, 'skill-check')
    await expect(b.page.getByText(slotCheckLine(fixture, 'skill-check'))).toBeVisible({ timeout: 60_000 })
  })

  await test.step('…and is still linked for the engines: OpenCode’s next turn gets the link to the cached revision, allowed by name', async () => {
    const before = fake.received('session/prompt').length
    await startAgentChat(b, mine, `Hello after ${how === 'grant' ? 'the revoke' : 'the unshare'}.`)
    await expect.poll(() => fake.received('session/prompt').length, { timeout: 60_000 }).toBeGreaterThan(before)
    const links = join(skillsPluginDir(b, agent.id), 'skills')
    expect(readdirSync(links)).toEqual([skill])
    expect(readlinkSync(join(links, skill))).toBe(cached)
    const written = openCodeConfigOf(b, agent.id)
    expect(written?.config.skills.paths).toContain(links)
    expect(written?.entry.permission.skill).toEqual({ '*': 'ask', 'cinna-tasks': 'allow', 'cinna-artifacts': 'allow', [skill]: 'allow' })
  })

  await test.step('B’s Inbox has the Disconnected card: the agent, Remove, Dismiss', async () => {
    await openInbox(b)
    const card = disconnectedCard(b, skill, mine)
    await expect(card).toBeVisible({ timeout: 20_000 })
    await expect(card.getByRole('button')).toHaveText([mine, 'Remove', 'Dismiss'])
    await expect(card.getByText(CARD_CACHED, { exact: true })).toBeVisible()
    if (how === 'grant') await shot(b, 'disconnected-inbox-card.png')
  })

  if (how === 'grant') {
    await test.step('Dismiss: the card says so, and is gone from the next Inbox', async () => {
      const card = disconnectedCard(b, skill, mine)
      await card.getByRole('button', { name: 'Dismiss', exact: true }).click()
      await expect(card.getByRole('status')).toHaveText('Dismissed. It shows again only if this skill is disconnected again.')
      await openInbox(b)
      await expect(b.page.getByRole('article').first().or(b.page.getByText('Nothing is waiting on you.', { exact: true }))).toBeVisible({ timeout: 20_000 })
      await expect(disconnectedCard(b, skill, mine)).toHaveCount(0)
    })

    await test.step('A shares it with B again through Share with a person…: B’s row is connected again, and no card', async () => {
      const dialog = await openWhoCanUse(a, workshop.name, skill)
      await addToWhoCanUse(dialog, personB, 'use', () => shot(a, 'who-can-use-add-form.png'))
      await expect.poll(grants, { timeout: 30_000 }).toEqual([`user:${personA.id}:maintain`, `user:${personB.id}:use`].sort())
      await dialog.getByRole('button', { name: 'Close', exact: true }).click()
      await expect(dialog).toHaveCount(0)
      expect((await skillItem(fixture, personB.token, skill))?.access).toBe('use')

      await refreshLibrary(b)
      await openSkills(b, mine)
      await expect(skillRow(b, skill, 'From the catalog').getByRole('img', { name: READY, exact: true })).toBeVisible({ timeout: 30_000 })
      await openInbox(b)
      await expect(disconnectedCard(b, skill, mine)).toHaveCount(0)
      // Main's read while connected: no card, and the dismissal is forgotten.
      expect(await disconnectedRead(b)).toEqual([])
    })

    await test.step('A removes B again: B’s row is Disconnected again and a new card appears', async () => {
      const dialog = await openWhoCanUse(a, workshop.name, skill)
      await removeFromWhoCanUse(dialog, personB.name)
      await expect.poll(grants, { timeout: 30_000 }).toEqual(onlyA)
      await dialog.getByRole('button', { name: 'Close', exact: true }).click()
      await expect(dialog).toHaveCount(0)

      await refreshLibrary(b)
      await openSkills(b, mine)
      await expect(skillRow(b, skill, 'From the catalog').getByRole('img', { name: NOT_IN_CATALOG, exact: true })).toBeVisible({ timeout: 30_000 })
      await openInbox(b)
      await expect(disconnectedCard(b, skill, mine)).toBeVisible({ timeout: 20_000 })
    })

    await test.step('B removes it from the card: confirm, Removed, the pin is gone and core hears of it', async () => {
      expect((await skillItem(fixture, personA.token, skill))?.install_count).toBe(1)
      const card = disconnectedCard(b, skill, mine)
      await card.getByRole('button', { name: 'Remove', exact: true }).click()
      const confirm = card.getByRole('group', { name: `Remove ${skill} from ${mine}`, exact: true })
      await confirm.getByRole('button', { name: 'Remove skill', exact: true }).click()
      await expect(card.getByRole('status')).toHaveText(`Removed. ${skill} is no longer in ${mine}.`, { timeout: 30_000 })
      expect(catalogPins(agent.path)).toEqual([])
      // B no longer sees the item, so core's record is read as A: nobody holds it.
      await expect.poll(async () => (await skillItem(fixture, personA.token, skill))?.install_count, { timeout: 20_000 }).toBe(0)
      await openInbox(b)
      await expect(disconnectedCard(b, skill, mine)).toHaveCount(0)
    })
    return
  }

  await test.step('a new download is refused: with the copy gone, the next start’s background fetch turns the row Disconnected — Check again instead of Try again, Remove stays', async () => {
    dropCachedRevision(b, item.uuid, 1, skill)
    // A copy gone behind the app's back reaches an agent page only on a fresh read: a later start.
    await b.relaunch()
    await openSkills(b, mine)
    const row = skillRow(b, skill, 'From the catalog')
    // No click: the start's profile-ready sweep fetches the missing pin in the background (`pinnedSkillAutoFetch.ts`).
    // B's own agent, no team behind it: the 404 is B's access gone — the card's state, not WITHDRAWN with a Try again.
    await expect(row.getByRole('img', { name: DISCONNECTED_NOT_CACHED, exact: true })).toBeVisible({ timeout: 60_000 })
    await expect(row.getByRole('listitem')).toHaveText([DISCONNECTED_NOT_CACHED])
    await expect(row.getByRole('img', { name: WITHDRAWN, exact: true })).toHaveCount(0)
    await expect(row.getByRole('button', { name: `Download ${skill} again`, exact: true })).toHaveCount(0)
    // Still refused: Check again leaves the row Disconnected, with no error line.
    const check = row.getByRole('button', { name: `Check ${skill} again`, exact: true })
    await check.click()
    await expect(check).toBeEnabled({ timeout: 60_000 })
    await expect(row.getByRole('listitem')).toHaveText([DISCONNECTED_NOT_CACHED])
    await expect(row.getByRole('alert')).toHaveCount(0)
    await expect(row.getByRole('button', { name: `Remove ${skill} from this agent`, exact: true })).toBeVisible()
    expect(cachedSkillDir(b, item.uuid, 1, skill)).toBeNull()
  })

  await test.step('…and the Inbox card says the agent cannot download it', async () => {
    await openInbox(b)
    const card = disconnectedCard(b, skill, mine)
    await expect(card).toBeVisible({ timeout: 20_000 })
    await expect(card.getByText(CARD_NOT_CACHED, { exact: true })).toBeVisible()
    await expect(card.getByRole('button')).toHaveText([mine, 'Remove', 'Dismiss'])
    await shot(b, 'disconnected-inbox-card-not-cached.png')
  })

  await test.step('the Inbox, as it stands', async () => {
    const cards = await inboxCards(b)
    test.info().annotations.push({ type: `inbox after ${how}`, description: JSON.stringify(cards) })
    // Nothing in the Inbox may offer an update of a skill B can no longer download.
    expect(cards.filter((name) => name.includes(skill) && name.startsWith('Update available'))).toEqual([])
  })
}

test('T3.1 A removes B in Who can use: B’s copy keeps working and stays linked, Disconnected; the card dismisses, a re-share reconnects it, a second removal brings a new card, and its Remove takes the pin out', async ({ team }) => {
  test.setTimeout(600_000)
  await withdrawnWhileHeld(team, 'grant')
})

test('T3.2 A shares with everyone, then removes B and Everyone in Who can use: B’s copy keeps working and stays linked, the card appears; a new download is refused, and the row says so', async ({ team }) => {
  test.setTimeout(480_000)
  await withdrawnWhileHeld(team, 'everyone')
})

test('T3.7 A opens Who can use from the catalog’s skill detail, and closes it back onto the detail', async ({ team }) => {
  test.setTimeout(240_000)
  const { fixture } = team
  const skill = skillName('erp-detail')
  const a = await team.open('a')
  await shareFromA(a, fixture, skill, [fixture.people.b])
  const { catalog, tile } = await searchSkills(a, skill)
  await tile.getByRole('button', { name: skill, exact: true }).click()
  await expect(catalog.getByRole('heading', { level: 3, name: skill, exact: true })).toBeVisible()
  await catalog.getByRole('button', { name: `Who can use ${skill}…`, exact: true }).click()
  const dialog = a.page.getByRole('dialog', { name: `Who can use ${skill}`, exact: true })
  await expect(dialog.getByRole('combobox', { name: `Access for ${fixture.people.b.name}`, exact: true })).toHaveValue('use', { timeout: 30_000 })
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  // The catalog dialog stays, on the detail.
  await expect(catalog.getByRole('heading', { level: 3, name: skill, exact: true })).toBeVisible()
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

  await test.step('C, behind, with Version 1 gone from this computer: the next start’s background fetch says to update the agent first', async () => {
    expect(catalogPins(got.path)).toEqual([expect.objectContaining({ name: skill, revision_number: 1 })])
    dropCachedRevision(c, item.uuid, 1, skill)
    // A copy gone behind the app's back reaches an agent page only on a fresh read: a later start.
    await c.relaunch()
    await openSkills(c, name)
    const row = skillRow(c, skill, 'From the catalog')
    // No click: the start's profile-ready sweep fetches the missing pin in the background (`pinnedSkillAutoFetch.ts`).
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
