import { afterEach, describe, expect, it } from 'vitest'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'
import { envLine, envValueProblem, mergeEnv, pySplitLines, pyStrip, PY_SPACE_CHAR } from './envFile'

const SCRIPT = 'resources/cinna-agent-kit/templates/agent/scripts/cinna_credentials.py'
const folders: string[] = []
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }) })

function envFolder(text: string): string {
  const folder = mkdtempSync(join(tmpdir(), 'env-roundtrip-')); folders.push(folder)
  mkdirSync(join(folder, 'scripts')); mkdirSync(join(folder, 'credentials'))
  copyFileSync(SCRIPT, join(folder, 'scripts/cinna_credentials.py'))
  writeFileSync(join(folder, 'credentials/.env'), text, 'utf8')
  return folder
}

/** What the kit's own reader makes of a `.env` text. */
function readByKit(text: string): Record<string, string> {
  const folder = envFolder(text)
  const code = `import sys; sys.path.insert(0, ${JSON.stringify(join(folder, 'scripts'))})\nimport json\nfrom cinna_credentials import _parse_env_file, LOCAL_ENV\nsys.stdout.write(json.dumps(_parse_env_file(LOCAL_ENV)))`
  return JSON.parse(execFileSync('python3', ['-I', '-c', code], { encoding: 'utf8' }))
}

/** python-dotenv, from uv's cache without the network; null where it is not available. */
const DOTENV_ARGS = ['run', '--no-project', '--offline', '--quiet', '--with', 'python-dotenv', 'python', '-I', '-c']
const hasDotenv = spawnSync('uv', [...DOTENV_ARGS, 'import dotenv'], { encoding: 'utf8' }).status === 0
function readByDotenv(text: string): Record<string, string> {
  const folder = envFolder(text)
  const code = `import json, sys\nfrom dotenv import dotenv_values\nsys.stdout.write(json.dumps(dotenv_values(${JSON.stringify(join(folder, 'credentials/.env'))})))`
  return JSON.parse(execFileSync('uv', [...DOTENV_ARGS, code], { encoding: 'utf8', env: { ...process.env, HOME: process.env.HOME ?? '' } }))
}

const TAB = String.fromCharCode(9)
/** Values both readers must read back exactly. */
const AGREED: Record<string, string> = {
  A_PLAIN: 'abc123-XYZ_=+/',
  A_BACKSLASH: 'C:\\path\\n\\t\\\\end\\',
  A_HASH_GLUED: 'abc#not-a-comment',
  A_HASH_SPACED: 'abc # looks like a comment',
  A_LEADING_HASH: '#starts-with-hash',
  A_SPACES: '  padded  ',
  A_WRAPPED_DOUBLE: '"already quoted"',
  A_WRAPPED_SINGLE: "'single'",
  A_DOUBLE_INSIDE: 'say "hi"',
  A_APOSTROPHE: "it's",
  A_BOTH_QUOTES: 'say "hi" it\'s',
  A_DOLLAR: '$HOME `id` $(x)',
  A_BACKSLASH_QUOTE: 'a\\"b',
  A_TAB: `a${TAB}b`,
  A_UNICODE: 'пароль-🔑',
  A_EXPORT: 'export X=1',
  A_EQUALS: 'k=v==w'
}
/** Needs quoting and holds a backslash and an apostrophe: only the kit reader is promised these. */
const KIT_ONLY: Record<string, string> = { K_ONLY: " it's C:\\x ", K_INTERPOLATED: 'a ${USER} b' }

