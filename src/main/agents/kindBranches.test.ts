import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The kind-branch ratchet — how many places decide what to do by asking *what
 * kind of agent* something is.
 *
 * Today the unit of abstraction is the transport. Whether a turn goes over A2A,
 * into the OpenCode engine or through the Claude SDK, whether a folder is a kit
 * or a bare directory, whether a job's run has a local chat — each is answered
 * by comparing `source`, `engine`, `kind` or `type` to a string literal at the
 * spot where the answer matters: the service that syncs, the IPC handler that
 * builds a client, the settings card that hides a tab. The agent runtime plan
 * (`drafts/agent_runtime/`) moves that decision behind an
 * `AgentDriver` that reports `capabilities()`, so a caller asks what an agent
 * can do rather than what it is. This test is the floor under that move: it
 * counts the literal comparisons and fails when a category grows.
 *
 * **Each phase lowers these limits.** A phase that removes branches sets the
 * numbers to the new count in the same commit. Raising one is allowed only with
 * a comment beside it naming the phase that pays it back; a limit raised
 * without one is a ceiling, and nobody reads a ceiling. The limits are per
 * category so a phase that lowers `source` cannot spend the headroom on a rise
 * in `kind`.
 *
 * What is counted, per file, in `src/main`, `src/shared` and `src/renderer/src`
 * (`.ts` / `.tsx`; never `*.test.*`, `node_modules`, `__golden__`,
 * `__snapshots__`), with either quote style, `===`/`!==` (and the loose forms),
 * on a bare identifier or a property access (`agent.source`, `row?.kind`), and
 * with the operands either way round (`'folder' === agent.source`):
 *
 * - `source`       — `source` / `…Source` against `'local' | 'remote' | 'folder'`,
 *                    plus every `isFolderAgent(` / `isFolderAgentId(` call (definitions excluded)
 * - `engine`       — `engine` / `…Engine` against `'opencode' | 'claude'`
 *                    (`declaredEngine` in the runtime panel is one)
 * - `kind`         — `kind` / `…Kind` against `'kit' | 'bare' | 'workshop' | 'external'`
 * - `jobType`      — the bare name `type` against `'local' | 'cinna_task'`; no
 *                    `…Type` suffix, because `remoteTargetType === 'agent'` and
 *                    every `mimeType` would come with it
 * - `providerType` — `providerType` against `'mcp' | 'agent'`
 *
 * Comments are blanked before matching: a doc comment quoting
 * `source === 'remote'` is not a branch, and three of them were in the first
 * measurement. The walk and the count happen here, in Node, and never in shell
 * `grep` — the `grep` in this environment is a ugrep wrapper that silently
 * misses matches, so a number from it is a guess.
 *
 * Noise the first measurement turned up. `'local'` is also a value of two
 * unrelated `'local' | 'cinna'` unions: an attachment's `FileScope` (fileService,
 * fileStore) and the account type chosen in `RegisterForm`. Those comparisons
 * are dropped by `NOT_A_KIND_BRANCH`, which names the file, the category and the
 * value, so a `source === 'folder'` added to fileService still counts. A file-
 * wide heuristic ("`'local'` counts only where `'cinna_task'` also appears")
 * was rejected: `JobEditForm` branches on job type without ever naming it.
 * Every other match was read and is a real branch.
 *
 * Known blind spots — branches on kind that are *not* counted:
 * - `switch (x.source) { case 'folder': … }`. Parsing the switch subject is not
 *   worth it for one site today (`sync/identity.ts`, allowlisted anyway).
 * - Membership and lookup: `['local', 'folder'].includes(a.source)`,
 *   `LABELS[agent.kind]`, a `Record<AgentSource, …>`.
 * - A branch behind a helper other than those two. A new helper is
 *   invisible until its call pattern is added here — which is the honest thing
 *   to do in the commit that introduces it.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')

type Category = 'source' | 'engine' | 'kind' | 'jobType' | 'providerType'

const CATEGORIES: Category[] = ['source', 'engine', 'kind', 'jobType', 'providerType']

/** Non-allowlisted branch sites per category, exactly as measured. Lowered by each phase. */
const LIMITS: Record<Category, number> = {
  // 31 comparisons + 5 `isFolderAgentId(` calls, counted since the phase 0
  // review widened the pattern: not new branches, previously unseen ones.
  source: 36,
  engine: 5,
  kind: 43,
  jobType: 29,
  providerType: 3
}

/** The sum of `LIMITS`, stated on its own so the headline number is greppable in a diff. */
const LIMIT = 116

