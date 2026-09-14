import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

vi.mock('../../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

/** Runs just before the service opens a file for reading: where a swap is staged. */
const hooks = vi.hoisted(() => ({ beforeOpen: null as null | (() => void) }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: (path: string, flags?: string) => {
      hooks.beforeOpen?.()
      return actual.open(path, flags)
    }
  }
})

const { createAgentFileService } = await import('./agentFileService')
const { createConsentRegistry } = await import('./consent')
const { createPathCanonicalizer } = await import('./canonicalPath')
type ConsentRequest = import('./consent').ConsentRequest
type ConsentAnswer = import('./consent').ConsentAnswer
type PathCanonicalizer = import('./canonicalPath').PathCanonicalizer

/**
 * The gate between a renderer and the disk: what is read, opened or revealed
 * without asking, what needs the user's approval, and what is never read at
 * all. Launchers are recorded, never run.
 */

let root: string
let agent: string
let outside: string
let home: string
/** `${firm}${path}` stands for `/System/Volumes/Data${path}`. */
let firm: string

function write(path: string, contents = 'hello'): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cinna-agent-files-')))
  agent = join(root, 'agent')
  outside = join(root, 'outside')
  home = join(root, 'home')
  firm = join(root, 'data-volume')
  write(join(agent, 'data/omp.csv'), 'a,b\n1,2\n')
  write(join(agent, 'main.py'), 'print(1)\n')
  write(join(agent, 'report.pdf'), '%PDF')
  write(join(agent, '.env'), 'SECRET=1\n')
  write(join(agent, 'credentials/service.json'), '{"key":"x"}')
  write(join(agent, 'credentials/README.md'), '# How to add credentials')
  write(join(agent, 'dump.gz'), 'binary')
  write(join(agent, 'big.txt'), 'é'.repeat(10))
  write(join(outside, 'notes.md'), '# outside')
  write(join(outside, 'sibling.md'), '# sibling')
  write(join(outside, '.env.local'), 'SECRET=2')
  write(join(outside, '.env.md'), 'SECRET=3')
  write(join(outside, 'sibling.gz'), 'binary')
  write(join(outside, 'sub/x.md'), '# sub')
  write(join(home, 'notes.md'), '# home')
  write(join(home, 'Documents/doc.md'), '# documents')
  symlinkSync(join(outside, 'notes.md'), join(agent, 'link.md'))
  for (const path of [join(agent, 'main.py'), join(agent, 'credentials/service.json'), join(home, 'notes.md')]) {
    write(firm + path, 'mirror')
  }
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

let user = 'u1'
let prompts: ConsentRequest[]
let launched: Array<[string, string]>

interface ServiceOptions {
  editor?: boolean
  openPathFailure?: string
  agentDir?: string
  home?: string
  homeDirs?: string[]
  paths?: PathCanonicalizer
  isGuardedLocation?: (path: string) => boolean
  /** Runs while the service looks up the default editor, between its check and its launch. */
  onEditorLookup?: () => void
}

function makeService(options: ServiceOptions = {}) {
  launched = []
  return createAgentFileService({
    locateAgent: (agentId) => {
      if (agentId !== 'folder:a') throw new Error('not a folder agent')
      return options.agentDir ?? agent
    },
    agentName: () => 'GFCA',
    getConsentUserId: () => user,
    consent: createConsentRegistry({ homeDirs: () => options.homeDirs ?? ['/Users/nobody'] }),
    platform: 'darwin',
    isGuardedLocation: options.isGuardedLocation ?? (() => false),
    paths: options.paths,
    home: options.home,
    maxPreviewBytes: 7,
    getDefaultEditor: async () => {
      options.onEditorLookup?.()
      return options.editor
        ? ({ id: 'code', kind: 'editor', label: 'VS Code', path: '/bin/code', available: true, source: 'path' } as never)
        : null
    },
    launchEditor: async (_tool, target) => void launched.push(['editor', target]),
    openPath: async (path) => {
      launched.push(['default-app', path])
      return options.openPathFailure ?? ''
    },
    openInTextEditor: async (path) => void launched.push(['text-editor', path]),
    showItemInFolder: (path) => void launched.push(['reveal', path])
  })
}

