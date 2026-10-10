import { closeSync, mkdirSync, openSync, ftruncateSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator } from '@playwright/test'
import { test, expect, type CinnaApp } from '../fixtures/app'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'
import { writeSkill } from '../fixtures/liveCatalog'

/**
 * An agent's own skills — `skills/<name>/SKILL.md` — as the Skills section of
 * the agent's Addons tab judges them, with no account and no core: the
 * validator is `src/main/kit/skills.ts`, a port of core's `skill_manifest.py`,
 * so every sentence asserted here is core's `ISSUE_MESSAGES` verbatim.
 *
 * One valid skill with a `credentials:` slot, and beside it one folder per
 * defect, each of which must carry its own issue and nothing else. The budget
 * defect is the byte cap (16 MiB per agent, `DEFAULT_MAX_TOTAL_BYTES`),
 * triggered by one sparse 17 MiB file: cheaper than the 51 folders the
 * count cap would take.
 */

const AGENT = 'Skill Workshop'
const OK_GLYPH = 'Every engine of this agent gets this skill'

const MESSAGES = {
  nameMismatch: 'The name in SKILL.md does not match the folder name.',
  noDescription: 'SKILL.md frontmatter has no description.',
  secrets: 'This skill holds files that look like credentials.',
  budget: 'Excluded — the agent is over its skill count or size budget.',
  // Desktop only (core skips links silently); Share refuses a link.
  links: 'This skill holds links, which can’t be shared — replace them with the files themselves.'
}

async function openSkillsSection(cinna: CinnaApp): Promise<Locator> {
  const page = cinna.page
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await page.getByRole('button', { name: AGENT, exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(AGENT)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('tablist', { name: 'Agent details' }).getByRole('tab', { name: /^Addons/ }).click()
  return page
    .getByRole('tabpanel')
    .locator('section')
    .filter({ has: page.getByRole('heading', { level: 2, name: 'Skills', exact: true }) })
}

/** The Skills row of an authored skill, by its folder name. */
function row(section: Locator, name: string): Locator {
  // The row is a listitem; its issues are listitems nested inside it.
  return section.getByRole('listitem').filter({ hasText: name }).filter({ hasText: 'Authored' })
}

function writeRaw(agentPath: string, folder: string, frontmatter: string[]): string {
  const dir = join(agentPath, 'skills', folder)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), ['---', ...frontmatter, '---', '', 'Body.', ''].join('\n'))
  return dir
}

async function skillRows(cinna: CinnaApp, agentId: string) {
  const agent = await cinna.page.evaluate((id) => window.api.localAgents.get(id), agentId)
  if (!agent.ok) throw new Error(agent.message)
  return Object.fromEntries((agent.value.skills ?? []).map((s) => [s.name, { deliverable: s.deliverable, codes: s.issues.map((i) => i.code) }]))
}

