import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

vi.mock('../../host/runtimeHost', () => ({
  runtimeHost: { isPackaged: false, getAppPath: () => process.cwd(), resourcesPath: '', getPath: () => '/nonexistent' }
}))
vi.mock('../../logger/logger', () => ({ createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }) }))

const { agentDashboardFindings, dashboardsFolderRole, missingCredentials, readComponent, scanComponents } = await import('./componentScanner')
type ComponentAgent = import('./componentScanner').ComponentAgent
type ComponentFinding = import('../../../shared/dashboards').ComponentFinding

let base = ''
let agentDir = ''
let extra: Partial<ComponentAgent> = {}
const agent = (): ComponentAgent => ({ id: 'folder:m1', manifestId: 'm1', name: 'Sales', path: agentDir, ...extra })

function write(rel: string, content: string, root = agentDir): void {
  const file = join(root, rel)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}

const good = {
  schema_version: 1,
  title: 'Open deals',
  view: 'list',
  source: { endpoint: 'deals' },
  endpoints: { deals: { script: 'api/deals.py' } },
  refresh: { max_age: '5m' },
  size: 'l'
}

/** `dashboards/c/` with `doc` and `files`, read back. */
function check(doc: object, files: Record<string, string> = { 'api/deals.py': 'print("{}")' }) {
  rmSync(join(agentDir, 'dashboards', 'c'), { recursive: true, force: true })
  write('dashboards/c/component.json', JSON.stringify(doc))
  for (const [rel, content] of Object.entries(files)) write(`dashboards/c/${rel}`, content)
  const scanned = readComponent(agent(), 'c')!
  return { spec: scanned.spec, info: scanned.info, triples: scanned.info.findings.map((f) => [f.code, f.field, f.severity]) }
}

const triple = (f: ComponentFinding) => [f.path, f.code, f.field]

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'dash-scan-'))
  agentDir = join(base, 'agent')
  mkdirSync(agentDir)
  write('cinna-agent.json', JSON.stringify({ id: 'm1', credentials: [{ name: 'gmail' }, { name: 'stripe' }], schedules: [{ name: 'nightly' }] }))
  extra = {}
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('the dashboards folder', () => {
  it('falls back to dashboards/ while the bundled contract has no dashboards role', () => {
    expect(dashboardsFolderRole()).toBe('dashboards')
  })
})

describe('scanComponents', () => {
  it('lists every component folder, name-sorted, valid or not, with core’s findings', () => {
    write('dashboards/pipeline/component.json', JSON.stringify(good))
    write('dashboards/pipeline/api/deals.py', 'print("{}")')
    write('dashboards/broken/component.json', '{ not json')
    write('dashboards/Bad_Name/component.json', JSON.stringify(good))
    write('dashboards/Bad_Name/api/deals.py', 'x')
    write('dashboards/README.md', '# not a folder')
    mkdirSync(join(agentDir, 'dashboards', '.cache'))
    mkdirSync(join(agentDir, 'dashboards', 'node_modules'))
    const list = scanComponents(agent())
    expect(list.map((c) => c.name)).toEqual(['Bad_Name', 'broken', 'pipeline'])
    expect(list.find((c) => c.name === 'pipeline')).toMatchObject({
      valid: true, title: 'Open deals', view: 'list', size: 'l', maxAge: '5m', agentId: 'folder:m1', manifestId: 'm1', skill: null, findings: [], missingCredentials: []
    })
    expect(list.find((c) => c.name === 'broken')!.findings.map(triple)).toEqual([['dashboards/broken/component.json', 'component_json_invalid', null]])
    expect(list.find((c) => c.name === 'Bad_Name')!.findings.map(triple)).toEqual([['dashboards/Bad_Name', 'component_name_invalid', null]])
    // A plain file in dashboards/ is the agent's warning, not a component.
    expect(agentDashboardFindings(agent()).map((f) => [...triple(f), f.severity])).toEqual([['dashboards/README.md', 'stray_file', null, 'warning']])
  })

  it('returns nothing for an agent with no dashboards folder', () => {
    expect(scanComponents(agent())).toEqual([])
    expect(agentDashboardFindings(agent())).toEqual([])
  })

  it('reports a folder with no component.json', () => {
    mkdirSync(join(agentDir, 'dashboards', 'empty'), { recursive: true })
    expect(scanComponents(agent())).toEqual([
      expect.objectContaining({ name: 'empty', valid: false, findings: [expect.objectContaining({ path: 'dashboards/empty/component.json', code: 'component_json_missing', field: null })] })
    ])
  })

  it('refuses a name outside the component name pattern without touching the disk', () => {
    expect(readComponent(agent(), '../agent')).toBeNull()
    expect(readComponent(agent(), 'a/b')).toBeNull()
  })
})

