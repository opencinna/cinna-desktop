import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import {
  test,
  expect,
  agentName,
  catalogEntry,
  buildAcmeReporter,
  cloneHistory,
  findAgent,
  finishDialog,
  finishWithWeather,
  getFromLibrary,
  openCatalogAgents,
  catalogEntryOrFail,
  openAgent,
  refreshLibrary,
  setCatalogAccess,
  shareChanges,
  shareWithTeam,
  whereFact,
  type PersonApp,
  type SharingFixture,
  type SharingPerson,
  type Team
} from '../fixtures/liveTeamSharing'
import { installCachedEngine } from '../fixtures/engine-cache'
import { OPENAI_API_KEY, seedOpenAiDefaultMode } from '../fixtures/live'

/**
 * Two people changing one shared agent, against the real local cinna-core:
 * Update and Share changes in both directions, a teammate who shared first, a
 * collision and its two answers, edit access taken away mid-way, and what
 * core's push policy refuses. B can edit, C can only use.
 * Setup: `e2e/fixtures/live-team-sharing.py`.
 */

const ACME_MD = 'knowledge/acme.md'
const SKILL_MD = 'skills/acme-report/SKILL.md'

/** A builds and shares with B (Can edit) and C (Can use); B Gets it. */
async function sharedWithEditor(team: Team): Promise<{ a: PersonApp; b: PersonApp; name: string; aPath: string; bPath: string; slug: string }> {
  const { fixture } = team
  const name = agentName(fixture)
  const a = await team.open('a')
  const built = await buildAcmeReporter(a, fixture, { name, weatherKey: `weather-a-${fixture.tag}-secret` })
  await shareWithTeam(a, name, [
    { person: fixture.people.b, access: 'Can edit' },
    { person: fixture.people.c, access: 'Can use' }
  ])
  const b = await team.open('b')
  await getFromLibrary(b, name)
  await finishWithWeather(b, name, `weather-b-${fixture.tag}-secret`)
  return { a, b, name, aPath: built.path, bPath: (await findAgent(b, name)).path, slug: built.slug }
}

function edit(path: string, rel: string, text: string): void {
  writeFileSync(join(path, rel), text)
}

