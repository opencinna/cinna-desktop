import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  test,
  expect,
  admin,
  agentName,
  buildAcmeReporter,
  findAgent,
  finishDialog,
  finishWithWeather,
  getFromLibrary,
  libraryEntry,
  openAgent,
  refreshLibrary,
  runCommand,
  shareChanges,
  shareWithTeam,
  shortHash,
  slotStates,
  syncCredentials,
  type PersonApp,
  type PersonLabel,
  type SharingFixture,
  type Team
} from '../fixtures/liveTeamSharing'

/**
 * Credentials on Get, Update and Use the team's version, against the real
 * local cinna-core: what is attached without asking, what the Finish setting
 * up dialog offers, and what an admin's revoke, re-share and rotation do to a
 * teammate's copy. Setup: `e2e/fixtures/live-team-sharing.py`.
 */

const access = { read: 'Can use', write: 'Can edit' } as const

/** A builds the agent and shares it with `to`; `to` Gets it. */
async function sharedAndGot(
  team: Team,
  to: PersonLabel,
  level: keyof typeof access = 'read'
): Promise<{ a: PersonApp; other: PersonApp; name: string; aPath: string }> {
  const { fixture } = team
  const name = agentName(fixture)
  const a = await team.open('a')
  const built = await buildAcmeReporter(a, fixture, { name, weatherKey: `weather-a-${fixture.tag}-secret` })
  await shareWithTeam(a, name, [{ person: fixture.people[to], access: access[level] }])
  const other = await team.open(to)
  await getFromLibrary(other, name)
  return { a, other, name, aPath: built.path }
}

