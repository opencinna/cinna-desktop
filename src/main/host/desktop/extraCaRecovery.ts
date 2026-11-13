import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createLogger } from '../../logger/logger'

const logger = createLogger('tls')

export const NODE_EXTRA_CA_CERTS = 'NODE_EXTRA_CA_CERTS'

/** Bounds every platform lookup; startup waits at most this long, once. */
const LOOKUP_TIMEOUT_MS = 1500

export interface ExtraCaRecoveryDeps {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  /** Linux: the raw `/proc/self/environ`. */
  readProcEnviron: () => Buffer | string
  /** macOS `launchctl`, Windows `reg`: argv only, never a shell. Returns stdout. */
  run: (command: string, args: string[]) => string
}

/** Exact-name lookup in a NUL-separated `NAME=value` block. */
export function fromProcEnviron(raw: Buffer | string, name: string): string | undefined {
  const text = typeof raw === 'string' ? raw : raw.toString('utf8')
  const prefix = `${name}=`
  for (const entry of text.split('\0')) {
    if (entry.startsWith(prefix)) return entry.slice(prefix.length)
  }
  return undefined
}

/** `%NAME%` references expanded from `env` (case-insensitive, as Windows does); unknown ones stay. */
export function expandWindowsVars(value: string, env: NodeJS.ProcessEnv): string {
  const byUpper = new Map(Object.entries(env).map(([key, val]) => [key.toUpperCase(), val]))
  return value.replace(/%([^%]+)%/g, (whole, name: string) => {
    const found = byUpper.get(name.toUpperCase())
    return typeof found === 'string' ? found : whole
  })
}

/** The value of `name` in `reg query <key> /v <name>` output, expanded when it is REG_EXPAND_SZ. */
export function fromRegQuery(stdout: string, name: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s+(\S+)\s+(REG_SZ|REG_EXPAND_SZ)\s+(.*)$/.exec(line)
    if (!match || match[1].toUpperCase() !== name.toUpperCase()) continue
    const value = match[3].trim()
    return match[2] === 'REG_EXPAND_SZ' ? expandWindowsVars(value, env) : value
  }
  return undefined
}

/**
 * `reg.exe` by absolute path: a bare name is looked up on PATH (and in the
 * current directory first on Windows), and whatever answers decides TLS trust.
 */
function windowsReg(env: NodeJS.ProcessEnv): string {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows'
  return `${root}\\System32\\reg.exe`
}

const WINDOWS_KEYS = [
  // The user's value wins over the machine's, as Windows builds a session's environment.
  'HKCU\\Environment',
  'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'
]

function lookup(deps: ExtraCaRecoveryDeps): string | undefined {
  switch (deps.platform) {
    case 'linux':
      // The environment the process was started with; unsetenv does not touch it.
      return fromProcEnviron(deps.readProcEnviron(), NODE_EXTRA_CA_CERTS)
    case 'darwin': {
      // Where a GUI app's environment comes from. Known miss: a value exported
      // only in the shell that started the binary directly.
      const out = deps.run('/bin/launchctl', ['getenv', NODE_EXTRA_CA_CERTS]).replace(/\r?\n$/, '')
      return out || undefined
    }
    case 'win32':
      // Known miss: a value set only in a parent shell (`set` in cmd), which
      // the registry never sees.
      for (const key of WINDOWS_KEYS) {
        let out: string
        try {
          out = deps.run(windowsReg(deps.env), ['query', key, '/v', NODE_EXTRA_CA_CERTS])
        } catch {
          continue // `reg` exits 1 when the value is absent.
        }
        const value = fromRegQuery(out, NODE_EXTRA_CA_CERTS, deps.env)
        if (value) return value
      }
      return undefined
    default:
      return undefined
  }
}

/**
 * Puts `NODE_EXTRA_CA_CERTS` back into `deps.env` when Electron removed it.
 * With the NodeOptions fuse off (electron-builder.yml), Electron deletes the
 * variable from `process.env` at startup, so the app and everything it spawns
 * lose it. Read it again from where the OS keeps it; once back in
 * `process.env`, `envMerge`'s regression pass forwards it to non-Electron
 * children unchanged, and `installExtraCaCertificates` applies it to main.
 * A value already present (development, an unfused build) is kept as it is.
 * Never throws; a failed lookup costs one debug line.
 */
export function recoverExtraCaCertsEnv(deps: ExtraCaRecoveryDeps = defaultDeps()): string | undefined {
  const present = deps.env[NODE_EXTRA_CA_CERTS]
  if (present) return present
  try {
    const value = lookup(deps)
    if (value) deps.env[NODE_EXTRA_CA_CERTS] = value
    return value
  } catch (error) {
    try {
      logger.debug('could not read NODE_EXTRA_CA_CERTS from the system', {
        platform: deps.platform,
        error: (error as { code?: unknown })?.code ?? (error instanceof Error ? error.name : 'error')
      })
    } catch { /* never throws */ }
    return undefined
  }
}

function defaultDeps(): ExtraCaRecoveryDeps {
  return {
    platform: process.platform,
    env: process.env,
    readProcEnviron: () => readFileSync('/proc/self/environ'),
    run: (command, args) => execFileSync(command, args, {
      encoding: 'utf8',
      timeout: LOOKUP_TIMEOUT_MS,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    })
  }
}