describe('symlinks (component_symlink, symlink_escape)', () => {
  it('never follows a component folder that is a symlink, inside the dashboards folder or out of it', () => {
    write('dashboards/real/component.json', JSON.stringify({ ...good, view: 'table', source: { file: 'files/x.csv' }, endpoints: undefined }))
    symlinkSync(join(agentDir, 'dashboards', 'real'), join(agentDir, 'dashboards', 'alias'))
    const outside = join(base, 'outside')
    write('component.json', JSON.stringify(good), outside)
    symlinkSync(outside, join(agentDir, 'dashboards', 'escape'))
    const list = scanComponents(agent())
    expect(list.map((c) => [c.name, c.valid])).toEqual([['alias', false], ['escape', false], ['real', true]])
    for (const name of ['alias', 'escape']) {
      const scanned = readComponent(agent(), name)!
      expect(scanned.spec).toBeNull()
      expect(scanned.info.findings.map(triple)).toEqual([[`dashboards/${name}`, 'component_symlink', null]])
    }
  })

  it('refuses a script or entry that leaves the component folder, and a source file that leaves the agent folder', () => {
    write('secret.py', 'x', base)
    write('page.html', '<p>', base)
    write('data.json', '{}', base)
    mkdirSync(join(agentDir, 'app-data'))
    symlinkSync(base, join(agentDir, 'app-data', 'up'))
    const read = (doc: object, link: [string, string]) => {
      rmSync(join(agentDir, 'dashboards', 'c'), { recursive: true, force: true })
      write('dashboards/c/component.json', JSON.stringify(doc))
      write('dashboards/c/api/deals.py', 'x')
      symlinkSync(join(base, link[0]), join(agentDir, 'dashboards', 'c', link[1]))
      return readComponent(agent(), 'c')!
    }
    const script = read({ ...good, endpoints: { deals: { script: 'api/leak.py' } } }, ['secret.py', 'api/leak.py'])
    expect(script.spec).toBeNull()
    expect(script.info.findings.map(triple)).toEqual([['dashboards/c/component.json', 'symlink_escape', 'endpoints.deals.script']])
    const entry = read({ ...good, view: 'html' }, ['page.html', 'index.html'])
    expect(entry.info.findings.map(triple)).toEqual([['dashboards/c/component.json', 'symlink_escape', 'entry']])
    const file = read({ ...good, source: { file: 'app-data/up/data.json' }, endpoints: undefined }, ['page.html', 'x.html'])
    expect(file.info.findings.map(triple)).toEqual([['dashboards/c/component.json', 'symlink_escape', 'source.file']])
  })
})

