import { describe, expect, it } from 'vitest'
import { chooseOpenStrategy, findDefaultEditor } from './openStrategy'
import type { DetectedTool } from '../../../shared/localTools'

describe('chooseOpenStrategy', () => {
  it.each([
    // kind, filename, platform, default editor, expected
    ['dir', 'pulled', 'darwin', true, 'reveal'],
    ['dir', 'pulled', 'linux', false, 'reveal'],
    // Binary documents go to the system app even with a default editor.
    ['file', 'report.pdf', 'darwin', true, 'default-app'],
    ['file', 'Deck.PPTX', 'linux', true, 'default-app'],
    ['file', 'budget.numbers', 'darwin', true, 'default-app'],
    ['file', 'photo.heic', 'darwin', true, 'default-app'],
    ['file', 'Report.PDF', 'linux', false, 'default-app'],
    ['file', 'sheet.xlsx', 'win32', false, 'default-app'],
    // Text and code: the editor when set…
    ['file', 'main.py', 'darwin', true, 'editor'],
    ['file', 'omp.csv', 'darwin', true, 'editor'],
    ['file', 'notes.md', 'win32', true, 'editor'],
    ['file', 'Launch.command', 'darwin', true, 'editor'],
    // …else the system app for a text document type…
    ['file', 'omp.csv', 'darwin', false, 'default-app'],
    ['file', 'notes.md', 'linux', false, 'default-app'],
    ['file', 'config.YML', 'win32', false, 'default-app'],
    // …else `open -t` on macOS, else reveal.
    ['file', 'main.py', 'darwin', false, 'text-editor'],
    ['file', 'run.sh', 'darwin', false, 'text-editor'],
    ['file', 'Launch.command', 'darwin', false, 'text-editor'],
    ['file', 'data.gz', 'darwin', false, 'text-editor'],
    ['file', 'Makefile', 'darwin', false, 'text-editor'],
    ['file', 'main.py', 'linux', false, 'reveal'],
    ['file', 'run.sh', 'win32', false, 'reveal'],
    // A credential file never reaches the system app: a PEM `.key` is not a
    // Keynote deck. The editor when set, else `open -t`, else reveal.
    ['file', 'server.key', 'darwin', true, 'editor'],
    ['file', 'server.key', 'darwin', false, 'text-editor'],
    ['file', 'server.key', 'linux', false, 'reveal'],
    ['file', '.env.json', 'darwin', false, 'text-editor'],
    // …and an ordinary binary document is unchanged.
    ['file', 'deck.pdf', 'darwin', true, 'default-app'],
    ['file', 'deck.pdf', 'darwin', false, 'default-app']
  ] as const)('%s %s on %s (editor: %s) → %s', (kind, filename, platform, hasDefaultEditor, expected) => {
    expect(chooseOpenStrategy({ kind, filename, platform, hasDefaultEditor })).toBe(expected)
  })
})

describe('findDefaultEditor', () => {
  const tools: Record<string, DetectedTool> = {
    code: { id: 'code', kind: 'editor', label: 'VS Code', path: '/usr/local/bin/code', available: true, source: 'path' } as DetectedTool,
    cursor: { id: 'cursor', kind: 'editor', label: 'Cursor', path: null, available: false, source: null } as DetectedTool,
    claude: { id: 'claude', kind: 'cli-assistant', label: 'Claude Code', path: '/usr/bin/claude', available: true, source: 'path' } as DetectedTool
  }
  const get = async (id: string): Promise<DetectedTool | undefined> => tools[id]

  it('returns the default tool when it is an installed editor', async () => {
    expect(await findDefaultEditor('code', get)).toBe(tools.code)
  })

  it.each(['', 'vim', 'cursor', 'claude'])('returns null for %j', async (setting) => {
    expect(await findDefaultEditor(setting, get)).toBeNull()
  })
})
