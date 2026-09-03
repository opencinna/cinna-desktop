import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The "open in…" path guard, exercised on its **allow** path.
 *
 * Until the agents roots were registered, `getAllowedRoots()` returned `[]` and
 * every request was refused with `no_roots` — which meant the code that decides
 * a folder *is* allowed had never run anywhere. Wiring the real provider makes
 * the first production run of `resolveAllowedFolder` also its first run ever, so
 * both sides are pinned down here: what it lets through, and what it must not.
 *
 * Nothing is actually launched. `child_process` and `shell` are recorded, so the
 * assertions are about which folder reached a launcher, not about a terminal
 * appearing.
 */

const spawned = vi.hoisted(() => [] as Array<{ file: string; args: string[]; cwd?: string }>)
const executed = vi.hoisted(() => [] as Array<{ file: string; args: string[] }>)
const revealed = vi.hoisted(() => [] as string[])

vi.mock('node:child_process', () => ({
  spawn: (file: string, args: string[], opts?: { cwd?: string }) => {
    spawned.push({ file, args, cwd: opts?.cwd })
    return { once: () => undefined, unref: () => undefined }
  },
  execFile: (
    file: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, stdout: string, stderr: string) => void
  ) => {
    executed.push({ file, args })
    cb(null, '', '')
  }
}))
vi.mock('electron', () => ({
  shell: { showItemInFolder: (path: string) => revealed.push(path) }
}))
vi.mock('../../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../../shell/env', () => ({ which: async () => null }))
vi.mock('./toolDetectionService', () => ({
  toolDetectionService: {
    get: async (id: string) =>
      id === 'code'
        ? { id: 'code', label: 'VS Code', kind: 'editor', available: true, path: '/usr/bin/code', source: 'path' }
        : id === 'claude'
          ? {
              id: 'claude',
              label: 'Claude Code',
              kind: 'cli-assistant',
              available: true,
              path: '/usr/bin/claude',
              source: 'path'
            }
          : null
  }
}))

const { createOpenInService, openInService, setAllowedRootsProvider } = await import(
  './openInService'
)

let workshop: string
let outside: string
let agentDir: string

/** The temp dir resolved through symlinks — on macOS `/var` is one. */
function real(path: string): string {
  return realpathSync(path)
}

beforeEach(() => {
  spawned.length = 0
  executed.length = 0
  revealed.length = 0
  workshop = mkdtempSync(join(tmpdir(), 'cinna-openin-'))
  outside = mkdtempSync(join(tmpdir(), 'cinna-elsewhere-'))
  agentDir = join(workshop, 'Local', 'alpha')
  mkdirSync(agentDir, { recursive: true })
})

