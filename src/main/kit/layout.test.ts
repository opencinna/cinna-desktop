import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

vi.mock('../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { createLayoutView, matchesPattern, parseLayout } from './layout'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const raw = JSON.parse(
  readFileSync(join(repoRoot, 'resources/cinna-kit-contract/layout.json'), 'utf8')
)
const layout = createLayoutView(parseLayout(raw))

describe('parseLayout', () => {
  it('reads the shipped contract', () => {
    expect(layout.layout.workshop.agents_dir).toBe('Local')
    expect(layout.layout.agent.manifest).toBe('cinna-agent.json')
    expect(layout.layout.agent.prompt_files.workflow).toBe('docs/WORKFLOW_PROMPT.md')
    expect(layout.desktopOwned()).toEqual(['app-data/desktop.json'])
  })

  it('degrades to an empty layout rather than throwing on nonsense', () => {
    expect(parseLayout(null).cloud_import_excludes).toEqual([])
    expect(parseLayout({ agent: 'not an object' }).agent.manifest).toBe('cinna-agent.json')
  })
})

describe('matchesPattern', () => {
  it('anchors a plain pattern at the root', () => {
    expect(matchesPattern('README.md', 'README.md')).toBe(true)
    expect(matchesPattern('README.md', 'docs/README.md')).toBe(false)
  })

  it('takes a trailing slash as "this directory and everything under it"', () => {
    expect(matchesPattern('app-data/', 'app-data')).toBe(true)
    expect(matchesPattern('app-data/', 'app-data/storage/STATUS.md')).toBe(true)
    expect(matchesPattern('app-data/', 'app-database/x')).toBe(false)
  })

  it('matches across segments only with a double star', () => {
    expect(matchesPattern('**/.env', 'credentials/.env')).toBe(true)
    expect(matchesPattern('**/.env', '.env')).toBe(true)
    expect(matchesPattern('*.pyc', 'scripts/a.pyc')).toBe(false)
    expect(matchesPattern('**/*.pyc', 'scripts/deep/a.pyc')).toBe(true)
  })
})

describe('roles', () => {
  it('names the role of a path, most specific first', () => {
    expect(layout.roleFor('app-data/cache/x.json')?.role).toBe('runtime_cache')
    expect(layout.roleFor('app-data/other/x.json')?.role).toBe('runtime_data')
    expect(layout.roleFor('docs/WORKFLOW_PROMPT.md')?.role).toBe('prompts_and_commands')
    expect(layout.roleFor('nowhere/at/all')).toBeNull()
  })

  it('lets a refresh replace only the kit', () => {
    expect(layout.survivesUpdate('.cinna-kit')).toBe(false)
    expect(layout.survivesUpdate('.cinna-kit/schema/cinna-agent.schema.json')).toBe(false)
    expect(layout.survivesUpdate('Local/invoice-watcher')).toBe(true)
    expect(layout.survivesUpdate('AGENTS.md')).toBe(true)
    // Something the contract does not claim is never touched.
    expect(layout.survivesUpdate('notes-to-self.md')).toBe(true)
  })
})

describe('localizeCommand', () => {
  it('runs a cloud-first python command through uv when the agent has a pyproject', () => {
    expect(layout.localizeCommand('python scripts/update_status.py', { hasPyproject: true })).toBe(
      'uv run scripts/update_status.py'
    )
    expect(layout.localizeCommand('python3 scripts/x.py --since 7d', { hasPyproject: true })).toBe(
      'uv run scripts/x.py --since 7d'
    )
  })

  it('leaves the command alone when the condition does not hold', () => {
    expect(layout.localizeCommand('python scripts/update_status.py', { hasPyproject: false })).toBe(
      'python scripts/update_status.py'
    )
  })

  it('leaves a command no rule matches alone', () => {
    expect(layout.localizeCommand('make status', { hasPyproject: true })).toBe('make status')
    expect(layout.localizeCommand('  node tools/x.js  ', { hasPyproject: true })).toBe('node tools/x.js')
  })
})
