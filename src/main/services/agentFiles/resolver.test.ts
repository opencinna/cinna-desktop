import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

vi.mock('../../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

/** Every path the resolver (or the canonicalizer under it) touches. */
const touched = vi.hoisted(() => [] as string[])
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    realpath: (path: string) => {
      touched.push(path)
      return actual.realpath(path)
    },
    stat: (path: string) => {
      touched.push(path)
      return actual.stat(path)
    }
  }
})

/** The home the real `isGuardedLocation` sees: the fake home, once it exists. */
const realGuardHome = vi.hoisted(() => ({ path: '' }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => realGuardHome.path }
})
vi.mock('../../db/appSettings', () => ({ appSettingsRepo: { get: () => undefined } }))

const { resolveFileRefs } = await import('./resolver')
const { createPathCanonicalizer } = await import('./canonicalPath')
const { isGuardedLocation } = await import('../localAgents/homePath')

/**
 * The resolver on a real folder tree: an agent folder shaped like the evidence
 * session (`data/reforecast/2026-H2/…`), a sibling outside it, a fake home, and
 * symlinks out of the folder.
 */

let root: string
let agent: string
let outside: string
let home: string
let firm: string

function touch(path: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, 'x')
}

const within = (dir: string, path: string): boolean => path === dir || path.startsWith(`${dir}/`)
/** `isGuardedLocation` for the fake home. */
const guarded = (path: string): boolean =>
  ['Documents', 'Desktop', 'Downloads'].some((dir) => within(join(home, dir), path))
const touchedGuarded = (): string[] => touched.filter(guarded)

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cinna-refs-')))
  agent = join(root, 'agent')
  outside = join(root, 'outside')
  home = join(root, 'home')
  firm = join(root, 'data-volume')
  realGuardHome.path = home
  touch(join(agent, 'README.md'))
  touch(join(agent, 'data/reforecast/2026-H2/pulled/omp.csv'))
  touch(join(agent, 'data/reforecast/2026-H2/pulled/reseller.csv'))
  touch(join(agent, 'data/reforecast/2026-H2/cycle_summary.md'))
  touch(join(agent, 'a/x.csv'))
  touch(join(agent, 'a/summary.md'))
  touch(join(agent, 'b/y.csv'))
  touch(join(agent, 'b/summary.md'))
  touch(join(outside, 'notes.md'))
  touch(join(outside, 'other.md'))
  touch(join(outside, 'sub/deep.md'))
  touch(join(home, 'doc.md'))
  touch(join(home, 'notes.md'))
  touch(join(home, 'Documents/doc.md'))
  touch(join(home, 'Documents/other.md'))
  touch(join(home, 'Documents/agent2/README.md'))
  touch(join(home, 'Desktop/d.md'))
  touch(join(home, 'Downloads/x.md'))
  symlinkSync(join(outside, 'notes.md'), join(agent, 'link.md'))
  symlinkSync(outside, join(agent, 'linkdir'))
  symlinkSync(join(home, 'Documents'), join(agent, 'docs'))
  // `${firm}${path}` stands for `/System/Volumes/Data${path}`.
  touch(firm + join(agent, 'README.md'))
  touch(firm + join(home, 'Desktop/d.md'))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  touched.length = 0
})

const resolveIn = (candidates: unknown[], options = {}) =>
  resolveFileRefs(agent, candidates, { home, isGuarded: () => false, ...options })

