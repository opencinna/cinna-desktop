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
 * - `source`       — `source` / `…Source` against `'local' | 'remote' | 'folder'` or
 *                    the `FOLDER_AGENT_SOURCE` constant, plus every `isFolderAgent(` /
 *                    `isFolderAgentId(` call (definitions excluded)
 * - `engine`       — `engine` / `…Engine` against `'opencode' | 'claude'`
 *                    (`declaredEngine` in the runtime panel is one)
 * - `kind`         — `kind` / `…Kind` against `'kit' | 'bare' | 'workshop' | 'external'`
 * - `jobType`      — the bare name `type` against `'local' | 'cinna_task'`; no
 *                    `…Type` suffix, because `remoteTargetType === 'agent'` and
 *                    every `mimeType` would come with it
 * - `providerType` — `providerType` against `'mcp' | 'agent'`
 * - `remoteAdapter` — an **equality comparison against an adapter id** (`'cinna'`,
 *                    and the ids §5.6 names as the reason the seam is an
 *                    interface): `remoteAdapter === 'cinna'`, `adapter.id ===
 *                    'cinna'`. Deliberately *not* every read of
 *                    `remote_adapter` — `taskRepo`, `taskService` and
 *                    `schema.ts` legitimately read it to ask *whether* a task
 *                    is bound and to pass the opaque id through to the DTO, and
 *                    a category that counted those would enter non-zero on code
 *                    that branches on nothing. Comparing it to a literal is the
 *                    thing that turns `cinna` from a file into a concept.
 * - `routing`      — every read of `.orchestrated`, the boolean that used to say
 *                    who answers in a chat. `chat.agentId && !chat.orchestrated`
 *                    was re-derived in five places before phase 4; the column
 *                    survives one more phase as a mirror of `chats.router`, and
 *                    the four sites that *write* the mirror are pinned in
 *                    `OWNERSHIP` rather than counted, because writing it is
 *                    their job. A read is a re-derivation, and there are none.
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
 * - **A subject renamed off the word the pattern looks for.** `adapterId ===
 *   'cinna'`, `service === 'cinna'`, a bare `id === 'cinna'` — every one a
 *   quoted-literal comparison, which is exactly what `remoteAdapter` claims to
 *   count, defeated by a one-word variable name. Worse in kind than the rest of
 *   this list, which is why it is spelled out: the category's own description
 *   would otherwise imply that literal comparisons are all caught. Widening the
 *   subject to any identifier would count `id === 'cinna'` in the auth and
 *   account-type code that legitimately compares against that string
 *   (`auth.ipc.ts`, `fileService`, `RegisterForm`), so the subject stays narrow
 *   and this stays a known gap.
 * - A branch behind a helper other than those two. A new helper is
 *   invisible until its call pattern is added here — which is the honest thing
 *   to do in the commit that introduces it.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')

type Category =
  | 'source'
  | 'engine'
  | 'kind'
  | 'jobType'
  | 'providerType'
  | 'routing'
  | 'remoteAdapter'

const CATEGORIES: Category[] = [
  'source',
  'engine',
  'kind',
  'jobType',
  'providerType',
  'routing',
  'remoteAdapter'
]

/**
 * The ids a `RemoteTaskAdapter` can have. `cinna` is the only one implemented;
 * the other three are the worked examples in §5.6 that the seam exists for, and
 * naming them here means the first `remoteAdapter === 'linear'` is counted the
 * day it is written rather than the day someone remembers to add it.
 */
const ADAPTER_IDS = ['cinna', 'linear', 'github', 'a2a']

/**
 * The two ways an adapter is named **without a string literal**: a
 * screaming-case constant with ADAPTER in it (`CINNA_ADAPTER_ID`), and a
 * concrete adapter's own `id` (`cinnaTaskAdapter.id`).
 */
const ADAPTER_CONSTANT = '(?:[A-Z][A-Z0-9_]*ADAPTER[A-Z0-9_]*|[a-z]\\w*Adapter\\.id)'

