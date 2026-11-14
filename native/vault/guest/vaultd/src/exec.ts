/**
 * `exec` presets (D29: vaultd builds every command line). Output (stdout and
 * stderr merged) goes to the stream; `shell` also reads stdin from it.
 * The process starts when the stream is attached, not before.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { approvalDetail, type ApprovalClaims, type ExecPreset } from '../../../../../src/shared/vault/protocol'
import type { Ctx, Handler } from './context'
import { bindChild, spawnGroup } from './procs'
import { spawnIdentity, roleEnv, type Role } from './users'
import { log, oneOf } from './util'

const PRESETS: readonly ExecPreset[] = ['uv-python-install', 'uv-sync', 'rebuild', 'check', 'shell']

/** Who runs a preset (D36): the terminal is the agent's; install and check run as build. */
export function presetRole(preset: ExecPreset): Role {
  return preset === 'shell' ? 'agent' : 'build'
}

const PROXY_CRED = /^[0-9a-f]{32}$/

/**
 * The proxy variables carrying an install approval's credential (D37):
 * `http://cinna:<cred>@127.0.0.1:3128`. Only the variables already set (the
 * guest defaults; whatever the host had in fake mode) get it.
 */
export function credProxyEnv(proxyEnv: Record<string, string>, cred: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) {
    const url = proxyEnv[name]
    const m = url ? /^(https?:\/\/)(?:[^@/]*@)?(.*)$/.exec(url) : null
    if (m) out[name] = `${m[1]}cinna:${cred}@${m[2]}`
  }
  return out
}

/** The proxy credential a session token carries, if it is well formed. */
export function proxyCredOf(claims: ApprovalClaims): string | null {
  return claims.action !== 'terminal' && typeof claims.proxyCred === 'string' && PROXY_CRED.test(claims.proxyCred)
    ? claims.proxyCred
    : null
}

/** The kit's validator when the agent folder carries the kit (`.cinna-kit/tools/kit.py`). */
const KIT = '.cinna-kit/tools/kit.py'

/**
 * The lock step of `rebuild`, for a project that comes without a `uv.lock`
 * (a fresh kit agent): `uv lock --no-build` resolves the pyproject's
 * dependencies from wheel metadata only, so no build backend or hook runs
 * while the install hosts are open; a dependency that has no wheel fails the
 * resolution here, in uv's words. A project that has a lock keeps it as it is.
 */
const LOCK = [
  'if [ -f pyproject.toml ] && [ ! -f uv.lock ]; then',
  '  echo "No uv.lock: resolving and locking the dependencies (wheels only)."',
  '  uv lock --no-build 2>&1 || exit $?',
  'fi'
].join('\n')

/**
 * The sync step (D37). Only wheels from the lock: `--no-build` keeps build
 * backends and hooks named by the agent-editable pyproject from running while
 * the install hosts are open. Without a `uv.lock` it resolves nothing itself
 * (`rebuild` locks first, see {@link LOCK}). The agent's own project
 * (and workspace members) is never installed: that would build it from source. uv's "no binary
 * distribution" error is restated in plain words after its own output.
 */
const SYNC = [
  'if [ ! -f pyproject.toml ]; then echo "No pyproject.toml: nothing to sync."; exit 0; fi',
  'if [ ! -f uv.lock ]; then echo "This agent has no uv.lock yet: use Update dependencies to resolve and lock them."; exit 1; fi',
  'out=$(mktemp) || exit 1',
  '{ uv sync --locked --no-build --no-install-project --no-install-workspace 2>&1; echo "$?" > "$out.rc"; } | tee "$out"',
  'rc=$(cat "$out.rc")',
  "sed -n 's/^.*Distribution `\\([^=` ]*\\)[=` ].*no binary distribution.*$/\\1/p' \"$out\" | while read -r pkg; do",
  '  echo "$pkg has no prebuilt wheel; packages that build from source can\'t be installed in a vault yet."',
  'done',
  'rm -f "$out" "$out.rc"',
  'exit "$rc"'
].join('\n')

/** Presets that get an install approval's proxy credential (D37); `check` runs agent code and never does. */
const CRED_PRESETS: readonly ExecPreset[] = ['uv-python-install', 'rebuild']

/** `sh -c` scripts, fixed text: nothing from the caller is interpolated. */
export function presetCommand(ctx: Ctx, preset: ExecPreset): { command: string; args: string[]; interactive: boolean } {
  switch (preset) {
    case 'uv-python-install':
      // With no request, uv reads `.python-version` and else the project's `requires-python`.
      return { command: 'sh', args: ['-c', 'exec uv python install'], interactive: false }
    case 'rebuild':
      // One exec for both steps, so one proxy credential covers them and exec-end follows the last (D37).
      return { command: 'sh', args: ['-c', ['uv python install || exit $?', LOCK, SYNC].join('\n')], interactive: false }
    case 'uv-sync':
      // Never given a credential: it syncs only from what the uv cache already holds.
      return { command: 'sh', args: ['-c', SYNC], interactive: false }
    case 'check':
      if (existsSync(join(ctx.layout.agent, KIT))) {
        return { command: 'uv', args: ['run', '--no-project', 'python', KIT, 'validate', '.'], interactive: false }
      }
      return { command: 'sh', args: ['-c', 'echo "This agent has no check to run."; exit 0'], interactive: false }
    case 'shell':
      // A pty through script(1) so the shell is interactive; util-linux in the guest, BSD syntax in fake mode on macOS.
      if (process.platform === 'linux') {
        return { command: 'script', args: ['-q', '-e', '-c', 'bash -l', '/dev/null'], interactive: true }
      }
      return { command: 'script', args: ['-q', '/dev/null', 'bash', '-l'], interactive: true }
  }
}

export const exec: Handler = async (ctx, params, conn) => {
  const preset = oneOf(params.preset, PRESETS, 'preset')
  const claims = ctx.tokens.verify(params.token, preset === 'shell'
    ? { actions: ['terminal'], detail: () => approvalDetail({ method: 'exec', preset }) }
    : { actions: ['move-in', 'install'] })
  const { command, args, interactive } = presetCommand(ctx, preset)
  const role = presetRole(preset)
  // Only this exec gets the install hosts (D37); the helper revokes the credential at exec-end.
  const cred = CRED_PRESETS.includes(preset) ? proxyCredOf(claims) : null
  if (cred) ctx.helperEvents.execStarted(cred)
  let ended = false
  const end = (): void => {
    if (ended) return
    ended = true
    if (cred) ctx.helperEvents.execEnded(cred)
  }

  const stream = ctx.streams.create((socket) => {
    const env = {
      ...roleEnv(ctx, role),
      ...(cred ? credProxyEnv(ctx.config.proxyEnv, cred) : {}),
      ...(interactive ? { TERM: 'xterm-256color' } : {})
    }
    const child = spawnGroup(command, args, {
      cwd: ctx.layout.agent, env, stdio: ['pipe', 'pipe', 'pipe'], ...spawnIdentity(ctx, role)
    })
    log('info', 'exec started', { preset, stream })
    bindChild(child, socket, interactive, (code) => {
      log('info', 'exec exited', { preset, stream, code })
      end()
      conn.notify('exec.exit', { stream, code })
    })
  }, end)
  return { stream }
}
