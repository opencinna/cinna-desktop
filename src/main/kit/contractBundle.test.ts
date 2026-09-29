import { describe, it, expect } from 'vitest'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, type Dirent } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { contractTreeHash } from './contractTreeHash'
import { createLayoutView, parseLayout } from './layout'
import { isIgnoredPath, isSecretFile } from './validator'
import { applyTarballModes, freshWorkDir } from '../../../scripts/kit-sync/bundleFiles'

/**
 * `resources/cinna-agent-kit/` is a byte-exact render of cinna-core's whole
 * agent kit — contract, guides, assistant notes, `tools/kit.py`, `VERSION` —
 * produced by `make kit-sync` (scripts/kit-sync/sync.mjs). Core is the only
 * place a contract version is minted and its templates are canonical, so a hand
 * edit here is a fork — this test is what makes one fail.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const bundle = join(repoRoot, 'resources/cinna-agent-kit')
const lock = JSON.parse(readFileSync(join(repoRoot, 'scripts/kit-sync/kit.lock.json'), 'utf8')) as {
  contract_version: string
  kit_version: string
  file_count: number
  tree_hash: string
}

const RESYNC = 'resources/cinna-agent-kit/ no longer matches scripts/kit-sync/kit.lock.json. Re-run `make kit-sync`; never hand-edit the bundle or the lock.'

describe('the bundled agent kit', () => {
  it('is exactly the tree the last `make kit-sync` wrote', () => {
    const tree = contractTreeHash(bundle)
    expect({ fileCount: tree.fileCount, hash: tree.hash }, RESYNC).toEqual({
      fileCount: lock.file_count,
      hash: lock.tree_hash
    })
  })

  it('declares one contract_version in CONTRACT_VERSION, kit.json and layout.json', () => {
    const declared = {
      CONTRACT_VERSION: readFileSync(join(bundle, 'CONTRACT_VERSION'), 'utf8').trim(),
      'kit.json': (JSON.parse(readFileSync(join(bundle, 'kit.json'), 'utf8')) as { contract_version?: unknown }).contract_version,
      'layout.json': (JSON.parse(readFileSync(join(bundle, 'layout.json'), 'utf8')) as { contract_version?: unknown }).contract_version,
      lock: lock.contract_version
    }
    expect(declared['CONTRACT_VERSION']).toMatch(/^\d+\.\d+\.\d+/)
    for (const [where, value] of Object.entries(declared)) {
      expect(value, `${where} disagrees — ${RESYNC}`).toBe(declared['CONTRACT_VERSION'])
    }
  })

  it('is the full kit, not just the contract', () => {
    // The workshop templates' AGENTS.md sends an assistant to the index, the
    // guides and the validator; a contract-only bundle is how every build
    // request came to say "the kit is missing".
    const required = ['README.md', 'START.md', 'VERSION', 'tools/kit.py', 'assistants/cinna-desktop.md']
    expect(required.filter((rel) => !statSync(join(bundle, rel), { throwIfNoEntry: false })?.isFile()), RESYNC).toEqual([])
    expect(readdirSync(join(bundle, 'guides')).filter((name) => name.endsWith('.md')).length).toBeGreaterThan(0)
  })

  it('carries the kit version the lock recorded in VERSION', () => {
    // `VERSION` is the kit content hash the workshop sync compares on.
    expect(readFileSync(join(bundle, 'VERSION'), 'utf8').trim(), RESYNC).toBe(lock.kit_version)
  })

  it('ships tools/kit.py executable', () => {
    // The agent template's `make validate` runs it; a packaged copy that lost
    // the bit would fail there rather than here.
    expect(statSync(join(bundle, 'tools/kit.py')).mode & 0o111, RESYNC).toBe(0o111)
  })
})

/** Every path under `dir` with its permission bits, relative and POSIX. */
function modesUnder(dir: string, rel = ''): Array<[string, number]> {
  const out: Array<[string, number]> = [[rel === '' ? '.' : rel, statSync(join(dir, rel)).mode & 0o777]]
  const entries: Dirent[] = readdirSync(join(dir, rel), { withFileTypes: true })
  for (const entry of entries) {
    const child = rel === '' ? entry.name : `${rel}/${entry.name}`
    if (entry.isDirectory()) out.push(...modesUnder(dir, child))
    else out.push([child, statSync(join(dir, child)).mode & 0o777])
  }
  return out
}

/** Core's tarball modes: directories 0755, `.py` 0755, every other file 0644. */
function expectedMode(dir: string, rel: string): number {
  if (statSync(join(dir, rel)).isDirectory()) return 0o755
  return rel.endsWith('.py') ? 0o755 : 0o644
}

