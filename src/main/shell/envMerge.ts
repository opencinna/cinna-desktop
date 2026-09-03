import { DEFAULT_INHERITED_ENV_VARS } from '@modelcontextprotocol/sdk/client/stdio.js'

/**
 * Environment merging and narrowing, kept in its own Electron-free module so
 * the rules the MCP stdio spawn depends on can be unit tested. Re-exported from
 * `./env` — callers should import from there.
 */

/**
 * Session variables a GUI-launched process already carries today.
 *
 * These are **not** SDK parity, and their justification differs from
 * `PATHEXT`'s: launchd (and the Linux session manager) put them in our own
 * environment, so a server that declares a `config.env` receives them right
 * now. Narrowing to the SDK's six keys alone would take them away — a real
 * regression, not a hypothetical one. `SSH_AUTH_SOCK` is the sharp case: a
 * git-over-SSH server would silently lose agent auth on private repos.
 *
 * None of these carries a credential itself. `SSH_AUTH_SOCK` is a socket path
 * whose access is already governed by filesystem permissions, and a child that
 * can reach the agent could equally have run `ssh` for itself.
 */
const SESSION_ENV_VARS: readonly string[] = [
  'SSH_AUTH_SOCK',
  // Linux GUI, keyring and OAuth-browser access.
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XAUTHORITY',
  'DBUS_SESSION_BUS_ADDRESS',
  // macOS per-user temp dir. Every runtime falls back to `/tmp` without it, so
  // it is the least load-bearing entry here — but it passes the same test as
  // the rest (launchd sets it, so the non-null branch has it today) and carries
  // no secret, and one uniform rule for the group is worth more than trimming
  // the one member whose absence would merely be survivable.
  'TMPDIR'
]

/**
 * A **deliberate addition, not SDK parity**: `PATHEXT` is absent from the SDK's
 * Windows list, but without it a child cannot resolve the `.cmd` shims that
 * `npm` and `uv` install on Windows — the very resolution failure this module
 * exists to fix.
 */
const WINDOWS_EXTRA_ENV_VARS: readonly string[] =
  process.platform === 'win32' ? ['PATHEXT'] : []

const EXTRA_INHERITED_ENV_VARS: readonly string[] = [
  ...SESSION_ENV_VARS,
  ...WINDOWS_EXTRA_ENV_VARS
]

/**
 * The variables a spawned MCP server inherits from the **login-shell**
 * environment: the SDK's allowlist, plus the session variables a GUI process
 * already had, plus `PATHEXT` on Windows.
 *
 * Deliberately absent from this list, and not to be added to it: `NODE_PATH`
 * and `npm_config_*` (shell exports on every platform — omitting them regresses
 * nothing, and they redirect where a child resolves its code), and the proxy /
 * CA variables, which are handled by {@link REGRESSION_ONLY_ENV_VARS} under a
 * different sourcing rule. The per-server `env` map remains the opt-in for
 * anything else.
 */
/**
 * Variables inherited from **`process.env`, never from the login-shell dump**.
 *
 * This is a deliberately different sourcing rule from the rest of the
 * allowlist, and the difference is the entire point. These carry real risk — a
 * proxy URL routinely embeds credentials (`http://user:pass@proxy:8080`), and
 * `NODE_EXTRA_CA_CERTS` changes TLS trust for a third-party child — so we
 * inherit them only where the GUI process *already had them*, which makes this
 * a regression fix rather than a new capability.
 *
 * Where that is: Windows, where the process inherits the full user environment
 * from Explorer (see `resolveShellEnv`, which short-circuits win32 for exactly
 * that reason) and where corporate IT and MDM push these as user-scope
 * variables; and Linux, where the display manager sources `/etc/environment`
 * into the session. On both, a server declaring a `config.env` receives them
 * today and narrowing would take them away.
 *
 * Where it is not: macOS, where these reach a process only as a shell export.
 * Reading them from `process.env` means a `.zshrc` export cannot silently
 * redirect a child's traffic — that user puts them in the server's
 * `config.env`, explicitly.
 *
 * Read this as defence in depth and a guard against honest misconfiguration,
 * **not as a security boundary**. `PATH` comes from that same shell dump, and
 * controlling `PATH` is strictly more powerful than controlling a proxy
 * variable — anyone who can write the shell profile owns the child process
 * either way. The value here is that a stray export does not quietly reroute
 * traffic; it is not that the shell environment is treated as hostile.
 */