function head(path: string): string {
  return execFileSync('git', ['-C', path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
}

function isAncestor(path: string, commit: string): boolean {
  try {
    execFileSync('git', ['-C', path, 'merge-base', '--is-ancestor', commit, 'HEAD'])
    return true
  } catch {
    return false
  }
}

/** The share badge, by the words it shows. */
function badge(app: PersonApp, words: string) {
  return app.page.getByRole('group', { name: 'Runtime summary' }).getByRole('button', { name: words, exact: true })
}

/** Settings → Sharing for `name`. */
async function openSharingTab(app: PersonApp, name: string): Promise<void> {
  await openAgent(app, name)
  await app.page.getByRole('button', { name: 'Settings', exact: true }).click()
  await app.page.getByRole('tablist', { name: 'Agent details' }).getByRole('tab', { name: 'Sharing', exact: true }).click()
}

function section(app: PersonApp, title: string) {
  return app.page.locator('section').filter({ has: app.page.getByRole('heading', { level: 2, name: title, exact: true }) })
}

/** The team changed it: refresh B's library, open the page, Update from the badge. */
async function updateFromBadge(app: PersonApp, name: string): Promise<void> {
  await refreshLibrary(app)
  await openAgent(app, name)
  await expect(badge(app, 'The team changed this agent')).toBeVisible().catch(async (error: Error) => {
    // Seen once in ~15 runs and not reproduced since: say what main believed.
    const id = (await findAgent(app, name)).id
    const status = await app.page.evaluate((agentId) => window.api.sharing.status(agentId), id)
    throw new Error(`${error.message}\nmain's status then: ${JSON.stringify(status)}`)
  })
  await app.page.getByRole('group', { name: 'Runtime summary' }).getByRole('button', { name: 'Update', exact: true }).click()
  await expect(badge(app, 'Up to date with the team')).toBeVisible({ timeout: 60_000 })
}

/** A raw `git push` of one new commit with `person`'s web token, as anything outside the app could. */
function rawPush(fixture: SharingFixture, dir: string, person: SharingPerson): string {
  const auth = ['-c', `http.${fixture.server}/.extraheader=Authorization: Bearer ${person.token}`]
  const id = ['-c', 'user.name=Raw', '-c', 'user.email=raw@example.com', '-c', 'commit.gpgsign=false']
  writeFileSync(join(dir, 'knowledge/raw.md'), `raw ${randomBytes(4).toString('hex')}\n`)
  execFileSync('git', ['-C', dir, ...id, 'add', 'knowledge/raw.md'])
  execFileSync('git', ['-C', dir, ...id, 'commit', '-q', '-m', 'raw'])
  try {
    execFileSync('git', ['-C', dir, ...auth, 'push', 'origin', 'HEAD:main'], { stdio: 'pipe', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
    return 'pushed'
  } catch (error) {
    return ((error as { stderr?: Buffer }).stderr?.toString() ?? String(error)).replace(/Bearer \S+/g, 'Bearer ***')
  }
}

test('a file edited in a shared agent offers Share changes while its page stays open', async ({ team }) => {
  // No rescan, no remount, no status read: only the folder watcher's push.
  test.setTimeout(240_000)
  const { fixture } = team
  const name = agentName(fixture)
  const a = await team.open('a')
  const built = await buildAcmeReporter(a, fixture, { name, weatherKey: 'weather-key' })
  await shareWithTeam(a, name, [{ person: fixture.people.b }])
  await expect(badge(a, 'Up to date with the team')).toBeVisible()
  edit(built.path, ACME_MD, '# Acme\n\nAcme sells anvils and rope.\n')
  await expect(badge(a, '1 change not shared')).toBeVisible({ timeout: 20_000 })
  await expect(a.page.getByRole('button', { name: 'Share changes…', exact: true })).toBeVisible()
})

test('a change shared by either side comes in with Update, with its note and author in History', async ({ team }) => {
  test.setTimeout(300_000)
  const { fixture } = team
  const { people } = fixture
  const { a, b, name, aPath, bPath, slug } = await sharedWithEditor(team)

  await test.step('A shares; B updates', async () => {
    edit(aPath, ACME_MD, '# Acme\n\nAnvils are heavy.\n')
    await shareChanges(a, name, 'A: anvils are heavy')
    await updateFromBadge(b, name)
    expect(readFileSync(join(bPath, ACME_MD), 'utf8')).toBe('# Acme\n\nAnvils are heavy.\n')
    const entry = await catalogEntryOrFail(fixture, slug)
    expect(entry.latest?.revision_number).toBe(2)
    expect(entry.latest?.release_notes).toContain('A: anvils are heavy')
    expect(entry.desktop.head_sha).toBe(head(aPath))
    await openSharingTab(b, name)
    await expect(whereFact(b, 'Version')).toHaveText('2')
    await expect(whereFact(b, 'Shared by')).toHaveText(people.a.name)
    const history = section(b, 'History')
    await expect(history.getByText('A: anvils are heavy', { exact: true }).locator('..')).toContainText(`${people.a.name} · `)
    await expect(history.getByText('Not shared yet', { exact: true })).toHaveCount(0)
  })

  await test.step('B shares; A updates', async () => {
    edit(bPath, SKILL_MD, '---\nname: acme-report\ndescription: Write the Acme report.\n---\n\nAlways mention anvils.\n')
    await shareChanges(b, name, 'B: mention anvils')
    await openSharingTab(b, name)
    await expect(section(b, 'History').getByText('Not shared yet', { exact: true })).toHaveCount(0)
    await updateFromBadge(a, name)
    expect(readFileSync(join(aPath, SKILL_MD), 'utf8')).toContain('Always mention anvils.')
    expect((await catalogEntryOrFail(fixture, slug)).latest?.published_by?.user_id).toBe(people.b.id)
    await openSharingTab(a, name)
    await expect(whereFact(a, 'Version')).toHaveText('3')
    await expect(whereFact(a, 'Shared by')).toHaveText(people.b.name)
    const history = section(a, 'History')
    await expect(history.getByText('B: mention anvils', { exact: true }).locator('..')).toContainText(`${people.b.name} · `)
    expect(head(aPath)).toBe(head(bPath))
  })
})

test('a teammate shared first: Share changes brings their version in, sends once more, and both converge', async ({ team }) => {
  test.setTimeout(300_000)
  const { a, b, name, aPath, bPath, slug } = await sharedWithEditor(team)
  edit(aPath, ACME_MD, '# Acme\n\nA was here first.\n')
  await shareChanges(a, name, 'A first')
  edit(bPath, SKILL_MD, '---\nname: acme-report\ndescription: Write the Acme report.\n---\n\nB second.\n')
  // B's app has not re-read the library since A shared (no refresh here, and
  // its background re-read runs every five minutes), so B's status still
  // reads "1 change not shared" and Share changes opens on the field, not on
  // Bring together. Core refuses the first send; the send's safety net
  // retries it on top of A's version because the two touched different
  // files. This is that net, not the adoption session.
  await shareChanges(b, name, 'B second')
  expect(readFileSync(join(bPath, ACME_MD), 'utf8')).toContain('A was here first.')
  await updateFromBadge(a, name)
  expect(readFileSync(join(aPath, SKILL_MD), 'utf8')).toContain('B second.')
  expect(head(aPath)).toBe(head(bPath))
  expect((await catalogEntryOrFail(team.fixture, slug)).desktop.head_sha).toBe(head(aPath))
})

test('the same lines on both: Keep working on mine leaves both changed; Use the team’s version keeps mine as a copy', async ({ team }) => {
  test.setTimeout(300_000)
  const { a, b, name, aPath, bPath, slug } = await sharedWithEditor(team)
  const conflict = () => b.page.getByRole('dialog', { name: 'The team changed this agent too' })
  edit(aPath, ACME_MD, '# Acme\n\nAcme sells rockets (from A).\n')
  await shareChanges(a, name, 'A says rockets')
  edit(bPath, ACME_MD, '# Acme\n\nAcme sells skates (from B).\n')

  // B's status reads `diverged` once the library is re-read, so Share changes…
  // opens on the Bring together step; a same-lines collision there answers
  // with the old two buttons.
  const bringTogetherFromShare = async (): Promise<void> => {
    await openAgent(b, name)
    await expect(badge(b, 'You and the team both changed it')).toBeVisible()
    await b.page.getByRole('group', { name: 'Runtime summary' }).getByRole('button', { name: 'Share changes…', exact: true }).click()
    const dialog = b.page.getByRole('dialog', { name: 'Share changes' })
    await expect(dialog.locator('[data-share-combine]')).toHaveText(
      'The team changed this agent and you have changes you haven’t shared. Bring them together before working?'
    )
    await expect(dialog.getByRole('textbox')).toHaveCount(0)
    await expect(dialog.getByRole('button', { name: 'Share', exact: true })).toHaveCount(0)
    await expect(dialog.getByRole('button', { name: 'Bring together', exact: true })).toBeFocused()
    await dialog.getByRole('button', { name: 'Bring together', exact: true }).click()
  }

  await test.step('Keep working on mine', async () => {
    await refreshLibrary(b)
    await bringTogetherFromShare()
    await expect(conflict()).toBeVisible({ timeout: 60_000 })
    await expect(conflict().getByRole('button', { name: 'Keep working on mine (share later)', exact: true })).toBeFocused()
    await conflict().getByRole('button', { name: 'Keep working on mine (share later)', exact: true }).click()
    await expect(conflict()).toHaveCount(0)
    await openAgent(b, name)
    await expect(badge(b, 'You and the team both changed it')).toBeVisible()
    expect(readFileSync(join(bPath, ACME_MD), 'utf8')).toContain('skates (from B)')
  })

  await test.step('Use the team’s version (keep mine as a copy)', async () => {
    await bringTogetherFromShare()
    await expect(conflict()).toBeVisible({ timeout: 60_000 })
    await conflict().getByRole('button', { name: 'Use the team’s version (keep mine as a copy)', exact: true }).click()
    await expect(conflict()).toHaveCount(0, { timeout: 60_000 })
    const listed = await b.page.evaluate(() => window.api.localAgents.list())
    const original = listed.agents.find((row) => row.name === name)!
    const mine = listed.agents.find((row) => row.name === `${name} (my copy)`)
    expect(mine?.path).toBe(`${original.path}-mine`)
    expect(mine?.slug).toBe(`${slug}-mine`)
    expect(mine?.readiness).toBe('ok')
    expect(JSON.parse(readFileSync(join(mine!.path, 'cinna-agent.json'), 'utf8')).slug).toBe(`${slug}-mine`)
    expect(readFileSync(join(original.path, ACME_MD), 'utf8')).toContain('rockets (from A)')
    expect(readFileSync(join(mine!.path, ACME_MD), 'utf8')).toContain('skates (from B)')
    const id = (path: string): string => JSON.parse(readFileSync(join(path, 'cinna-agent.json'), 'utf8')).id
    expect(id(mine!.path)).not.toBe(id(original.path))
    expect(execFileSync('git', ['-C', mine!.path, 'remote'], { encoding: 'utf8' }).trim()).toBe('')
    await expect(b.page.getByText(`Your version is kept as ${name} (my copy).`, { exact: true })).toBeVisible()
  })
})

/**
 * A shares an edit to `ACME_MD`; B has an unshared edit to `SKILL_MD` and
 * re-reads the library, so B's agent is `diverged` (different files on both
 * sides, nothing combined yet).
 */
async function bothChangedDifferentFiles(team: Team) {
  const shared = await sharedWithEditor(team)
  const { a, b, name, aPath, bPath } = shared
  edit(aPath, ACME_MD, '# Acme\n\nThe team moved.\n')
  await shareChanges(a, name, 'Team moved')
  edit(bPath, SKILL_MD, BS_SKILL)
  await refreshLibrary(b)
  const id = (await findAgent(b, name)).id
  const seen: string[] = []
  await expect
    .poll(async () => {
      const status = await b.page.evaluate((agentId) => window.api.sharing.status(agentId), id)
      seen.push(JSON.stringify(status))
      return status.success ? status.value?.state : 'failed'
    }, { timeout: 30_000 })
    .toBe('diverged')
    .catch((error: Error) => {
      throw new Error(`${error.message}\nmain's status reads: ${seen.slice(-3).join('\n')}`)
    })
  return shared
}

/** B's reply to any question the session's agent asks. */
const SESSION_ANSWER = 'Keep both sides: Acme sells anvils, and the team moved. Make the files consistent without asking again.'

const BS_SKILL = '---\nname: acme-report\ndescription: Write the Acme report.\n---\n\nUnsent edit.\n'

/** The adoption chat's banner on the agent page (chat mode). */
function banner(app: PersonApp) {
  return app.page.getByRole('region', { name: 'Bring the team’s changes together', exact: true })
}

/**
 * Open the agent page afresh. The banner is decided once per mount, and the
 * page B was left on (Get, Finish setting up) mounted before the team moved;
 * clicking its row again keeps that mount. A new chat in between unmounts it.
 */
async function reopenAgent(app: PersonApp, name: string): Promise<void> {
  await app.page.getByRole('button', { name: 'New Chat', exact: true }).click()
  await expect(app.page.getByRole('heading', { level: 1, name, exact: true })).toHaveCount(0)
  await openAgent(app, name)
}

test('edits here and a team that moved: the chat offers Bring together, the agent combines them in a session, Finish shares it', async ({ team }) => {
  // The one billed model turn of this spec: B's agent answers the brief, on
  // the cached pinned OpenCode and the OpenAI key in `.env` (the team fixture
  // has no real-login launcher, so CINNA_E2E_LIVE_ENGINE does not apply here).
  test.skip(OPENAI_API_KEY === '', 'OPENAI_API_KEY is not set in .env')
  test.setTimeout(480_000)
  const { a, b, name, aPath, bPath } = await bothChangedDifferentFiles(team)
  const teamHead = head(aPath)
  installCachedEngine(b.sandbox.userData)
  await seedOpenAiDefaultMode(b)

  await test.step('the banner and the catalog tile both say bring together first', async () => {
    await reopenAgent(b, name)
    await expect(badge(b, 'You and the team both changed it')).toBeVisible()
    await expect(banner(b)).toContainText(
      'The team changed this agent and you have changes you haven’t shared. Bring them together before working?'
    )
    await expect(banner(b).getByRole('button', { name: 'Bring together', exact: true })).toBeVisible()
    await expect(banner(b).getByRole('button', { name: 'Not now', exact: true })).toBeVisible()
    const catalog = await openCatalogAgents(b)
    const tile = catalog.getByRole('group', { name })
    await tile.getByRole('button', { name: 'Update', exact: true }).click()
    await expect(tile.getByRole('alert')).toHaveText('Bring the team’s changes together first — Share changes will offer it.')
    await catalog.getByRole('button', { name: 'Close', exact: true }).click()
    expect(readFileSync(join(bPath, ACME_MD), 'utf8')).not.toContain('The team moved.')
  })

  await test.step('Bring together opens the session chat with the brief, and the agent answers', async () => {
    await openAgent(b, name)
    await banner(b).getByRole('button', { name: 'Bring together', exact: true }).click()
    const row = b.page.locator('[data-chat-row]').filter({ hasText: 'Bringing team changes together' })
    await expect(row).toHaveCount(1, { timeout: 60_000 })
    const chatId = (await row.getAttribute('data-chat-row'))!
    const userBubble = b.page.locator('div.relative.group').filter({ hasText: 'Team moved' })
    await expect(userBubble.first()).toContainText(ACME_MD)
    // Both sides are in the folder from the start of the session.
    expect(readFileSync(join(bPath, ACME_MD), 'utf8')).toContain('The team moved.')
    expect(readFileSync(join(bPath, SKILL_MD), 'utf8')).toContain('Unsent edit.')
    // The agent may ask to read or write (on OpenCode it asked to read the
    // kit's own instructions first); B answers each ask as a user would.
    const allow = b.page.getByRole('button', { name: 'Allow once', exact: true })
    const answer = b.page.getByRole('button', { name: /^Answer( questions)?$/ })
    const asks: string[] = []
    await expect
      .poll(
        async () => {
          if (await allow.first().isVisible()) {
            asks.push((await b.page.getByText(/^The agent is asking to /).first().textContent().catch(() => null)) ?? '?')
            await allow.first().click()
            return 'asked'
          }
          // The brief tells it to ask, never guess, a fact the sides state
          // differently; the test's edits are not real facts, so one answer
          // settles any question it asks.
          if (await answer.first().isVisible()) {
            asks.push('question')
            await answer.first().click()
            const others = b.page.getByRole('button', { name: 'Other (enter custom answer)', exact: true })
            for (let i = 0; i < (await others.count()); i++) {
              await others.nth(i).click()
              await b.page.getByPlaceholder('Type your answer…').nth(i).fill(SESSION_ANSWER)
            }
            await b.page.getByRole('button', { name: /^Send answers?$/ }).click()
            return 'answered a question'
          }
          const chat = await b.page.evaluate((id) => window.api.chat.get(id), chatId)
          if (!chat) return 'no chat'
          if (chat.activeRunId) return 'running'
          return chat.messages.some((m) => m.role === 'assistant' && m.content.trim() !== '') ? 'answered' : 'no answer'
        },
        { message: 'the session’s turn ends with an answer', timeout: 300_000, intervals: [2_000] }
      )
      .toBe('answered')
    test.info().annotations.push({ type: 'asks answered', description: asks.join(' | ') || 'none' })
    const first = (await b.page.evaluate((id) => window.api.chat.get(id), chatId))!.messages.find((m) => m.role === 'user')
    expect(first?.content).toContain('Team moved')
    expect(first?.content).toContain(ACME_MD)
  })

  await test.step('Finish… opens Share changes on the note, and Share sends the combined version', async () => {
    await openAgent(b, name)
    await expect(badge(b, 'Bringing team changes together')).toBeVisible()
    const summary = b.page.getByRole('group', { name: 'Runtime summary' })
    await expect(summary.getByRole('button', { name: 'Discard', exact: true })).toBeVisible()
    await summary.getByRole('button', { name: 'Finish…', exact: true }).click()
    const dialog = b.page.getByRole('dialog', { name: 'Share changes' })
    const field = dialog.getByRole('textbox')
    await expect(field).toBeVisible({ timeout: 60_000 })
    if ((await field.inputValue()).trim() === '') await field.fill('Brought the team’s changes together')
    await dialog.getByRole('button', { name: 'Share', exact: true }).click()
    await expect(dialog).toHaveCount(0, { timeout: 60_000 })
    await expect(badge(b, 'Up to date with the team')).toBeVisible({ timeout: 30_000 })
    // The agent may reword either side's line, so the proof of the combine is
    // git's: A's shared version is in what B sent.
    expect(isAncestor(bPath, teamHead)).toBe(true)
  })

  await test.step('A’s Update brings the combined version', async () => {
    const agent = await findAgent(b, name)
    await expect
      .poll(async () => (await catalogEntry(team.fixture, b.person.token, agent.slug))?.desktop?.head_sha, { timeout: 30_000 })
      .toBe(head(bPath))
    await updateFromBadge(a, name)
    // The agent reconciles, so B's own line may be reworded: A gets whatever
    // B shared, in both files.
    for (const rel of [ACME_MD, SKILL_MD]) expect(readFileSync(join(aPath, rel), 'utf8')).toBe(readFileSync(join(bPath, rel), 'utf8'))
    expect(head(aPath)).toBe(head(bPath))
  })
})

test('Discard ends a Bring together session and puts the folder back where it began', async ({ team }) => {
  // No model is set up for B, so the session's turn cannot answer: Discard
  // is pressed on a session whose agent never edited anything.
  test.setTimeout(300_000)
  const { b, name, bPath } = await bothChangedDifferentFiles(team)
  const before = head(bPath)
  await reopenAgent(b, name)
  await banner(b).getByRole('button', { name: 'Bring together', exact: true }).click()
  // Whether or not the chat could start, the session is recorded on the badge.
  await expect(b.page.locator('[data-chat-row]').filter({ hasText: 'Bringing team changes together' })).toHaveCount(1, { timeout: 60_000 })
  await openAgent(b, name)
  await expect(badge(b, 'Bringing team changes together')).toBeVisible()
  expect(readFileSync(join(bPath, ACME_MD), 'utf8')).toContain('The team moved.')
  // The loose edit was recorded as a version first.
  expect(execFileSync('git', ['-C', bPath, 'status', '--porcelain'], { encoding: 'utf8' }).trim()).toBe('')
  await b.page.getByRole('group', { name: 'Runtime summary' }).getByRole('button', { name: 'Discard', exact: true }).click()
  const confirm = b.page.getByRole('dialog', { name: 'Discard the session’s changes' })
  await confirm.getByRole('button', { name: 'Discard changes', exact: true }).click()
  await expect(confirm).toHaveCount(0, { timeout: 60_000 })
  await expect(badge(b, 'You and the team both changed it')).toBeVisible({ timeout: 30_000 })
  expect(readFileSync(join(bPath, ACME_MD), 'utf8')).not.toContain('The team moved.')
  expect(readFileSync(join(bPath, SKILL_MD), 'utf8')).toBe(BS_SKILL)
  expect(execFileSync('git', ['-C', bPath, 'log', '-1', '--format=%s'], { encoding: 'utf8' })).toContain(
    'Changes made before bringing the team’s version in'
  )
  expect(head(bPath)).not.toBe(before)
})

test('Can use: no Share changes in the app, and a raw send is refused by core', async ({ team }) => {
  test.setTimeout(300_000)
  const { fixture } = team
  const { name } = await sharedWithEditor(team)
  const c = await team.open('c')
  await getFromLibrary(c, name)
  await c.page.getByRole('dialog', { name: `Finish setting up ${name}` }).getByRole('button', { name: 'Finish later', exact: true }).click()
  const cPath = (await findAgent(c, name)).path
  edit(cPath, ACME_MD, '# Acme\n\nC would like to change this.\n')
  await openAgent(c, name)
  await expect(badge(c, '1 change not shared')).toBeVisible()
  await expect(c.page.getByRole('button', { name: 'Share changes…', exact: true })).toHaveCount(0)
  const pushed = rawPush(fixture, cPath, fixture.people.c)
  expect(pushed).toContain('403')
})

test('edit access taken away mid-way: the send asks for a maintainer', async ({ team }) => {
  test.setTimeout(300_000)
  const { fixture } = team
  const { b, name, bPath, slug } = await sharedWithEditor(team)
  edit(bPath, ACME_MD, '# Acme\n\nB edits before being demoted.\n')
  await openAgent(b, name)
  await b.page.getByRole('group', { name: 'Runtime summary' }).getByRole('button', { name: 'Share changes…', exact: true }).click()
  const dialog = b.page.getByRole('dialog', { name: 'Share changes' })
  await dialog.getByRole('textbox').fill('B, about to be demoted')

  await setCatalogAccess(fixture, slug, fixture.people.b.id, 'use')

  await dialog.getByRole('button', { name: 'Share', exact: true }).click()
  await expect(dialog.getByRole('alert')).toHaveText(
    'Ask a maintainer for edit access — you can use this agent but not change it for the team.',
    { timeout: 60_000 }
  )
  await expect(dialog).toBeVisible()
})

for (const refusal of [
  {
    title: 'a symlink',
    make: (path: string) => symlinkSync('acme.md', join(path, 'knowledge/link.md')),
    sentence: "This change includes knowledge/link.md, a shortcut (symlink) to another file, which can't be shared. Replace it with the file itself."
  },
  {
    title: 'an oversized file',
    make: (path: string) => writeFileSync(join(path, 'files/big.bin'), randomBytes(11 * 1024 * 1024)),
    sentence: 'The file files/big.bin is larger than 10 MB, too big to share with the team.'
  },
  {
    title: 'an invalid manifest',
    make: (path: string) => {
      const manifest = JSON.parse(readFileSync(join(path, 'cinna-agent.json'), 'utf8'))
      manifest.schedules = 'every morning'
      writeFileSync(join(path, 'cinna-agent.json'), JSON.stringify(manifest, null, 2) + '\n')
    },
    sentence: "This agent's cinna-agent.json isn't valid (schedules: 'every morning' is not of type 'array'), so it can't be shared."
  },
  {
    title: 'a changed manifest id',
    make: (path: string) => {
      const manifest = JSON.parse(readFileSync(join(path, 'cinna-agent.json'), 'utf8'))
      manifest.id = randomUUID()
      writeFileSync(join(path, 'cinna-agent.json'), JSON.stringify(manifest, null, 2) + '\n')
    },
    sentence: "This agent's identity changed; share it as a new agent instead.",
    relaunch: true
  }
]) {
  test(`core refuses ${refusal.title}: the dialog shows core's sentence and the version stays Not shared yet`, async ({ team }) => {
    test.setTimeout(300_000)
    const { fixture } = team
    const { a, name, aPath, slug } = await sharedWithEditor(team)
    const before = (await catalogEntryOrFail(fixture, slug)).desktop.head_sha
    refusal.make(aPath)
    // A new manifest id is a new agent to the app: like a seeded one, it needs a relaunch.
    if (refusal.relaunch) await a.relaunch()
    await openAgent(a, name)
    await a.page.getByRole('group', { name: 'Runtime summary' }).getByRole('button', { name: 'Share changes…', exact: true }).click()
    const dialog = a.page.getByRole('dialog', { name: 'Share changes' })
    await dialog.getByRole('textbox').fill(`Adds ${refusal.title}`)
    await dialog.getByRole('button', { name: 'Share', exact: true }).click()
    await expect(dialog.getByRole('alert')).toHaveText(`Fix what the catalog refused, then share again. ${refusal.sentence}`, { timeout: 60_000 })
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect((await catalogEntryOrFail(fixture, slug)).desktop.head_sha).toBe(before)
    await openSharingTab(a, name)
    const history = section(a, 'History')
    await expect(history.getByText(`Adds ${refusal.title}`, { exact: true })).toBeVisible()
    await expect(history.getByText('Not shared yet', { exact: true })).toHaveCount(1)
  })
}

for (const fixable of [
  {
    title: 'a symlink',
    make: (path: string) => symlinkSync('acme.md', join(path, 'knowledge/link.md')),
    refused: 'a shortcut (symlink) to another file',
    fix: (path: string) => {
      rmSync(join(path, 'knowledge/link.md'))
      writeFileSync(join(path, 'knowledge/link.md'), 'Now a real file.\n')
    }
  },
  {
    title: 'an oversized file',
    make: (path: string) => writeFileSync(join(path, 'files/big.bin'), randomBytes(11 * 1024 * 1024)),
    refused: 'The file files/big.bin is larger than 10 MB',
    fix: (path: string) => writeFileSync(join(path, 'files/big.bin'), randomBytes(1024))
  }
]) {
  test(`after core refuses ${fixable.title}, fixing it lets the next Share changes through as one combined version`, async ({ team }) => {
    test.setTimeout(300_000)
    const { fixture } = team
    const { a, name, aPath, slug } = await sharedWithEditor(team)
    const repoId = (await catalogEntryOrFail(fixture, slug)).desktop.repo_id as string
    const clone = () => {
      const history = cloneHistory(fixture, repoId, fixture.admin.token)
      if (history.status !== 'ok') throw new Error(`admin clone refused: ${history.output}`)
      return history
    }
    const before = clone().commits.length
    const dialog = () => a.page.getByRole('dialog', { name: 'Share changes' })
    const share = async (note: string): Promise<void> => {
      await openAgent(a, name)
      await a.page.getByRole('group', { name: 'Runtime summary' }).getByRole('button', { name: 'Share changes…', exact: true }).click()
      await dialog().getByRole('textbox').fill(note)
      await dialog().getByRole('button', { name: 'Share', exact: true }).click()
    }

    fixable.make(aPath)
    await share(`Adds ${fixable.title}`)
    await expect(dialog().getByRole('alert')).toContainText(fixable.refused, { timeout: 60_000 })
    await dialog().getByRole('button', { name: 'Cancel', exact: true }).click()

    fixable.fix(aPath)
    await share(`Fixes ${fixable.title}`)
    await expect(dialog().getByRole('alert').or(badge(a, 'Up to date with the team'))).toBeVisible({ timeout: 60_000 })
    await expect(dialog()).toHaveCount(0)
    await expect(badge(a, 'Up to date with the team')).toBeVisible()

    const after = clone()
    expect(after.commits.length).toBe(before + 1)
    expect(after.commits[0].sha).toBe(head(aPath))
    expect(after.commits[0].message).toContain(`Adds ${fixable.title}`)
    expect(after.commits[0].message).toContain(`Fixes ${fixable.title}`)
    expect(after.commits.flatMap((commit) => commit.symlinks)).toEqual([])
    expect(Math.max(...after.commits.map((commit) => commit.maxBlob))).toBeLessThan(10 * 1024 * 1024)
    const localTree = execFileSync('git', ['-C', aPath, 'ls-tree', '-r', '-l', 'HEAD'], { encoding: 'utf8' })
    expect(localTree.split('\n').filter((line) => line.startsWith('120000 '))).toEqual([])
    await openSharingTab(a, name)
    await expect(section(a, 'History').getByText('Not shared yet', { exact: true })).toHaveCount(0)
  })
}
