// Live-backend control server: holds one built Cinna Desktop app and lets a
// shell (a person, or an agent through `live.sh`) drive it step by step —
// launch, SIGKILL, clean quit, and arbitrary Playwright code against the
// window — while the same shell stops, kills or rewinds the cinna-core stack.
//
// Unlike the E2E suite this runs on a REAL profile (the one `npm run dev`
// uses) unless CINNA_LIVE_USER_DATA is set, because a synced Cinna account's
// tokens are encrypted with the login keychain and cannot be copied into a
// sandbox. Back the profile up first (`live_backup` in live.sh).
//
//   node scripts/live-backend/ctl.mjs            (or: make live-ctl)
//   POST /launch | /kill | /quit | /front | /status
//   POST /run   body = async JS with `page`, `app`, `proc`, `dir` in scope
//
// Docs: docs/development/live_backend/live_backend.md
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const require = createRequire(join(repo, 'package.json'))
const { _electron: electron } = require('@playwright/test')
const electronPath = require('electron')

const PORT = Number(process.env.CINNA_LIVE_PORT || 47111)
const today = new Date().toISOString().slice(0, 10).replaceAll('-', '')
const dir = resolve(process.env.CINNA_LIVE_RUN_DIR || join(repo, 'drafts', 'live_runs', today))
const LOG = join(dir, 'app.log')
mkdirSync(join(dir, 'shots'), { recursive: true })

let app = null
let page = null
let proc = null
const log = (s) => appendFileSync(LOG, s)
const running = () => !!proc && proc.exitCode === null && proc.signalCode === null

/**
 * Another Cinna Desktop on this machine shares the profile and holds the
 * single-instance lock: the launched app would exit at once, or — worse — the
 * installed release would take over a `cinna://` sign-in redirect.
 */
function otherInstances() {
  let out = ''
  try {
    out = execFileSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8' })
  } catch {
    return []
  }
  const ours = proc?.pid
  return out
    .split('\n')
    .filter((line) => /Cinna Desktop\.app\/Contents\/MacOS\/Cinna Desktop$/.test(line.trim()) ||
      /node_modules\/electron\/dist\/Electron\.app\/Contents\/MacOS\/Electron .*cinna-desktop/.test(line))
    .filter((line) => !/--type=/.test(line))
    .filter((line) => Number(line.trim().split(/\s+/)[0]) !== ours)
    .map((line) => line.trim().slice(0, 160))
}

async function launch() {
  if (running()) throw new Error('already running')
  const others = otherInstances()
  if (others.length) throw new Error(`another Cinna Desktop is running — quit it first:\n${others.join('\n')}`)
  const env = { ...process.env, CINNA_BACKGROUND_WINDOW: process.env.CINNA_LIVE_FOREGROUND === '1' ? '0' : '1' }
  delete env.CINNA_USER_DATA
  if (process.env.CINNA_LIVE_USER_DATA) env.CINNA_USER_DATA = process.env.CINNA_LIVE_USER_DATA
  log(`\n===== LAUNCH ${new Date().toISOString()} =====\n`)
  app = await electron.launch({ executablePath: electronPath, args: [repo], cwd: repo, env, timeout: 60_000 })
  proc = app.process()
  const stamp = (chunk) => log(chunk.toString().replace(/^(?=.)/gm, `[${new Date().toISOString().slice(11, 23)}] `))
  proc.stdout?.on('data', stamp)
  proc.stderr?.on('data', stamp)
  proc.once('exit', (code, signal) => log(`===== EXIT code=${code} signal=${signal} ${new Date().toISOString()} =====\n`))
  const isMain = (p) => p.url().endsWith('index.html')
  page = app.windows().find(isMain) ?? (await app.waitForEvent('window', { predicate: isMain, timeout: 60_000 }))
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('button', { name: 'Chats', exact: true }).waitFor({ timeout: 90_000 })
  return { pid: proc.pid, profile: env.CINNA_USER_DATA ?? 'real profile' }
}

function exited() {
  return new Promise((done) => {
    if (!running()) return done({ code: proc?.exitCode ?? null, signal: proc?.signalCode ?? null })
    proc.once('exit', (code, signal) => done({ code, signal }))
  })
}

/** A crash: SIGKILL of the main process only, so `will-quit` never runs. */
async function kill() {
  if (!running()) throw new Error('not running')
  const pid = proc.pid
  const done = exited()
  proc.kill('SIGKILL')
  return { pid, at: new Date().toISOString(), ...(await done) }
}

/** A normal quit (Cmd+Q): `app.quit()`, so `will-quit` and its flushes run. */
async function quit() {
  if (!running()) return { note: 'not running' }
  const done = exited()
  await app.evaluate(({ app }) => { setTimeout(() => app.quit(), 0) }).catch(() => {})
  return { at: new Date().toISOString(), ...(await done) }
}

/** Show the hidden window, for a step a person has to do (sign-in, a look). */
async function front() {
  if (!running()) throw new Error('not running')
  await app.evaluate(({ app, BrowserWindow }) => {
    app.dock?.show?.()
    app.focus({ steal: true })
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.webContents.getURL().endsWith('index.html')) { w.show(); w.focus() }
    }
  })
  return 'front'
}

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor

const server = http.createServer(async (req, res) => {
  let body = ''
  for await (const c of req) body += c
  try {
    let out
    if (req.url === '/launch') out = await launch()
    else if (req.url === '/kill') out = await kill()
    else if (req.url === '/quit') out = await quit()
    else if (req.url === '/front') out = await front()
    else if (req.url === '/status') out = { running: running(), pid: proc?.pid ?? null, dir, others: otherInstances() }
    else if (req.url === '/run') {
      if (!running()) throw new Error('not running')
      out = await new AsyncFunction('page', 'app', 'proc', 'dir', body)(page, app, proc, dir)
    } else throw new Error('unknown ' + req.url)
    res.end(JSON.stringify(out ?? null, null, 1) + '\n')
  } catch (err) {
    res.statusCode = 500
    res.end('ERROR ' + (err?.stack ?? String(err)) + '\n')
  }
})

server.listen(PORT, '127.0.0.1', () => console.log(`live ctl on 127.0.0.1:${PORT}, run dir ${dir}`))

const shutdown = async () => {
  await quit().catch(() => {})
  server.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
