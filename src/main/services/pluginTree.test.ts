import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { declaredPathIn, pluginTitleOf, readPluginTree } from './pluginTree'

/**
 * A cached plugin's agents and hook events as its row lists them: agents by
 * the name their file gives itself, hook events from `hooks/hooks.json`, and
 * the plugin's own title from its manifest.
 */

let dir: string
const write = (rel: string, body: string): void => {
  mkdirSync(join(dir, rel, '..'), { recursive: true })
  writeFileSync(join(dir, rel), body)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cinna-tree-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('readPluginTree', () => {
  it('names each agent by its frontmatter name, else its file, and lists the hook events with a hook', () => {
    write('agents/reviewer.md', '---\nname: "Code Reviewer"\ndescription: x\n---\nBody')
    write('agents/plain.md', 'No frontmatter')
    write('agents/notes.txt', 'not an agent')
    write('hooks/hooks.json', JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [] }], Stop: [{}], Empty: [] } }))
    const tree = readPluginTree(dir)
    expect(tree.agents).toEqual(['Code Reviewer', 'plain'])
    expect(tree.hasAgents).toBe(true)
    expect(tree.hookEvents).toEqual(['PreToolUse', 'Stop'])
    expect(tree.hasHooks).toBe(true)
  })

  it('reads none of either when the folders are absent or hooks.json is not a map', () => {
    expect(readPluginTree(dir)).toMatchObject({ agents: [], hasAgents: false, hookEvents: [], hasHooks: false })
    write('hooks/hooks.json', '[1]')
    expect(readPluginTree(dir)).toMatchObject({ hookEvents: [], hasHooks: true })
  })

  it('titles a plugin by its manifest’s displayName, else its name', () => {
    expect(pluginTitleOf(dir)).toBeNull()
    write('.claude-plugin/plugin.json', JSON.stringify({ name: 'carbone' }))
    expect(pluginTitleOf(dir)).toBe('carbone')
    write('.claude-plugin/plugin.json', JSON.stringify({ name: 'carbone', displayName: 'Carbone Reports' }))
    expect(pluginTitleOf(dir)).toBe('Carbone Reports')
  })

  it('reads a skill from a declared skills path that is itself a skill folder (carbone-skill’s "./carbone")', () => {
    write('.claude-plugin/plugin.json', JSON.stringify({ name: 'carbone-skill', skills: './carbone' }))
    write('carbone/SKILL.md', '---\nname: carbone\ndescription: Render documents\n---\nBody')
    const tree = readPluginTree(dir)
    expect(tree.skills).toEqual(['carbone'])
    expect(tree.skillDirs).toEqual({ carbone: join(dir, 'carbone') })
  })

  it('supplements skills/ with each declared folder of skill folders, by the name the SKILL.md gives', () => {
    write('.claude-plugin/plugin.json', JSON.stringify({ name: 'p', skills: ['./more', 7, './missing'] }))
    write('skills/alpha/SKILL.md', '---\nname: alpha\n---\n')
    write('more/beta/SKILL.md', '---\nname: beta\n---\n')
    write('more/gamma/SKILL.md', '---\nname: "Gamma Skill"\n---\n')
    write('more/notes/readme.md', 'not a skill')
    const tree = readPluginTree(dir)
    expect(tree.skills).toEqual(['alpha', 'beta', 'Gamma Skill'])
    expect(tree.skillDirs.beta).toBe(join(dir, 'more', 'beta'))
  })

  it('reads a root SKILL.md as the plugin’s one skill only when nothing else is found', () => {
    write('.claude-plugin/plugin.json', JSON.stringify({ name: 'solo' }))
    write('SKILL.md', '---\ndescription: x\n---\n')
    expect(readPluginTree(dir)).toMatchObject({ skills: ['solo'], skillDirs: { solo: dir } })
    write('skills/real/SKILL.md', '---\nname: real\n---\n')
    expect(readPluginTree(dir).skills).toEqual(['real'])
  })

  it('refuses a declared path leading out of the plugin, through .. or a leading / or a link', () => {
    const outside = mkdtempSync(join(tmpdir(), 'cinna-tree-out-'))
    try {
      mkdirSync(join(outside, 'evil'), { recursive: true })
      writeFileSync(join(outside, 'evil', 'SKILL.md'), '---\nname: evil\n---\n')
      symlinkSync(outside, join(dir, 'link'))
      write('.claude-plugin/plugin.json', JSON.stringify({ name: 'p', skills: ['../' + outside.split('/').pop() + '/evil', join(outside, 'evil'), './link/evil'], commands: './link' }))
      expect(declaredPathIn(dir, './link/evil')).toBeNull()
      expect(declaredPathIn(dir, '../x')).toBeNull()
      expect(declaredPathIn(dir, '/etc')).toBeNull()
      expect(declaredPathIn(dir, './ok')).toBe(join(dir, 'ok'))
      const tree = readPluginTree(dir)
      expect(tree.skills).toEqual([])
      expect(tree.commands).toEqual([])
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('reads commands recursively from commands/ and each declared path (an array, a file or a folder), agents from declared folders', () => {
    write('.claude-plugin/plugin.json', JSON.stringify({ name: 'p', commands: ['./tools/cmds', './single.md'], agents: './crew' }))
    write('commands/a.md', 'A')
    write('commands/sub/b.md', 'B')
    write('tools/cmds/c.md', 'C')
    write('single.md', 'S')
    write('crew/helper.md', '---\nname: Helper\n---\n')
    const tree = readPluginTree(dir)
    expect(tree.commands.map((command) => command.name)).toEqual(['a', 'sub:b', 'c', 'single'])
    expect(tree.commands[1].path).toBe(join(dir, 'commands', 'sub', 'b.md'))
    expect(tree.agents).toEqual(['Helper'])
    expect(tree.declared).toEqual({ commands: ['./tools/cmds', './single.md'], agents: ['./crew'], hooks: [], lspServers: [] })
  })

  it('reads hook events and servers from declared files and inline maps', () => {
    write('.claude-plugin/plugin.json', JSON.stringify({ name: 'p', hooks: './cfg/hooks.json', mcpServers: ['./cfg/mcp.json', { inline: { url: 'https://x.test/mcp' } }], lspServers: './cfg/lsp.json' }))
    write('cfg/hooks.json', JSON.stringify({ hooks: { Stop: [{}] } }))
    write('cfg/mcp.json', JSON.stringify({ mcpServers: { files: { command: 'npx', args: ['-y', 'f'] } } }))
    write('cfg/lsp.json', JSON.stringify({ ts: { command: 'tsls' } }))
    write('.mcp.json', JSON.stringify({ base: { command: 'node' } }))
    const tree = readPluginTree(dir)
    expect(tree).toMatchObject({ hasHooks: true, hookEvents: ['Stop'], lspServers: ['ts'] })
    expect(tree.mcpServers.map((server) => server.name)).toEqual(['base', 'files', 'inline'])
  })
})
