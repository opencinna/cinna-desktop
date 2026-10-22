import { describe, expect, it } from 'vitest'
import { agentRunsCommands, fenceLanguage } from './userCommands'

type Agent = Parameters<typeof agentRunsCommands>[0]
const agent = (patch: Record<string, unknown>): Agent => ({ id: 'a', driver: 'acp', source: 'folder', localPath: '/agents/a', ...patch }) as never

describe('agentRunsCommands', () => {
  it('is true for a folder agent with a folder and for the build session', () => {
    expect(agentRunsCommands(agent({}))).toBe(true)
    expect(agentRunsCommands(agent({ source: 'local', localPath: null, development: true }))).toBe(true)
  })

  it('is false for remote, core, chat-runtime, websocket and folderless agents', () => {
    expect(agentRunsCommands(agent({ source: 'remote', driver: 'a2a', localPath: null }))).toBe(false)
    expect(agentRunsCommands(agent({ driver: 'managed' }))).toBe(false)
    expect(agentRunsCommands(agent({ conductor: true }))).toBe(false)
    expect(agentRunsCommands(agent({ acpTransport: 'websocket' }))).toBe(false)
    expect(agentRunsCommands(agent({ localPath: null }))).toBe(false)
    expect(agentRunsCommands(agent({ source: 'local', localPath: null }))).toBe(false)
    expect(agentRunsCommands(undefined)).toBe(false)
  })
})

describe('fenceLanguage', () => {
  it('reads the language class react-markdown gives a fenced block', () => {
    const code = document.createElement('code')
    code.className = 'hljs language-Bash'
    expect(fenceLanguage(code)).toBe('bash')
    code.className = ''
    expect(fenceLanguage(code)).toBeNull()
  })
})
