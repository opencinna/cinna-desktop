// Core web UI screenshots for the issued Agent API key live run (companion of live-issued-key.py).
// Usage: node e2e/fixtures/live-issued-key-core-ui.mjs <fixture.json> <phase: active|paused|revoked> [outDir]
// FRONTEND (default http://localhost:5173) must serve the current core frontend build.
// `paused` toggles the producer's external access off and back on; nothing else is written.
import { readFileSync, mkdirSync } from 'node:fs'
import { chromium } from '@playwright/test'

const [fixturePath, phase, out = '/tmp/issued-keys-live'] = process.argv.slice(2)
const fx = JSON.parse(readFileSync(fixturePath, 'utf8'))
const FE = process.env.FRONTEND ?? 'http://localhost:5173'
const API = process.env.CORE_API ?? 'http://localhost:8000/api/v1'
mkdirSync(out, { recursive: true })
const tokenOf = h => h.Authorization.replace(/^Bearer /, '')
const results = []

const browser = await chromium.launch()
async function as(headers) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await ctx.addInitScript(t => localStorage.setItem('access_token', t), tokenOf(headers))
  return ctx.newPage()
}
async function shot(name, fn) {
  try { await fn(); results.push(`OK   ${name}`) } catch (e) { results.push(`FAIL ${name}: ${String(e).split('\n')[0]}`) }
}
const settle = page => page.waitForLoadState('networkidle').catch(() => {})
const setExternal = on => fetch(`${API}/agents/${fx.producer_id}`, { method: 'PUT', headers: { ...fx.admin.headers, 'content-type': 'application/json' }, body: JSON.stringify({ agent_api_external_access_enabled: on }) })
const accessCard = page => page.locator('div.rounded-xl, [class*="card"]').filter({ has: page.getByText('API access', { exact: true }) }).filter({ hasText: 'External access' }).first()

const admin = await as(fx.admin.headers)
const recipient = await as(fx.recipient.headers)
const selfCred = fx.self_key?.credential_id

if (phase === 'active') {
  await shot('S1 API access card', async () => {
    await admin.goto(`${FE}/agent/${fx.producer_id}#integrations`); await settle(admin)
    const card = accessCard(admin); await card.waitFor({ timeout: 20_000 }); await card.scrollIntoViewIfNeeded()
    await card.screenshot({ path: `${out}/core-01-api-access-card.png` })
  })
  await shot('S1a person dialog', async () => {
    await accessCard(admin).getByRole('button', { name: new RegExp(fx.recipient.email.split('@')[0]) }).first().click()
    const d = admin.getByRole('dialog'); await d.waitFor()
    await d.screenshot({ path: `${out}/core-02-person-dialog.png` }); await admin.keyboard.press('Escape')
  })
  await shot('S2 Give API access dialog', async () => {
    await accessCard(admin).getByRole('button', { name: 'Give access' }).click()
    const d = admin.getByRole('dialog', { name: 'Give API access' }); await d.waitFor()
    await admin.waitForTimeout(500)
    await d.screenshot({ path: `${out}/core-03-give-api-access-dialog.png` }); await admin.keyboard.press('Escape')
  })
  await shot('S3 recipient key page (active)', async () => {
    await recipient.goto(`${FE}/credential/${fx.credential_id}`); await settle(recipient); await recipient.waitForTimeout(800)
    await recipient.screenshot({ path: `${out}/core-04-recipient-key-active.png`, fullPage: true })
  })
  await shot('S5 connection Sharing hint', async () => {
    const conn = process.env.CONNECTION_CREDENTIAL_ID
    if (!conn) throw new Error('set CONNECTION_CREDENTIAL_ID to an agent_api connection whose producer the admin owns')
    await admin.goto(`${FE}/credential/${conn}`); await settle(admin); await admin.waitForTimeout(800)
    const hint = admin.getByText('Open API access'); await hint.waitFor({ timeout: 15_000 })
    await admin.screenshot({ path: `${out}/core-05-connection-sharing-hint.png`, fullPage: true })
  })
}

if (phase === 'paused') {
  await setExternal(false)
  try {
    await shot('S4 admin list badge (self key paused)', async () => {
      await admin.goto(`${FE}/credentials`); await settle(admin); await admin.waitForTimeout(800)
      await admin.getByText('External access paused').first().waitFor({ timeout: 15_000 })
      await admin.screenshot({ path: `${out}/core-06-credentials-list-paused.png`, fullPage: true })
    })
    await shot('S3 key page paused (self key)', async () => {
      await admin.goto(`${FE}/credential/${selfCred}`); await settle(admin); await admin.waitForTimeout(800)
      await admin.screenshot({ path: `${out}/core-07-key-page-paused.png`, fullPage: true })
    })
    await shot('S3 recipient key page paused', async () => {
      await recipient.goto(`${FE}/credential/${fx.credential_id}`); await settle(recipient); await recipient.waitForTimeout(800)
      await recipient.screenshot({ path: `${out}/core-07b-recipient-key-paused.png`, fullPage: true })
    })
    await shot('S1 access card paused', async () => {
      await admin.goto(`${FE}/agent/${fx.producer_id}#integrations`); await settle(admin)
      const card = accessCard(admin); await card.waitFor({ timeout: 20_000 }); await card.scrollIntoViewIfNeeded()
      await card.screenshot({ path: `${out}/core-08-api-access-card-paused.png` })
    })
  } finally { await setExternal(true) }
}

if (phase === 'revoked') {
  await shot('S4 recipient list badge (revoked)', async () => {
    await recipient.goto(`${FE}/credentials`); await settle(recipient); await recipient.waitForTimeout(800)
    await recipient.getByText('Revoked by issuer').first().waitFor({ timeout: 15_000 })
    await recipient.screenshot({ path: `${out}/core-09-recipient-list-revoked.png`, fullPage: true })
  })
  await shot('S3 recipient key page revoked', async () => {
    await recipient.goto(`${FE}/credential/${fx.credential_id}`); await settle(recipient); await recipient.waitForTimeout(800)
    await recipient.getByText('Revoked by issuer').first().waitFor({ timeout: 15_000 })
    await recipient.screenshot({ path: `${out}/core-10-recipient-key-revoked.png`, fullPage: true })
  })
  await shot('S1a person dialog with ended key', async () => {
    await admin.goto(`${FE}/agent/${fx.producer_id}#integrations`); await settle(admin)
    const card = accessCard(admin); await card.waitFor({ timeout: 20_000 }); await card.scrollIntoViewIfNeeded()
    await card.screenshot({ path: `${out}/core-11-api-access-card-revoked.png` })
    await card.getByRole('button', { name: new RegExp(fx.recipient.email.split('@')[0]) }).first().click()
    const d = admin.getByRole('dialog'); await d.waitFor()
    const disclosure = d.getByRole('button', { name: /ended|revoked|history/i }).first()
    if (await disclosure.count()) await disclosure.click()
    await admin.waitForTimeout(400)
    await d.screenshot({ path: `${out}/core-12-person-dialog-revoked.png` })
  })
}

await browser.close()
console.log(results.join('\n'))