afterEach(() => {
  rmSync(workshop, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
  // Leave the module-level provider in its refuse-everything default.
  setAllowedRootsProvider(() => [])
})

function serviceWithRoots(...roots: string[]) {
  return createOpenInService({ getAllowedRoots: () => roots })
}

describe('the allow path', () => {
  it('reveals a folder that is genuinely inside a registered root', async () => {
    await serviceWithRoots(workshop).revealInFileManager(agentDir)
    expect(revealed).toEqual([real(agentDir)])
  })

  it('launches an editor in that folder, passing it as its own argument', async () => {
    await serviceWithRoots(workshop).openFolderInEditor(agentDir, 'code')
    expect(spawned).toEqual([
      { file: '/usr/bin/code', args: [real(agentDir)], cwd: real(agentDir) }
    ])
  })

  it('allows the root itself, not only what is under it', async () => {
    await serviceWithRoots(workshop).revealInFileManager(workshop)
    expect(revealed).toEqual([real(workshop)])
  })

  it('matches a root reached through a symlink', async () => {
    // The macOS case this exists for: `/var/folders/…` realpaths to
    // `/private/var/folders/…`, so comparing the raw strings would never match.
    const linkedRoot = join(outside, 'link-to-workshop')
    symlinkSync(workshop, linkedRoot)
    await serviceWithRoots(linkedRoot).revealInFileManager(agentDir)
    expect(revealed).toEqual([real(agentDir)])
  })

  it('allows a deeply nested path inside the root', async () => {
    const nested = join(agentDir, 'docs', 'deeper')
    mkdirSync(nested, { recursive: true })
    await serviceWithRoots(workshop).openTerminalAt(nested)
    // Something was launched with the nested folder — the guard let it through.
    expect(executed.length + spawned.length).toBeGreaterThan(0)
  })
})

describe('what the guard refuses', () => {
  it('refuses a sibling whose name merely prefixes an allowed root', async () => {
    // `…/cinna-openin-XYZEvil` must not match root `…/cinna-openin-XYZ`.
    const evil = `${workshop}Evil`
    mkdirSync(evil, { recursive: true })
    try {
      await expect(serviceWithRoots(workshop).revealInFileManager(evil)).rejects.toThrow(
        /outside your agents folders/i
      )
      expect(revealed).toEqual([])
    } finally {
      rmSync(evil, { recursive: true, force: true })
    }
  })

  it('refuses a symlink inside the root that points out of it', async () => {
    const secrets = join(real(outside), 'secrets')
    mkdirSync(secrets, { recursive: true })
    const trap = join(real(workshop), 'Local', 'looks-local')
    symlinkSync(secrets, trap)

    // The root is passed already-resolved on purpose. With a root like
    // `/var/…` whose realpath is `/private/var/…`, the trap would be refused
    // for the wrong reason — the raw string simply not matching — and the test
    // would still pass with symlink resolution removed entirely. Resolving the
    // root first removes that accident, so the only thing that can refuse this
    // path is `realpath` following the link out of the root.
    await expect(serviceWithRoots(real(workshop)).revealInFileManager(trap)).rejects.toThrow(
      /outside your agents folders/i
    )
    expect(revealed).toEqual([])
  })

  it('refuses a path that climbs out with ..', async () => {
    const escape = join(agentDir, '..', '..', '..', 'cinna-elsewhere-escape')
    mkdirSync(escape, { recursive: true })
    try {
      await expect(serviceWithRoots(workshop).revealInFileManager(escape)).rejects.toThrow(
        /outside your agents folders/i
      )
    } finally {
      rmSync(escape, { recursive: true, force: true })
    }
  })

  it('refuses a path that does not exist', async () => {
    await expect(
      serviceWithRoots(workshop).revealInFileManager(join(agentDir, 'no-such-folder'))
    ).rejects.toThrow(/no longer exists/i)
  })

  it('refuses a file where a folder is required', async () => {
    const file = join(agentDir, 'cinna-agent.json')
    writeFileSync(file, '{}\n')
    await expect(serviceWithRoots(workshop).revealInFileManager(file)).rejects.toThrow(
      /not a folder/i
    )
  })

  it('refuses a relative path outright', async () => {
    await expect(serviceWithRoots(workshop).revealInFileManager('Local/alpha')).rejects.toThrow(
      /not valid/i
    )
  })

  it('refuses everything when no root is registered', async () => {
    await expect(serviceWithRoots().revealInFileManager(agentDir)).rejects.toThrow(
      /No agents folder is configured/i
    )
  })

  it('allows nothing through a root that has gone missing', async () => {
    await expect(
      serviceWithRoots(join(outside, 'unmounted-volume')).revealInFileManager(agentDir)
    ).rejects.toThrow(/outside your agents folders/i)
  })
})

describe('setAllowedRootsProvider', () => {
  it('drops roots that are not absolute', async () => {
    // A relative root would `realpath` against `process.cwd()` — for a packaged
    // app, whatever directory the OS launched it from.
    setAllowedRootsProvider(() => ['Documents/CinnaAgents', './agents', ''])
    await expect(openInService.revealInFileManager(agentDir)).rejects.toThrow(
      /No agents folder is configured/i
    )
  })

  it('keeps the absolute ones alongside a dropped relative one', async () => {
    setAllowedRootsProvider(() => ['relative/path', workshop])
    await openInService.revealInFileManager(agentDir)
    expect(revealed).toEqual([real(agentDir)])
  })

  it('re-reads the provider on every call, so a newly added root takes effect', async () => {
    let roots: string[] = []
    setAllowedRootsProvider(() => roots)
    await expect(openInService.revealInFileManager(agentDir)).rejects.toThrow(/No agents folder/i)

    roots = [workshop]
    await openInService.revealInFileManager(agentDir)
    expect(revealed).toEqual([real(agentDir)])
  })
})
