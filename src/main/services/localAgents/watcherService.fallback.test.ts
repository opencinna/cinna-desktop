vi.mock('../../host/runtimeHost', async () => {
  const { createDesktopHost } = await import('../../host/desktop/runtimeHost')
  return { runtimeHost: createDesktopHost() }
})
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The per-directory fallback (Linux, or anywhere `recursive` is refused),
 * forced here by a `watch` that refuses recursion and records what it was
 * asked to watch: one level down is invisible without recursion, so every
 * directory whose change matters has to be in the set.
 */

const watched = vi.hoisted(() => [] as string[])
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return {
    ...real,
    watch: (dir: string, options: { recursive?: boolean }) => {
      if (options?.recursive) {
        throw Object.assign(new Error('no recursion'), { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' })
      }
      watched.push(dir)
      return { on: () => undefined, close: () => undefined }
    }
  }
})
vi.mock('../../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

const { watcherService } = await import('./watcherService')

let workshop: string

afterEach(() => {
  watcherService.stopAll()
  watched.length = 0
  rmSync(workshop, { recursive: true, force: true })
})

describe('the non-recursive fallback', () => {
  it('watches skills/ and each skill folder, where a SKILL.md is edited', () => {
    workshop = mkdtempSync(join(tmpdir(), 'cinna-watch-fallback-'))
    const agentDir = join(workshop, 'Local', 'alpha')
    mkdirSync(join(agentDir, 'docs'), { recursive: true })
    mkdirSync(join(agentDir, 'skills', 'pdf-tools'), { recursive: true })
    mkdirSync(join(agentDir, 'skills', '.staging'), { recursive: true })
    writeFileSync(join(agentDir, 'skills', 'README.md'), '# Skills\n')

    watcherService.configure({
      rescanAgent: () => undefined,
      rescanRoot: () => undefined,
      agentIdForPath: () => null,
      agentIdsForRoot: () => []
    })
    watcherService.watchRoot({
      id: 'r1', userId: '__default__', path: workshop, label: 'Agents', isDefault: true, kind: 'workshop', createdAt: new Date()
    } as never)

    expect(watched).toEqual(expect.arrayContaining([
      join(agentDir, 'docs'),
      join(agentDir, 'skills'),
      join(agentDir, 'skills', 'pdf-tools')
    ]))
    expect(watched).not.toContain(join(agentDir, 'skills', '.staging'))
    expect(watched).not.toContain(join(agentDir, 'skills', 'README.md'))
  })
})
