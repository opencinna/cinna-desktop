import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import {
  createToolchain,
  MUTAGEN_ASSETS,
  mutagenAssetUrl,
  parseVersion,
  PINNED_UV_VERSION,
  UV_ASSETS,
  uvAssetUrl,
  type ToolchainDeps,
  type ToolchainPins
} from './toolchain'

/**
 * The managed local-dev toolchain.
 *
 * Two things carry this file. The first is the **pin tables**: a digest that is
 * not 64 hex characters, or a URL that does not point at the release it claims
 * to, is a failure nobody sees until a user's install dies — and the tables are
 * hand-maintained, so the test is the only thing standing between a typo and a
 * broken release. The second is **what happens on disk when something is
 * wrong**: an unknown Mutagen version, a substituted asset, a platform with no
 * build. Each of those must leave the toolchain root exactly as it found it,
 * because the reconciler treats a present directory as a finished install.
 *
 * Everything below runs without Electron and without a network: the deps are
 * injected precisely so the *failures* — the interesting half — are reproducible.
 */

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent' } }))
vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

const BYTES = 'pretend this is a release tarball'
const SHA = createHash('sha256').update(BYTES).digest('hex')

const PINS: ToolchainPins = { cinnaCliVersion: '0.4.0', mutagenVersion: '9.9.9' }

let root: string
let downloads: string[]
let runs: { bin: string; args: string[]; env: NodeJS.ProcessEnv }[]
/** What the fake `cinna --version` reports; null means "not installed". */
let installedCli: string | null
/** What an `--editable` install of the fake checkout reports. */
const editableCliVersion = '0.9.9-dev'

function deps(overrides: Partial<ToolchainDeps> = {}): ToolchainDeps {
  return {
    root: () => root,
    platformKey: () => 'test-arch',
    // No local checkout by default: the override is the integration run's, and
    // every other case here is the ordinary pinned-release path.
    cliSourceOverride: () => null,
    uvVersion: '1.2.3',
    uvAssets: { 'test-arch': { file: 'uv.tar.gz', sha256: SHA } },
    mutagenAssets: { '9.9.9': { 'test-arch': { file: 'mutagen.tar.gz', sha256: SHA } } },
    download: async (_url, dest) => {
      downloads.push(dest)
      writeFileSync(dest, BYTES)
    },
    extract: async (archive, dest) => {
      // uv nests under `uv-<target>/`; mutagen is flat and ships a sidecar.
      if (archive.includes('uv')) {
        mkdirSync(join(dest, 'uv-test-arch'))
        writeFileSync(join(dest, 'uv-test-arch', 'uv'), '#!/bin/sh\n')
        writeFileSync(join(dest, 'uv-test-arch', 'uvx'), '#!/bin/sh\n')
      } else {
        writeFileSync(join(dest, 'mutagen'), '#!/bin/sh\n')
        writeFileSync(join(dest, 'mutagen-agents.tar.gz'), 'sidecar')
      }
    },
    shellEnv: async () => ({ PATH: '/usr/local/bin:/usr/bin', HOME: '/home/tester' }),
    run: async (bin, args, env) => {
      runs.push({ bin, args: [...args], env })
      if (args[0] === '--version') {
        return installedCli === null
          ? { code: 1, stdout: '', stderr: 'not found' }
          : { code: 0, stdout: `cinna, version ${installedCli}\n`, stderr: '' }
      }
      // `uv tool install …` — drop the shim where uv would, and report the
      // version uv would end up with: the pin for a release, and whatever the
      // working tree says for `--editable`, which is the whole reason an
      // editable install cannot be skipped on a version match.
      mkdirSync(join(root, 'bin'), { recursive: true })
      writeFileSync(join(root, 'bin', 'cinna'), '#!/bin/sh\n')
      installedCli = args.includes('--editable')
        ? editableCliVersion
        : (/cinna-cli==(.+)$/.exec(args[args.length - 1] ?? '')?.[1] ?? null)
      return { code: 0, stdout: '', stderr: '' }
    },
    ...overrides
  }
}

/** Everything in the toolchain root, staging included. */
function everything(): string[] {
  return existsSync(root) ? readdirSync(root).sort() : []
}

