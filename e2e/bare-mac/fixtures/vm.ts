import { test as base, chromium, type Browser, type Page, type TestInfo } from '@playwright/test'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

/**
 * One bare macOS VM per test, and the packaged app running inside it.
 *
 * Every test clones the base image `make bare-mac-image` built — a Mac with no
 * Command Line Tools, no Homebrew, no uv or node, Gatekeeper on — boots it,
 * installs the app the way a user would, and launches it in the guest's login
 * session. Playwright on the host drives the renderer over CDP through an SSH
 * tunnel; there is no `electronApp`, so nothing in main can be stubbed. What a
 * spec can do is what a user can do, plus `window.api` calls from the page.
 *
 * **The point of the suite is the nag watch.** Throughout the test the guest's
 * on-screen windows are polled; any window whose owner is not the app or the
 * desktop — the "install command line developer tools" dialog, a keychain
 * prompt, a folder-access prompt — is recorded with the step it appeared in,
 * and fails the test at the end. Specs call `vm.step(label)` before each user
 * action so a failure says which action raised the dialog.
 *
 * The clone is deleted after the test; `CINNA_BARE_KEEP=1` keeps a failed
 * test's VM running for a look (`tart ip <name>`, ssh admin@<ip>, password admin).
 */

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const IMAGE = process.env.CINNA_BARE_IMAGE ?? 'cinna-bare-sequoia'
const ASKPASS = join(repoRoot, 'scripts', 'bare-mac', 'askpass.sh')
const WINDOWS_JS = join(repoRoot, 'scripts', 'bare-mac', 'windows.js')
const CDP_PORT = 9222
const POLL_MS = 2_000

/**
 * Window owners that are never a nag: the app itself and what a logged-in
 * desktop always shows. Anything else on screen is a finding.
 */
const EXPECTED_OWNERS = new Set(['Cinna Desktop', 'Window Server', 'Dock', 'Control Center', 'Spotlight', 'Finder'])

/**
 * Gatekeeper's "Verifying “Cinna Desktop”…" bar: a 400x70 panel at layer 3
 * that every downloaded app shows once on its first open and that asks
 * nothing. Seen on the DMG install only, never on a zip. Its other windows —
 * the "downloaded from the Internet" confirmation, a rejection — are layer 0
 * and still count.
 */
function isExpectedWindow(w: GuestWindow): boolean {
  if (EXPECTED_OWNERS.has(w.owner)) return true
  const height = Number(w.size.split('x')[1])
  return w.owner === 'CoreServicesUIAgent' && w.layer === 3 && height <= 100
}

const execFileP = promisify(execFile)

export interface GuestWindow {
  owner: string
  pid: number
  layer: number
  size: string
}

export interface Nag extends GuestWindow {
  /** The `vm.step` label current when the window was first seen. */
  step: string
  /** Seconds since the app was launched. */
  atSeconds: number
}

export interface BareVm {
  readonly name: string
  readonly ip: string
  /** The app's main window (`index.html`), never the tray panel. */
  readonly page: Page
  /** Where the app keeps its profile in the guest. */
  readonly userData: string
  /** Label the next stretch of the test; nags are reported against it. */
  step(label: string): void
  /** Run a command in the guest (as admin, in zsh). Rejects on a non-zero exit. */
  sh(command: string, timeoutMs?: number): Promise<string>
  /** Poll the guest's windows now rather than at the next tick. */
  pollWindows(): Promise<GuestWindow[]>
  /** Every nag seen so far. */
  nags(): readonly Nag[]
}

function sshBase(controlPath: string): string[] {
  return [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'LogLevel=ERROR',
    '-o', 'PubkeyAuthentication=no',
    '-o', 'ConnectTimeout=5',
    // One authenticated connection for the whole test: the window poll runs
    // every two seconds and must not pay a password login each time.
    '-o', 'ControlMaster=auto',
    '-o', `ControlPath=${controlPath}`,
    '-o', 'ControlPersist=600'
  ]
}

const sshEnv = { ...process.env, SSH_ASKPASS: ASKPASS, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: ':0' }

async function tart(args: string[], timeoutMs = 120_000): Promise<string> {
  const { stdout } = await execFileP('tart', args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 })
  return stdout
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))))
    })
  })
}

/** Single-quote for the guest's shell. */
export function q(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function parseWindows(listing: string): GuestWindow[] {
  return listing
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [owner = '', pid = '0', layer = '0', size = ''] = line.split('\t')
      return { owner: owner.trim(), pid: Number(pid), layer: Number(layer), size }
    })
}

export function formatNags(nags: readonly Nag[]): string {
  return nags.map((n) => `  - ${n.owner} (pid ${n.pid}, ${n.size}, layer ${n.layer}) at +${n.atSeconds}s during "${n.step}"`).join('\n')
}

