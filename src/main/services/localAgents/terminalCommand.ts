import { win32, posix } from 'node:path'

/**
 * Pure command construction for "Open in…". Every function here turns an
 * absolute folder path and an absolute executable path into something a
 * launcher can hand to `execFile`/`spawn` — no side effects, no Electron, no
 * `node:fs`, so the escaping rules are unit tested directly.
 *
 * The rule the whole module follows: **a path is never concatenated into a
 * command line**. Linux and Windows launchers receive the folder as the child's
 * `cwd` or as its own argv element, so no quoting is involved at all. macOS is
 * the one exception — AppleScript's `do script` has no working-directory
 * argument, so the folder must be embedded in a `cd` — and there it is escaped
 * twice: once for the POSIX shell that runs inside the terminal, then once for
 * the AppleScript string literal that carries it.
 */

/**
 * Quote a value for a POSIX shell. Single quotes suppress every expansion the
 * shell would otherwise perform, and an embedded single quote is closed,
 * escaped and reopened — the standard `'\''` dance. A folder called
 * `foo'; rm -rf ~; '` therefore stays one argument.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Quote a value as an AppleScript string literal. Only backslash and double
 * quote are special inside one, and the backslash must be doubled first or it
 * would escape the escape we are about to add.
 */
export function appleScriptQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * The shell line a terminal window should run: enter the folder, then
 * optionally launch the tool. `&&` rather than `;` so a `cd` that fails (folder
 * removed between validation and launch) does not run the tool somewhere
 * unexpected.
 */
export function buildTerminalShellCommand(folder: string, commandPath: string | null): string {
  const cd = `cd ${shellQuote(folder)}`
  return commandPath ? `${cd} && ${shellQuote(commandPath)}` : cd
}

/** AppleScript that opens a Terminal.app window running the folder's command. */
export function buildTerminalAppleScript(folder: string, commandPath: string | null): string {
  const script = appleScriptQuote(buildTerminalShellCommand(folder, commandPath))
  return [
    'tell application "Terminal"',
    `  do script ${script}`,
    '  activate',
    'end tell'
  ].join('\n')
}

/** AppleScript that opens an iTerm2 window running the folder's command. */
export function buildITermAppleScript(folder: string, commandPath: string | null): string {
  const script = appleScriptQuote(buildTerminalShellCommand(folder, commandPath))
  return [
    'tell application "iTerm"',
    '  activate',
    '  set newWindow to (create window with default profile)',
    '  tell current session of newWindow',
    `    write text ${script}`,
    '  end tell',
    'end tell'
  ].join('\n')
}

/** Terminal emulators tried on Linux, in order of preference. */
export const LINUX_TERMINALS = [
  'x-terminal-emulator',
  'gnome-terminal',
  'konsole',
  'xterm'
] as const

export type LinuxTerminal = (typeof LINUX_TERMINALS)[number]

/**
 * Argv for a Linux terminal emulator. The folder is *not* here — the caller
 * passes it as the child's `cwd`, which every one of these emulators inherits
 * for the shell it starts. `exec bash -l` at the end keeps the window alive
 * after the assistant exits, so its final output stays readable.
 */
export function buildLinuxTerminalArgv(
  terminal: LinuxTerminal,
  commandPath: string | null
): string[] {
  if (!commandPath) return []
  const inner = `${shellQuote(commandPath)}; exec bash -l`
  // `gnome-terminal` deprecated `-e` in favour of a `--` separator; the others
  // still take `-e`.
  const flag = terminal === 'gnome-terminal' ? '--' : '-e'
  return [flag, 'bash', '-lc', inner]
}

/**
 * Escape a value for Windows Terminal's own argument parser.
 *
 * `wt.exe` re-parses its command line after `CreateProcess` has already split
 * it, and treats `;` as the separator between sub-commands — so a folder named
 * `Q3;final` would end the `-d` value and have its tail run as a second
 * command. Node's quoting does not help: it satisfies `CreateProcess`, and
 * `wt` splits what it gets afterwards.
 */
export function windowsTerminalQuote(value: string): string {
  return value.replace(/;/g, '\\;')
}

export interface WindowsLaunch {
  file: string
  args: string[]
  /** Set as the child's working directory when the launcher takes no path arg. */
  cwd: string
}

/**
 * Windows launch descriptor. Windows Terminal takes the folder as a discrete
 * `-d` argument (Node quotes it for `CreateProcess`; `wt.exe` is spawned
 * directly, so `cmd`'s `%VAR%` expansion never sees it). The `cmd.exe` fallback
 * gets the folder as `cwd` instead, keeping it off the command line entirely.
 */
export function buildWindowsLaunch(
  folder: string,
  commandPath: string | null,
  hasWindowsTerminal: boolean
): WindowsLaunch {
  if (hasWindowsTerminal) {
    // `wt` splits its own argv on `;`, so both operands need its escaping —
    // the folder and the executable path alike.
    const args = ['-d', windowsTerminalQuote(folder)]
    if (commandPath) args.push('cmd.exe', '/k', windowsTerminalQuote(commandPath))
    return { file: 'wt.exe', args, cwd: folder }
  }
  return {
    file: 'cmd.exe',
    args: commandPath ? ['/k', commandPath] : [],
    cwd: folder
  }
}

/**
 * Whether `folder` is inside one of `roots` (or is a root itself). Both sides
 * must already be absolute and resolved — the caller does the `realpath`, so a
 * symlink cannot point out of a root after the check.
 *
 * Comparison is case-insensitive on macOS and Windows, whose default
 * filesystems are, so `/users/x/…` cannot slip past a `/Users/x/…` root.
 */
export function isPathWithinRoots(
  folder: string,
  roots: readonly string[],
  platform: NodeJS.Platform = process.platform
): boolean {
  const p = platform === 'win32' ? win32 : posix
  const caseInsensitive = platform === 'win32' || platform === 'darwin'
  const normalize = (value: string): string => {
    const trimmed = p.normalize(value).replace(/[\\/]+$/, '') || p.sep
    return caseInsensitive ? trimmed.toLowerCase() : trimmed
  }

  const target = normalize(folder)
  return roots.some((root) => {
    if (!root) return false
    const base = normalize(root)
    if (target === base) return true
    const prefix = base.endsWith(p.sep) ? base : base + p.sep
    return target.startsWith(prefix)
  })
}

/**
 * Reject paths that are not plainly absolute, or that carry characters no
 * legitimate folder path has and every launcher would have to escape (NUL,
 * newlines, other control characters).
 */
export function isLaunchablePath(
  folder: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (!folder || folder.length > 4096) return false
  if (/[\u0000-\u001f\u007f]/.test(folder)) return false
  const p = platform === 'win32' ? win32 : posix
  return p.isAbsolute(folder)
}
