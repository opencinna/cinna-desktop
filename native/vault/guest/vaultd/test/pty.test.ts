/**
 * The terminal's size in the guest: finding the shell's pty slave under a
 * /proc tree (a fake one here; the real one is only reachable in the VM) and
 * applying the last size asked for once that pty exists.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { childPids, findShellPts, ptySize, ShellPty, type PtyOps, type PtySize } from '../src/pty'

let proc = ''
beforeEach(() => { proc = mkdtempSync(join(tmpdir(), 'vd-proc-')) })
afterEach(() => { rmSync(proc, { recursive: true, force: true }) })

function task(pid: number, children: number[] | null, ppid = 1, fd0?: string): void {
  mkdirSync(join(proc, String(pid), 'task', String(pid)), { recursive: true })
  if (children) writeFileSync(join(proc, String(pid), 'task', String(pid), 'children'), children.map((c) => `${c} `).join(''))
  writeFileSync(join(proc, String(pid), 'stat'), `${pid} (we ird) name) S ${ppid} ${pid} ${pid} 0`)
  if (fd0) {
    mkdirSync(join(proc, String(pid), 'fd'), { recursive: true })
    symlinkSync(fd0, join(proc, String(pid), 'fd', '0'))
  }
}

describe('finding the shell pty', () => {
  it('reads script\'s child from the children file and takes its stdin when it is /dev/pts/<n>', () => {
    task(100, [101])
    task(101, [], 100, '/dev/pts/7')
    expect(childPids(proc, 100)).toEqual([101])
    expect(findShellPts(proc, 100)).toBe('/dev/pts/7')
  })

  it('falls back to a ppid scan when the kernel has no children file', () => {
    task(200, null)
    task(201, null, 200, '/dev/pts/12')
    task(202, null, 1, '/dev/pts/13')
    expect(childPids(proc, 200)).toEqual([201])
    expect(findShellPts(proc, 200)).toBe('/dev/pts/12')
  })

  it('takes nothing that is not exactly /dev/pts/<digits>, and nothing before the shell exists', () => {
    task(300, [301, 302, 303])
    task(301, [], 300, 'pipe:[4242]')
    task(302, [], 300, '/dev/pts/../tty1')
    task(303, [], 300, '/dev/null')
    expect(findShellPts(proc, 300)).toBeNull()
    task(400, [])
    expect(findShellPts(proc, 400)).toBeNull()
    expect(findShellPts(proc, 999)).toBeNull()
  })
})

describe('size validation', () => {
  it('clamps integers and refuses anything else', () => {
    expect(ptySize({ cols: 80, rows: 24 })).toEqual({ cols: 80, rows: 24 })
    expect(ptySize({ cols: 0, rows: 1_000 })).toEqual({ cols: 2, rows: 200 })
    expect(ptySize({ cols: 9_999, rows: -5 })).toEqual({ cols: 500, rows: 2 })
    expect(() => ptySize({ cols: 80.5, rows: 24 })).toThrow('Invalid size.')
    expect(() => ptySize({ cols: '80', rows: 24 })).toThrow('Invalid size.')
  })
})

function recorder(ptsAfter = 0): { ops: PtyOps; sets: PtySize[] } {
  const sets: PtySize[] = []
  let looks = 0
  return {
    sets,
    ops: {
      findPts: () => (looks++ >= ptsAfter ? '/dev/pts/3' : null),
      setSize: async (pts, size) => {
        expect(pts).toBe('/dev/pts/3')
        sets.push(size)
        return true
      }
    }
  }
}

describe('ShellPty', () => {
  it('sizes the pty as the shell\'s own user, never as root', async () => {
    const users: unknown[] = []
    const ops: PtyOps = { findPts: () => '/dev/pts/3', setSize: async (_pts, _size, _path, asUser) => { users.push(asUser); return true } }
    const pty = new ShellPty(ops, '/usr/bin', { cols: 80, rows: 24 }, { uid: 1000, gid: 1000 })
    pty.started(42)
    await pty.idle()
    expect(users).toEqual([{ uid: 1000, gid: 1000 }])
  })

  it('applies the size it was opened at once the shell starts, and each later change once', async () => {
    const { ops, sets } = recorder()
    const pty = new ShellPty(ops, '/usr/bin', { cols: 120, rows: 40 })
    await pty.idle()
    expect(sets).toEqual([])
    pty.started(42)
    await pty.idle()
    expect(sets).toEqual([{ cols: 120, rows: 40 }])
    pty.resize({ cols: 120, rows: 40 })
    await pty.idle()
    expect(sets).toHaveLength(1)
    pty.resize({ cols: 90, rows: 20 })
    await pty.idle()
    expect(sets.at(-1)).toEqual({ cols: 90, rows: 20 })
  })

  it('keeps a size asked for before the pty exists and applies only the latest when it appears', async () => {
    const { ops, sets } = recorder(3)
    const pty = new ShellPty(ops, '/usr/bin', null)
    pty.resize({ cols: 70, rows: 20 })
    pty.started(42)
    pty.resize({ cols: 100, rows: 30 })
    await pty.idle()
    expect(sets).toEqual([{ cols: 100, rows: 30 }])
  })

  it('applies nothing once ended, and nothing at all without ops (fake mode)', async () => {
    const { ops, sets } = recorder()
    const pty = new ShellPty(ops, '/usr/bin', null)
    pty.end()
    pty.started(42)
    pty.resize({ cols: 80, rows: 24 })
    await pty.idle()
    expect(sets).toEqual([])
    const none = new ShellPty(null, '/usr/bin', { cols: 80, rows: 24 })
    none.started(42)
    none.resize({ cols: 81, rows: 24 })
    await none.idle()
  })
})