test('an authored skill with a credential slot is valid; each defective skill shows its own issue on its row', async ({ cinna }) => {
  await cinna.skipOnboarding()
  const root = await addAgentRoot(cinna)
  const agent = await createFolderAgent(cinna, root, AGENT)

  writeSkill(agent.path, 'erp-lookup', {
    description: 'Look up an order in the ERP.',
    credentials: [{ slot: 'erp-api', type: 'api_token', description: 'The ERP API token.' }]
  })
  writeRaw(agent.path, 'wrong-folder', ['name: other-name', 'description: Its frontmatter names another folder.'])
  writeRaw(agent.path, 'no-description', ['name: no-description'])
  const secret = writeRaw(agent.path, 'has-secret', ['name: has-secret', 'description: Carries a dotenv file.'])
  writeFileSync(join(secret, '.env'), 'TOKEN=not-a-real-one\n')
  const big = writeRaw(agent.path, 'big-files', ['name: big-files', 'description: Carries a file larger than the agent budget.'])
  mkdirSync(join(big, 'data'))
  // Sparse: 17 MiB by size, nothing written. The budget sums `stat().size`.
  const fd = openSync(join(big, 'data', 'blob.bin'), 'w')
  ftruncateSync(fd, 17 * 1024 * 1024)
  closeSync(fd)
  await cinna.page.evaluate(() => window.api.localAgents.rescan())

  await test.step('main: only the valid and the secret-carrying skills are delivered', async () => {
    expect(await skillRows(cinna, agent.id)).toEqual({
      'big-files': { deliverable: false, codes: ['budget'] },
      'erp-lookup': { deliverable: true, codes: [] },
      'has-secret': { deliverable: true, codes: ['secrets'] },
      'no-description': { deliverable: false, codes: ['missing_description'] },
      'wrong-folder': { deliverable: false, codes: ['name_mismatch'] }
    })
  })

  const section = await openSkillsSection(cinna)

  await test.step('valid: erp-lookup reads working, Needs erp-api, no issue', async () => {
    const valid = row(section, 'erp-lookup')
    await expect(valid.getByRole('img', { name: OK_GLYPH, exact: true })).toBeVisible()
    await expect(valid).toContainText('Look up an order in the ERP.')
    await expect(valid.locator('[data-skill-slots]')).toContainText('Needs')
    await expect(valid.locator('[data-skill-slots] code')).toHaveText(['erp-api'])
    await expect(valid.getByRole('listitem')).toHaveCount(0)
  })

  await test.step('frontmatter name differs from the folder name', async () => {
    const r = row(section, 'wrong-folder')
    await expect(r.getByRole('img', { name: MESSAGES.nameMismatch, exact: true })).toBeVisible()
    await expect(r.getByRole('listitem')).toHaveText([MESSAGES.nameMismatch])
  })

  await test.step('no description', async () => {
    const r = row(section, 'no-description')
    await expect(r.getByRole('img', { name: MESSAGES.noDescription, exact: true })).toBeVisible()
    await expect(r.getByRole('listitem')).toHaveText([MESSAGES.noDescription])
  })

  await test.step('a secret-looking file in the skill folder (a warning: still delivered)', async () => {
    const r = row(section, 'has-secret')
    await expect(r.getByRole('img', { name: MESSAGES.secrets, exact: true })).toBeVisible()
    const issues = r.getByRole('listitem')
    await expect(issues).toHaveCount(1)
    await expect(issues).toContainText(MESSAGES.secrets)
    await expect(issues.locator('code')).toHaveText(['.env'])
  })

  await test.step('over the 16 MiB per-agent byte budget', async () => {
    const r = row(section, 'big-files')
    await expect(r.getByRole('img', { name: MESSAGES.budget, exact: true })).toBeVisible()
    await expect(r.getByRole('listitem')).toHaveText([MESSAGES.budget])
  })
})

test('a symlink inside a skill folder warns on its row, and the skill is still delivered', async ({ cinna }) => {
  // Core's scanner skips links silently; the desktop warns because Share
  // refuses a link ("Replace notes.md with the file itself — a link can’t be
  // shared."), and the author should hear that before trying.
  await cinna.skipOnboarding()
  const root = await addAgentRoot(cinna)
  const agent = await createFolderAgent(cinna, root, AGENT)
  const dir = writeRaw(agent.path, 'has-link', ['name: has-link', 'description: Carries a symlink.'])
  writeFileSync(join(agent.path, 'knowledge', 'notes.md'), '# Notes\n')
  symlinkSync('../../knowledge/notes.md', join(dir, 'notes.md'))
  await cinna.page.evaluate(() => window.api.localAgents.rescan())

  const section = await openSkillsSection(cinna)
  const r = row(section, 'has-link')
  await expect(r.getByRole('img', { name: MESSAGES.links, exact: true })).toBeVisible()
  const issues = r.getByRole('listitem')
  await expect(issues).toHaveCount(1)
  await expect(issues).toContainText(MESSAGES.links)
  await expect(issues.locator('code')).toHaveText(['notes.md'])
})
