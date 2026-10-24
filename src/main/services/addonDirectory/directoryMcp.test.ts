import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { cpSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, type Dirent } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

vi.mock('../../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { createLayoutView, parseLayout } from '../../kit/layout'
import { validateAgentFolder } from '../../kit/validator'
import { directoryStdioLaunch, requirementName, requirementOf, withoutRequirement, withRequirement, writeMcpRequirements, type RequirementRow } from './directoryMcp'
import type { McpServerRequirement } from '../../../shared/kit/manifest'

/**
 * Directory MCP servers: the command each package registry becomes, and the
 * `mcp_servers[]` requirement a kit agent's connector is written as — no
 * values, only names — written and removed through the manifest guard and
 * passing the contract's own validator.
 */

const UV = { uvBin: '/ud/localdev/uv-0.12.10/uv', uvxBin: '/ud/localdev/uv-0.12.10/uvx' }
const REF = { source: 'core-mcp-directory', id: 'fs' }

describe('directoryStdioLaunch', () => {
  const pkg = (registry: 'npm' | 'pypi' | 'oci', name = 'srv', version: string | null = '1.2.0', args: string[] = ['--ro']) => ({
    package: { registry, name, version, args },
    env: [
      { name: 'API_KEY', secret: true, description: null },
      { name: 'ROOT', secret: false, description: null }
    ]
  })

  it('runs an npm package through npx, a pypi one through the managed uvx, an oci image through docker with its env passed in', () => {
    expect(directoryStdioLaunch(pkg('npm', '@mcp/fs'), UV)).toEqual({ command: 'npx', args: ['-y', '@mcp/fs@1.2.0', '--ro'], runtime: 'node' })
    expect(directoryStdioLaunch(pkg('pypi', 'mcp-server-fetch'), UV)).toEqual({ command: UV.uvxBin, args: ['mcp-server-fetch==1.2.0', '--ro'], runtime: 'python' })
    expect(directoryStdioLaunch(pkg('oci', 'ghcr.io/acme/srv'), UV)).toEqual({
      command: 'docker',
      args: ['run', '-i', '--rm', '-e', 'API_KEY', '-e', 'ROOT', 'ghcr.io/acme/srv:1.2.0', '--ro'],
      runtime: 'docker'
    })
    expect(directoryStdioLaunch(pkg('npm', 'plain', null, []), UV)?.args).toEqual(['-y', 'plain'])
  })

  it('refuses a package name or version that would read as a flag or a second argument', () => {
    expect(directoryStdioLaunch(pkg('npm', '--registry=evil'), UV)).toBeNull()
    expect(directoryStdioLaunch(pkg('pypi', 'a b'), UV)).toBeNull()
    expect(directoryStdioLaunch(pkg('oci', 'img', '-v /:/host'), UV)).toBeNull()
  })

  it('takes only what each registry publishes: no git, github:, file: or URL sources, no versions with a colon, slash or @', () => {
    const ok = (registry: 'npm' | 'pypi' | 'oci', name: string, version: string | null = '1.2.0'): boolean => directoryStdioLaunch(pkg(registry, name, version), UV) !== null
    expect(ok('npm', '@modelcontextprotocol/server-filesystem')).toBe(true)
    expect(ok('npm', 'mcp-server.x_y~z', '2.0.0-beta.1+build')).toBe(true)
    expect(ok('npm', 'github:acme/srv', null)).toBe(false)
    expect(ok('npm', 'git+https://github.com/acme/srv.git', null)).toBe(false)
    expect(ok('npm', 'file:../srv', null)).toBe(false)
    expect(ok('npm', '@acme/srv', 'github:acme/srv')).toBe(false)
    expect(ok('npm', 'srv', 'https://evil.example/srv.tgz')).toBe(false)
    expect(ok('npm', 'srv', 'npm:other@1')).toBe(false)
    expect(ok('npm', ':srv', null)).toBe(false)
  })

  it('takes an npm version only as semver (a range operator allowed) or a plain dist-tag, never a tarball name', () => {
    const npm = (version: string): boolean => directoryStdioLaunch(pkg('npm', 'srv', version), UV) !== null
    for (const version of ['1.2.3', '^1.2.3', '~0.4.0', '>=2.0.0-rc.1', '<3.0.0', '=1.0.0+b.7', 'latest', 'next', 'beta-2', '1.2', 'v1_x']) expect(npm(version)).toBe(true)
    for (const version of ['srv-1.0.0.tgz', 'x.tar', 'x.TAR.GZ', 'a/b', 'tag:x', 'x@1', '^1.2', '>=x', '-latest', '.hidden', '1.2.3 || 2', '^^1.2.3', 'x'.repeat(129)]) {
      expect(npm(version)).toBe(false)
    }
  })

  it('takes the other registries’ versions as before', () => {
    const ok = (registry: 'npm' | 'pypi' | 'oci', name: string, version: string | null = '1.2.0'): boolean => directoryStdioLaunch(pkg(registry, name, version), UV) !== null
    expect(ok('pypi', 'mcp-server-fetch[cli,extra]', '1!2.0.post1+local')).toBe(true)
    expect(ok('pypi', 'git+https://github.com/acme/srv', null)).toBe(false)
    expect(ok('pypi', 'srv @ https://evil.example/srv.whl', null)).toBe(false)
    expect(ok('pypi', 'srv', '>=1.0')).toBe(false)
    expect(ok('pypi', 'srv-', null)).toBe(false)
    expect(ok('oci', 'ghcr.io/acme/srv')).toBe(true)
    expect(ok('oci', 'localhost:5000/team/srv-x', 'v1.2_rc')).toBe(true)
    expect(ok('oci', 'mcp/fetch:latest', null)).toBe(true)
    expect(ok('oci', 'mcp/fetch:latest', '1.0')).toBe(false)
    expect(ok('oci', 'docker://ghcr.io/acme/srv', null)).toBe(false)
    expect(ok('oci', 'ghcr.io/acme/srv', 'sha256:abc')).toBe(false)
    expect(ok('oci', 'ghcr.io/acme/srv', '1.0/../x')).toBe(false)
    expect(ok('oci', 'Ghcr.io/Acme/Srv', null)).toBe(false)
  })
})

describe('requirements', () => {
  const row = (over: Partial<RequirementRow> = {}): RequirementRow => ({
    name: 'File System',
    transportType: 'stdio',
    command: UV.uvxBin,
    args: ['mcp-fs==1.0'],
    url: null,
    env: { ROOT: '/Users/me/secret-place', API_KEY: 'sk-live-123' },
    authType: 'oauth',
    ...over
  })

  it('names the env, never its values, and writes the portable command rather than the managed binary', () => {
    const requirement = requirementOf(row(), REF, UV)
    expect(requirement).toEqual({
      name: 'File-System',
      ref: REF,
      transport: 'stdio',
      command: 'uvx',
      args: ['mcp-fs==1.0'],
      auth: 'env',
      env: [
        { name: 'API_KEY', secret: true },
        { name: 'ROOT', secret: true }
      ]
    })
    expect(JSON.stringify(requirement)).not.toContain('sk-live')
    expect(JSON.stringify(requirement)).not.toContain('secret-place')
    expect(requirementOf(row({ transportType: 'streamable-http', command: null, args: null, url: 'https://gh.example/mcp', env: null, authType: 'bearer' }), REF, UV)).toEqual({
      name: 'File-System',
      ref: REF,
      transport: 'http',
      url: 'https://gh.example/mcp',
      auth: 'bearer'
    })
  })

  it('writes only env names the contract takes (a name typed by hand in Settings may be anything)', () => {
    const requirement = requirementOf(row({ env: { API_KEY: '', 'my key': '', '1BAD': '', 'A-B': '', _OK: '' } }), REF, UV)
    expect(requirement.env).toEqual([
      { name: 'API_KEY', secret: true },
      { name: '_OK', secret: true }
    ])
    expect(requirementOf(row({ env: { 'not valid': '' } }), REF, UV)).not.toHaveProperty('env')
  })

  it('makes a name the contract accepts', () => {
    expect(requirementName('  ---GitHub (official)  ')).toBe('GitHub-official')
    expect(requirementName('???')).toBe('mcp')
    expect(requirementName('x'.repeat(90))).toHaveLength(64)
  })

  it('replaces the entry of the same ref in place, keeps names apart, and removes by ref', () => {
    const a: McpServerRequirement = { name: 'fs', ref: REF, transport: 'stdio', command: 'npx' }
    const b: McpServerRequirement = { name: 'fs', ref: { source: 'core-mcp-directory', id: 'other' }, transport: 'stdio', command: 'npx' }
    const list = withRequirement([], a)!
    expect(withRequirement(list, a)).toBeNull()
    expect(withRequirement(list, { ...a, name: 'renamed', args: ['x'] })).toEqual([{ ...a, args: ['x'] }])
    expect(withRequirement(list, b)!.map((item) => item.name)).toEqual(['fs', 'fs-2'])
    expect(withoutRequirement(list, REF)).toEqual([])
    expect(withoutRequirement(list, { source: 'core-mcp-directory', id: 'nope' })).toBeNull()
  })
})

describe('writeMcpRequirements — round trip through the validator', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
  const contractDir = join(repoRoot, 'resources/cinna-agent-kit')
  const CONTRACT_VERSION = readFileSync(join(contractDir, 'CONTRACT_VERSION'), 'utf8').trim()
  const layout = createLayoutView(parseLayout(JSON.parse(readFileSync(join(contractDir, 'layout.json'), 'utf8'))))
  const OPTIONS = { layout, contractVersion: CONTRACT_VERSION }
  let home: string
  let agentDir: string

  /** The contract's own agent template, scaffolded as the validator tests do. */
  function scaffold(parent: string): string {
    const dir = join(parent, 'fs-agent')
    cpSync(join(contractDir, 'templates/agent'), dir, { recursive: true })
    for (const [from, to] of layout.scaffoldIgnoreFiles('agent')) renameSync(join(dir, from), join(dir, to))
    const tokens: Record<string, string> = {
      SLUG: 'fs-agent',
      NAME: 'FS Agent',
      DESCRIPTION: 'Reads files.',
      ID: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      CONTRACT_VERSION,
      KIT_VERSION: CONTRACT_VERSION,
      CREATED_AT: '2026-10-24T10:00:00Z'
    }
    const substitute = (at: string): void => {
      const entries: Dirent[] = readdirSync(at, { withFileTypes: true })
      for (const entry of entries) {
        const abs = join(at, entry.name)
        if (entry.isDirectory()) {
          substitute(abs)
          continue
        }
        const before = readFileSync(abs, 'utf8')
        const after = before.replace(/\{\{([A-Z_]+)\}\}/g, (match, token: string) => tokens[token] ?? match)
        if (after !== before) writeFileSync(abs, after)
      }
    }
    substitute(dir)
    return dir
  }

  const manifest = (): Record<string, unknown> => JSON.parse(readFileSync(join(agentDir, 'cinna-agent.json'), 'utf8'))

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cinna-mcp-req-'))
    agentDir = scaffold(home)
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('writes a stdio and an http requirement the validator accepts, then removes them and drops the key', () => {
    expect(validateAgentFolder(agentDir, OPTIONS).errors).toEqual([])
    const stdio = requirementOf(
      { name: 'filesystem', transportType: 'stdio', command: 'docker', args: ['run', '-i', '--rm', '-e', 'ROOT', 'img:1'], url: null, env: { ROOT: '/private' }, authType: 'oauth' },
      REF,
      UV
    )
    const http = requirementOf(
      { name: 'GitHub', transportType: 'streamable-http', command: null, args: null, url: 'https://gh.example/mcp', env: null, authType: 'oauth' },
      { source: 'mcp-registry:official', id: 'gh' },
      UV
    )
    expect(writeMcpRequirements(agentDir, (list) => withRequirement(list, stdio))).toBe(true)
    expect(writeMcpRequirements(agentDir, (list) => withRequirement(list, http))).toBe(true)
    expect(writeMcpRequirements(agentDir, (list) => withRequirement(list, http))).toBe(false)
    const written = manifest()
    expect((written.mcp_servers as McpServerRequirement[]).map((item) => [item.name, item.transport, item.ref])).toEqual([
      ['filesystem', 'stdio', REF],
      ['GitHub', 'http', { source: 'mcp-registry:official', id: 'gh' }]
    ])
    expect(JSON.stringify(written)).not.toContain('/private')
    expect(validateAgentFolder(agentDir, OPTIONS).errors).toEqual([])

    expect(writeMcpRequirements(agentDir, (list) => withoutRequirement(list, REF))).toBe(true)
    expect((manifest().mcp_servers as McpServerRequirement[]).map((item) => item.name)).toEqual(['GitHub'])
    expect(writeMcpRequirements(agentDir, (list) => withoutRequirement(list, { source: 'mcp-registry:official', id: 'gh' }))).toBe(true)
    expect(manifest()).not.toHaveProperty('mcp_servers')
    expect(validateAgentFolder(agentDir, OPTIONS).errors).toEqual([])
  })

  it('keeps the rest of the manifest as it was', () => {
    const before = manifest()
    writeMcpRequirements(agentDir, (list) => withRequirement(list, { name: 'x', ref: REF, transport: 'http', url: 'https://x.example', auth: 'oauth' }))
    const { mcp_servers: _added, ...rest } = manifest() // eslint-disable-line @typescript-eslint/no-unused-vars
    expect(rest).toEqual(before)
  })
})