/**
 * Files where branching on kind is the job, not a leak. Still counted and
 * printed, never held against a limit. An entry ending in `/` covers a folder.
 *
 * Sync is here because ownership is exactly what it decides: a remote row is
 * the server's, a folder row is the manifest's, a local row is the user's.
 * `source` keeps that meaning after the plan; it only stops meaning "how it runs".
 */
const ALLOWLIST: string[] = [
  'src/main/sync/collections.ts',
  'src/main/sync/identity.ts',
  'src/main/sync/manifest.ts',
  'src/main/sync/resolvers.ts'
  // Phase 2 adds 'src/main/agents/drivers/': a driver is where a kind branch belongs.
]

/** Comparisons that match a pattern but are not about agents or jobs. See the header. */
const NOT_A_KIND_BRANCH: { file: string; category: Category; value: string; why: string }[] = [
  {
    file: 'src/main/services/fileService.ts',
    category: 'source',
    value: 'local',
    why: "`opts.source` is an attachment's FileScope ('local' | 'cinna')"
  },
  {
    file: 'src/main/services/fileStore.ts',
    category: 'source',
    value: 'local',
    why: "`attachment.source` is an attachment's FileScope ('local' | 'cinna')"
  },
  {
    file: 'src/renderer/src/components/auth/RegisterForm.tsx',
    category: 'jobType',
    value: 'local',
    why: "`type` is the account being registered ('local' | 'cinna')"
  }
]

const ROOTS = ['src/main', 'src/shared', 'src/renderer/src']
const SKIP_DIRS = new Set(['node_modules', '__golden__', '__snapshots__'])

const OP = '(?:===|!==|==|!=)'
const QUOTE = "(['\"`])"
const RECEIVER = '(?:[\\w$]+!?\\??\\.)*'

/** `subject === 'value'` and `'value' === receiver.subject`, value captured as `value`. */
function comparisons(subject: string, values: string[]): RegExp[] {
  const value = `(?<value>${values.join('|')})`
  return [
    new RegExp(`\\b${subject}\\s*${OP}\\s*${QUOTE}${value}\\1`, 'g'),
    new RegExp(`${QUOTE}${value}\\1\\s*${OP}\\s*${RECEIVER}\\b${subject}\\b`, 'g')
  ]
}

const PATTERNS: Record<Category, RegExp[]> = {
  source: [
    ...comparisons('(?:source|\\w*Source)', ['local', 'remote', 'folder']),
    /(?<!function\s+)\bisFolderAgent\s*\(/g,
    /(?<!function\s+)\bisFolderAgentId\s*\(/g
  ],
  engine: comparisons('(?:engine|\\w*Engine)', ['opencode', 'claude']),
  kind: comparisons('(?:kind|\\w*Kind)', ['kit', 'bare', 'workshop', 'external']),
  jobType: comparisons('type', ['local', 'cinna_task']),
  providerType: comparisons('providerType', ['mcp', 'agent'])
}

/**
 * Blank `//` and `/* *\/` comments, keeping strings, template literals (and the
 * code inside `${…}`) and every newline. Not a parser: a regex literal holding
 * a quote or `//` can confuse it for the rest of that line, which is as far as
 * an unterminated quote is allowed to reach.
 */
function stripComments(src: string): string {
  let out = ''
  let mode: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code'
  const holes: number[] = [] // brace depth inside each open `${`
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    const next = src[i + 1]
    if (mode === 'line') {
      if (c === '\n') mode = 'code'
      out += c === '\n' ? c : ' '
      continue
    }
    if (mode === 'block') {
      if (c === '*' && next === '/') {
        mode = 'code'
        out += '  '
        i++
      } else {
        out += c === '\n' ? c : ' '
      }
      continue
    }
    if (mode !== 'code') {
      out += c
      if (c === '\\' && next !== undefined) {
        out += next
        i++
      } else if (mode === 'template') {
        if (c === '`') mode = 'code'
        else if (c === '$' && next === '{') {
          out += next
          i++
          holes.push(0)
          mode = 'code'
        }
      } else if (c === (mode === 'single' ? "'" : '"') || c === '\n') {
        mode = 'code'
      }
      continue
    }
    if (c === '/' && (next === '/' || next === '*')) {
      mode = next === '/' ? 'line' : 'block'
      out += '  '
      i++
      continue
    }
    out += c
    if (c === "'") mode = 'single'
    else if (c === '"') mode = 'double'
    else if (c === '`') mode = 'template'
    else if (holes.length > 0 && c === '{') holes[holes.length - 1]++
    else if (holes.length > 0 && c === '}') {
      if (holes[holes.length - 1] === 0) {
        holes.pop()
        mode = 'template'
      } else {
        holes[holes.length - 1]--
      }
    }
  }
  return out
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  const entries: Dirent[] = readdirSync(join(repoRoot, dir), { withFileTypes: true })
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const entry of entries) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) sourceFiles(rel, out)
    } else if (entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      out.push(rel)
    }
  }
  return out
}

