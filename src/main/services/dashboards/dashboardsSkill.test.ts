import { afterAll, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

const userData = mkdtempSync(join(tmpdir(), 'cinna-dashboards-skill-'))
vi.mock('../../host/runtimeHost', () => ({
  runtimeHost: { isPackaged: false, getAppPath: () => process.cwd(), resourcesPath: '', getPath: () => userData }
}))
vi.mock('../../logger/logger', () => ({ createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }) }))

const {
  DASHBOARDS_SKILL_NAME, agentReferencePrefix, cinnaDashboardsSection, dashboardsSkillDeliveryFor, dashboardsSkillInfo,
  ensureDashboardsSkillPlugin, skillDashboardComponentCount
} = await import('./dashboardsSkill')
const { resolveDesktopPromptContext } = await import('../localAgents/promptAssembly')
const { PLATFORM_SKILL_NAMES } = await import('../../kit/skills')
const { DESIGN_PACK_FILES, dashboardDesignGuide, getDashboardDesignDir } = await import('./designPack')

afterAll(() => rmSync(userData, { recursive: true, force: true }))

/** The bundled skill (resources/cinna-agent-kit, synced at contract 1.19.1) reaches every kit agent: no profile gate. */
describe('the cinna-dashboards skill', () => {
  it('is in this build, with its check script, and is a platform skill name', () => {
    const info = dashboardsSkillInfo()
    expect(info).toMatchObject({ available: true, skillFile: expect.stringMatching(/skills\/cinna-dashboards\/SKILL\.md$/) })
    expect(existsSync(info.checkScript)).toBe(true)
    expect(info.checkScript).toMatch(/skills\/cinna-dashboards\/scripts\/check_component\.py$/)
    expect(PLATFORM_SKILL_NAMES.has(DASHBOARDS_SKILL_NAME)).toBe(true)
  })

  it('is a skill for Claude and OpenCode, a pointer for Codex and Antigravity, and nothing when the build has none', () => {
    expect(dashboardsSkillDeliveryFor('claude')).toEqual({ kind: 'skill' })
    expect(dashboardsSkillDeliveryFor('opencode')).toEqual({ kind: 'skill' })
    expect(dashboardsSkillDeliveryFor('codex')).toMatchObject({ kind: 'pointer', path: expect.stringMatching(/cinna-dashboards\/SKILL\.md$/) })
    expect(dashboardsSkillDeliveryFor('antigravity')).toMatchObject({ kind: 'pointer' })
    const missing = { available: false, dir: '/x', skillFile: '/x/SKILL.md', checkScript: '/x/scripts/check_component.py' }
    expect(dashboardsSkillDeliveryFor('claude', missing)).toBeNull()
  })

  it('reaches the prompt context with the check script, with no gate to open', () => {
    const context = resolveDesktopPromptContext('codex')
    expect(context.dashboardsSkill).toMatchObject({ kind: 'pointer' })
    expect(context.dashboardsCheckScript).toBe(dashboardsSkillInfo().checkScript)
    expect(resolveDesktopPromptContext().dashboardsSkill).toBeUndefined()
  })

  it('names the bundle form when the agent has a bundle id (manifest first), else the id form', () => {
    expect(agentReferencePrefix({ id: 'abc' }, null)).toBe('cinna://component/id:abc/')
    expect(agentReferencePrefix({ id: 'abc' }, 'io.a.cinna.1')).toBe('cinna://component/bundle:io.a.cinna.1/')
    expect(agentReferencePrefix({ id: 'abc', bundle: { bundle_id: 'io.m.cinna.2' } }, 'io.a.cinna.1')).toBe('cinna://component/bundle:io.m.cinna.2/')
    expect(agentReferencePrefix({ id: 'abc', bundle: { bundle_id: '  ' } }, '')).toBe('cinna://component/id:abc/')
    expect(agentReferencePrefix({}, null)).toBeNull()
    const lines = cinnaDashboardsSection({ delivery: { kind: 'skill' }, checkScript: '/k/check_component.py', referencePrefix: 'cinna://component/id:abc/' })
    expect(lines[0]).toMatch(/## Cinna dashboards[\s\S]*uv run python \/k\/check_component\.py dashboards\/<name>[\s\S]*cinna:\/\/component\/id:abc\//)
    expect(cinnaDashboardsSection(null)).toEqual([])
  })

  it('names the design pack guide and example by absolute path for an html view, and says nothing of it when the build has none', () => {
    const input = { delivery: { kind: 'skill' as const }, checkScript: '/k/check_component.py', referencePrefix: 'cinna://component/id:abc/' }
    const [section] = cinnaDashboardsSection({ ...input, design: { guide: '/app/dashboard-design/DESIGN.md', example: '/app/dashboard-design/example' } })
    const line = section.split('\n').find((l) => l.includes('design pack'))!
    expect(line).toContain("not the kit's `templates/dashboard-html/`")
    expect(line).toContain('read `/app/dashboard-design/DESIGN.md`')
    expect(line).toContain('Start from `/app/dashboard-design/example` (copy it to `dashboards/<name>/`)')
    expect(line).toContain('link `_cinna/ui.css` and `_cinna/charts.js`')
    expect(line).toContain('`var(--cinna-*)`')
    // It comes right after the skill line, ahead of the check and reference lines,
    // so it is read before the skill's own pointer to the kit template wins.
    const lines = section.split('\n')
    expect(lines.indexOf(line)).toBeLessThan(lines.findIndex((l) => l.includes('check_component.py')))
    expect(cinnaDashboardsSection({ ...input, design: null })[0]).not.toContain('_cinna/')
    expect(cinnaDashboardsSection(input)[0]).not.toContain('DESIGN.md')
    // The prompt context carries this build's pack with the skill, absolute.
    const context = resolveDesktopPromptContext('claude')
    expect(context.dashboardsDesign).toEqual(dashboardDesignGuide())
    expect(context.dashboardsDesign?.guide).toBe(join(getDashboardDesignDir(), 'DESIGN.md'))
    expect(isAbsolute(context.dashboardsDesign!.example)).toBe(true)
  })

  it('writes a Claude plugin carrying the skill and its script, and rebuilds it only when the skill changes', () => {
    const target = ensureDashboardsSkillPlugin()
    expect(target).toBe(join(userData, 'cinna-plugins', DASHBOARDS_SKILL_NAME))
    const manifest = JSON.parse(readFileSync(join(target!, '.claude-plugin', 'plugin.json'), 'utf8'))
    expect(manifest.name).toBe(DASHBOARDS_SKILL_NAME)
    expect(existsSync(join(target!, 'skills', DASHBOARDS_SKILL_NAME, 'SKILL.md'))).toBe(true)
    expect(existsSync(join(target!, 'skills', DASHBOARDS_SKILL_NAME, 'scripts', 'check_component.py'))).toBe(true)
    writeFileSync(join(target!, 'marker'), 'kept while the hash matches')
    expect(ensureDashboardsSkillPlugin()).toBe(target)
    expect(existsSync(join(target!, 'marker'))).toBe(true)
    expect(ensureDashboardsSkillPlugin({ available: false, dir: '', skillFile: '', checkScript: '' })).toBeNull()
  })
})

describe('skillDashboardComponentCount', () => {
  it('counts the dashboards/ folders that hold a component.json, and nothing for a skill without them', () => {
    const skill = mkdtempSync(join(tmpdir(), 'cinna-skill-components-'))
    try {
      expect(skillDashboardComponentCount(skill)).toBe(0)
      for (const name of ['deals', 'revenue', 'draft']) mkdirSync(join(skill, 'dashboards', name), { recursive: true })
      writeFileSync(join(skill, 'dashboards', 'deals', 'component.json'), '{}')
      writeFileSync(join(skill, 'dashboards', 'revenue', 'component.json'), '{}')
      writeFileSync(join(skill, 'dashboards', 'README.md'), 'not a component')
      expect(skillDashboardComponentCount(skill)).toBe(2)
      expect(skillDashboardComponentCount(join(skill, 'nope'))).toBe(0)
    } finally {
      rmSync(skill, { recursive: true, force: true })
    }
  })
})

/** The desktop's dashboard design pack (resources/dashboard-design), served at _cinna/ and named in the prompt. */
describe('the dashboard design pack', () => {
  it('ships its served files, its guide and a complete example component', () => {
    const dir = getDashboardDesignDir()
    expect(dir).toBe(join(process.cwd(), 'resources', 'dashboard-design'))
    for (const file of DESIGN_PACK_FILES) expect(existsSync(join(dir, file)), file).toBe(true)
    const guide = dashboardDesignGuide()
    expect(guide).toEqual({ guide: join(dir, 'DESIGN.md'), example: join(dir, 'example') })
    for (const file of ['component.json', 'index.html', 'api/data.py']) expect(existsSync(join(guide!.example, file)), file).toBe(true)
    const component = JSON.parse(readFileSync(join(guide!.example, 'component.json'), 'utf8'))
    expect(component).toMatchObject({ view: 'html', entry: 'index.html', source: { endpoint: 'data' } })
    const page = readFileSync(join(guide!.example, 'index.html'), 'utf8')
    expect(page).toContain('<link rel="stylesheet" href="_cinna/ui.css">')
    expect(page).toContain('<script src="_cinna/charts.js"></script>')
    expect(dashboardDesignGuide(join(dir, 'missing'))).toBeNull()
  })
})
