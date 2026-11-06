const { spawn } = require('node:child_process')
const { closeSync, openSync, readSync } = require('node:fs')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

function checkEnvironment(scratch, host = process.env) {
  // Clear loader overrides before Electron starts; changing them in its entry
  // point is too late. Only OS/GUI plumbing is inherited from the host.
  const env = {}
  for (const name of ['PATH', 'SystemRoot', 'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY',
    'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'LANG', 'LC_ALL']) {
    if (host[name] !== undefined) env[name] = host[name]
  }
  return {
    ...env, HOME: scratch, USERPROFILE: scratch,
    APPDATA: scratch, LOCALAPPDATA: scratch,
    XDG_CONFIG_HOME: scratch, XDG_CACHE_HOME: scratch,
    TMPDIR: scratch, TMP: scratch, TEMP: scratch
  }
}

/** `x64` / `arm64` from a thin Mach-O or ELF executable's header; null for anything else (a universal binary too). */
function executableArch(path) {
  const header = Buffer.alloc(20)
  let fd
  try {
    fd = openSync(path, 'r')
    if (readSync(fd, header, 0, header.length, 0) < header.length) return null
  } catch { return null } finally { if (fd !== undefined) closeSync(fd) }
  if (header.readUInt32LE(0) === 0xfeedfacf) {
    const cpu = header.readUInt32LE(4)
    return cpu === 0x01000007 ? 'x64' : cpu === 0x0100000c ? 'arm64' : null
  }
  if (header.readUInt32BE(0) === 0x7f454c46) {
    const machine = header.readUInt16LE(18)
    return machine === 0x3e ? 'x64' : machine === 0xb7 ? 'arm64' : null
  }
  return null
}

/**
 * How long the launcher waits for the probe. 45 s covers a native run; an executable of another
 * architecture runs translated (the x64 package under Rosetta on Apple silicon needs ~80 s with
 * PDF.js starting its own process), so it gets 120 s. CINNA_PACKAGED_MAIN_TIMEOUT_MS (a positive
 * integer, in ms) overrides both. The probe is passed the deadline and stops 5 s before it.
 */
function checkDeadline(probedArch, hostArch = process.arch, env = process.env) {
  const override = Number(env.CINNA_PACKAGED_MAIN_TIMEOUT_MS)
  if (Number.isInteger(override) && override > 0) return override
  return probedArch && probedArch !== hostArch ? 120_000 : 45_000
}

async function main() {
  const resources = process.argv[2]
  if (!resources) throw new Error('Usage: npm run test:packaged:main -- <resources directory> [matching Electron executable]')
  const electron = process.argv[3] ? resolve(process.argv[3]) : require('electron')
  const scratch = await mkdtemp(join(tmpdir(), 'cinna-main-check-'))
  try {
    const deadline = checkDeadline(executableArch(electron))
    const child = spawn(electron, [join(__dirname, 'packaged-main-probe.cjs'), resolve(resources), String(deadline)], {
      cwd: scratch, env: checkEnvironment(scratch), stdio: 'inherit'
    })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, deadline)
    try {
      await new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('close', (code, signal) => {
          if (timedOut) reject(new Error(`Packaged main-process check timed out after ${deadline / 1000} s`))
          else if (code !== 0) reject(new Error(`Packaged main-process check exited (${code ?? signal})`))
          else resolve()
        })
      })
    } finally { clearTimeout(timer) }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

module.exports = { checkDeadline, checkEnvironment, executableArch }
if (require.main === module) {
  main().catch((error) => { console.error(error); process.exitCode = 1 })
}
