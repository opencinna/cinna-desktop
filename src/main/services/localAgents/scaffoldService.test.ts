import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync, type Dirent } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The scaffold's output as a whole tree, not one file at a time.
 *
 * The defect this guards against: `pyproject.toml` shipped with
 * `name = "{{SLUG}}"` because only the markdown files were substituted, and
 * every `uv run` under a scaffolded agent then died on a TOML parse error
 * before Python started. A test that reads one known file cannot catch the
 * *next* template that grows a token, so this one sweeps every file.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..')

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => repoRoot,
    getVersion: () => '0.0.0-test',
    on: () => undefined
  }
}))
vi.mock('../../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

const { clearContractCache } = await import('../../kit/contractStore')
const { scaffoldService } = await import('./scaffoldService')

function walk(dir: string, out: string[] = []): string[] {
  const entries: Dirent[] = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.isFile()) out.push(full)
  }
  return out
}

let workshop: string

beforeEach(() => {
  clearContractCache()
  workshop = mkdtempSync(join(tmpdir(), 'cinna-scaffold-'))
  scaffoldService.installRootTemplates(workshop)
})

afterEach(() => {
  rmSync(workshop, { recursive: true, force: true })
})

describe('scaffoldAgent', () => {
  it('leaves no {{TOKEN}} anywhere in the created tree', () => {
    const { agentDir } = scaffoldService.scaffoldAgent({
      rootPath: workshop,
      slug: 'alpha',
      name: 'Alpha',
      description: 'Reads invoices.'
    })
    const leftovers = walk(agentDir)
      .filter((file) => /\{\{[A-Z_]+\}\}/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(agentDir, file))
    expect(leftovers).toEqual([])
  })

  it('writes a pyproject.toml uv can parse, with the slug as the project name', () => {
    const { agentDir } = scaffoldService.scaffoldAgent({
      rootPath: workshop,
      slug: 'alpha',
      name: 'Alpha',
      description: 'Reads invoices.'
    })
    const toml = readFileSync(join(agentDir, 'pyproject.toml'), 'utf8')
    expect(toml).toContain('name = "alpha"')
    expect(toml).toContain('description = "Reads invoices."')
  })

  it('escapes the description for TOML rather than breaking the file', () => {
    const { agentDir } = scaffoldService.scaffoldAgent({
      rootPath: workshop,
      slug: 'alpha',
      name: 'Alpha',
      description: 'Says "hi" and C:\\path\nsecond line'
    })
    const toml = readFileSync(join(agentDir, 'pyproject.toml'), 'utf8')
    expect(toml).toContain('description = "Says \\"hi\\" and C:\\\\path\\nsecond line"')
  })

  it('still copies scripts byte-for-byte', () => {
    const { agentDir } = scaffoldService.scaffoldAgent({
      rootPath: workshop,
      slug: 'alpha',
      name: 'Alpha',
      description: 'Reads invoices.'
    })
    const template = join(repoRoot, 'resources/cinna-kit-contract/templates/agent/scripts/update_status.py')
    expect(readFileSync(join(agentDir, 'scripts/update_status.py'))).toEqual(readFileSync(template))
  })
})
