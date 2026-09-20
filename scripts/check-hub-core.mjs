import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scratch = mkdtempSync(join(tmpdir(), 'cinna-hub-spike-'))
// Keep package resolution beside the repository's dependencies, never copy or rebuild its Electron addon.
const outputRoot = join(repo, 'out')
mkdirSync(outputRoot, { recursive: true })
const output = mkdtempSync(join(outputRoot, 'hub-spike-'))
try {
  const outfile = join(output, 'spike.mjs')
  const result = await build({ entryPoints: [join(repo, 'scripts/hub/spike.ts')], bundle: true, platform: 'node',
    format: 'esm', packages: 'external', outfile, metafile: true })
  const bad = Object.keys(result.metafile.inputs).filter(path => /src\/main\/(?:host\/desktop\/|ipc\/|window\/|index\.ts$|localdev\/(?:localDevService|developmentSessionService))/.test(path))
  if (bad.length) throw new Error(`Desktop modules reached by hub:\n${bad.join('\n')}`)
  const imports = Object.values(result.metafile.outputs).flatMap(value => value.imports)
  if (imports.some(value => /^(electron|electron-updater|@electron-toolkit\/)/.test(value.path))) throw new Error('Electron reached by hub bundle')
  const child = spawnSync(process.execPath, [outfile, join(scratch, 'data'), repo], {
    cwd: scratch, encoding: 'utf8', timeout: 45_000,
    env: { HOME: scratch, PATH: '/usr/bin:/bin', SHELL: '/bin/bash', TMPDIR: scratch }
  })
  process.stdout.write(child.stdout ?? '')
  process.stderr.write(child.stderr ?? '')
  if (child.error) throw child.error
  if (child.status !== 0) throw new Error(`Hub spike exited ${child.status}`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
  rmSync(output, { recursive: true, force: true })
}
