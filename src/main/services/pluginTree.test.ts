import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pluginTitleOf, readPluginTree } from './pluginTree'

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
})
