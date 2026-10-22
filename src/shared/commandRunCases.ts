/**
 * Test fixture, shared by `commandRun.test.ts` (the menu's disk-free check)
 * and `ownCommandPolicy.test.ts` (main's rule against a real folder), so the
 * two are held to one table. Every path a row names is created there by
 * {@link COMMAND_CASE_FILES}.
 *
 * [code text, detected command (null: not a command), whether the menu offers Run]
 */
export const COMMAND_CASES: readonly [string, string | null, boolean][] = [
  ['uv run scripts/load_time_keys.py --apply', 'uv run scripts/load_time_keys.py --apply', true],
  ['uv run scripts/check_credentials.py --live', 'uv run scripts/check_credentials.py --live', true],
  ['! uv run scripts/x.py', 'uv run scripts/x.py', true],
  ['!uv run scripts/x.py', 'uv run scripts/x.py', true],
  ['$ uv run scripts/x.py', 'uv run scripts/x.py', true],
  ['./run.sh', './run.sh', true],
  ['ls -la', 'ls -la', true],
  ['cat notes/a.txt', 'cat notes/a.txt', true],
  ['tail -n 5 notes/a.txt', 'tail -n 5 notes/a.txt', true],
  ['grep -r foo notes', 'grep -r foo notes', true],
  ['rg foo notes', 'rg foo notes', true],
  ['find . -name a.txt', 'find . -name a.txt', true],
  ['! rm -rf build', 'rm -rf build', false],
  ['rm -rf build', 'rm -rf build', false],
  ['ls | sh', 'ls | sh', false],
  ['cat x > y', 'cat x > y', false],
  ['uv run ../evil.py', 'uv run ../evil.py', false],
  ['uv run /tmp/x.py', 'uv run /tmp/x.py', false],
  ['git status', 'git status', false],
  ['echo $(whoami)', 'echo $(whoami)', false],
  ['uv run scripts/x.py && rm y', 'uv run scripts/x.py && rm y', false],
  // A search with no root, or rooted at the folder itself, and an option outside the tables.
  ['rg foo', 'rg foo', false],
  ['grep -r foo .', 'grep -r foo .', false],
  ['grep -r foo ./', 'grep -r foo ./', false],
  ['tail -f README.md', 'tail -f README.md', false],
  ['cat -f notes/a.txt', 'cat -f notes/a.txt', false],
  ['find . -delete', 'find . -delete', false],
  ['FOO=1 uv run scripts/x.py', null, false],
  ['!', null, false],
  ['git', null, false],
  ['tasks_report', null, false],
  ['not a command here', null, false]
]

/** The files the table's rows name, relative to the agent's folder. */
export const COMMAND_CASE_FILES: readonly string[] = [
  'scripts/load_time_keys.py', 'scripts/check_credentials.py', 'scripts/x.py', 'run.sh', 'notes/a.txt', 'README.md'
]
