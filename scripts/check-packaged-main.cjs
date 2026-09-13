const { spawn } = require('node:child_process')
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

async function main() {
  const resources = process.argv[2]
  if (!resources) throw new Error('Usage: npm run test:packaged:main -- <resources directory>')
  const scratch = await mkdtemp(join(tmpdir(), 'cinna-main-check-'))
  try {
    const child = spawn(require('electron'), [join(__dirname, 'packaged-main-probe.cjs'), resolve(resources)], {
      cwd: scratch, env: checkEnvironment(scratch), stdio: 'inherit'
    })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 45_000)
    try {
      await new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('close', (code, signal) => {
          if (timedOut) reject(new Error('Packaged main-process check timed out'))
          else if (code !== 0) reject(new Error(`Packaged main-process check exited (${code ?? signal})`))
          else resolve()
        })
      })
    } finally { clearTimeout(timer) }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

module.exports = { checkEnvironment }
if (require.main === module) {
  main().catch((error) => { console.error(error); process.exitCode = 1 })
}