/** A firmlink: the long spelling stats as the short one, while realpath keeps it. */
const firmlinked = () =>
  createPathCanonicalizer({
    platform: 'darwin',
    dataVolume: firm,
    stat: (path) => stat(path.startsWith(`${firm}/`) ? path.slice(firm.length) : path)
  })

const approve = (rememberDir = false) => async (request: ConsentRequest) => {
  prompts.push(request)
  return { approved: true, rememberDir }
}
const deny = async (request: ConsentRequest) => {
  prompts.push(request)
  return { approved: false, rememberDir: false }
}

beforeEach(() => {
  user = 'u1'
  prompts = []
  hooks.beforeOpen = null
})

const at = (path: string) => ({ agentId: 'folder:a', path })

describe('readPreview', () => {
  it('reads a file inside the agent folder without asking', async () => {
    const service = makeService()
    expect(await service.readPreview(at(join(agent, 'data/omp.csv')))).toEqual({
      success: true,
      text: 'a,b\n1,2',
      truncated: true
    })
  })

  it('refuses a file outside the folder until the user approves it', async () => {
    const service = makeService()
    const path = join(outside, 'notes.md')
    expect(await service.readPreview(at(path))).toMatchObject({ success: false, code: 'needs_consent' })

    expect(await service.authorize(at(path), deny)).toEqual({ success: true, approved: false })
    expect(await service.readPreview(at(path))).toMatchObject({ success: false, code: 'needs_consent' })

    expect(await service.authorize(at(path), approve())).toEqual({ success: true, approved: true })
    expect(await service.readPreview(at(path))).toEqual({ success: true, text: '# outsi', truncated: true })
    expect(prompts.map((p) => [p.agentName, p.path, p.dir, p.offerDir])).toEqual([
      ['GFCA', path, outside, true],
      ['GFCA', path, outside, true]
    ])
  })

  it('treats a symlink out of the folder as outside', async () => {
    const service = makeService()
    expect(await service.readPreview(at(join(agent, 'link.md')))).toMatchObject({ code: 'needs_consent' })
  })

  it('a file approval does not cover its sibling; a folder approval does', async () => {
    const service = makeService()
    await service.authorize(at(join(outside, 'notes.md')), approve(false))
    expect(await service.readPreview(at(join(outside, 'sibling.md')))).toMatchObject({ code: 'needs_consent' })
    await service.authorize(at(join(outside, 'notes.md')), approve(true))
    // Already approved: no second dialog, and the folder was not remembered by it.
    expect(prompts).toHaveLength(1)
    const other = makeService()
    await other.authorize(at(join(outside, 'notes.md')), approve(true))
    expect(await other.readPreview(at(join(outside, 'sibling.md')))).toMatchObject({ success: true })
  })

  it('keeps approvals per profile', async () => {
    const service = makeService()
    await service.authorize(at(join(outside, 'notes.md')), approve())
    user = 'u2'
    expect(await service.readPreview(at(join(outside, 'notes.md')))).toMatchObject({ code: 'needs_consent' })
  })

  it.each(['.env', 'credentials/service.json'])('never reads the credential file %s', async (rel) => {
    const service = makeService()
    expect(await service.readPreview(at(join(agent, rel)))).toEqual({
      success: false,
      code: 'credential_file',
      error: 'Preview is off for credential files.'
    })
  })

  it('refuses an approved outside credential file too, but reads credentials/README.md', async () => {
    const service = makeService()
    await service.authorize(at(join(outside, '.env.local')), approve())
    expect(await service.readPreview(at(join(outside, '.env.local')))).toMatchObject({ code: 'credential_file' })
    expect(await service.readPreview(at(join(agent, 'credentials/README.md')))).toMatchObject({ success: true })
  })

  it('does not read types it cannot preview, folders, or missing files', async () => {
    const service = makeService()
    expect(await service.readPreview(at(join(agent, 'dump.gz')))).toMatchObject({ code: 'not_previewable' })
    expect(await service.readPreview(at(join(agent, 'data')))).toMatchObject({ code: 'not_a_file' })
    expect(await service.readPreview(at(join(agent, 'gone.md')))).toMatchObject({ code: 'not_found' })
  })

  it('drops a multi-byte character severed by the byte cap', async () => {
    const service = makeService()
    expect(await service.readPreview(at(join(agent, 'big.txt')))).toEqual({ success: true, text: 'ééé', truncated: true })
  })

  it('refuses malformed input and unknown agents as data', async () => {
    const service = makeService()
    expect(await service.readPreview({ agentId: 'folder:a', path: 'relative.md' })).toMatchObject({ code: 'invalid_input' })
    expect(await service.readPreview(null)).toMatchObject({ code: 'invalid_input' })
    expect(await service.readPreview({ agentId: 'folder:b', path: join(agent, 'main.py') })).toMatchObject({
      code: 'agent_not_found'
    })
  })

  it('refuses a file swapped for another between the check and the read', async () => {
    const service = makeService()
    write(join(agent, 'swap.md'), 'checked')
    write(join(agent, 'swap-new.md'), 'swapped in')
    hooks.beforeOpen = () => renameSync(join(agent, 'swap-new.md'), join(agent, 'swap.md'))
    expect(await service.readPreview(at(join(agent, 'swap.md')))).toEqual({
      success: false,
      code: 'not_found',
      error: 'That file is no longer there.'
    })
  })
})