/** Non-allowlisted branch sites per category, exactly as measured. Lowered by each phase. */
const LIMITS: Record<Category, number> = {
  // Phase 2: 36 → 4. The turn, readiness, auth, attachment and command
  // branches moved into `agents/drivers/` (allowlisted); the ownership reads
  // that remain are pinned in `OWNERSHIP` instead of held here. What is left is
  // how *agent status* refreshes — `agentStatusService`, `statusViews`,
  // `useAgentStatus`, `useChatStream` — which no driver owns yet (phase 7).
  // The count also includes `source === FOLDER_AGENT_SOURCE`, counted since
  // phase 2: previously unseen, not new.
  source: 4,
  // **Zero, and the four reads that remain are pinned in `OWNERSHIP`.**
  //
  // Phase 3 owned this target and paid it: the config source no longer filters
  // by engine (the launcher is asked about one agent it was chosen for), and
  // the shared engine's own state — a row that said Running and offered Start —
  // went with the server. What is left is not behaviour dispatched on kind. It
  // is the *manifest's* `runtime.engine`, read by the two places that own that
  // field (the service that resolves and validates it, the panel that edits it)
  // and by the one card whose control exists only on one engine. Those are
  // pinned per file below, for the same reason sync's `source` reads are:
  // pretending they can be answered by `capabilities()` would mean hiding what
  // a file says from the code whose job is that file.
  engine: 0,
  // Phase 2: the `bare` prompt branch moved with the Claude wiring into
  // `agents/drivers/index.ts`.
  kind: 42,
  // Phase 6 adds one validation guard: autonomous routing belongs to a local
  // job. Phase 7's job-type cleanup moves this to the executor contract.
  jobType: 30,
  providerType: 3,
  // **Zero from the day it was added.** Phase 4 replaced every read of
  // `orchestrated` with `chats.router` behind `src/shared/chatRouting.ts`; what
  // is left is the four statements that keep the mirror in step with the
  // router, pinned per file in `OWNERSHIP`. The category exists so the next
  // read of the column — in the phase before it is dropped — has to be
  // deliberate.
  routing: 0,
  // **Zero from the day it was added**, and phase 5 step 8 is the step that
  // added it. `cinna` is a file, not a concept: `adapterFor(id)` is the one
  // lookup, `capabilities()` is what a caller asks, and nothing outside
  // `src/main/tasks/adapters/` (allowlisted) names a service. The category
  // exists so that the first `if (task.remoteAdapter === 'cinna')` — the
  // cheapest thing to write when step 11 folds in the `cinna_task` job path —
  // fails this test instead of shipping.
  remoteAdapter: 0
}

/** The sum of `LIMITS`, stated on its own so the headline number is greppable in a diff. */
const LIMIT = 79

/**
 * Files where branching on kind is the job, not a leak. Still counted and
 * printed, never held against a limit. An entry ending in `/` covers a folder.
 *
 * Sync is here because ownership is exactly what it decides: a remote row is
 * the server's, a folder row is the manifest's, a local row is the user's.
 * `source` keeps that meaning after the plan; it only stops meaning "how it runs".
 */
const ALLOWLIST: string[] = [
  // A driver is where a kind branch belongs (phase 2).
  'src/main/agents/drivers/',
  // And an adapter is where a *remote* branch belongs (phase 5). The registry
  // and the null adapter name ids because looking one up is their whole job.
  'src/main/tasks/adapters/',
  // And the routing helper is where a *routing* branch belongs (phase 4). Its
  // one read of `orchestrated` is the fallback for a chat DTO that predates
  // `chats.router` — the whole reason the mirror is still written.
  'src/shared/chatRouting.ts',
  'src/main/sync/collections.ts',
  'src/main/sync/identity.ts',
  'src/main/sync/manifest.ts',
  'src/main/sync/resolvers.ts'
]

/**
 * Files outside sync whose `source` reads are about **ownership** — who may
 * edit or delete a row, which settings page lists it, which account a synced
 * job's dependency belongs to — and not about how the agent runs.
 *
 * `source` keeps exactly that meaning after the plan, so these are not debt a
 * later phase pays back. They are not allowlisted either: a file-wide pass
 * would hide the next *behavioural* branch added beside them. Each entry pins
 * the file's count for its category **exactly**; the rows it covers are
 * printed and kept out of `LIMITS`, and a count that moves either way fails
 * until someone reads the new or vanished branch and decides which kind it is.
 * A behavioural one moves into a driver.
 */