function isAllowlisted(file: string): boolean {
  return ALLOWLIST.some((entry) => (entry.endsWith('/') ? file.startsWith(entry) : file === entry))
}

interface Row {
  file: string
  category: Category
  count: number
  allowlisted: boolean
}

function countFile(file: string, code: string): Row[] {
  const rows: Row[] = []
  for (const category of CATEGORIES) {
    let count = 0
    for (const pattern of PATTERNS[category]) {
      for (const match of code.matchAll(pattern)) {
        const value = match.groups?.value
        const noise = NOT_A_KIND_BRANCH.some(
          (n) => n.file === file && n.category === category && n.value === value
        )
        if (!noise) count++
      }
    }
    if (count > 0) rows.push({ file, category, count, allowlisted: isAllowlisted(file) })
  }
  return rows
}

function sum(rows: Row[]): number {
  return rows.reduce((total, row) => total + row.count, 0)
}

function report(rows: Row[]): string {
  const pad = (s: string | number, n: number): string => String(s).padStart(n)
  const lines = [
    'Kind branches over the limit. Remove the branch, or raise the limit with a comment',
    'naming the phase that pays it back.',
    '',
    `${'category'.padEnd(14)}${pad('counted', 8)}${pad('limit', 7)}${pad('allowlisted', 13)}`
  ]
  for (const category of CATEGORIES) {
    const inCategory = rows.filter((r) => r.category === category)
    lines.push(
      `${category.padEnd(14)}${pad(sum(inCategory.filter((r) => !r.allowlisted)), 8)}` +
        `${pad(LIMITS[category], 7)}${pad(sum(inCategory.filter((r) => r.allowlisted)), 13)}`
    )
  }
  lines.push(
    `${'total'.padEnd(14)}${pad(sum(rows.filter((r) => !r.allowlisted)), 8)}` +
      `${pad(LIMIT, 7)}${pad(sum(rows.filter((r) => r.allowlisted)), 13)}`,
    '',
    `${pad('count', 5)}  ${'category'.padEnd(14)}file`
  )
  const sorted = [...rows].sort(
    (a, b) =>
      b.count - a.count ||
      (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
      CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category)
  )
  for (const row of sorted) {
    lines.push(
      `${pad(row.count, 5)}  ${row.category.padEnd(14)}${row.file}${row.allowlisted ? '  (allowlisted)' : ''}`
    )
  }
  // Vitest appends ": expected [...]" to the message; give it a line of its own.
  lines.push('', 'over the limit')
  return lines.join('\n')
}

describe('kind-branch ratchet', () => {
  const files = ROOTS.flatMap((root) => sourceFiles(root))
  const rows = files.flatMap((file) =>
    countFile(file, stripComments(readFileSync(join(repoRoot, file), 'utf8')))
  )
  const counted = (category?: Category): number =>
    sum(rows.filter((r) => !r.allowlisted && (category === undefined || r.category === category)))

  it('walks the source tree', () => {
    // A wrong root counts zero branches and passes every limit.
    expect(files.length).toBeGreaterThan(300)
  })

  it('every category branches on kind exactly as often as its limit says', () => {
    // Equality, not a ceiling: a branch removed without lowering its limit
    // would leave room for a new one to arrive unnoticed in a later phase.
    const off = CATEGORIES.filter((c) => counted(c) !== LIMITS[c]).map((c) =>
      counted(c) > LIMITS[c]
        ? `${c}: ${counted(c)} > ${LIMITS[c]} (remove the branch, or raise the limit with a comment)`
        : `${c}: ${counted(c)} < ${LIMITS[c]} (lower LIMITS.${c} to ${counted(c)})`
    )
    if (counted() !== LIMIT) off.push(`total: ${counted()}, LIMIT says ${LIMIT}`)
    expect(off, report(rows)).toEqual([])
  })

  it('LIMIT is the sum of LIMITS', () => {
    expect(LIMIT).toBe(CATEGORIES.reduce((total, c) => total + LIMITS[c], 0))
  })

  it('every allowlist and exclusion entry names a path that exists', () => {
    // A renamed file leaves a stale entry behind; delete it rather than carry it.
    const paths = [...ALLOWLIST, ...NOT_A_KIND_BRANCH.map((n) => n.file)]
    expect(paths.filter((p) => !existsSync(join(repoRoot, p)))).toEqual([])
  })
})