describe('direct resolution', () => {
  it('resolves a relative path against the agent folder', async () => {
    expect(await resolveIn(['README.md'])).toEqual([
      { text: 'README.md', path: join(agent, 'README.md'), displayPath: 'README.md', kind: 'file', inside: true }
    ])
  })

  it('keeps the span text but strips a :line suffix from the path', async () => {
    const [ref] = await resolveIn(['README.md:12:3'])
    expect(ref).toMatchObject({ text: 'README.md:12:3', path: join(agent, 'README.md'), inside: true })
  })

  it('resolves ../ out of the folder as an outside ref with an absolute display path', async () => {
    const [ref] = await resolveIn(['../outside/notes.md'])
    expect(ref).toMatchObject({ path: join(outside, 'notes.md'), displayPath: join(outside, 'notes.md'), inside: false })
  })

  it('resolves absolute paths inside and outside', async () => {
    const refs = await resolveIn([join(agent, 'README.md'), join(outside, 'notes.md')])
    expect(refs.map((r) => [r.displayPath, r.inside])).toEqual([
      ['README.md', true],
      [join(outside, 'notes.md'), false]
    ])
  })

  it('expands ~/ against the home and shows it that way', async () => {
    const [ref] = await resolveIn(['~/doc.md'])
    expect(ref).toMatchObject({ path: join(home, 'doc.md'), displayPath: '~/doc.md', inside: false })
  })

  it('decides inside on realpaths: a symlink out of the folder is outside', async () => {
    const refs = await resolveIn(['link.md', 'linkdir/other.md'])
    expect(refs.map((r) => [r.path, r.inside])).toEqual([
      [join(outside, 'notes.md'), false],
      [join(outside, 'other.md'), false]
    ])
  })

  it('resolves a folder as a dir ref', async () => {
    const [ref] = await resolveIn(['data/reforecast/'])
    expect(ref).toMatchObject({ kind: 'dir', displayPath: 'data/reforecast', inside: true })
  })

  it('ignores what does not exist, is not a string, or fails the shape filter', async () => {
    expect(await resolveIn(['missing.md', 42, 'rm -rf data/', 'data/*.csv'])).toEqual([])
  })

  it('returns nothing when the agent folder is gone', async () => {
    expect(await resolveFileRefs(join(root, 'nope'), ['README.md'], { home, isGuarded: () => false })).toEqual([])
  })
})

describe('base heuristic', () => {
  it('links a later span against the folders of earlier refs and their ancestors', async () => {
    const refs = await resolveIn([
      'data/reforecast/2026-H2/pulled/omp.csv',
      'pulled/reseller.csv',
      'cycle_summary.md'
    ])
    expect(refs.map((r) => r.displayPath)).toEqual([
      'data/reforecast/2026-H2/pulled/omp.csv',
      'data/reforecast/2026-H2/pulled/reseller.csv',
      'data/reforecast/2026-H2/cycle_summary.md'
    ])
  })

  it('does not link when more than one distinct file matches', async () => {
    const refs = await resolveIn(['a/x.csv', 'b/y.csv', 'summary.md'])
    expect(refs.map((r) => r.text)).toEqual(['a/x.csv', 'b/y.csv'])
  })

  it('only counts earlier spans', async () => {
    const refs = await resolveIn(['reseller.csv', 'data/reforecast/2026-H2/pulled/omp.csv'])
    expect(refs.map((r) => r.text)).toEqual(['data/reforecast/2026-H2/pulled/omp.csv'])
  })

  it('never tries a span with .. against a base', async () => {
    const refs = await resolveIn(['data/reforecast/2026-H2/pulled/omp.csv', '../pulled/reseller.csv'])
    expect(refs.map((r) => r.text)).toEqual(['data/reforecast/2026-H2/pulled/omp.csv'])
  })

  it('takes only the own folder of an outside ref, not its ancestors', async () => {
    const refs = await resolveIn(['../outside/sub/deep.md', 'notes.md', '../outside/other.md', 'deep.md'])
    expect(refs.map((r) => r.text)).toEqual(['../outside/sub/deep.md', '../outside/other.md', 'deep.md'])
    expect(refs[2]).toMatchObject({ path: join(outside, 'sub/deep.md'), inside: false })
  })
})

describe('caps', () => {
  it('stops after maxCandidates valid candidates, not counting refused shapes', async () => {
    const refs = await resolveIn(['not a path', 'README.md', 'a/x.csv', 'b/y.csv'], { maxCandidates: 2 })
    expect(refs.map((r) => r.text)).toEqual(['README.md', 'a/x.csv'])
  })

  it('keeps the first bases when capped, so earlier links stay stable', async () => {
    const candidates = ['data/reforecast/2026-H2/pulled/omp.csv', 'cycle_summary.md']
    expect((await resolveIn(candidates, { maxBases: 1 })).map((r) => r.text)).toEqual([candidates[0]])
    expect((await resolveIn(candidates)).map((r) => r.text)).toEqual(candidates)
  })
})