const OWNERSHIP: { file: string; category: Category; count: number; why: string }[] = [
  {
    file: 'src/main/services/localScheduleService.ts',
    category: 'kind',
    count: 1,
    why: 'only a kit manifest owns schedule declarations; this validates the definition source, while execution uses the script and driver seams'
  },
  {
    file: 'src/main/services/localAgents/runtimeService.ts',
    category: 'engine',
    count: 2,
    why: "the manifest's own `runtime.engine`, read by the service that resolves it (a Claude runtime has no credential ladder) and refused by the one that validates it (an engine and a credential together)"
  },
  {
    file: 'src/renderer/src/components/agents/local/RuntimePanel.tsx',
    category: 'engine',
    count: 1,
    why: 'the editor for that field: the panel offering the choice has to name the values it writes'
  },
  {
    file: 'src/renderer/src/components/agents/local/PermissionsCard.tsx',
    category: 'engine',
    count: 1,
    why: 'the approvals control exists on one engine only, and the card reads the folder it edits rather than a capability the local-agent DTO does not carry'
  },
  {
    file: 'src/main/services/agentService.ts',
    category: 'source',
    count: 7,
    why: 'listMerged picks each scope by owner (4), setEnabled logs which scope it wrote (1), delete refuses a row sync or a folder owns (2)'
  },
  {
    file: 'src/main/services/localAgents/localAgentService.ts',
    category: 'source',
    count: 3,
    why: '`locate` refuses an id or row that is not a folder agent (2), and a rekey drops the stale folder descriptor from a synced job (1)'
  },
  {
    file: 'src/main/services/jobService.ts',
    category: 'source',
    count: 4,
    why: "a synced job manifest's dependency descriptors name the account or workshop that owns them"
  },
  {
    file: 'src/renderer/src/components/settings/AgentsSettingsSection.tsx',
    category: 'source',
    count: 2,
    why: 'which settings tab lists, and lets the user edit, a row'
  },
  {
    file: 'src/renderer/src/components/settings/AgentCard.tsx',
    category: 'source',
    count: 1,
    why: 'the bundle-install pill and update belong to a Cinna-synced install'
  },
  {
    file: 'src/renderer/src/components/settings/CatalogSettingsSection.tsx',
    category: 'source',
    count: 1,
    why: "a synced install's bundle version, keyed by its Cinna install id"
  },
  {
    file: 'src/renderer/src/components/jobs/JobEditForm.tsx',
    category: 'source',
    count: 1,
    why: 'the agent picker is grouped by owner (My Agents, Shared with Me, People, Local)'
  },
  {
    file: 'src/renderer/src/components/jobs/JobDetail.tsx',
    category: 'source',
    count: 1,
    why: '"Set up" opens the settings tab that owns the dependency'
  }
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
    /(?<!function\s+)\bisFolderAgentId\s*\(/g,
    // The same comparison against the constant for `'folder'`. Unseen until
    // phase 2 read the tree by hand and found two outside sync.
    new RegExp(`\\b(?:source|\\w*Source)\\s*${OP}\\s*FOLDER_AGENT_SOURCE\\b`, 'g'),
    new RegExp(`\\bFOLDER_AGENT_SOURCE\\s*${OP}\\s*${RECEIVER}\\b(?:source|\\w*Source)\\b`, 'g')
  ],
  engine: comparisons('(?:engine|\\w*Engine)', ['opencode', 'claude']),
  kind: comparisons('(?:kind|\\w*Kind)', ['kit', 'bare', 'workshop', 'external']),
  jobType: comparisons('type', ['local', 'cinna_task']),
  providerType: comparisons('providerType', ['mcp', 'agent']),
  remoteAdapter: [
    ...comparisons('(?:adapter|\\w*Adapter)', ADAPTER_IDS),
    // The same branch reached through the object: `adapter.id === 'cinna'`.
    new RegExp(
      `\\b(?:adapter|\\w*Adapter)!?\\??\\.id\\s*${OP}\\s*${QUOTE}(?<value>${ADAPTER_IDS.join('|')})\\1`,
      'g'
    ),
    // **And the same branch with no literal in it at all.** `source` has this
    // exact hole and closed it with the two `FOLDER_AGENT_SOURCE` patterns
    // above — whose comment records that it went unseen until someone read the
    // tree by hand. The trigger here is step 9: the moment `cinnaTaskAdapter`
    // exists, `binding.adapter === cinnaTaskAdapter.id` is the *natural* way to
    // write the branch, and it reads more correct than the literal does — no
    // magic string — which is what makes it likely rather than merely possible.
    // A screaming-case constant naming an adapter is the other shape.
    new RegExp(`\\b(?:adapter|\\w*Adapter)!?\\??(?:\\.id)?\\s*${OP}\\s*${ADAPTER_CONSTANT}`, 'g'),
    new RegExp(`${ADAPTER_CONSTANT}\\s*${OP}\\s*${RECEIVER}\\b(?:adapter|\\w*Adapter)\\b`, 'g')
  ],
  // Any read of the property, not a comparison: the re-derivations that phase 4
  // removed were `chat.agentId && !chat.orchestrated` and `chatData?.orchestrated
  // ? … : …`, neither of which compares it to a literal. A `key: value` write
  // (`orchestrated: router === 'coordinator'`) is excluded by the `.` — the
  // writers name the column, they do not read it off an object.
  routing: [/(?:\.|\?\.)orchestrated\b/g]
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
  /** Covered by an {@link OWNERSHIP} entry: printed and pinned there, not held against `LIMITS`. */
  ownership: boolean
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
    if (count > 0) {
      rows.push({
        file,
        category,
        count,
        allowlisted: isAllowlisted(file),
        ownership: OWNERSHIP.some((o) => o.file === file && o.category === category)
      })
    }
  }
  return rows
}