/** The `uv tool install` invocations, ignoring `--version` probes. */
function installRuns(): { bin: string; args: string[]; env: NodeJS.ProcessEnv }[] {
  return runs.filter((r) => r.args[0] === 'tool')
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cinna-localdev-'))
  downloads = []
  runs = []
  installedCli = null
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('the pin tables', () => {
  it('carries a 64-hex digest and a plausible file name for every uv platform', () => {
    const keys = Object.keys(UV_ASSETS)
    expect(keys).toContain('darwin-arm64')
    expect(keys).toContain('darwin-x64')
    expect(keys).toContain('linux-x64')
    for (const [key, asset] of Object.entries(UV_ASSETS)) {
      expect(asset.sha256, key).toMatch(/^[0-9a-f]{64}$/)
      expect(asset.file, key).toMatch(/^uv-[\w-]+\.(tar\.gz|zip)$/)
    }
  })

  it('builds a well-formed uv release URL for every listed platform', () => {
    expect(PINNED_UV_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
    for (const [key, asset] of Object.entries(UV_ASSETS)) {
      const url = uvAssetUrl(PINNED_UV_VERSION, asset.file)
      expect(url, key).toBe(
        `https://github.com/astral-sh/uv/releases/download/${PINNED_UV_VERSION}/${asset.file}`
      )
    }
  })

  it('carries a full platform row, with digests, for every Mutagen version it knows', () => {
    const versions = Object.keys(MUTAGEN_ASSETS)
    expect(versions.length).toBeGreaterThanOrEqual(1)
    for (const version of versions) {
      expect(version, 'a table key is a bare version, never a v-prefixed tag').toMatch(
        /^\d+\.\d+\.\d+$/
      )
      const row = MUTAGEN_ASSETS[version]
      // A version with a partial row is worse than an absent one: it promises
      // support the platform will not get, and only on that platform.
      expect(Object.keys(row).sort()).toEqual(
        ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'].sort()
      )
      for (const [key, asset] of Object.entries(row)) {
        expect(asset.sha256, `${version}/${key}`).toMatch(/^[0-9a-f]{64}$/)
        // The file name embeds the version; a copy-pasted row that kept the old
        // one would download the wrong release and fail the digest — loudly,
        // but only for the user, not here.
        expect(asset.file, `${version}/${key}`).toContain(`_v${version}.tar.gz`)
        expect(mutagenAssetUrl(version, asset.file)).toBe(
          `https://github.com/mutagen-io/mutagen/releases/download/v${version}/${asset.file}`
        )
      }
    }
  })

  it('uses no digest twice, which is what a copy-pasted row looks like', () => {
    const all = [
      ...Object.values(UV_ASSETS).map((a) => a.sha256),
      ...Object.values(MUTAGEN_ASSETS).flatMap((row) => Object.values(row).map((a) => a.sha256))
    ]
    expect(new Set(all).size).toBe(all.length)
  })
})

describe('paths and the spawn environment', () => {
  it('puts every managed directory under the root and nowhere else', () => {
    const tc = createToolchain(deps())
    const paths = tc.paths(PINS)
    expect(paths).toEqual({
      root,
      binDir: join(root, 'bin'),
      mutagenDir: join(root, 'mutagen-9.9.9'),
      uvBin: join(root, 'uv-1.2.3', 'uv'),
      cinnaBin: join(root, 'bin', 'cinna')
    })
  })

  it('leads PATH with the toolchain and appends the login-shell PATH last', async () => {
    const env = await createToolchain(deps()).toolchainEnv(PINS)
    expect(env.PATH).toBe(
      [join(root, 'bin'), join(root, 'mutagen-9.9.9'), '/usr/local/bin:/usr/bin'].join(delimiter)
    )
    // The order is the whole point: cinna-cli must find *our* mutagen, so its
    // "install Mutagen with brew?" prompt never appears in a desktop-spawned
    // run — while the user's own git and ssh still resolve.
    const entries = env.PATH!.split(delimiter)
    expect(entries.indexOf(join(root, 'mutagen-9.9.9'))).toBeLessThan(
      entries.indexOf('/usr/local/bin')
    )
  })

  it('points every UV_* variable inside the root', async () => {
    const env = await createToolchain(deps()).toolchainEnv(PINS)
    expect(env.UV_TOOL_DIR).toBe(join(root, 'uv-tools'))
    expect(env.UV_TOOL_BIN_DIR).toBe(join(root, 'bin'))
    expect(env.UV_PYTHON_INSTALL_DIR).toBe(join(root, 'python'))
    expect(env.UV_CACHE_DIR).toBe(join(root, 'uv-cache'))
    for (const [name, value] of Object.entries(env)) {
      if (!name.startsWith('UV_')) continue
      expect(value!.startsWith(root), `${name} escapes the toolchain root`).toBe(true)
    }
  })

  it('keeps the rest of the login-shell environment', async () => {
    const env = await createToolchain(deps()).toolchainEnv(PINS)
    // cinna-cli spawned by the desktop should behave as it does in the user's
    // own terminal — starting with knowing where HOME is.
    expect(env.HOME).toBe('/home/tester')
  })
})

describe('ensure', () => {
  it('installs uv, Mutagen and cinna-cli, and reports each step', async () => {
    const steps: string[] = []
    const result = await createToolchain(deps()).ensure(PINS, ({ step }) => steps.push(step))

    expect(steps).toEqual([
      'Installing uv',
      'Installing Mutagen',
      'Installing cinna-cli',
      'Toolchain ready'
    ])
    expect(result.cliVersion).toBe('0.4.0')
    expect(everything().sort()).toEqual(
      ['bin', 'mutagen-9.9.9', 'state.json', 'uv-1.2.3'].sort()
    )
    // Mutagen refuses to run without its agent bundle beside the binary.
    expect(readdirSync(join(root, 'mutagen-9.9.9')).sort()).toEqual([
      'mutagen',
      'mutagen-agents.tar.gz'
    ])
    expect(existsSync(join(root, 'uv-1.2.3', 'uv'))).toBe(true)
    // uv is run through the toolchain env, or it would install into ~/.local.
    expect(installRuns()[0]?.env.UV_TOOL_BIN_DIR).toBe(join(root, 'bin'))
    expect(installRuns()[0]?.args).toEqual(['tool', 'install', 'cinna-cli==0.4.0'])
  })

  it('is a cheap no-op the second time, and says so instead of saying nothing', async () => {
    const tc = createToolchain(deps())
    await tc.ensure(PINS)
    downloads = []
    runs = []
    const reports: { step: string; percent?: number }[] = []
    const result = await tc.ensure(PINS, ({ step, percent }) => reports.push({ step, percent }))
    expect(result.cliVersion).toBe('0.4.0')
    expect(downloads).toEqual([])
    // Not even a `--version` probe: the recorded state answers it.
    expect(runs).toEqual([])
    // A stage that is already satisfied still reports its *end* percentage. It
    // used to report nothing, which left a warm run's bar at zero for its whole
    // (very short) life — the one shape guaranteed to look stuck.
    expect(reports.map((r) => r.percent)).toEqual([20, 55, 100])
  })

  it('never moves the bar backwards, whatever the mix of work and skips', async () => {
    // The invariant a user actually perceives. Percentages come from three
    // stages plus a byte counter inside two of them, and a bar that jumps back
    // reads as a restart — worse than no bar.
    const tc = createToolchain(deps())
    const percents: number[] = []
    await tc.ensure(PINS, ({ percent }) => {
      if (percent !== undefined) percents.push(percent)
    })
    expect(percents.length).toBeGreaterThan(0)
    expect([...percents].sort((a, b) => a - b)).toEqual(percents)
    expect(percents.at(-1)).toBe(100)
    expect(Math.min(...percents)).toBeGreaterThanOrEqual(0)
  })

  it('turns a download into a labelled percentage inside its stage', async () => {
    // uv's stage is 0..20, and the download is capped at 90% of it so verify
    // and unpack still have somewhere to land.
    const reports: { step: string; percent?: number }[] = []
    await createToolchain(
      deps({
        download: async (_url, dest, onProgress) => {
          downloads.push(dest)
          onProgress?.(5_000_000, 10_000_000)
          writeFileSync(dest, BYTES)
        }
      })
    ).ensure(PINS, ({ step, percent }) => reports.push({ step, percent }))

    const halfway = reports.find((r) => r.step.startsWith('Downloading uv'))
    expect(halfway?.step).toBe('Downloading uv — 5.0 of 10.0 MB')
    expect(halfway?.percent).toBe(9)
  })

  it('counts up honestly when the server declares no length', async () => {
    const reports: string[] = []
    await createToolchain(
      deps({
        download: async (_url, dest, onProgress) => {
          downloads.push(dest)
          // A chunked response has no content-length, and a bar filled from an
          // invented denominator is worse than a number that only counts up.
          onProgress?.(3_500_000, null)
          writeFileSync(dest, BYTES)
        }
      })
    ).ensure(PINS, ({ step }) => reports.push(step))

    expect(reports).toContain('Downloading uv — 3.5 MB')
  })

  it('de-duplicates concurrent callers into one install', async () => {
    const tc = createToolchain(deps())
    await Promise.all([tc.ensure(PINS), tc.ensure(PINS), tc.ensure(PINS)])
    expect(downloads).toHaveLength(2) // uv and mutagen, once each
    expect(installRuns()).toHaveLength(1)
  })

  it('reinstalls cinna-cli when the pinned version changes, and nothing else', async () => {
    const tc = createToolchain(deps())
    await tc.ensure(PINS)
    downloads = []
    const result = await tc.ensure({ ...PINS, cinnaCliVersion: '0.5.0' })
    expect(result.cliVersion).toBe('0.5.0')
    expect(installRuns().map((r) => r.args[2])).toEqual(['cinna-cli==0.4.0', 'cinna-cli==0.5.0'])
    // uv and Mutagen are unchanged pins, so nothing is downloaded again.
    expect(downloads).toEqual([])
  })

  it('adopts a cinna-cli that already reports the pinned version', async () => {
    // A `cinna` left by an older build of the app, or by a run that died before
    // it could write the stamp. Reinstalling it would be minutes for nothing.
    const tc = createToolchain(deps())
    mkdirSync(join(root, 'bin'), { recursive: true })
    writeFileSync(join(root, 'bin', 'cinna'), '#!/bin/sh\n')
    installedCli = '0.4.0'
    const result = await tc.ensure(PINS)
    expect(result.cliVersion).toBe('0.4.0')
    expect(installRuns()).toEqual([])
  })

  it('sweeps staging leftovers from a killed run', async () => {
    mkdirSync(join(root, '.staging-1-2', 'unpacked'), { recursive: true })
    await createToolchain(deps()).ensure(PINS)
    expect(everything().some((name) => name.startsWith('.staging-'))).toBe(false)
  })
})

describe('ensure — failures leave the root untouched', () => {
  it('refuses a Mutagen version it has no digest for, before downloading anything', async () => {
    // The deliberate trade: a server ahead of the desktop yields "update Cinna
    // Desktop", never an unverified download. And it costs nothing — the check
    // happens before uv is fetched, not after.
    await expect(
      createToolchain(deps()).ensure({ ...PINS, mutagenVersion: '0.99.0' })
    ).rejects.toMatchObject({ code: 'unknown_mutagen_version' })
    expect(downloads).toEqual([])
    expect(runs).toEqual([])
    expect(everything()).toEqual([])
  })

  it('explains a platform with no verified build rather than crashing', async () => {
    await expect(
      createToolchain(deps({ platformKey: () => 'sunos-sparc' })).ensure(PINS)
    ).rejects.toMatchObject({ code: 'unsupported_platform' })
    expect(downloads).toEqual([])
    expect(everything()).toEqual([])
  })

  it('publishes nothing when a download does not match its digest', async () => {
    const tc = createToolchain(
      deps({
        download: async (_url, dest) => {
          downloads.push(dest)
          writeFileSync(dest, 'substituted bytes')
        }
      })
    )
    await expect(tc.ensure(PINS)).rejects.toMatchObject({ code: 'checksum_mismatch' })
    // Not merely that it threw: nothing on disk that a later run — which trusts
    // a present directory absolutely — could take for a finished install.
    expect(everything()).toEqual([])
  })

  it('reports a failing uv tool install with the tail of its output', async () => {
    const tc = createToolchain(
      deps({
        run: async (_bin, args) => {
          if (args[0] === '--version') return { code: 1, stdout: '', stderr: '' }
          return { code: 2, stdout: '', stderr: 'No solution found for cinna-cli==0.4.0' }
        }
      })
    )
    await expect(tc.ensure(PINS)).rejects.toMatchObject({
      code: 'install_failed',
      detail: expect.stringContaining('No solution found')
    })
  })

  it('refuses an install whose cinna will not run', async () => {
    const tc = createToolchain(
      deps({
        run: async (_bin, args) => {
          if (args[0] === '--version') return { code: 127, stdout: '', stderr: '' }
          mkdirSync(join(root, 'bin'), { recursive: true })
          writeFileSync(join(root, 'bin', 'cinna'), 'broken')
          return { code: 0, stdout: '', stderr: '' }
        }
      })
    )
    await expect(tc.ensure(PINS)).rejects.toMatchObject({ code: 'install_failed' })
    // And it is not recorded, so the next reconcile tries again instead of
    // trusting a stamp for something that does not work.
    expect(existsSync(join(root, 'state.json'))).toBe(false)
  })
})

describe('repair', () => {
  it('reinstalls everything, keeping the uv cache and the downloaded Python', async () => {
    const tc = createToolchain(deps())
    await tc.ensure(PINS)
    mkdirSync(join(root, 'uv-cache'), { recursive: true })
    mkdirSync(join(root, 'python'), { recursive: true })
    downloads = []
    runs = []

    await tc.repair(PINS)
    expect(downloads).toHaveLength(2)
    expect(installRuns()[0]?.args).toEqual([
      'tool',
      'install',
      '--reinstall',
      'cinna-cli==0.4.0'
    ])
    // A repair that re-downloaded a hundred megabytes of CPython would be a
    // repair nobody waits for.
    expect(existsSync(join(root, 'uv-cache'))).toBe(true)
    expect(existsSync(join(root, 'python'))).toBe(true)
  })
})

describe('parseVersion', () => {
  it('pulls the version out of whatever shape the CLI prints', () => {
    expect(parseVersion('cinna, version 0.4.0')).toBe('0.4.0')
    expect(parseVersion('0.4.0\n')).toBe('0.4.0')
    expect(parseVersion('cinna 1.2.3-rc.1')).toBe('1.2.3-rc.1')
    expect(parseVersion('')).toBeNull()
  })
})

describe('a local cinna-cli checkout', () => {
  /**
   * The cross-repo integration run has to exercise the cinna-cli being
   * developed beside this app, which by definition is not on PyPI. These are
   * the two properties that make that safe rather than merely possible: the pin
   * is visibly abandoned, and the result is never remembered.
   */
  it('installs the checkout editable instead of the pinned release', async () => {
    const tc = createToolchain(deps({ cliSourceOverride: () => '/src/cinna-cli' }))
    const result = await tc.ensure(PINS)

    const install = runs.find((r) => r.args[0] === 'tool')
    expect(install?.args).toEqual([
      'tool',
      'install',
      '--reinstall',
      '--editable',
      '/src/cinna-cli'
    ])
    // Nothing mentions the pinned version: the override replaces it rather
    // than adding to it, which is what makes the log warning honest.
    expect(install?.args.join(' ')).not.toContain(PINS.cinnaCliVersion)
    expect(result.cliVersion).toBe(editableCliVersion)
  })

  it('reinstalls on every pass, because a working tree changes underneath', async () => {
    const tc = createToolchain(deps({ cliSourceOverride: () => '/src/cinna-cli' }))
    await tc.ensure(PINS)
    const first = runs.filter((r) => r.args[0] === 'tool').length
    await tc.ensure(PINS)
    const second = runs.filter((r) => r.args[0] === 'tool').length
    // The stamp would have skipped the second one on the pinned path; here it
    // must not, or a run would silently be testing yesterday's checkout.
    expect(second).toBeGreaterThan(first)
  })
})
