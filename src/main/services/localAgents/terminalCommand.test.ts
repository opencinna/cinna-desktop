import { describe, it, expect } from 'vitest'
import {
  appleScriptQuote,
  buildITermAppleScript,
  buildLinuxTerminalArgv,
  buildTerminalAppleScript,
  buildTerminalShellCommand,
  buildWindowsLaunch,
  windowsTerminalQuote,
  isLaunchablePath,
  isPathWithinRoots,
  shellQuote
} from './terminalCommand'

/**
 * The folder path reaches a terminal through two nested quoting layers on
 * macOS, and through none at all on Linux/Windows. These tests pin both halves
 * — a regression here is a shell-injection bug, not a cosmetic one.
 */

/** A folder whose name carries every character that matters to a shell. */
const NASTY = `/Users/x/Agents/it's a "test"; rm -rf $HOME \\ & | \`whoami\``

describe('shellQuote', () => {
  it('wraps in single quotes', () => {
    expect(shellQuote('/Users/x/My Agents')).toBe(`'/Users/x/My Agents'`)
  })

  it('neutralises expansion, substitution and command separators', () => {
    const quoted = shellQuote('$HOME `whoami` $(id) & | ; > <')
    expect(quoted).toBe(`'$HOME \`whoami\` $(id) & | ; > <'`)
    // Everything stayed inside one pair of single quotes.
    expect(quoted.slice(1, -1)).not.toContain("'")
  })

  it('closes and reopens the quote around an embedded single quote', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`)
  })

  it('cannot be escaped from by a crafted folder name', () => {
    // A naive `'${value}'` would end the quote here and run `rm`.
    const quoted = shellQuote(`'; rm -rf ~; '`)
    expect(quoted).toBe(`''\\''; rm -rf ~; '\\'''`)
    // Reassembling with POSIX rules yields the original literal, nothing more.
    expect(unquotePosix(quoted)).toBe(`'; rm -rf ~; '`)
  })
})

describe('appleScriptQuote', () => {
  it('escapes backslashes before double quotes', () => {
    expect(appleScriptQuote('a\\b"c')).toBe('"a\\\\b\\"c"')
  })

  it('cannot be escaped from by a trailing backslash', () => {
    // Doubling the backslash first is what stops `\"` closing the literal.
    expect(appleScriptQuote('c:\\')).toBe('"c:\\\\"')
  })
})

describe('buildTerminalShellCommand', () => {
  it('cds only when no command is given', () => {
    expect(buildTerminalShellCommand('/Users/x/A', null)).toBe(`cd '/Users/x/A'`)
  })

  it('joins with && so a failed cd never runs the tool elsewhere', () => {
    expect(buildTerminalShellCommand('/Users/x/A', '/opt/homebrew/bin/claude')).toBe(
      `cd '/Users/x/A' && '/opt/homebrew/bin/claude'`
    )
  })

  it('quotes a hostile folder name', () => {
    const cmd = buildTerminalShellCommand(NASTY, '/usr/local/bin/codex')
    expect(unquotePosix(cmd.slice('cd '.length, cmd.lastIndexOf(' && ')))).toBe(NASTY)
  })
})

describe('AppleScript builders', () => {
  it('embeds the double-escaped command in a Terminal.app do script', () => {
    const script = buildTerminalAppleScript('/Users/x/A B', '/bin/claude')
    expect(script).toContain('tell application "Terminal"')
    expect(script).toContain(`do script "cd '/Users/x/A B' && '/bin/claude'"`)
  })

  it('embeds the double-escaped command in an iTerm write text', () => {
    const script = buildITermAppleScript('/Users/x/A B', null)
    expect(script).toContain('tell application "iTerm"')
    expect(script).toContain(`write text "cd '/Users/x/A B'"`)
  })

  it('leaves no unescaped quote in the script for a hostile folder', () => {
    const script = buildTerminalAppleScript(NASTY, '/bin/claude')
    const literal = script.slice(script.indexOf('do script ') + 'do script '.length).split('\n')[0]
    expect(literal.startsWith('"')).toBe(true)
    expect(literal.endsWith('"')).toBe(true)
    // The AppleScript literal round-trips back to the shell command verbatim.
    expect(unquoteAppleScript(literal)).toBe(buildTerminalShellCommand(NASTY, '/bin/claude'))
  })
})