function sum(rows: Row[]): number {
  return rows.reduce((total, row) => total + row.count, 0)
}

function report(rows: Row[]): string {
  const pad = (s: string | number, n: number): string => String(s).padStart(n)
  const held = (r: Row): boolean => !r.allowlisted && !r.ownership
  const columns = (subset: Row[], limit: number): string =>
    `${pad(sum(subset.filter(held)), 8)}${pad(limit, 7)}` +
    `${pad(sum(subset.filter((r) => r.allowlisted)), 13)}${pad(sum(subset.filter((r) => r.ownership)), 11)}`
  const lines = [
    'Kind branches over the limit. Remove the branch, or raise the limit with a comment',
    'naming the phase that pays it back.',
    '',
    `${'category'.padEnd(14)}${pad('counted', 8)}${pad('limit', 7)}${pad('allowlisted', 13)}${pad('ownership', 11)}`
  ]
  for (const category of CATEGORIES) {
    lines.push(`${category.padEnd(14)}${columns(rows.filter((r) => r.category === category), LIMITS[category])}`)
  }
  lines.push(
    `${'total'.padEnd(14)}${columns(rows, LIMIT)}`,
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
      `${pad(row.count, 5)}  ${row.category.padEnd(14)}${row.file}` +
        `${row.allowlisted ? '  (allowlisted)' : ''}${row.ownership ? '  (ownership)' : ''}`
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
    sum(
      rows.filter(
        (r) => !r.allowlisted && !r.ownership && (category === undefined || r.category === category)
      )
    )

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

  it('every ownership file branches on ownership exactly as often as its entry says', () => {
    // Pinned both ways, like `LIMITS`: a new read in one of these files may be
    // behaviour, and a vanished one leaves room for one to arrive unread.
    const off = OWNERSHIP.flatMap((o) => {
      const actual = sum(rows.filter((r) => r.file === o.file && r.category === o.category))
      return actual === o.count
        ? []
        : [
            `${o.file} ${o.category}: ${actual}, entry says ${o.count} — read the branch that ` +
              'moved; a behavioural one belongs in a driver'
          ]
    })
    expect(off, report(rows)).toEqual([])
  })

  it('every allowlist and exclusion entry names a path that exists', () => {
    // A renamed file leaves a stale entry behind; delete it rather than carry it.
    const paths = [...ALLOWLIST, ...NOT_A_KIND_BRANCH.map((n) => n.file), ...OWNERSHIP.map((o) => o.file)]
    expect(paths.filter((p) => !existsSync(join(repoRoot, p)))).toEqual([])
  })
})