const REGRESSION_ONLY_ENV_VARS: readonly string[] = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
  'NODE_EXTRA_CA_CERTS'
]

export const CHILD_ENV_ALLOWLIST: readonly string[] = [
  ...DEFAULT_INHERITED_ENV_VARS,
  ...EXTRA_INHERITED_ENV_VARS
]

/**
 * Narrow a full environment down to what a child process may inherit.
 *
 * This reproduces the MCP SDK's `getDefaultEnvironment()` — the same allowlist
 * (imported, not copied, so it cannot drift from the SDK), the same skipping of
 * `()`-prefixed values — but reads it out of the **login-shell** environment
 * instead of the app's own, and adds the session variables a GUI process
 * already carried. The point is a `PATH` that reflects the user's shell rather
 * than launchd's bare one, without the rest of the shell's environment coming
 * along with it.
 *
 * The narrowing is the security half of it. `getShellEnv()` exists precisely to
 * source `.zshrc`/`.bashrc`, which is where `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`
 * and `AWS_SECRET_ACCESS_KEY` live — handing that wholesale to a third-party
 * stdio binary would widen the blast radius of every one of those secrets.
 *
 * The `()` filter matters more here than it does in the SDK: an interactive
 * login shell exports its functions as `BASH_FUNC_x%%=() {...}` entries, which
 * our `env -0` capture picks up and launchd's environment never contains.
 * It is also load-bearing on its own now, which it was not at first — while the
 * allowlist held only the SDK's six keys, every `()`-valued name was also a
 * non-allowlisted one, so the key check alone would have caught them. With
 * `SSH_AUTH_SOCK` and the session group allowlisted, a `()`-valued
 * `SSH_AUTH_SOCK` passes the key check and *only* this filter stops it. Which
 * is why reproducing the SDK's filter, and not merely its key list, mattered.
 */
export function shellEnvForChild(
  base: NodeJS.ProcessEnv,
  allowlist: readonly string[] = CHILD_ENV_ALLOWLIST,
  /** Injected for testability; the second source, see `REGRESSION_ONLY_ENV_VARS`. */
  processEnv: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of allowlist) {
    const value = base[key]
    if (typeof value !== 'string') continue
    // Exported shell functions are a shellshock-era risk the SDK refuses to
    // pass on, and so do we.
    if (value.startsWith('()')) continue
    out[key] = value
  }
  // Second pass, second source: these come from our own environment only, so a
  // shell profile cannot introduce them. See `REGRESSION_ONLY_ENV_VARS`.
  for (const key of REGRESSION_ONLY_ENV_VARS) {
    const value = processEnv[key]
    if (typeof value !== 'string') continue
    if (value.startsWith('()')) continue
    out[key] = value
  }
  return out
}

/**
 * Merge overrides over a base environment, dropping undefined values, for
 * callers that need the `Record<string, string>` shape a child process's `env`
 * option wants. Later wins: a per-server override beats the shell environment.
 *
 * This does **not** narrow. Anything spawning a third-party binary should pass
 * a base that has already been through {@link shellEnvForChild}.
 */
export function mergeEnv(
  base: NodeJS.ProcessEnv,
  overrides?: Record<string, string> | null
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (typeof value === 'string') out[key] = value
  }
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}

/**
 * The variables the previous behaviour would have handed to a child and this
 * rule drops — for a debug log line at connect time.
 *
 * This rule narrows what a stdio server can read, so somewhere a server will
 * stop working and the failure will look unrelated to us (a git-over-SSH
 * permission-denied, a tool that cannot find its config). One line naming what
 * disappeared turns that report into a one-minute diagnosis.
 *
 * **Names only, never values — this is a hard rule.** The names alone are the
 * whole diagnostic value, and the dropped set is by definition the secret-
 * bearing part of the environment: logging a value here would recreate the leak
 * this module exists to prevent, in the log buffer instead of the child process.
 */
export function droppedChildEnvNames(
  base: NodeJS.ProcessEnv,
  overrides?: Record<string, string> | null,
  processEnv: NodeJS.ProcessEnv = process.env
): string[] {
  const passed = mergeEnv(shellEnvForChild(base, CHILD_ENV_ALLOWLIST, processEnv), overrides)
  return Object.keys(base)
    .filter((key) => typeof base[key] === 'string' && !Object.hasOwn(passed, key))
    .sort()
}