describe('validation by core’s codes', () => {
  it('accepts a minimal endpoint component and normalizes it', () => {
    const { spec, triples } = check(good)
    expect(triples).toEqual([])
    expect(spec).toMatchObject({ view: 'list', source: { endpoint: 'deals' }, maxAge: '5m', maxAgeMs: 300_000, size: 'l' })
    expect(spec!.endpoints.deals).toEqual({ name: 'deals', script: 'api/deals.py', runtime: 'python', timeoutS: 60 })
  })

  it('picks the runtime from the extension; an unknown or upper-case one is script_extension, not a spawn', () => {
    expect(check({ ...good, endpoints: { deals: { script: 'api/deals.mjs', timeout_s: 30 } } }, { 'api/deals.mjs': 'x' }).spec!.endpoints.deals).toMatchObject({ runtime: 'node', timeoutS: 30 })
    for (const script of ['api/deals.ts', 'api/deals.PY']) {
      const { spec, triples } = check({ ...good, endpoints: { deals: { script } } }, { [script]: 'x' })
      expect(spec).toBeNull()
      expect(triples).toEqual([['script_extension', 'endpoints.deals.script', 'error']])
    }
  })

  it('warns on a script outside api/, and refuses climbs, absolute paths, missing files and timeouts over 300 s', () => {
    const lib = check({ ...good, endpoints: { deals: { script: 'lib/deals.py' } } }, { 'lib/deals.py': 'x' })
    expect(lib.info.valid).toBe(true)
    expect(lib.triples).toEqual([['script_location', 'endpoints.deals.script', 'warning']])
    const cases: Array<[unknown, string, string]> = [
      [{ script: '../x.py' }, 'script_outside_component', 'endpoints.deals.script'],
      [{ script: '/abs/x.py' }, 'script_outside_component', 'endpoints.deals.script'],
      [{ script: 'api\\x.py' }, 'script_outside_component', 'endpoints.deals.script'],
      [{ script: 'api/missing.py' }, 'script_missing', 'endpoints.deals.script'],
      [{ script: 'api/deals.py', timeout_s: 301 }, 'invalid_value', 'endpoints.deals.timeout_s'],
      [{}, 'required', 'endpoints.deals.script']
    ]
    for (const [endpoint, code, field] of cases) {
      const { spec, triples } = check({ ...good, endpoints: { deals: endpoint } })
      expect(spec).toBeNull()
      expect(triples).toEqual([[code, field, 'error']])
    }
  })

  it('takes a file source only as .md, .json or .csv under app-data/ or files/, fitting the view', () => {
    const md = { schema_version: 1, title: 'Notes', view: 'markdown', source: { file: 'app-data/notes.md' } }
    expect(check(md, {}).triples).toEqual([])
    expect(check({ ...md, source: { file: 'notes.md' } }, {}).triples).toEqual([['source_file_location', 'source.file', 'error']])
    expect(check({ ...md, source: { file: 'files/../x.md' } }, {}).triples).toEqual([['source_file_location', 'source.file', 'error']])
    expect(check({ ...md, source: { file: 'app-data/x.MD' } }, {}).triples).toEqual([['source_file_extension', 'source.file', 'error']])
    expect(check({ ...md, view: 'list' }, {}).triples).toEqual([['source_file_view', 'source.file', 'error']])
    expect(check({ ...md, view: 'list', source: { file: 'files/x.csv' } }, {}).triples).toEqual([['source_file_view', 'source.file', 'error']])
    expect(check({ ...md, view: 'list', source: { file: 'app-data/x.json' } }, {}).triples).toEqual([])
    expect(check({ ...md, source: { file: 'app-data/x.md', endpoint: 'x' } }, {}).triples).toEqual([['source_invalid', 'source', 'error']])
  })

  it('names each finding by its field', () => {
    const { spec, triples } = check({
      schema_version: 2, view: 'chart', source: { endpoint: 'nope' }, size: 'xl',
      refresh: { max_age: 'soon', while_open_every: '10s', command: 'run it', after_turn: 'yes' },
      params: { m: { type: 'week' }, s: { type: 'enum' } }, requires_credentials: ['slack']
    }, {})
    expect(spec).toBeNull()
    expect(triples).toEqual(expect.arrayContaining([
      ['invalid_value', 'schema_version', 'error'],
      ['required', 'title', 'error'],
      ['invalid_value', 'view', 'error'],
      ['unknown_endpoint', 'source.endpoint', 'error'],
      ['invalid_value', 'size', 'error'],
      ['duration_invalid', 'refresh.max_age', 'error'],
      ['while_open_every_too_short', 'refresh.while_open_every', 'error'],
      ['refresh_command_invalid', 'refresh.command', 'error'],
      ['invalid_type', 'refresh.after_turn', 'error'],
      ['invalid_value', 'params.m.type', 'error'],
      ['invalid_value', 'params.s.values', 'error'],
      ['credential_unknown', 'requires_credentials', 'error']
    ]))
  })

  it('warns on an entry for a view other than html, and on a refresh command or schedule the agent does not have', () => {
    write('docs/CLI_COMMANDS.yaml', 'commands:\n  - name: update-status\n    command: python x.py\n')
    const file = { schema_version: 1, title: 'Status', view: 'markdown', source: { file: 'app-data/s.md' }, refresh: { command: '/run:update-status', schedule: 'nightly' } }
    expect(check(file, {})).toMatchObject({ triples: [], spec: { refreshCommand: '/run:update-status' } })
    const unknown = check({ ...file, entry: 'index.html', refresh: { command: '/run:other', schedule: 'weekly' } }, {})
    expect(unknown.info.valid).toBe(true)
    expect(unknown.triples).toEqual([
      ['entry_ignored', 'entry', 'warning'],
      ['refresh_command_unknown', 'refresh.command', 'warning'],
      ['refresh_schedule_unknown', 'refresh.schedule', 'warning']
    ])
  })

  it('applies the param defaults, duration and prompts limits', () => {
    const codes = (extra: object) => check({ ...good, ...extra }).triples
    expect(codes({ params: { 'bad-name': { type: 'text' } } })).toEqual([['param_name_invalid', 'params.bad-name', 'error']])
    expect(codes({ params: { s: { type: 'enum', values: ['a', 'b'], default: 'c' } } })).toEqual([['invalid_value', 'params.s.default', 'error']])
    expect(codes({ params: { m: { type: 'month', default: 'current' }, d: { type: 'date', default: '2026-13-01' }, n: { type: 'number', default: null } } })).toEqual([['invalid_value', 'params.d.default', 'error']])
    expect(codes({ refresh: { max_age: '05m' } })).toEqual([['duration_invalid', 'refresh.max_age', 'error']])
    expect(codes({ refresh: { max_age: null } })).toEqual([['duration_invalid', 'refresh.max_age', 'error']])
    expect(codes({ refresh: { while_open_every: '59s' } })).toEqual([['while_open_every_too_short', 'refresh.while_open_every', 'error']])
    expect(codes({ refresh: { while_open_every: '60s' } })).toEqual([])
    expect(codes({ prompts: Array.from({ length: 11 }, () => ({ label: 'x', prompt: 'y' })) })).toEqual([['invalid_value', 'prompts', 'error']])
    expect(codes({ prompts: [{ label: 'x'.repeat(61), prompt: 'y' }] })).toEqual([['invalid_value', 'prompts', 'error']])
  })

  it('fills prompts from a valid prompts[] and after_turn from refresh, empty and false otherwise', () => {
    const withPrompts = check({ ...good, refresh: { max_age: '5m', after_turn: true }, prompts: [{ label: ' Biggest ', prompt: ' Which deal is biggest? ' }] })
    expect(withPrompts.info.prompts).toEqual([{ label: 'Biggest', prompt: 'Which deal is biggest?' }])
    expect(withPrompts.spec!.afterTurn).toBe(true)
    const plain = check(good)
    expect(plain.info.prompts).toEqual([])
    expect(plain.spec!.afterTurn).toBe(false)
    // An invalid prompts[] makes the component invalid, and its info carries none.
    expect(check({ ...good, prompts: [{ label: 'x' }] }).info.prompts).toEqual([])
  })

  it('scans a web view’s page files for what the sandbox blocks, outside api/', () => {
    const html = { ...good, view: 'html' }
    const { info } = check(html, {
      'api/deals.py': 'x',
      'api/note.html': '<base href="/">',
      'index.html': '<link href="/style.css"><script src="https://cdn.example/x.js"></script>',
      'app.js': 'fetch("./api/deals.py"); localStorage.x = 1; const r = retrieval(2)',
      'style.css': '.a { background: url(/bg.png) }'
    })
    expect(info.valid).toBe(false)
    expect(info.findings.map((f) => [...triple(f), f.severity])).toEqual([
      ['dashboards/c/app.js', 'fetch_endpoint', 'fetch', 'error'],
      ['dashboards/c/index.html', 'root_relative_path', 'href', 'error'],
      ['dashboards/c/style.css', 'root_relative_path', 'url', 'error'],
      ['dashboards/c/app.js', 'sandbox_unsupported', 'localStorage', 'warning'],
      ['dashboards/c/index.html', 'network_reference', null, 'warning']
    ])
  })

  it('warns, without failing, when there is no manifest to check requires_credentials against', () => {
    rmSync(join(agentDir, 'cinna-agent.json'))
    const { info, triples } = check({ ...good, requires_credentials: ['gmail'] })
    expect(info.valid).toBe(true)
    expect(triples).toEqual([['manifest_missing', 'requires_credentials', 'warning']])
  })
})