/** Every file under `root` (outside `.git` and `.venv`) holding `needle`. */
function filesContaining(root: string, needle: string): string[] {
  try {
    return execFileSync('grep', ['-rl', '--exclude-dir=.git', '--exclude-dir=.venv', '-F', needle, root], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
  } catch {
    return [] // grep exits 1 when nothing matched
  }
}

function acmeHash(fixture: SharingFixture, secret = fixture.credentials.acme.secret): string {
  return shortHash(`Bearer ${secret}`)
}

test('a teammate the credential is not shared with gets no cloud option and nothing of the sharer’s', async ({ team }) => {
  test.setTimeout(300_000)
  const { fixture } = team
  const { other: c, name } = await sharedAndGot(team, 'c')
  const { dialog, row } = finishDialog(c, name)
  await expect(dialog).toBeVisible()
  await expect(row('acme').getByText('Missing', { exact: true })).toBeVisible()
  await expect(row('acme').getByRole('button', { name: 'Use this' })).toHaveCount(0)
  await expect(row('weather').getByText('Missing', { exact: true })).toBeVisible()
  const agent = await findAgent(c, name)
  const setup = await c.page.evaluate((id) => window.api.serviceCredentials.setupState(id), agent.id)
  expect(setup.ok && setup.value.slots.find((s) => s.name === 'acme')?.options).toEqual([])
  expect(existsSync(join(agent.path, 'credentials/credentials.json'))).toBe(false)
  expect(filesContaining(agent.path, `weather-a-${fixture.tag}-secret`)).toEqual([])
  expect(filesContaining(agent.path, fixture.credentials.acme.secret)).toEqual([])
  await dialog.getByRole('button', { name: 'Finish later', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(c.page.getByRole('button', { name: 'Finish setup', exact: true })).toBeVisible()
})

test('two matching records: nothing is attached without asking, the dialog offers both, and the chosen one is used', async ({ team }) => {
  test.setTimeout(300_000)
  const { fixture } = team
  const { other: otherCred } = fixture.credentials
  await admin.share(fixture, otherCred.id, fixture.people.b.email)
  try {
    const { other: b, name } = await sharedAndGot(team, 'b')
    const { dialog, row } = finishDialog(b, name)
    await expect(dialog).toBeVisible()
    await expect(row('acme').getByText('Missing', { exact: true })).toBeVisible()
    await expect(row('acme').getByRole('button', { name: 'Use this' })).toHaveCount(2)
    await expect(row('acme').getByTitle(`Use ${fixture.credentials.acme.name}`, { exact: true })).toBeVisible()
    await row('acme').getByTitle(`Use ${otherCred.name}`, { exact: true }).click()
    await expect(row('acme').getByText('Connected', { exact: true })).toBeVisible()
    await finishWithWeather(b, name, `weather-b-${fixture.tag}-secret`)
    await runCommand(b, name, 'check-creds')
    await expect(
      b.page.getByText(`acme=${acmeHash(fixture, otherCred.secret)} weather=${shortHash(`weather-b-${fixture.tag}-secret`)}`)
    ).toBeVisible({ timeout: 30_000 })
  } finally {
    await admin.unshare(fixture, otherCred.id, fixture.people.b.email)
  }
})

test('the admin revokes the teammate’s share, re-shares it, then rotates the value', async ({ team }) => {
  test.setTimeout(300_000)
  const { fixture } = team
  const { acme } = fixture.credentials
  const rotated = `acme-rotated-${fixture.tag}-secret`
  try {
    const { other: b, name } = await sharedAndGot(team, 'b')
    const weather = `weather-b-${fixture.tag}-secret`
    await expect(finishDialog(b, name).row('acme').getByText('Connected automatically', { exact: true })).toBeVisible()
    await finishWithWeather(b, name, weather)
    const agent = await findAgent(b, name)

    await test.step('revoked: the slot is missing again and Finish setup is offered', async () => {
      await admin.unshare(fixture, acme.id, fixture.people.b.email)
      await syncCredentials(b)
      await expect.poll(async () => (await slotStates(b, agent.id)).acme).toBe('missing')
      await b.page.evaluate(() => window.api.localAgents.rescan())
      await openAgent(b, name)
      await b.page.getByRole('button', { name: 'Finish setup', exact: true }).click()
      const { dialog, row } = finishDialog(b, name)
      await expect(row('acme').getByText('Missing', { exact: true })).toBeVisible()
      await expect(row('weather').getByText('Set on this computer', { exact: true })).toBeVisible()
      await dialog.getByRole('button', { name: 'Finish later', exact: true }).click()
    })

    await test.step('re-shared: the same attachment is ready again', async () => {
      await admin.share(fixture, acme.id, fixture.people.b.email)
      await syncCredentials(b)
      await expect.poll(async () => (await slotStates(b, agent.id)).acme).toBe('connected')
      await runCommand(b, name, 'check-creds')
      await expect(b.page.getByText(`acme=${acmeHash(fixture)} weather=${shortHash(weather)}`)).toBeVisible({ timeout: 30_000 })
    })

    await test.step('rotated: the script reads the new value', async () => {
      await admin.rotate(fixture, acme.id, rotated)
      await syncCredentials(b)
      await expect.poll(() => readFileSync(join(agent.path, 'credentials/credentials.json'), 'utf8').includes(rotated)).toBe(true)
      await runCommand(b, name, 'check-creds')
      await expect(b.page.getByText(`acme=${acmeHash(fixture, rotated)} weather=${shortHash(weather)}`)).toBeVisible({ timeout: 30_000 })
    })
  } finally {
    await admin.rotate(fixture, acme.id, acme.secret)
    if (!(await admin.isSharedWith(fixture, acme.id, fixture.people.b.email))) await admin.share(fixture, acme.id, fixture.people.b.email)
  }
})

test('an empty KEY= in credentials/.env does not satisfy the slot', async ({ team }) => {
  test.setTimeout(300_000)
  const { other: b, name } = await sharedAndGot(team, 'b')
  const { dialog, row } = finishDialog(b, name)
  await dialog.getByRole('button', { name: 'Finish later', exact: true }).click()
  const agent = await findAgent(b, name)
  for (const line of ['WEATHER_API_KEY=', 'WEATHER_API_KEY=""', "WEATHER_API_KEY=''"]) {
    writeFileSync(join(agent.path, 'credentials/.env'), `# weather\n${line}\n`)
    await b.page.evaluate(() => window.api.localAgents.rescan())
    expect((await findAgent(b, name)).readiness, line).toBe('credentials_needed')
    expect((await slotStates(b, agent.id)).weather, line).toBe('missing')
  }
  await openAgent(b, name)
  await b.page.getByRole('button', { name: 'Finish setup', exact: true }).click()
  await expect(row('weather').getByText('Missing', { exact: true })).toBeVisible()
  await expect(row('weather').getByLabel('WEATHER_API_KEY')).toBeVisible()
})

test('a slot the team added comes in with Update and reopens Finish setting up', async ({ team }) => {
  test.setTimeout(300_000)
  const { fixture } = team
  const { a, other: b, name, aPath } = await sharedAndGot(team, 'b')
  await finishWithWeather(b, name, `weather-b-${fixture.tag}-secret`)

  const manifestPath = join(aPath, 'cinna-agent.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.credentials.push({ name: 'maps', type: 'api_token', env_prefix: 'MAPS_', fields: ['api_key'], description: 'The maps service.' })
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  await shareChanges(a, name, 'Adds the maps credential')

  await refreshLibrary(b)
  await openAgent(b, name)
  await expect(b.page.getByRole('button', { name: 'The team changed this agent', exact: true })).toBeVisible()
  await b.page.getByRole('button', { name: 'Update', exact: true }).click()
  const { dialog, row } = finishDialog(b, name)
  await expect(dialog).toBeVisible({ timeout: 60_000 })
  await expect(row('maps').getByText('Missing', { exact: true })).toBeVisible()
  await expect(row('maps').getByLabel('MAPS_API_KEY')).toBeVisible()
  // Remembered for the app session: the Get attached it (finishSetup.store.ts).
  await expect(row('acme').getByText('Connected automatically', { exact: true })).toBeVisible()
  await expect(row('weather').getByText('Set on this computer', { exact: true })).toBeVisible()
})

test('after Finish later, an Update that leaves nothing newly missing does not reopen Finish setting up; one that adds a slot does', async ({ team }) => {
  test.setTimeout(300_000)
  const { a, other: b, name, aPath } = await sharedAndGot(team, 'b')
  const { dialog, row } = finishDialog(b, name)
  await expect(row('weather').getByText('Missing', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Finish later', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  const update = async (): Promise<void> => {
    await refreshLibrary(b)
    await openAgent(b, name)
    await b.page.getByRole('group', { name: 'Runtime summary' }).getByRole('button', { name: 'Update', exact: true }).click()
    await expect(b.page.getByRole('group', { name: 'Runtime summary' }).getByRole('button', { name: 'Up to date with the team', exact: true })).toBeVisible({ timeout: 60_000 })
  }

  await test.step('a knowledge change: weather is still missing, but not newly', async () => {
    writeFileSync(join(aPath, 'knowledge/acme.md'), '# Acme\n\nNo new credentials here.\n')
    await shareChanges(a, name, 'Knowledge only')
    await update()
    expect(readFileSync(join((await findAgent(b, name)).path, 'knowledge/acme.md'), 'utf8')).toContain('No new credentials here.')
    await expect(dialog).toHaveCount(0)
    await expect(b.page.getByRole('button', { name: 'Finish setup', exact: true })).toBeVisible()
  })

  await test.step('a new required slot: the dialog reopens', async () => {
    const manifestPath = join(aPath, 'cinna-agent.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.credentials.push({ name: 'maps', type: 'api_token', env_prefix: 'MAPS_', fields: ['api_key'] })
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    await shareChanges(a, name, 'Adds maps')
    await update()
    await expect(dialog).toBeVisible()
    await expect(row('maps').getByText('Missing', { exact: true })).toBeVisible()
    await expect(row('weather').getByText('Missing', { exact: true })).toBeVisible()
  })
})

test('a tracked .env at the agent root refuses Share with the team before anything reaches core', async ({ team }) => {
  test.setTimeout(300_000)
  const { fixture } = team
  const name = agentName(fixture)
  const a = await team.open('a')
  const agent = await buildAcmeReporter(a, fixture, { name, weatherKey: `weather-a-${fixture.tag}-secret` })
  writeFileSync(join(agent.path, '.env'), 'ACME_TOKEN=leak-me\n')
  const git = (...args: string[]): string =>
    execFileSync('git', ['-C', agent.path, '-c', 'user.name=Sharer', '-c', 'user.email=sharer@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('add', '-f', '.env')
  git('commit', '-q', '-m', 'first')

  await openAgent(a, name)
  await a.page.getByRole('button', { name: 'More actions' }).click()
  await a.page.getByRole('menu', { name: 'Agent actions' }).getByRole('menuitem', { name: 'Share with the team…' }).click()
  const dialog = a.page.getByRole('dialog', { name: 'Share with the team' })
  await expect(dialog.getByRole('textbox')).toHaveValue(name)
  await dialog.getByRole('button', { name: 'Share', exact: true }).click()
  await expect(dialog.getByRole('alert')).toHaveText(
    'A file that can hold a secret is recorded in this agent’s history (.env). Ask whoever maintains this agent to remove it before sharing.'
  )
  await expect(dialog).toBeVisible()
  expect(await libraryEntry(fixture, fixture.people.a.token, agent.slug)).toBeUndefined()
  expect(execFileSync('git', ['-C', agent.path, 'remote'], { encoding: 'utf8' }).trim()).toBe('')
})

test('Use the team’s version keeps this computer’s .env and attachments', async ({ team }) => {
  test.setTimeout(300_000)
  const { fixture } = team
  const { a, other: b, name, aPath } = await sharedAndGot(team, 'b', 'write')
  const weather = `weather-b-${fixture.tag}-secret`
  await finishWithWeather(b, name, weather)
  const bAgent = await findAgent(b, name)

  writeFileSync(join(aPath, 'knowledge/acme.md'), '# Acme\n\nAcme sells rockets (from A).\n')
  await shareChanges(a, name, 'A says rockets')

  writeFileSync(join(bAgent.path, 'knowledge/acme.md'), '# Acme\n\nAcme sells roller skates (from B).\n')
  await refreshLibrary(b)
  await shareChanges(b, name, 'B says roller skates')
  const conflict = b.page.getByRole('dialog', { name: 'The team changed this agent too' })
  await expect(conflict).toBeVisible({ timeout: 60_000 })
  await conflict.getByRole('button', { name: 'Use the team’s version (keep mine as a copy)', exact: true }).click()
  await expect(conflict).toHaveCount(0, { timeout: 60_000 })

  const after = await findAgent(b, name)
  expect(readFileSync(join(after.path, 'knowledge/acme.md'), 'utf8')).toContain('rockets (from A)')
  expect(readFileSync(join(after.path, 'credentials/.env'), 'utf8')).toContain('WEATHER_API_KEY=')
  expect(await slotStates(b, after.id)).toEqual({ acme: 'connected', weather: 'env' })
  await expect(finishDialog(b, name).dialog).toHaveCount(0)
  await runCommand(b, name, 'check-creds')
  await expect(b.page.getByText(`acme=${acmeHash(fixture)} weather=${shortHash(weather)}`)).toBeVisible({ timeout: 30_000 })
})
