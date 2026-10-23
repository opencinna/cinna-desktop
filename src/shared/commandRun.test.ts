import { describe, expect, it } from 'vitest'
import { autoRunRefusal, chainsCommands, commandFirstWord, commandOutputFilename, detectCommand, looksAutoRunnable } from './commandRun'
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

describe('autoRunRefusal', () => {
  it('says nothing for what looksAutoRunnable passes', () => {
    expect(autoRunRefusal('ls -la')).toBeNull()
    expect(autoRunRefusal('uv run scripts/check.py italy')).toBeNull()
  })

  it.each([
    ['a block of lines', 'echo one\necho two'],
    ['a chain', 'make build && make test'],
    ['a sequence', 'cd x; ls'],
    ['a pipe', 'cat a.txt | wc -l'],
    ['an or', 'ls x || true'],
    ['a background job before another', 'sleep 1 & ls']
  ])('calls %s several commands', (_name, command) => {
    expect(chainsCommands(command)).toBe(true)
    expect(autoRunRefusal(command)).toBe('several_commands')
  })

  it.each([
    ['rm', 'rm -rf build'],
    ['a quoted operator', "echo 'a; b | c && d'"],
    ['an escaped semicolon', 'find . -name x -exec ls {} \\;'],
    ['a redirection of stderr', 'make 2>&1'],
    ['a trailing background job', 'sleep 60 &'],
    ['an absolute script', '/usr/local/bin/tool --x'],
    ['a heredoc', 'cat <<EOF > notes/out.txt\nfirst line\nsecond; line | x\nEOF'],
    ['a quoted, tab-stripped heredoc', "cat <<-'END'\n\tbody && more\n\tEND"],
    ['an unterminated heredoc', 'cat <<EOF\nbody\nmore'],
    ['a ; inside a trailing comment', 'rm -rf build # then; ls | wc'],
    ['a comment line under the command', 'rm -rf build\n# done; next'],
    ['a comment after a trailing background job', 'sleep 60 & # wait; then'],
    ['a here-string', 'wc -w <<< "a; b"'],
    ['a # inside a word', 'rm -rf build#1'],
    ['a heredoc with \\r\\n line endings', 'cat <<EOF > notes/out.txt\r\nfirst; line\r\nEOF'],
    ['an arithmetic or', 'echo $(( a | b ))']
  ])('calls %s not known to be read-only', (_name, command) => {
    expect(chainsCommands(command)).toBe(false)
    expect(autoRunRefusal(command)).toBe('not_read_only')
  })

  it.each([
    ['a command after a heredoc', 'cat <<EOF\nbody\nEOF\nls'],
    ['a chain on the heredoc line', 'cat <<EOF | wc -l\nbody\nEOF'],
    ['a command before a comment line', 'rm -rf build # one\nls'],
    ['a shift that is not a heredoc', 'echo $((1<<2))\nls'],
    ['a shift by a name in $((…))', 'echo $((x<<y))\nls'],
    ['a shift in ((…))', '(( n = x<<y ))\nls'],
    ['a command after a heredoc with \\r\\n line endings', 'cat <<EOF\r\nbody\r\nEOF\r\nls']
  ])('still calls %s several commands', (_name, command) => {
    expect(chainsCommands(command)).toBe(true)
  })
})