describe('missing credentials (D16)', () => {
  it('names the required slots that are not ready for the agent', () => {
    extra = { credentialSlots: [{ name: 'gmail', ready: false }, { name: 'stripe', ready: true }] }
    const { info } = check({ ...good, requires_credentials: ['gmail', 'stripe', 'gmail'] })
    expect(info).toMatchObject({ valid: true, missingCredentials: ['gmail'] })
    expect(missingCredentials({}, ['gmail'])).toEqual([])
  })
})

describe('skill-shipped components (D15)', () => {
  it('reads <skill>/dashboards/*/ for every skill the agent resolves, from the agent or a cache, read-only', () => {
    write('dashboards/own/component.json', JSON.stringify(good))
    write('dashboards/own/api/deals.py', 'x')
    write('skills/crm/SKILL.md', '---\nname: crm\n---')
    write('skills/crm/dashboards/deals/component.json', JSON.stringify(good))
    write('skills/crm/dashboards/deals/api/deals.py', 'x')
    const cache = join(base, 'cache', 'inbox-triage')
    write('SKILL.md', '---\nname: inbox-triage\n---', cache)
    write('dashboards/follow-ups/component.json', JSON.stringify({ ...good, source: { endpoint: 'gone' } }), cache)
    write('dashboards/follow-ups/api/deals.py', 'x', cache)
    const before = readdirSync(cache, { recursive: true })
    extra = { skills: () => [{ name: 'inbox-triage', dir: cache }, { name: 'crm', dir: join(agentDir, 'skills', 'crm') }] }

    const list = scanComponents(agent())
    expect(list.map((c) => [c.skill, c.name, c.valid])).toEqual([[null, 'own', true], ['crm', 'deals', true], ['inbox-triage', 'follow-ups', false]])
    // A cached skill's findings are named as the agent sees it, never by the cache's path.
    expect(list[2].findings.map(triple)).toEqual([['skills/inbox-triage/dashboards/follow-ups/component.json', 'unknown_endpoint', 'source.endpoint']])
    const deals = readComponent(agent(), 'deals', 'crm')!
    expect(deals).toMatchObject({ shownDir: 'skills/crm/dashboards/deals', info: { skill: 'crm', agentId: 'folder:m1' } })
    expect(readComponent(agent(), 'deals')).toBeNull()
    expect(readComponent(agent(), 'deals', 'removed-skill')).toBeNull()
    expect(readdirSync(cache, { recursive: true })).toEqual(before)
  })
})
