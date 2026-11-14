// Shared host-side pieces for make vault-image and the guest boot smoke test: start a VM with
// vzbuild, follow its console, unix-socket services the guest reaches over vsock, hashing.
// Dev-only tooling; nothing here ships.
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'

export const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
export const GUEST_OUT = path.join(REPO, 'build/vault-guest')
export const VZBUILD = path.join(GUEST_OUT, 'tools/vzbuild')

const T0 = Date.now()
export const elapsed = () => Date.now() - T0
export const log = (...a) => console.log(`[${String(elapsed()).padStart(7)}ms]`, ...a)

/** A short private directory for unix sockets (sun_path is 104 bytes on macOS). */
export function socketDir(tag) {
  return fs.mkdtempSync(path.join('/tmp', `cinna-vz-${tag}-`))
}

export function unixServer(sockPath, onConn) {
  try {
    fs.unlinkSync(sockPath)
  } catch {}
  const s = net.createServer(onConn)
  s.listen(sockPath)
  return s
}

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256')
    fs.createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')))
  })
}

/**
 * Starts vzbuild with `cfg` (see native/vault/tools/vzbuild/main.swift). Console lines that
 * contain "VAULT" are passed to onConsole(line, ms) as they appear.
 */
export function startVM(cfg, { configPath, onConsole = () => {} } = {}) {
  if (!fs.existsSync(VZBUILD)) throw new Error(`vzbuild missing: run make vault-image once (${VZBUILD})`)
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2))
  const t0 = Date.now()
  const child = spawn(VZBUILD, ['run', configPath], { stdio: ['pipe', 'pipe', 'inherit'] })
  const waiters = []
  const events = []
  let buf = ''
  child.stdout.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      let ev
      try {
        ev = JSON.parse(line)
      } catch {
        log('vzbuild:', line)
        continue
      }
      events.push(ev)
      if (!['starting', 'running', 'connect-failed'].includes(ev.ev)) log('vzbuild', JSON.stringify(ev))
      for (const w of [...waiters]) if (w.ev === ev.ev) (waiters.splice(waiters.indexOf(w), 1), w.resolve(ev))
    }
  })
  const exited = new Promise((r) => child.on('exit', (code) => r(code)))
  let consoleOffset = 0
  let partial = ''
  const readConsole = () => {
    let fd
    try {
      fd = fs.openSync(cfg.console, 'r')
    } catch {
      return
    }
    try {
      const size = fs.fstatSync(fd).size
      if (size <= consoleOffset) return
      const b = Buffer.alloc(size - consoleOffset)
      fs.readSync(fd, b, 0, b.length, consoleOffset)
      consoleOffset = size
      partial += b.toString('utf8')
      const lines = partial.split('\n')
      partial = lines.pop()
      for (const l of lines) {
        const m = l.match(/VAULT.*/)
        if (m) onConsole(m[0].replace(/\r$/, ''), Date.now() - t0)
      }
    } finally {
      fs.closeSync(fd)
    }
  }
  const timer = setInterval(readConsole, 25)
  // Last lines (e.g. "VAULT FAILED ...") are written just before the guest powers off.
  exited.then(() => (clearInterval(timer), readConsole()))
  return {
    child,
    exited,
    events,
    waitEv: (ev) => new Promise((resolve) => waiters.push({ ev, resolve })),
    send: (cmd) => child.stdin.write(cmd + '\n'),
    stop: async () => {
      if (child.exitCode === null) {
        try {
          child.stdin.write('stop\n')
        } catch {}
      }
      const t = setTimeout(() => child.kill('SIGKILL'), 10_000)
      await exited
      clearTimeout(t)
    }
  }
}

export function cpuCount(max) {
  return Math.max(1, Math.min(max, os.cpus().length - 1))
}