describe('open and reveal', () => {
  it('launch nothing for an outside path without approval', async () => {
    const service = makeService()
    expect(await service.open(at(join(outside, 'notes.md')))).toMatchObject({ code: 'needs_consent' })
    expect(await service.reveal(at(join(outside, 'notes.md')))).toMatchObject({ code: 'needs_consent' })
    expect(launched).toEqual([])
  })

  it('open a credential file and follow the strategy', async () => {
    const service = makeService()
    expect(await service.open(at(join(agent, '.env')))).toEqual({ success: true })
    expect(await service.open(at(join(agent, 'data/omp.csv')))).toEqual({ success: true })
    expect(await service.open(at(join(agent, 'data')))).toEqual({ success: true })
    expect(await service.reveal(at(join(agent, 'main.py')))).toEqual({ success: true })
    expect(launched).toEqual([
      ['text-editor', join(agent, '.env')],
      ['default-app', join(agent, 'data/omp.csv')],
      ['reveal', join(agent, 'data')],
      ['reveal', join(agent, 'main.py')]
    ])
  })

  it('use the default editor when there is one, but the system app for a binary document', async () => {
    const service = makeService({ editor: true })
    await service.open(at(join(agent, 'main.py')))
    await service.open(at(join(agent, 'report.pdf')))
    expect(launched).toEqual([
      ['editor', join(agent, 'main.py')],
      ['default-app', join(agent, 'report.pdf')]
    ])
  })

  it('report a default app that refused as data', async () => {
    const service = makeService({ openPathFailure: 'No application knows how to open this file' })
    expect(await service.open(at(join(agent, 'data/omp.csv')))).toEqual({
      success: false,
      code: 'launch_failed',
      error: 'No app could open this file.'
    })
  })

  it.each([
    [true, 'moving-editor.py'],
    [false, 'moving-app.csv'],
    [false, 'moving-text.py']
  ])('launch nothing when the path leads elsewhere by launch time (editor: %s, %s)', async (editor, name) => {
    const link = join(agent, name)
    symlinkSync(join(agent, 'data/omp.csv'), link)
    const service = makeService({
      editor,
      onEditorLookup: () => {
        unlinkSync(link)
        symlinkSync(join(agent, 'big.txt'), link)
      }
    })
    expect(await service.open(at(link))).toEqual({
      success: false,
      code: 'launch_failed',
      error: 'Could not open the file.'
    })
    expect(launched).toEqual([])
  })
})

