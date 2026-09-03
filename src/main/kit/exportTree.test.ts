import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { createLayoutView, parseLayout } from './layout'
import { buildExportTree } from './exportTree'

/** The real contract, not a fixture — the exclude list is what is under test. */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const layout = createLayoutView(
  parseLayout(
    JSON.parse(readFileSync(join(repoRoot, 'resources/cinna-kit-contract/layout.json'), 'utf8'))
  )
)

let dir: string

function write(rel: string, contents: string): void {
  const abs = join(dir, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, contents)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cinna-export-'))
  write('cinna-agent.json', '{}\n')
  write('docs/WORKFLOW_PROMPT.md', '# workflow\n')
  write('docs/README.md', 'notes\n')
  write('scripts/README.md', 'catalog\n')
  write('scripts/update_status.py', 'print(1)\n')
  write('knowledge/rules.md', 'rules\n')
  write('credentials/README.md', 'docs\n')
  write('credentials/.env.example', 'TOKEN=\n')
  // None of these may travel.
  write('credentials/.env', 'VENDOR_TOKEN=super-secret\n')
  // What the platform injects at the agent root in the cloud: slot -> field -> VALUE.
  write('credentials.json', '{"Vendor Portal":{"token":"live-secret"}}\n')
  write('config/service-account.pem', '-----BEGIN PRIVATE KEY-----\n')
  write('config/id_rsa.key', 'private\n')
  write('certs/client.p12', 'binary')
  // An orphan from a manifest write that was killed between open and rename.
  write('.cinna-agent.json.4242.1756845000000.tmp', '{ "half": ')
  write('app-data/storage/STATUS.md', '---\nstatus: ok\n---\n')
  write('app-data/desktop.json', '{"agentToken":"secret"}\n')
  write('AGENTS.md', 'wrapper\n')
  write('CLAUDE.md', 'wrapper\n')
  write('README.md', 'wrapper\n')
  write('Makefile', 'status:\n')
  write('.gitignore', 'app-data/\n')
  write('.git/config', '[core]\n')
  write('scripts/__pycache__/update_status.cpython-311.pyc', 'bytes')
  write('.DS_Store', 'junk')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('exportTree', () => {
  it('applies the contract exclude list', () => {
    const { files } = buildExportTree(dir, layout)

    expect(files).toEqual([
      'cinna-agent.json',
      'credentials/.env.example',
      'credentials/README.md',
      'docs/README.md',
      'docs/WORKFLOW_PROMPT.md',
      'knowledge/rules.md',
      'scripts/README.md',
      'scripts/update_status.py'
    ])
  })

  it('never lets a secret or desktop state travel', () => {
    const { files } = buildExportTree(dir, layout)
    for (const excluded of [
      'credentials/.env',
      'credentials.json',
      'config/service-account.pem',
      'config/id_rsa.key',
      'certs/client.p12',
      '.cinna-agent.json.4242.1756845000000.tmp',
      'app-data/desktop.json',
      'app-data/storage/STATUS.md',
      '.git/config',
      '.gitignore',
      '.DS_Store',
      'AGENTS.md',
      'CLAUDE.md',
      'README.md',
      'Makefile'
    ]) {
      expect(files).not.toContain(excluded)
    }
  })

  it('excludes a root credentials.json wherever it sits', () => {
    write('scripts/credentials.json', '{"Vendor Portal":{"token":"live-secret"}}\n')
    const { files } = buildExportTree(dir, layout)
    expect(files).not.toContain('credentials.json')
    expect(files).not.toContain('scripts/credentials.json')
    // The documentation of the slots still travels — it carries no value.
    expect(files).toContain('credentials/README.md')
    expect(files).toContain('credentials/.env.example')
  })

  it('keeps a nested README that is not the wrapper', () => {
    const { files } = buildExportTree(dir, layout)
    expect(files).toContain('docs/README.md')
    expect(files).toContain('scripts/README.md')
  })

  it('reports the size of what travels', () => {
    const { totalBytes } = buildExportTree(dir, layout)
    expect(totalBytes).toBeGreaterThan(0)
  })

  it('hashes stably across runs and changes with content', () => {
    const first = buildExportTree(dir, layout).contentHash
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(buildExportTree(dir, layout).contentHash).toBe(first)

    // Touching an excluded file cannot move the hash.
    write('app-data/storage/STATUS.md', '---\nstatus: attention\n---\n')
    expect(buildExportTree(dir, layout).contentHash).toBe(first)

    // Changing content that travels must.
    write('docs/WORKFLOW_PROMPT.md', '# workflow, revised\n')
    const second = buildExportTree(dir, layout).contentHash
    expect(second).not.toBe(first)

    // And so must adding a file, or renaming one without changing its bytes.
    write('knowledge/more.md', 'more\n')
    expect(buildExportTree(dir, layout).contentHash).not.toBe(second)
  })

  it('reports a file it could not read instead of hiding it in the hash', () => {
    const secret = join(dir, 'knowledge/locked.md')
    writeFileSync(secret, 'readable for now\n')
    const before = buildExportTree(dir, layout)
    expect(before.unreadable).toEqual([])

    chmodSync(secret, 0o000)
    try {
      const after = buildExportTree(dir, layout)
      // The file is still part of the tree, and the hash still computes...
      expect(after.files).toContain('knowledge/locked.md')
      expect(after.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/)
      // ...but the caller is told the digest does not describe the bytes, so a
      // publish can refuse rather than record a hash that means nothing.
      expect(after.unreadable).toEqual(['knowledge/locked.md'])
      expect(after.contentHash).not.toBe(before.contentHash)
    } finally {
      chmodSync(secret, 0o600)
    }
  })

  it('fails typed on a folder that is not there', () => {
    expect(() => buildExportTree(join(dir, 'nope'), layout)).toThrowError(
      expect.objectContaining({ code: 'export_failed' })
    )
  })
})