describe('the .env writer', () => {
  it('writes values the kit reader returns byte for byte', () => {
    const all = { ...AGREED, ...KIT_ONLY }
    expect(readByKit(mergeEnv('', all))).toEqual(all)
  })

  it.skipIf(!hasDotenv)('writes values python-dotenv reads back the same, never with an escape', () => {
    const text = mergeEnv('', AGREED)
    expect(readByDotenv(text)).toEqual(AGREED)
    // A value with no backslash or double quote is written without one.
    for (const [key, value] of Object.entries(AGREED)) {
      if (!/[\\"]/.test(value)) expect(envLine(key, value).slice(key.length + 1).replace(/^(['"])(.*)\1$/, '$2')).toBe(value)
    }
  })

  it('picks the plainest form', () => {
    expect(envLine('K', 'abc')).toBe('K=abc')
    expect(envLine('K', 'C:\\x')).toBe('K=C:\\x')
    expect(envLine('K', ' x ')).toBe('K=" x "')
    expect(envLine('K', ' "x" ')).toBe("K=' \"x\" '")
  })

  it('round-trips through a seeded file with comments and other values', () => {
    const seeded = '# Credentials for X.\n#\n# A_PLAIN=\nOTHER=keep\n# A_HASH_SPACED=\n'
    const merged = mergeEnv(seeded, AGREED)
    expect(merged.startsWith('# Credentials for X.\n#\nA_PLAIN=')).toBe(true)
    expect(readByKit(merged)).toEqual({ OTHER: 'keep', ...AGREED })
  })

  it('replaces the first live assignment, drops later ones and keeps the seed when a value exists', () => {
    const text = '# KEY=\nKEY=one\nexport KEY = two\nKEEP=1\n'
    expect(mergeEnv(text, { KEY: 'new' })).toBe('# KEY=\nKEY=new\nKEEP=1\n')
  })

  it('appends unknown keys, adds a final newline and keeps CRLF files CRLF', () => {
    expect(mergeEnv('A=1', { B: 'x' })).toBe('A=1\nB=x\n')
    expect(mergeEnv('A=1\r\n# B=\r\n', { B: 'x' })).toBe('A=1\r\nB=x\r\n')
  })

  it('refuses empty and line-breaking values without naming them', () => {
    expect(envValueProblem('')).toBe('is empty')
    expect(envValueProblem(' ')).toBe('is empty')
    expect(envValueProblem(undefined)).toBe('is empty')
    for (const code of [10, 13, 11, 12, 0x1c, 0x1d, 0x1e, 0x85, 0x2028, 0x2029, 0]) {
      expect(envValueProblem(`a${String.fromCharCode(code)}b`)).toBe('must be a single line')
    }
    expect(envValueProblem('fine "value" # here')).toBeNull()
  })

  it('judges space as Python does, and refuses U+001F, which only Python strips', () => {
    // Every code point Python's str.isspace() accepts, against ours.
    const python = JSON.parse(execFileSync('python3', ['-I', '-c',
      'import json, sys; sys.stdout.write(json.dumps([c for c in range(0x110000) if chr(c).isspace()]))'], { encoding: 'utf8' })) as number[]
    const ours: number[] = []
    for (let c = 0; c < 0x110000; c++) if (PY_SPACE_CHAR.test(String.fromCodePoint(c))) ours.push(c)
    expect(ours).toEqual(python)
    // What Python strips and JS trim() keeps is all refused: U+001F as a control character,
    // the rest as line breaks, and a value made only of them as empty.
    for (const code of [0x1c, 0x1d, 0x1e, 0x1f, 0x85]) {
      const c = String.fromCharCode(code)
      expect(c.trim()).toBe(c)
      expect(envValueProblem(c)).toBe('is empty')
      expect(envValueProblem(`${c}${c} `)).toBe('is empty')
      expect(envValueProblem(`a${c}`)).not.toBeNull()
      expect(envValueProblem(`${c}a`)).not.toBeNull()
    }
    expect(envValueProblem('a\x1fb')).toBe('holds a control character')
    // U+FEFF is the reverse: trim() removes it, Python keeps it. It is a value, and survives.
    const bom = { K_BOM: '\ufeff', K_BOM_ENDS: '\ufeffx\ufeff' }
    for (const value of Object.values(bom)) expect(envValueProblem(value)).toBeNull()
    expect(readByKit(mergeEnv('', bom))).toEqual(bom)
  })

  it('splits and strips lines as Python does', () => {
    expect(pyStrip('\x1f\x85 a b\u3000\x1c')).toBe('a b')
    expect(pyStrip('\ufeffa')).toBe('\ufeffa')
    expect(pySplitLines('')).toEqual([])
    expect(pySplitLines('a\r\nb\rc\x1dd\n')).toEqual(['a', 'b', 'c', 'd'])
    expect(pySplitLines('a\n\n')).toEqual(['a', ''])
  })
})