describe('buildLinuxTerminalArgv', () => {
  it('passes no arguments when there is nothing to run (cwd carries the folder)', () => {
    expect(buildLinuxTerminalArgv('gnome-terminal', null)).toEqual([])
  })

  it('uses the -- separator for gnome-terminal and -e elsewhere', () => {
    expect(buildLinuxTerminalArgv('gnome-terminal', '/bin/claude')[0]).toBe('--')
    expect(buildLinuxTerminalArgv('xterm', '/bin/claude')[0]).toBe('-e')
    expect(buildLinuxTerminalArgv('konsole', '/bin/claude')[0]).toBe('-e')
  })

  it('never puts the folder on the command line', () => {
    const argv = buildLinuxTerminalArgv('xterm', '/bin/claude')
    expect(argv.join(' ')).not.toContain('/Users')
    expect(argv[argv.length - 1]).toBe(`'/bin/claude'; exec bash -l`)
  })

  it('quotes an executable path containing a space', () => {
    const argv = buildLinuxTerminalArgv('xterm', '/opt/my tools/claude')
    expect(argv[argv.length - 1]).toBe(`'/opt/my tools/claude'; exec bash -l`)
  })
})

describe('buildWindowsLaunch', () => {
  it('passes the folder to Windows Terminal as its own argument', () => {
    const launch = buildWindowsLaunch('C:\\Users\\x\\My Agents', 'C:\\bin\\claude.exe', true)
    expect(launch.file).toBe('wt.exe')
    expect(launch.args).toEqual(['-d', 'C:\\Users\\x\\My Agents', 'cmd.exe', '/k', 'C:\\bin\\claude.exe'])
  })

  it('escapes a semicolon in the folder, which wt would read as a sub-command break', () => {
    // `wt` re-parses its own command line after CreateProcess has split it, so
    // `Q3;final` would end the -d value and run `final` as a second command.
    const launch = buildWindowsLaunch('C:\\Users\\x\\Q3;final', null, true)
    expect(launch.args).toEqual(['-d', 'C:\\Users\\x\\Q3\\;final'])
    // The cwd is the unescaped path — that one goes to CreateProcess, not to wt.
    expect(launch.cwd).toBe('C:\\Users\\x\\Q3;final')
  })

  it('escapes a semicolon in the executable path too', () => {
    const launch = buildWindowsLaunch('C:\\a', 'C:\\bin;odd\\claude.exe', true)
    expect(launch.args).toEqual(['-d', 'C:\\a', 'cmd.exe', '/k', 'C:\\bin\\;odd\\claude.exe'])
  })

  it('leaves the cmd fallback unescaped — cmd does not re-split on semicolons', () => {
    const launch = buildWindowsLaunch('C:\\Users\\x\\Q3;final', 'C:\\bin\\claude.exe', false)
    expect(launch.cwd).toBe('C:\\Users\\x\\Q3;final')
    expect(launch.args).toEqual(['/k', 'C:\\bin\\claude.exe'])
  })

  it('keeps the folder off the command line entirely in the cmd fallback', () => {
    const launch = buildWindowsLaunch('C:\\Users\\x\\My Agents', 'C:\\bin\\claude.exe', false)
    expect(launch.file).toBe('cmd.exe')
    expect(launch.args).toEqual(['/k', 'C:\\bin\\claude.exe'])
    expect(launch.cwd).toBe('C:\\Users\\x\\My Agents')
  })

  it('opens a bare shell when no command is given', () => {
    expect(buildWindowsLaunch('C:\\a', null, false).args).toEqual([])
    expect(buildWindowsLaunch('C:\\a', null, true).args).toEqual(['-d', 'C:\\a'])
  })
})