describe('authorize', () => {
  it('asks in ~/ paths, says whether the file would be read, and names a folder as a folder', async () => {
    const service = makeService({ home: root })
    await service.authorize(at(join(outside, 'notes.md')), deny)
    await service.authorize(at(join(outside, '.env.md')), deny)
    await service.authorize(at(join(outside, 'sibling.gz')), deny)
    await service.authorize(at(join(outside, 'sub')), deny)
    expect(prompts.map((p) => [p.kind, p.displayPath, p.displayDir, p.previewable])).toEqual([
      ['file', '~/outside/notes.md', '~/outside', true],
      // A previewable type, but a credential name: never read, so not "reads it".
      ['file', '~/outside/.env.md', '~/outside', false],
      ['file', '~/outside/sibling.gz', '~/outside', false],
      ['dir', '~/outside/sub', '~/outside/sub', false]
    ])
  })

  it('shows one dialog when two calls for the same path overlap, and gives both its answer', async () => {
    const service = makeService()
    const answers: Array<(answer: ConsentAnswer) => void> = []
    const slow = (request: ConsentRequest) => {
      prompts.push(request)
      return new Promise<ConsentAnswer>((resolve) => answers.push(resolve))
    }
    const path = join(outside, 'sibling.md')
    const first = service.authorize(at(path), slow)
    await vi.waitFor(() => expect(prompts).toHaveLength(1))
    const second = service.authorize(at(path), slow)
    // Let the second call get past its own checks before the dialog is answered.
    await new Promise((resolve) => setTimeout(resolve, 50))
    for (const answer of answers) answer({ approved: true, rememberDir: false })
    expect(await Promise.all([first, second])).toEqual([
      { success: true, approved: true },
      { success: true, approved: true }
    ])
    expect(prompts).toHaveLength(1)
  })
})

describe('macOS data-volume spelling', () => {
  it('applies the credential rule and containment to a path spelled through the data volume', async () => {
    const service = makeService({ paths: firmlinked() })
    expect(await service.readPreview(at(firm + join(agent, 'credentials/service.json')))).toMatchObject({
      code: 'credential_file'
    })
    expect(await service.readPreview(at(firm + join(agent, 'main.py')))).toEqual({
      success: true,
      text: 'print(1',
      truncated: true
    })
  })

  it('keeps a file inside an agent folder located through the data volume', async () => {
    const service = makeService({ paths: firmlinked(), agentDir: firm + agent })
    expect(await service.readPreview(at(join(agent, 'main.py')))).toMatchObject({ success: true })
    expect(await service.readPreview(at(join(agent, 'credentials/service.json')))).toMatchObject({
      code: 'credential_file'
    })
  })

  it('does not offer the home as a folder to approve when a file in it is spelled through the data volume', async () => {
    const service = makeService({ paths: firmlinked(), home, homeDirs: [home] })
    await service.authorize(at(firm + join(home, 'notes.md')), approve(true))
    expect(prompts.map((p) => [p.path, p.dir, p.displayPath, p.offerDir])).toEqual([
      [join(home, 'notes.md'), home, '~/notes.md', false]
    ])
    expect(await service.readPreview(at(join(home, 'notes.md')))).toMatchObject({ success: true })
  })
})

describe('resolve', () => {
  it('resolves against the located folder and refuses unknown agents', async () => {
    const service = makeService()
    const result = await service.resolve({ agentId: 'folder:a', candidates: ['data/omp.csv', 'nope.md'] })
    expect(result).toMatchObject({ success: true, refs: [{ text: 'data/omp.csv', inside: true }] })
    expect(await service.resolve({ agentId: 'folder:b', candidates: [] })).toMatchObject({ code: 'agent_not_found' })
    expect(await service.resolve({ agentId: 'folder:a' })).toMatchObject({ code: 'invalid_input' })
  })

  it('hands the privacy guard to the resolver', async () => {
    const documents = join(home, 'Documents')
    const guarded = (path: string) => path === documents || path.startsWith(`${documents}/`)
    const candidates = ['~/Documents/doc.md']
    expect(await makeService({ home }).resolve({ agentId: 'folder:a', candidates })).toMatchObject({
      refs: [{ text: '~/Documents/doc.md' }]
    })
    expect(await makeService({ home, isGuardedLocation: guarded }).resolve({ agentId: 'folder:a', candidates })).toEqual({
      success: true,
      refs: []
    })
  })
})
