import { cpSync, existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { repoRoot } from '../playwright.config'
import {
  test,
  expect,
  agentName,
  buildAcmeReporter,
  coreCall,
  findAgent,
  finishWithWeather,
  getFromLibrary,
  libraryEntry,
  openAgent,
  refreshLibrary,
  shareChanges,
  shareWithTeam,
  type PersonApp,
  type SharingFixture,
  type Team
} from '../fixtures/liveTeamSharing'

/**
 * A shared agent's life outside the day-to-day, against the real local
 * cinna-core: sharing removed, access taken away, a Get that would land on
 * an agent already here, the Inbox's "The team changed X", and a blocked job
 * fetching its agent from the Team library. Setup:
 * `e2e/fixtures/live-team-sharing.py`.
 */

/** A builds and shares with B (Can use); B Gets it and finishes setup. */
async function shared(team: Team): Promise<{ a: PersonApp; b: PersonApp; name: string; aPath: string; slug: string; manifestId: string; aId: string }> {
  const { fixture } = team
  const name = agentName(fixture)
  const a = await team.open('a')
  const built = await buildAcmeReporter(a, fixture, { name, weatherKey: `weather-a-${fixture.tag}-secret` })
  await shareWithTeam(a, name, [{ person: fixture.people.b }])
  const b = await team.open('b')
  await getFromLibrary(b, name)
  await finishWithWeather(b, name, `weather-b-${fixture.tag}-secret`)
  return { a, b, name, aPath: built.path, slug: built.slug, manifestId: built.manifestId, aId: built.id }
}

function badge(app: PersonApp, words: string) {
  return app.page.getByRole('group', { name: 'Runtime summary' }).getByRole('button', { name: words, exact: true })
}

async function openSharingTab(app: PersonApp, name: string): Promise<void> {
  await openAgent(app, name)
  await app.page.getByRole('button', { name: 'Settings', exact: true }).click()
  await app.page.getByRole('tablist', { name: 'Agent details' }).getByRole('tab', { name: 'Sharing', exact: true }).click()
}

function section(app: PersonApp, title: string) {
  return app.page.locator('section').filter({ has: app.page.getByRole('heading', { level: 2, name: title, exact: true }) })
}


/** A commit of `paths` (forced past the ignore rules) sent with a raw `git push`, as plain git would. */
function rawSend(fixture: SharingFixture, dir: string, paths: string[], note: string): string {
  const git = (...args: string[]): string =>
    execFileSync('git', ['-C', dir, '-c', 'user.name=Plain Git', '-c', 'user.email=plain@example.com', '-c', 'commit.gpgsign=false',
      '-c', `http.${fixture.server}/.extraheader=Authorization: Bearer ${fixture.people.a.token}`, ...args], { encoding: 'utf8', stdio: 'pipe' })
  git('add', '-f', ...paths)
  git('commit', '-q', '-m', note)
  git('push', '-q', 'origin', 'HEAD:main')
  return git('rev-parse', 'HEAD').trim()
}

/** Core's listing takes a new head a few seconds after a push lands. */
async function waitForTeamHead(fixture: SharingFixture, slug: string, sha: string): Promise<void> {
  await expect.poll(async () => (await libraryEntry(fixture, fixture.people.a.token, slug))?.head_sha, { timeout: 30_000 }).toBe(sha)
}

/** Refresh, open the page, Update from the badge, wait for the folder to be at `sha`. */
async function updateFromBadge(app: PersonApp, name: string, path: string, sha: string): Promise<void> {
  await refreshLibrary(app)
  await openAgent(app, name)
  // Seen settling from "Up to date with the team" up to ~15s after the refresh
  // when this machine's copy of a tracked local-only file is edited.
  await expect(badge(app, 'The team changed this agent')).toBeVisible({ timeout: 30_000 })
  await app.page.getByRole('group', { name: 'Runtime summary' }).getByRole('button', { name: 'Update', exact: true }).click()
  await expect.poll(() => execFileSync('git', ['-C', path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), { timeout: 60_000 }).toBe(sha)
}

/** Replace one person's grant on the library entry `slug`, as its maintainer A. */
async function setAccess(fixture: SharingFixture, slug: string, userId: string, access: 'read' | 'write'): Promise<void> {
  const entry = await libraryEntry(fixture, fixture.people.a.token, slug)
  const grants = await coreCall(fixture, fixture.people.a.token, `/library/agents/${entry.repo_id}/grants`)
  const rows = (Array.isArray(grants.body) ? grants.body : grants.body.grants ?? grants.body.data) as any[]
  const changed = rows.map((g) => ((g.principal?.user_id ?? g.user_id) === userId ? { ...g, access } : g))
  const put = await coreCall(fixture, fixture.people.a.token, `/library/agents/${entry.repo_id}/grants`, {
    method: 'PUT',
    body: Array.isArray(grants.body) ? changed : { grants: changed }
  })
  expect(put.status, JSON.stringify(put.body)).toBe(200)
}

function gitStatus(path: string): string {
  return execFileSync('git', ['-C', path, 'status', '--short'], { encoding: 'utf8' }).trim() || 'clean'
}

test('A removes sharing and deletes it from the library: B reads No longer shared and keeps the folder; A shares it again', async ({ team }) => {
  test.setTimeout(300_000)
  const { fixture } = team
  const { a, b, name, slug } = await shared(team)
  const bPath = (await findAgent(b, name)).path

  await openSharingTab(a, name)
  await section(a, 'Remove sharing').getByRole('button', { name: 'Remove sharing…', exact: true }).click()
  const dialog = a.page.getByRole('dialog', { name: 'Remove sharing' })
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
  await dialog.getByRole('checkbox', { name: 'Also delete it from the team library — teammates can no longer get it' }).check()
  await dialog.getByRole('button', { name: 'Remove sharing', exact: true }).click()
  await expect(dialog).toHaveCount(0, { timeout: 60_000 })
  await expect(a.page.getByText(`${name} is no longer shared with the team.`, { exact: true })).toBeVisible()
  expect(await libraryEntry(fixture, fixture.people.a.token, slug)).toBeUndefined()

  await refreshLibrary(b)
  await openAgent(b, name)
  await expect(badge(b, 'No longer shared')).toBeVisible()
  expect(existsSync(join(bPath, 'cinna-agent.json'))).toBe(true)
  expect(existsSync(join(bPath, 'credentials/.env'))).toBe(true)

  await shareWithTeam(a, name, [{ person: fixture.people.b }])
  expect((await libraryEntry(fixture, fixture.people.b.token, slug))?.name).toBe(name)
})

test('A takes B’s access away: B’s copy reads No longer shared', async ({ team }) => {
  test.setTimeout(300_000)
  const { fixture } = team
  const { a, b, name, slug } = await shared(team)
  await openSharingTab(a, name)
  const people = section(a, 'People')
  await people.getByRole('button', { name: `Remove ${fixture.people.b.name}`, exact: true }).click()
  await expect(people.getByText(`Remove ${fixture.people.b.name}’s access?`, { exact: true })).toBeVisible()
  await people.getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(people.getByText('No one else has access yet.', { exact: true })).toBeVisible({ timeout: 30_000 })
  expect(await libraryEntry(fixture, fixture.people.b.token, slug)).toBeUndefined()

  await refreshLibrary(b)
  await openAgent(b, name)
  await expect(badge(b, 'No longer shared')).toBeVisible()
  await openSharingTab(b, name)
  await expect(section(b, 'Where it’s shared').getByText('This agent is no longer shared', { exact: true })).toBeVisible()
})

test('Get refuses to land on an agent already here, by folder name or by manifest id, and leaves nothing behind', async ({ team }) => {
  test.setTimeout(300_000)
  const { fixture } = team
  const name = agentName(fixture)
  const a = await team.open('a')
  const built = await buildAcmeReporter(a, fixture, { name, weatherKey: 'weather-key' })
  await shareWithTeam(a, name, [{ person: fixture.people.b }])
  const b = await team.open('b')
  const local = join(b.rootPath, 'Local')
  const before = (): string[] => readdirSync(local).sort()

  await test.step('a different agent of B’s already has the folder name', async () => {
    const rootId = await b.rootId()
    const mine = await b.page.evaluate((args) => window.api.localAgents.create(args), { rootId, name, description: 'B’s own.' })
    expect(mine.slug).toBe(built.slug)
    await b.relaunch()
    const folders = before()
    await b.page.getByRole('button', { name: 'Agents', exact: true }).click()
    await b.page.getByRole('button', { name: 'Add an agent' }).click()
    await b.page.getByRole('dialog', { name: 'Add an agent' }).getByRole('button', { name: /Install from catalog/ }).click()
    const catalog = b.page.getByRole('dialog', { name: 'Agent catalog' })
    await catalog.getByRole('tablist', { name: 'Catalog source' }).getByRole('tab', { name: 'Team library' }).click()
    const tile = catalog.getByRole('group', { name })
    await tile.getByRole('button', { name: 'Get', exact: true }).click()
    await expect(tile.getByRole('alert')).toHaveText(/this agent is already on this computer\.$/)
    await expect(catalog).toBeVisible()
    expect(before()).toEqual(folders)
    expect(JSON.parse(readFileSync(join(mine.path, 'cinna-agent.json'), 'utf8')).description).toBe('B’s own.')
    // Out of the home, not to the Trash: the next step needs the name free.
    renameSync(mine.path, join(b.sandbox.home, 'parked-agent'))
  })

  await test.step('a copy with the same manifest id under another folder name', async () => {
    const elsewhere = join(local, 'acme-elsewhere')
    cpSync(built.path, elsewhere, { recursive: true, filter: (src) => !src.includes('/.git') && !src.includes('/.venv') })
    const manifest = JSON.parse(readFileSync(join(elsewhere, 'cinna-agent.json'), 'utf8'))
    manifest.slug = 'acme-elsewhere'
    writeFileSync(join(elsewhere, 'cinna-agent.json'), JSON.stringify(manifest, null, 2) + '\n')
    await b.relaunch()
    const folders = before()
    const listing = await b.page.evaluate(() => window.api.sharing.library(true))
    const entry = listing.success ? listing.value?.agents.find((agent) => agent.name === name) : undefined
    expect(entry?.localAgentId).not.toBeNull()
    const got = await b.page.evaluate((repoId) => window.api.sharing.get(repoId), entry!.repoId)
    expect(got.success && got.value.refusal).toBe('exists')
    expect(before()).toEqual(folders)
  })
})

test('the Inbox card The team changed X updates the agent and says Updated.', async ({ team }) => {
  test.setTimeout(300_000)
  const { fixture } = team
  const { a, b, name, aPath } = await shared(team)
  writeFileSync(join(aPath, 'knowledge/acme.md'), '# Acme\n\nNews from A.\n')
  await shareChanges(a, name, 'News from A')
  await refreshLibrary(b)
  await b.page.getByRole('button', { name: /^Inbox/ }).click()
  const card = b.page.getByRole('article', { name: `The team changed ${name}` })
  await expect(card).toContainText(`by ${fixture.people.a.name}`)
  await card.getByRole('button', { name: 'Update', exact: true }).click()
  await expect(card.getByRole('status')).toHaveText('Updated. This agent now has the team’s latest version.', { timeout: 60_000 })
  expect(readFileSync(join((await findAgent(b, name)).path, 'knowledge/acme.md'), 'utf8')).toContain('News from A.')
})

test('a blocked job offers Get X from the team library, and the Get unblocks it', async ({ team }) => {
  // A job can only be bound to an agent this machine knows (setAgents drops
  // an unknown id), so B binds it to its copy and then the folder goes
  // missing — the state blocked-job.spec.ts arranges — while the team has it.
  test.setTimeout(300_000)
  const { fixture } = team
  const { b, name, aId } = await shared(team)
  const title = `Morning Acme report ${fixture.tag}`
  const bAgent = await findAgent(b, name)
  expect(bAgent.id).toBe(aId)
  await b.page.evaluate(
    async ({ title, agentId }) => {
      const job = await window.api.jobs.create({ type: 'local', title, prompt: 'Write the Acme report.' })
      await window.api.jobs.setAgents(job.id, [agentId])
    },
    { title, agentId: bAgent.id }
  )
  await b.close()
  renameSync(bAgent.path, join(b.sandbox.home, 'parked-agent'))
  await b.start()
  await b.waitForShell()
  await b.page.evaluate(() => window.api.localAgents.rescan())
  await b.page.getByRole('button', { name: 'Jobs', exact: true }).click()
  await b.page.getByText(title, { exact: true }).click()
  await expect(b.page.getByText('Agent unavailable', { exact: true })).toBeVisible()
  await expect(b.page.getByRole('button', { name: 'Run', exact: true })).toBeDisabled()
  await b.page.getByRole('button', { name: `Get ${name} from the team library`, exact: true }).click()
  await expect(b.page.getByText('Agent unavailable', { exact: true })).toHaveCount(0, { timeout: 60_000 })
  await expect(b.page.getByRole('button', { name: 'Run', exact: true })).toBeEnabled()
  expect((await findAgent(b, name)).id).toBe(aId)
})

const SETTINGS = '.claude/settings.local.json'
const TEMPLATE_SETTINGS = readFileSync(join(repoRoot, 'resources/cinna-agent-kit/templates/agent', SETTINGS), 'utf8')

test('a plain-git teammate’s Bash(*) settings.local.json never replaces B’s, and C’s Get gets the template’s', async ({ team }) => {
  // The migration case: a team version recorded by plain git (or an older
  // client) that tracks .claude/settings.local.json. A sends it with a raw push.
  test.setTimeout(300_000)
  const { fixture } = team
  const name = agentName(fixture)
  const a = await team.open('a')
  const built = await buildAcmeReporter(a, fixture, { name, weatherKey: 'weather-key' })
  await shareWithTeam(a, name, [{ person: fixture.people.b }, { person: fixture.people.c }])
  const b = await team.open('b')
  await getFromLibrary(b, name)
  await finishWithWeather(b, name, `weather-b-${fixture.tag}-secret`)
  const bPath = (await findAgent(b, name)).path
  const bBefore = readFileSync(join(bPath, SETTINGS), 'utf8')
  expect(bBefore).toBe(TEMPLATE_SETTINGS)

  const wide = '{ "permissions": { "allow": ["Bash(*)"] } }\n'
  writeFileSync(join(built.path, SETTINGS), wide)
  writeFileSync(join(built.path, 'knowledge/acme.md'), '# Acme\n\nSent by plain git.\n')
  const sent = rawSend(fixture, built.path, [SETTINGS, 'knowledge/acme.md'], 'Plain git: wide permissions')
  await waitForTeamHead(fixture, built.slug, sent)

  await test.step('B’s Update brings the change in and keeps B’s file', async () => {
    await updateFromBadge(b, name, bPath, sent)
    expect(readFileSync(join(bPath, 'knowledge/acme.md'), 'utf8')).toContain('Sent by plain git.')
    expect(readFileSync(join(bPath, SETTINGS), 'utf8')).toBe(bBefore)
  })

  await test.step('B (Can use) reads up to date, though git sees the file modified', async () => {
    // Read "1 change not shared" for a moment right after the Update, then settles.
    expect(gitStatus(bPath)).toBe('M .claude/settings.local.json')
    await expect(badge(b, 'Up to date with the team')).toBeVisible({ timeout: 20_000 })
    await expect(b.page.getByRole('button', { name: 'Share changes…', exact: true })).toHaveCount(0)
  })

  await test.step('C’s Get has the template’s file, not A’s', async () => {
    const c = await team.open('c')
    await getFromLibrary(c, name)
    const cPath = (await findAgent(c, name)).path
    expect(readFileSync(join(cPath, SETTINGS), 'utf8')).toBe(TEMPLATE_SETTINGS)
    expect(readFileSync(join(cPath, 'knowledge/acme.md'), 'utf8')).toContain('Sent by plain git.')
  })

  await test.step('B promoted to Can edit: still up to date, nothing of B’s to share', async () => {
    await setAccess(fixture, built.slug, fixture.people.b.id, 'write')
    await b.relaunch()
    await refreshLibrary(b)
    await openAgent(b, name)
    await expect(badge(b, 'Up to date with the team')).toBeVisible({ timeout: 20_000 })
    await expect(b.page.getByRole('button', { name: 'Share changes…', exact: true })).toHaveCount(0)
    expect(readFileSync(join(bPath, SETTINGS), 'utf8')).toBe(bBefore)
  })
})

test('migration: B edits a settings.local.json the team still tracks; A shares a change; B’s Update keeps B’s file', async ({ team }) => {
  test.setTimeout(300_000)
  const { fixture } = team
  const { a, b, name, aPath, slug } = await shared(team)
  const bPath = (await findAgent(b, name)).path
  writeFileSync(join(aPath, SETTINGS), '{ "permissions": { "allow": ["Bash(echo from-A)"] } }\n')
  const tracked = rawSend(fixture, aPath, [SETTINGS], 'Plain git: tracks the settings file')
  await waitForTeamHead(fixture, slug, tracked)
  await updateFromBadge(b, name, bPath, tracked)

  const mine = '{ "permissions": { "allow": ["Bash(echo from-B)"] } }\n'
  writeFileSync(join(bPath, SETTINGS), mine)
  writeFileSync(join(aPath, 'knowledge/acme.md'), '# Acme\n\nA change shared from the app.\n')
  await shareChanges(a, name, 'A shares a change')
  const head = execFileSync('git', ['-C', aPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()

  await test.step('1–2: B’s Update succeeds and B’s file is B’s own', async () => {
    await updateFromBadge(b, name, bPath, head)
    expect(readFileSync(join(bPath, 'knowledge/acme.md'), 'utf8')).toContain('A change shared from the app.')
    expect(readFileSync(join(bPath, SETTINGS), 'utf8')).toBe(mine)
  })

  await test.step('3: A’s in-app share dropped the file from the team version, so B reads up to date', async () => {
    await expect(badge(b, 'Up to date with the team')).toBeVisible()
    expect(gitStatus(bPath)).toBe('clean')
    expect(execFileSync('git', ['-C', bPath, 'ls-files', SETTINGS], { encoding: 'utf8' }).trim()).toBe('')
  })
})
