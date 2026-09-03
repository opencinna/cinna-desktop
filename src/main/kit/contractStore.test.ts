import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')

// `contractStore` is the one module in `src/main/kit` that reaches for Electron.
// Standing in for `app` here is what lets the dev-mode path resolution — the one
// a future move of `resources/cinna-kit-contract` would silently break — be
// exercised for real rather than re-derived in the test.
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => repoRoot }
}))
vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import {
  clearContractCache,
  getBundledContractDir,
  getContractVersion,
  getLayoutView,
  getSchema,
  getTemplateRoot,
  readContractFile,
  resolveContract
} from './contractStore'

beforeEach(() => {
  clearContractCache()
})

describe('the bundled contract', () => {
  it('resolves to the tree in resources/, and it is complete', () => {
    const root = getBundledContractDir()
    expect(root).toBe(join(repoRoot, 'resources/cinna-kit-contract'))

    // Named explicitly so moving or renaming any of them fails here first.
    for (const rel of [
      'kit.json',
      'VERSION',
      'CHANGELOG.md',
      'layout.json',
      'schema/cinna-agent.schema.json',
      'templates/root/AGENTS.md',
      'templates/root/gitignore',
      'templates/agent/cinna-agent.json',
      'templates/agent/Makefile',
      'templates/agent/gitignore',
      'templates/agent/docs/WORKFLOW_PROMPT.md',
      'templates/agent/docs/CLI_COMMANDS.yaml',
      'templates/agent/scripts/cinna_credentials.py',
      'templates/agent/scripts/update_status.py',
      'templates/agent/credentials/.gitignore',
      'templates/agent/app-data/cache/gitignore'
    ]) {
      expect(readContractFile(rel).length, rel).toBeGreaterThan(0)
    }
  })

  it('reports its version, schema, layout and template roots', () => {
    expect(getContractVersion()).toMatch(/^\d+\.\d+\.\d+$/)
    expect((getSchema() as { title: string }).title).toBe('cinna-agent.json')
    expect(getLayoutView().layout.agent.manifest).toBe('cinna-agent.json')
    expect(getTemplateRoot('agent')).toBe(join(repoRoot, 'resources/cinna-kit-contract/templates/agent'))
    expect(getTemplateRoot('root')).toBe(join(repoRoot, 'resources/cinna-kit-contract/templates/root'))
    expect(resolveContract().source).toBe('bundled')
  })

  it('refuses to read outside the contract tree', () => {
    for (const escape of ['../../package.json', '/etc/passwd', 'templates/../../package.json']) {
      expect(() => readContractFile(escape), escape).toThrowError(
        expect.objectContaining({ code: 'invalid_path' })
      )
    }
  })

  it('fails typed on a file that is not in the contract', () => {
    expect(() => readContractFile('schema/nope.json')).toThrowError(
      expect.objectContaining({ code: 'contract_unreadable' })
    )
  })
})

describe('a workshop with its own .cinna-kit/', () => {
  let workshop: string

  function installWorkshopContract(version: string): void {
    const target = join(workshop, '.cinna-kit')
    cpSync(getBundledContractDir(), target, { recursive: true })
    writeFileSync(join(target, 'kit.json'), JSON.stringify({ contract_version: version }, null, 2))
    writeFileSync(join(target, 'VERSION'), `${version}\n`)
  }

  beforeEach(() => {
    workshop = mkdtempSync(join(tmpdir(), 'cinna-workshop-'))
    mkdirSync(join(workshop, 'Local'), { recursive: true })
  })

  afterEach(() => {
    rmSync(workshop, { recursive: true, force: true })
  })

  it('falls back to the bundled copy when the workshop has none', () => {
    expect(resolveContract(workshop).source).toBe('bundled')
  })

  it('prefers a newer copy of the same major', () => {
    installWorkshopContract('1.9.0')
    const contract = resolveContract(workshop)
    expect(contract.source).toBe('workshop')
    expect(contract.version).toBe('1.9.0')
    expect(contract.root).toBe(join(workshop, '.cinna-kit'))
  })

  it('ignores an older copy', () => {
    installWorkshopContract('0.9.0')
    expect(resolveContract(workshop).source).toBe('bundled')
  })

  it('never adopts a newer major — that is what the version gate is for', () => {
    installWorkshopContract('2.0.0')
    expect(resolveContract(workshop).source).toBe('bundled')
  })

  it('ignores a .cinna-kit/ that is not a contract tree', () => {
    mkdirSync(join(workshop, '.cinna-kit/guides'), { recursive: true })
    writeFileSync(join(workshop, '.cinna-kit/VERSION'), '9.9.9\n')
    expect(resolveContract(workshop).source).toBe('bundled')
  })
})