describe('how `make kit-sync` writes the bundle', () => {
  it('ships the bundle with core\'s tarball modes, readable by every user', () => {
    // `mkdtempSync` creates 0700; a bundle that kept it is unreadable to any
    // other account running a packaged app.
    const wrong = modesUnder(bundle).filter(([rel, mode]) => mode !== expectedMode(bundle, rel))
    expect(wrong.map(([rel, mode]) => `${rel} ${mode.toString(8)}`), RESYNC).toEqual([])
  })

  it('sets those modes on a freshly staged tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'cinna-kit-modes-'))
    try {
      mkdirSync(join(root, 'templates/agent/scripts'), { recursive: true, mode: 0o700 })
      writeFileSync(join(root, 'kit.json'), '{}', { mode: 0o600 })
      writeFileSync(join(root, 'templates/agent/scripts/run.py'), '', { mode: 0o600 })
      applyTarballModes(root)
      expect(modesUnder(root).filter(([rel, mode]) => mode !== expectedMode(root, rel))).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('starts each run from an empty work dir', () => {
    // An interrupted run leaves a staging or parked tree behind.
    const root = mkdtempSync(join(tmpdir(), 'cinna-kit-work-'))
    try {
      const work = join(root, '.work')
      mkdirSync(join(work, 'staging-abc', 'templates'), { recursive: true })
      writeFileSync(join(work, 'staging-abc', 'templates', 'x.md'), 'left over')
      mkdirSync(join(work, 'staging-old.previous'))
      freshWorkDir(work)
      expect(readdirSync(work)).toEqual([])
      rmSync(work, { recursive: true })
      freshWorkDir(work)
      expect(existsSync(work)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps the kit-sync work dir, and the rest of scripts/, out of the packaged app', () => {
    // electron-builder packs everything `files` does not exclude, and
    // `scripts/kit-sync/.work/` is under scripts/.
    const files: string[] = []
    let inFiles = false
    for (const line of readFileSync(join(repoRoot, 'electron-builder.yml'), 'utf8').split('\n')) {
      if (/^\S/.test(line)) inFiles = line.startsWith('files:')
      else if (inFiles) {
        const entry = /^\s+-\s+'([^']*)'/.exec(line)
        if (entry) files.push(entry[1])
      }
    }
    expect(files).toContain('!scripts/**')
    // sync.mjs clears its work dir through the helper tested above.
    expect(readFileSync(join(repoRoot, 'scripts/kit-sync/sync.mjs'), 'utf8')).toMatch(/freshWorkDir\(WORK\)/)
  })
})

/**
 * The secret-file rule has one desktop copy (`isSecretFile`) and several in the
 * contract: `secret_files` and `cloud_import_excludes` in layout.json, and the
 * agent and root gitignore templates. Every path the desktop calls secret must
 * be ignored by each template on its own and kept home by the layout; every
 * path it leaves alone must stay tracked.
 */
describe('the secret-file rule agrees with the bundled contract', () => {
  const secret = [
    'credentials.json',
    'credentials/credentials.json',
    'scripts/credentials.json',
    '.env',
    'credentials/.env',
    '.env.local',
    '.env.production',
    'config/.env.staging',
    'vendor.env',
    'config/vendor.env',
    'config/service-account.pem',
    'tls.key',
    'certs/client.p12'
  ]
  const notSecret = [
    'credentials/.env.example',
    '.env.example',
    '.env.sample',
    'config/.env.template',
    'vendor.env.example',
    'credentials/README.md',
    'docs/environment.md'
  ]
  const layout = createLayoutView(parseLayout(JSON.parse(readFileSync(join(bundle, 'layout.json'), 'utf8'))))

  function workshopWith(template: 'agent' | 'root'): { root: string; agentDir: string } {
    const root = mkdtempSync(join(tmpdir(), 'cinna-secret-parity-'))
    const agentDir = join(root, 'Local', 'probe')
    mkdirSync(join(agentDir, 'credentials'), { recursive: true })
    if (template === 'agent') {
      copyFileSync(join(bundle, 'templates/agent/gitignore'), join(agentDir, '.gitignore'))
      copyFileSync(join(bundle, 'templates/agent/credentials/.gitignore'), join(agentDir, 'credentials/.gitignore'))
    } else {
      copyFileSync(join(bundle, 'templates/root/gitignore'), join(root, '.gitignore'))
    }
    return { root, agentDir }
  }

  it('calls exactly the expected paths secret', () => {
    expect(secret.filter((rel) => !isSecretFile(rel, layout))).toEqual([])
    expect(notSecret.filter((rel) => isSecretFile(rel, layout))).toEqual([])
  })

  it('keeps every secret out of an export and lets the rest travel', () => {
    expect(secret.filter((rel) => !layout.isExcludedFromExport(rel))).toEqual([])
    expect(layout.isExcludedFromExport('.env.example')).toBe(false)
    expect(layout.isExcludedFromExport('config/.env.template')).toBe(false)
  })

  for (const template of ['agent', 'root'] as const) {
    it(`is ignored by the ${template} gitignore template alone`, () => {
      const { root, agentDir } = workshopWith(template)
      try {
        expect(secret.filter((rel) => !isIgnoredPath(agentDir, rel))).toEqual([])
        expect(notSecret.filter((rel) => isIgnoredPath(agentDir, rel))).toEqual([])
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  }
})