describe('macOS privacy-guarded folders', () => {
  it('never touches ~/Documents, ~/Desktop or ~/Downloads for an agent outside them', async () => {
    const refs = await resolveIn(
      ['~/Documents/doc.md', join(home, 'Desktop/d.md'), '../home/Downloads/x.md'],
      { isGuarded: guarded }
    )
    expect(refs).toEqual([])
    expect(touchedGuarded()).toEqual([])
  })

  it('does not join a later span into a guarded folder through a base', async () => {
    const refs = await resolveIn(['~/notes.md', 'Documents/doc.md'], { isGuarded: guarded })
    expect(refs.map((r) => r.text)).toEqual(['~/notes.md'])
    expect(touchedGuarded()).toEqual([])
  })

  it('a ref that lands in a guarded folder through a symlink contributes no bases', async () => {
    // The probe would refuse a join into the guarded folder anyway; what the
    // rule adds is that such a base does not take a capped slot from a real one.
    const refs = await resolveIn(['docs/doc.md', '../outside/notes.md', 'other.md'], {
      isGuarded: guarded,
      maxBases: 1
    })
    expect(refs.map((r) => [r.text, r.path])).toEqual([
      ['docs/doc.md', join(home, 'Documents/doc.md')],
      ['../outside/notes.md', join(outside, 'notes.md')],
      ['other.md', join(outside, 'other.md')]
    ])
    expect(touched).not.toContain(join(home, 'Documents/other.md'))
  })

  it('resolves inside the guarded folder the agent itself lives in, and nowhere else guarded', async () => {
    const refs = await resolveFileRefs(
      join(home, 'Documents/agent2'),
      ['README.md', '../doc.md', '~/Documents/other.md', '~/Desktop/d.md'],
      { home, isGuarded: guarded }
    )
    expect(refs.map((r) => [r.text, r.inside])).toEqual([
      ['README.md', true],
      ['../doc.md', false],
      ['~/Documents/other.md', false]
    ])
    expect(touched.filter((path) => within(join(home, 'Desktop'), path))).toEqual([])
  })

  describe('with the real guard, spelled in another case', () => {
    /** The production guard, pinned to macOS. */
    const realGuard = (path: string): boolean => isGuardedLocation(path, 'darwin')
    /** Independent of the guard under test: any case of a guarded folder. */
    const touchedAnyCase = (dir: string): string[] =>
      touched.filter((path) => within(join(home, dir).toLowerCase(), path.toLowerCase()))

    it('never touches ~/downloads, ~/DESKTOP or ../home/documents for an agent outside them', async () => {
      const refs = await resolveIn(['~/downloads/x.md', join(home, 'DESKTOP/d.md'), '../home/documents/doc.md'], {
        isGuarded: realGuard
      })
      expect(refs).toEqual([])
      expect(['Documents', 'Desktop', 'Downloads'].flatMap(touchedAnyCase)).toEqual([])
    })

    it('walks a mixed-case spelling up to its own guarded folder, not past it', async () => {
      // A root found too high (the home) would contain this agent and let the
      // Desktop probe through; a root not found at all would too.
      const refs = await resolveFileRefs(join(home, 'Documents/agent2'), ['README.md', '~/desktop/d.md'], {
        home,
        isGuarded: realGuard
      })
      expect(refs.map((r) => [r.text, r.inside])).toEqual([['README.md', true]])
      expect(touchedAnyCase('Desktop')).toEqual([])
    })
  })

  it('sees a guarded folder through the data-volume spelling', async () => {
    const paths = createPathCanonicalizer({ platform: 'darwin', dataVolume: firm })
    const spelled = firm + join(home, 'Desktop/d.md')
    expect(await resolveIn([spelled], { isGuarded: guarded, paths })).toEqual([])
    expect(touched).not.toContain(spelled)
  })
})

describe('macOS data-volume spelling', () => {
  /** A firmlink: the long spelling stats as the short one. */
  const firmlinked = () =>
    createPathCanonicalizer({
      platform: 'darwin',
      dataVolume: firm,
      stat: (path) => stat(path.startsWith(`${firm}/`) ? path.slice(firm.length) : path)
    })

  it('resolves an absolute path spelled through the data volume as inside', async () => {
    const [ref] = await resolveIn([firm + join(agent, 'README.md')], { paths: firmlinked() })
    expect(ref).toMatchObject({ path: join(agent, 'README.md'), displayPath: 'README.md', inside: true })
  })

  it('treats an agent folder located through the data volume as the same folder', async () => {
    const refs = await resolveFileRefs(firm + agent, ['README.md', join(agent, 'README.md')], {
      home,
      isGuarded: () => false,
      paths: firmlinked()
    })
    expect(refs.map((r) => [r.path, r.displayPath, r.inside])).toEqual([
      [join(agent, 'README.md'), 'README.md', true],
      [join(agent, 'README.md'), 'README.md', true]
    ])
  })
})