function exited(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/** Stop the guest and delete its clone. Says so when the clone outlives it. */
async function stopVm(name: string, run: ChildProcess, testInfo: TestInfo): Promise<void> {
  await tart(['stop', name, '--timeout', '10']).catch(() => undefined)
  if (run.exitCode === null) run.kill()
  await exited(run, 15_000)
  try {
    await tart(['delete', name])
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    testInfo.annotations.push({ type: 'vm leaked', description: `${name}: ${reason} — make bare-mac-clean` })
    console.warn(`bare-mac: could not delete ${name}: ${reason}`)
  }
}

export const test = base.extend<{ vm: BareVm }>({
  vm: async ({}, use, testInfo) => {
    // A trailing slash is what tab completion leaves on a .app directory.
    const appArchive = process.env.CINNA_BARE_APP?.replace(/\/+$/, '')
    if (!appArchive || !existsSync(appArchive)) {
      throw new Error('CINNA_BARE_APP must name the .dmg, .zip or .app to install — run the suite through `make bare-mac`')
    }

    const name = `cinna-bare-run-${process.pid}-${testInfo.workerIndex}-${Date.now().toString(36)}`
    await tart(['clone', IMAGE, name])
    // From here on every exit path goes through the `finally`, which stops
    // and deletes the clone: Apple allows two guests, so a leaked one halves
    // the room and a second stops every later test from booting.
    const run = spawn('tart', ['run', name, '--no-graphics'], { stdio: 'ignore' })
    const controlDir = mkdtempSync(join(tmpdir(), 'cb-'))
    const opts = sshBase(join(controlDir, 'ssh'))
    let ip = ''
    let target = ''

    const sh = async (command: string, timeoutMs = 60_000): Promise<string> => {
      const { stdout } = await execFileP('ssh', [...opts, target, command], {
        env: sshEnv,
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024
      })
      return stdout
    }
    const scp = (local: string, remote: string): Promise<unknown> =>
      execFileP('scp', [...opts, local, `${target}:${remote}`], { env: sshEnv, timeout: 300_000 })

    let browser: Browser | undefined
    let monitor: Promise<void> | undefined
    let monitoring = false
    let currentStep = 'boot'
    let launchedAt = Date.now()
    const nags: Nag[] = []
    const seen = new Set<string>()
    const windowLog: string[] = []
    let failedPolls = 0

    const pollWindows = async (): Promise<GuestWindow[]> => {
      const windows = parseWindows(await sh(`osascript -l JavaScript /tmp/windows.js`, 20_000))
      const atSeconds = Math.round((Date.now() - launchedAt) / 1000)
      for (const w of windows) {
        if (isExpectedWindow(w)) continue
        const key = `${w.owner}:${w.pid}`
        if (seen.has(key)) continue
        seen.add(key)
        nags.push({ ...w, step: currentStep, atSeconds })
        windowLog.push(`+${atSeconds}s [${currentStep}] NEW ${w.owner} pid=${w.pid} ${w.size} layer=${w.layer}`)
      }
      return windows
    }

    try {
      ip = (await tart(['ip', name, '--wait', '180'], 200_000)).trim()
      target = `admin@${ip}`
      for (let attempt = 0; ; attempt++) {
        try {
          await sh('true', 10_000)
          break
        } catch (error) {
          if (attempt >= 36) throw error
          await sleep(5_000)
        }
      }
      await scp(WINDOWS_JS, '/tmp/windows.js')

      // The installed app, the way a user gets it.
      currentStep = 'install'
      let archive = appArchive
      if (archive.endsWith('.app')) {
        const zipped = join(controlDir, 'app.zip')
        await execFileP('ditto', ['-c', '-k', '--keepParent', archive, zipped])
        archive = zipped
      }
      let appPath: string
      if (archive.endsWith('.dmg')) {
        // As a browser download: quarantined, so Gatekeeper assesses it. The
        // one "downloaded from the Internet" confirmation every downloaded app
        // gets cannot be clicked from here; the assessment behind it is
        // checked instead, and the flag removed before launch.
        const dmg = `/Users/admin/Downloads/${basename(archive)}`
        await scp(archive, dmg)
        await sh(`xattr -w com.apple.quarantine "0083;$(printf %x $(date +%s));Safari;" ${q(dmg)}`)
        const mount = (await sh(`set -o pipefail; hdiutil attach -nobrowse ${q(dmg)} | tail -1 | cut -f3-`, 120_000)).trim()
        if (!mount.startsWith('/Volumes/')) throw new Error(`the DMG did not mount (got "${mount}")`)
        const bundle = (await sh(`ls -d ${q(mount)}/*.app`)).trim()
        appPath = `/Applications/${basename(bundle)}`
        await sh(`ditto ${q(bundle)} ${q(appPath)} && hdiutil detach ${q(mount)} -quiet`, 180_000)
        const assessment = await sh(`spctl -a -vv -t exec ${q(appPath)} 2>&1 || true`)
        testInfo.annotations.push({ type: 'gatekeeper', description: assessment.trim().replace(/\n/g, ' | ') })
        if (!/accepted/.test(assessment)) throw new Error(`Gatekeeper rejects the app:\n${assessment}`)
        await sh(`xattr -dr com.apple.quarantine ${q(appPath)}`)
      } else {
        await scp(archive, '/tmp/cinna-app.zip')
        await sh(`ditto -x -k /tmp/cinna-app.zip /Applications/ && rm /tmp/cinna-app.zip`, 180_000)
        appPath = (await sh(`ls -d /Applications/Cinna*.app`)).trim()
      }

      currentStep = 'launch'
      launchedAt = Date.now()
      await sh(
        `open -a ${q(appPath)} --stdout /tmp/cinna.out --stderr /tmp/cinna.err --args --remote-debugging-port=${CDP_PORT}`
      )
      monitoring = true
      monitor = (async () => {
        while (monitoring) {
          await pollWindows().catch((error: unknown) => {
            // A poll that saw nothing is a stretch of the test nobody
            // watched: a dialog that came and went in it would be missed.
            failedPolls++
            const reason = error instanceof Error ? error.message.split('\n')[0] : String(error)
            windowLog.push(`+${Math.round((Date.now() - launchedAt) / 1000)}s [${currentStep}] POLL FAILED ${reason}`)
          })
          await sleep(POLL_MS)
        }
      })()
      for (let attempt = 0; ; attempt++) {
        const up = await sh(`curl -s -m 2 localhost:${CDP_PORT}/json/version || true`)
        if (up.includes('webSocketDebuggerUrl')) break
        if (attempt >= 60) throw new Error('the app never opened its CDP port')
        await sleep(1_000)
      }
      const hostPort = await freePort()
      await execFileP('ssh', [...opts, '-O', 'forward', '-L', `${hostPort}:localhost:${CDP_PORT}`, target], { env: sshEnv })
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${hostPort}`)
      let page: Page | undefined
      for (let attempt = 0; !page; attempt++) {
        page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().endsWith('/index.html'))
        if (!page) {
          if (attempt >= 30) throw new Error('the main window never appeared')
          await sleep(1_000)
        }
      }
      currentStep = 'first screen'

      await use({
        name,
        ip,
        page,
        userData: '/Users/admin/Library/Application Support/cinna-desktop',
        step(label: string) {
          currentStep = label
        },
        sh,
        pollWindows,
        nags: () => nags
      })

      currentStep = 'end of test'
      await pollWindows()
    } finally {
      monitoring = false
      await monitor
      await collectArtifacts(testInfo, sh, browser, windowLog).catch(() => undefined)
      await browser?.close().catch(() => undefined)
      if (target) await execFileP('ssh', [...opts, '-O', 'exit', target], { env: sshEnv }).catch(() => undefined)
      rmSync(controlDir, { recursive: true, force: true })
      // The nag and poll failures are thrown below, after this block, so the
      // test status alone still reads "passed" here for exactly those runs.
      const failed = nags.length > 0 || failedPolls > 0 || testInfo.status !== testInfo.expectedStatus
      if (process.env.CINNA_BARE_KEEP === '1' && failed) {
        testInfo.annotations.push({ type: 'vm kept', description: `${name} at ${ip} (ssh admin@${ip}, password admin)` })
      } else {
        await stopVm(name, run, testInfo)
      }
    }

    if (nags.length > 0) {
      throw new Error(`System dialogs appeared on the bare Mac:\n${formatNags(nags)}`)
    }
    if (failedPolls > 0) {
      throw new Error(`${failedPolls} window poll(s) failed, so part of the test went unwatched — see windows.txt`)
    }
  }
})

async function collectArtifacts(
  testInfo: TestInfo,
  sh: (command: string, timeoutMs?: number) => Promise<string>,
  browser: Browser | undefined,
  windowLog: readonly string[]
): Promise<void> {
  const page = browser?.contexts().flatMap((c) => c.pages()).find((p) => p.url().endsWith('/index.html'))
  if (page) await testInfo.attach('app.png', { body: await page.screenshot(), contentType: 'image/png' }).catch(() => undefined)
  const appLog = await sh('cat /tmp/cinna.out /tmp/cinna.err 2>/dev/null || true').catch(() => '')
  await testInfo.attach('app.log', { body: appLog, contentType: 'text/plain' })
  const windows = await sh('osascript -l JavaScript /tmp/windows.js').catch(() => '')
  await testInfo.attach('windows.txt', {
    body: `${windowLog.join('\n')}\n\n--- on screen at the end\n${windows}`,
    contentType: 'text/plain'
  })
}

export { expect } from '@playwright/test'