describe('isPathWithinRoots', () => {
  const roots = ['/Users/x/Documents/CinnaAgents']

  it('accepts the root itself and anything below it', () => {
    expect(isPathWithinRoots('/Users/x/Documents/CinnaAgents', roots, 'linux')).toBe(true)
    expect(isPathWithinRoots('/Users/x/Documents/CinnaAgents/Local/a', roots, 'linux')).toBe(true)
  })

  it('rejects a sibling whose name merely starts with the root', () => {
    expect(isPathWithinRoots('/Users/x/Documents/CinnaAgentsEvil', roots, 'linux')).toBe(false)
  })

  it('rejects an unrelated path and a parent', () => {
    expect(isPathWithinRoots('/Users/x/.ssh', roots, 'linux')).toBe(false)
    expect(isPathWithinRoots('/Users/x/Documents', roots, 'linux')).toBe(false)
    expect(isPathWithinRoots('/', roots, 'linux')).toBe(false)
  })

  it('rejects traversal out of the root', () => {
    expect(
      isPathWithinRoots('/Users/x/Documents/CinnaAgents/../../.ssh', roots, 'linux')
    ).toBe(false)
  })

  it('rejects everything when no root is configured', () => {
    expect(isPathWithinRoots('/Users/x/Documents/CinnaAgents', [], 'linux')).toBe(false)
    expect(isPathWithinRoots('/anything', [''], 'linux')).toBe(false)
  })

  it('is case-insensitive on macOS and Windows, case-sensitive on Linux', () => {
    expect(isPathWithinRoots('/users/x/documents/cinnaagents/a', roots, 'darwin')).toBe(true)
    expect(isPathWithinRoots('/users/x/documents/cinnaagents/a', roots, 'linux')).toBe(false)
    expect(
      isPathWithinRoots('c:\\users\\x\\agents\\a', ['C:\\Users\\x\\Agents'], 'win32')
    ).toBe(true)
  })
})

describe('isLaunchablePath', () => {
  it('requires an absolute path', () => {
    expect(isLaunchablePath('/Users/x/A', 'linux')).toBe(true)
    expect(isLaunchablePath('relative/path', 'linux')).toBe(false)
    expect(isLaunchablePath('', 'linux')).toBe(false)
  })

  it('rejects control characters', () => {
    expect(isLaunchablePath('/Users/x/A\nB', 'linux')).toBe(false)
    expect(isLaunchablePath('/Users/x/A\0B', 'linux')).toBe(false)
  })

  it('accepts a Windows drive path on win32 only', () => {
    expect(isLaunchablePath('C:\\Users\\x', 'win32')).toBe(true)
    expect(isLaunchablePath('C:\\Users\\x', 'linux')).toBe(false)
  })
})

/** Undo POSIX single-quoting — the inverse of `shellQuote`, for round-tripping. */
function unquotePosix(quoted: string): string {
  let out = ''
  let i = 0
  while (i < quoted.length) {
    if (quoted[i] !== "'") throw new Error(`unquoted region at ${i}: ${quoted}`)
    i++
    while (i < quoted.length && quoted[i] !== "'") out += quoted[i++]
    i++ // closing quote
    if (quoted.slice(i, i + 2) === "\\'") {
      out += "'"
      i += 2
    }
  }
  return out
}

/** Undo AppleScript string escaping — the inverse of `appleScriptQuote`. */
function unquoteAppleScript(literal: string): string {
  return literal.slice(1, -1).replace(/\\(.)/g, '$1')
}

describe('windowsTerminalQuote', () => {
  it('escapes every semicolon, not just the first', () => {
    expect(windowsTerminalQuote('a;b;c')).toBe('a\\;b\\;c')
  })

  it('leaves a path with no semicolon untouched', () => {
    expect(windowsTerminalQuote('C:\\Users\\x\\Agents')).toBe('C:\\Users\\x\\Agents')
  })
})
