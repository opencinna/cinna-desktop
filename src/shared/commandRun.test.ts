import { describe, expect, it } from 'vitest'
import { commandFirstWord, commandOutputFilename, detectCommand, looksAutoRunnable } from './commandRun'
import { COMMAND_CASES } from './commandRunCases'

const inline = (text: string): string | null => detectCommand(text, { fenced: false })
const fenced = (text: string, lang: string | null = 'bash'): string | null => detectCommand(text, { fenced: true, lang })

describe('detectCommand and looksAutoRunnable', () => {
  it.each(COMMAND_CASES)('%s', (text, detected, auto) => {
    expect(inline(text)).toBe(detected)
    if (detected !== null) expect(looksAutoRunnable(detected)).toBe(auto)
  })

  it('never offers Run for an environment assignment or an empty line', () => {
    expect(looksAutoRunnable('FOO=1 uv run scripts/x.py')).toBe(false)
    expect(looksAutoRunnable('')).toBe(false)
    expect(looksAutoRunnable('python ../evil.py')).toBe(false)
  })
})

describe('fenced blocks', () => {
  it('takes a shell block without its comments and blank lines', () => {
    expect(fenced('# check first\n\nuv run scripts/x.py --live\n')).toBe('uv run scripts/x.py --live')
    expect(fenced('$ make build\n$ make test', 'sh')).toBe('make build\nmake test')
  })

  it('keeps only the prompt lines of a console block', () => {
    expect(fenced('$ ls -la\ntotal 8\n-rw-r--r-- 1 a b 0 x\n% cat notes/a.txt\nhello', 'console')).toBe('ls -la\ncat notes/a.txt')
    expect(fenced('total 8', 'console')).toBeNull()
  })

  it('takes a block with no language only when every line is a command', () => {
    expect(fenced('uv run scripts/x.py', null)).toBe('uv run scripts/x.py')
    expect(fenced('! rm -rf build', '')).toBe('rm -rf build')
    expect(fenced('uv run scripts/x.py\nsome output', null)).toBeNull()
  })

  it('is never a command in another language', () => {
    expect(fenced('ls -la', 'python')).toBeNull()
    expect(fenced('ls -la', 'json')).toBeNull()
  })

  it('treats a multi-line block as one review-only command', () => {
    expect(looksAutoRunnable(fenced('ls\nls -la')!)).toBe(false)
  })

  it('leaves a `!` that is not at the start alone', () => {
    expect(fenced('git log --format=!x', 'bash')).toBe('git log --format=!x')
  })
})

describe('commandFirstWord', () => {
  it('names the output attachment after the command', () => {
    expect(commandFirstWord('uv run scripts/x.py')).toBe('uv')
    expect(commandFirstWord('./scripts/run.sh --x')).toBe('run.sh')
    expect(commandFirstWord('$$$')).toBe('command')
  })
})

describe('commandOutputFilename', () => {
  it('names an own script\'s output after the script, else after the first word', () => {
    expect(commandOutputFilename('uv run scripts/check_credentials.py --live')).toBe('output-check_credentials.txt')
    expect(commandOutputFilename('python3 scripts/a.b.py')).toBe('output-a.b.txt')
    expect(commandOutputFilename('./run.sh --x')).toBe('output-run.txt')
    expect(commandOutputFilename('ls -la')).toBe('output-ls.txt')
    expect(commandOutputFilename('rm -rf build | tee x')).toBe('output-rm.txt')
  })
})
