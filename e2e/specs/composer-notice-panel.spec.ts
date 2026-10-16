import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { answerAgentsFolder, expect, test } from '../fixtures/app'
import { addAgentRoot, createFolderAgent } from '../fixtures/seed'

/**
 * The composer's notice panel on a folder agent whose manifest fails its check
 * (two credential slots with an empty `service_uri`), whose slots have no
 * values, and which runs on OpenCode in a sandbox with no AI credential. The
 * panel — `status` "Agent status" over the message box — carries one row each
 * for the missing credentials (Finish setup), the AI credential (Add
 * credential, since the sandbox has none to choose from) and the findings (first finding, "1 more", Reveal); the agent
 * page no longer repeats the finding as a banner, and the findings do not
 * block Send. Fixing the manifest on disk drops the findings row through the
 * folder watcher, with no relaunch. Model-free: nothing is sent.
 */

const AGENT = 'Notice Panel Agent'
const FIRST = '`credentials[0].service_uri` must be a non-empty string.'
const SECOND = '`credentials[1].service_uri` must be a non-empty string.'
const CREDENTIALS = 'Add the credentials for Odoo PROD, Billing API by attaching them or configuring credentials/.env.'
const AI_CREDENTIAL = 'No AI credential is set for this agent.'

test('composer notice panel: findings, credentials and AI credential rows on a folder agent', async ({ cinna }) => {
  await cinna.skipOnboarding()
  const root = await addAgentRoot(cinna)
  const created = await createFolderAgent(cinna, root, AGENT, AGENT)
  const manifestPath = join(created.path, 'cinna-agent.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.credentials = [
    { name: 'Odoo PROD', type: 'odoo', service_uri: '', env_prefix: 'ODOO_', fields: ['url', 'login'] },
    { name: 'Billing API', type: 'api_token', service_uri: '', env_prefix: 'BILLING_' }
  ]
  // OpenCode, so the sandbox's empty provider list leaves it with no AI credential.
  manifest.runtime = { ...(manifest.runtime ?? {}), engine: 'opencode' }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

  await cinna.relaunch()
  await cinna.skipOnboarding()
  await cinna.page.evaluate(() => window.api.localAgents.rescan())
  const indexed = await cinna.page.evaluate((id) => window.api.localAgents.get(id), created.id)
  expect(indexed.ok && indexed.value.readiness).toBe('invalid')

  await cinna.page.getByRole('button', { name: 'Agents', exact: true }).click()
  await answerAgentsFolder(cinna)
  await cinna.page.getByRole('button', { name: AGENT, exact: true }).click()

  const panel = cinna.page.getByRole('status', { name: 'Agent status' })
  // The panel's own rows; an expanded "1 more" adds a nested list of its own.
  const rows = panel.getByRole('listitem').filter({ has: cinna.page.getByRole('paragraph') })

  await test.step('the panel carries the three rows, in order', async () => {
    await expect(panel).toBeVisible()
    await expect(rows).toHaveCount(3)
    await expect(rows.nth(0).getByRole('paragraph')).toHaveText(CREDENTIALS)
    await expect(rows.nth(0).getByRole('button', { name: 'Finish setup', exact: true })).toBeVisible()
    await expect(rows.nth(1).getByRole('paragraph')).toHaveText(AI_CREDENTIAL)
    await expect(rows.nth(1).getByRole('button', { name: 'Add credential', exact: true })).toBeVisible()

    const findings = rows.nth(2)
    await expect(findings.getByRole('paragraph')).toHaveText(
      'cinna-agent.json: credentials[0].service_uri must be a non-empty string.'
    )
    await expect(findings.getByRole('code')).toHaveText('credentials[0].service_uri')
    await expect(findings.getByRole('button', { name: 'Reveal', exact: true })).toBeVisible()
    const more = findings.getByRole('button', { name: '1 more', exact: true })
    await expect(more).toHaveAttribute('aria-expanded', 'false')
    await more.click()
    await expect(more).toHaveAttribute('aria-expanded', 'true')
    await expect(findings.getByRole('listitem')).toHaveText(
      'cinna-agent.json: credentials[1].service_uri must be a non-empty string.'
    )
  })

  await test.step('no readiness banner repeats the finding above the page', async () => {
    // The removed strip printed readinessReason verbatim, backticks and all;
    // the panel draws them as code, so the raw sentence appears nowhere.
    await expect(cinna.page.getByText(FIRST, { exact: true })).toHaveCount(0)
    await expect(cinna.page.getByText(SECOND, { exact: true })).toHaveCount(0)
    await expect(cinna.page.getByText('This folder does not validate.')).toHaveCount(0)
    await expect(cinna.page.getByRole('banner').getByRole('alert')).toHaveCount(0)
  })

  await test.step('the findings do not block Send', async () => {
    const input = cinna.page.getByRole('combobox', { name: 'Type a message...', exact: true })
    await expect(cinna.page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
    await input.fill('Hello there')
    await expect(cinna.page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
    await input.fill('')
  })

  await test.step('Finish setup opens the dialog; Finish later leaves the panel', async () => {
    await rows.nth(0).getByRole('button', { name: 'Finish setup', exact: true }).click()
    const dialog = cinna.page.getByRole('dialog', { name: `Finish setting up ${AGENT}` })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Finish later', exact: true }).click()
    await expect(dialog).toBeHidden()
    await expect(rows).toHaveCount(3)
  })

  await test.step('fixing the manifest on disk drops the findings row without a restart', async () => {
    await expect(rows).toHaveCount(3)
    const fixed = JSON.parse(readFileSync(manifestPath, 'utf8'))
    for (const slot of fixed.credentials) delete slot.service_uri
    writeFileSync(manifestPath, JSON.stringify(fixed, null, 2))

    await expect(panel.getByRole('button', { name: 'Reveal', exact: true })).toHaveCount(0, { timeout: 15_000 })
    await expect(rows).toHaveCount(2)
    await expect(rows.nth(0).getByRole('paragraph')).toHaveText(CREDENTIALS)
    await expect(rows.nth(0).getByRole('button', { name: 'Finish setup', exact: true })).toBeVisible()
    await expect(rows.nth(1).getByRole('paragraph')).toHaveText(AI_CREDENTIAL)
    await expect(rows.nth(1).getByRole('button', { name: 'Add credential', exact: true })).toBeVisible()
    const after = await cinna.page.evaluate((id) => window.api.localAgents.get(id), created.id)
    expect(after.ok && after.value.readiness).toBe('credentials_needed')
  })

  await test.step('with no AI credential on this machine, Add credential opens Settings → AI Credentials', async () => {
    await rows.nth(1).getByRole('button', { name: 'Add credential', exact: true }).click()
    await expect(cinna.page.getByRole('heading', { name: 'AI Credentials' })).toBeVisible()
    await expect(panel).toBeHidden()
  })
})
