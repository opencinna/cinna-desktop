/**
 * `folder` — a bare agent's `.cinna/tasks/*.md` as a remote task store.
 *
 * The home of the tasks assigned to a bare folder agent: the files are the
 * truth, SQLite is the index. A pull reads the files (a stamp cache skips every
 * file that has not moved since the last read); a push patches **only the lines
 * Cinna owns** (`patchFolderTaskFile`) and publishes with temp + rename, so a
 * teammate's nested YAML, comments and key order survive every write.
 *
 * Shape of the binding: `id` is `<agentId>:<fileId>`, `key` the file id, `url`
 * null (a path is not a link `app:open-external` opens). `state` holds the
 * file's current name (a rename keeps the id), the digests last read and
 * written, the stamp, and `base` — the owned values as last read, which is what
 * the field-level merge compares against: **an owned field the file changed
 * since Cinna last read it wins over the local edit on that field.**
 *
 * What it does not have: assignee (the folder is the assignee), comments
 * (a comment is appended to the file's log section through
 * `localHome.appendLog`, an export nothing reads back), asks, execution,
 * artifacts. It is never a hand-off target and keeps no
 * transition table — a file's `status:` line takes whatever word it is given.
 *
 * Built over an injected {@link FolderTaskWorld} so the contract suite can run
 * it against a temp directory and count, fail and refuse its filesystem calls.
 * The production world is `folderTaskAdapter.wiring.ts`.
 */

import { createHash } from 'node:crypto'
import { join } from 'node:path'
import {
  EMPTY_FOLDER_BOARD,
  FOLDER_BOARD_FILE,
  FOLDER_TASKS_DIR,
  folderBoardColumns,
  folderCategoryForStatus,
  folderCustomFields,
  folderLabelMapsTo,
  folderStatusOf,
  folderTaskFileName,
  folderTaskId,
  folderTaskSlug,
  folderWordForStatus,
  isFolderTaskFileName,
  normalizeStatusWord,
  parseFolderBoard,
  parseFolderTaskFile,
  patchFolderTaskFile,
  renderFolderTaskFile,
  type FolderBoard,
  type FolderStatusCategory,
  type FolderTaskPatch,
  type ParsedFolderTask
} from '../../../shared/folderTasks'
import { isTaskPriority, type TaskCustomFieldValue, type TaskCustomFields, type TaskDto, type TaskPriority } from '../../../shared/tasks'
import type { TaskStatus } from '../../../shared/taskStatus'
import { createLogger } from '../../logger/logger'
import {
  RemoteTaskError,
  UnsupportedRemoteOperation,
  type RemoteBinding,
  type RemoteTaskAdapter,
  type RemoteTaskCapabilities,
  type RemoteTaskFields,
  type RemoteTaskSnapshot
} from './adapter'

const logger = createLogger('folder-tasks')

export const FOLDER_ADAPTER_ID = 'folder'

/** A bare agent whose folder holds a task queue. Enabled ones only. */
export interface FolderAgentRef {
  id: string
  name: string
  /** Absolute path of the agent folder. */
  path: string
}

/** One entry of `.cinna/tasks/`, from one listing. */
export interface FolderEntry {
  name: string
  /** `mtimeNs:size` — changes whenever the bytes might have. */
  stamp: string
  mtimeMs: number
  /** A regular file, not a symlink. Anything else is refused and skipped. */
  regular: boolean
}

/**
 * The filesystem as this adapter uses it. Every call is one "request" to the
 * contract suite, and every failure is a Node error with a `code`.
 */
export interface FolderFs {
  /**
   * The task files and `_board.yaml` directly in `dir` (`<agent>/.cinna/tasks`),
   * or null when the directory is absent — or is not a real directory, a
   * symlink at `.cinna` or `tasks` included, which is refused rather than
   * followed.
   */
  list(dir: string): FolderEntry[] | null
  /** The bytes of a regular file; a symlink is refused. */
  read(path: string): Buffer
  /** Replace an existing regular file by temp + rename. Returns the bytes written. */
  replace(path: string, content: string): Buffer
  /** Create a new file without replacing anything; null when the name is taken. */
  create(path: string, content: string): Buffer | null
  /** Make `<agent>/.cinna/tasks` as real directories; refuses a symlink on the way. */
  ensureDir(dir: string): void
  /** Delete a regular file; a symlink is refused, a missing file is not an error. */
  remove(path: string): void
}

export interface FolderTaskWorld {
  /** Every enabled bare agent. */
  agents(): Promise<FolderAgentRef[]>
  /**
   * The binding state this profile stored for each folder task, by binding
   * id. A pull has no binding in hand, and this is how it learns which digest
   * Cinna last wrote — so its own write still reads as its own after a
   * restart. Absent: nothing is known, and nothing reads as Cinna's.
   */
  states?(userId: string): Promise<Map<string, Record<string, unknown>>>
  fs: FolderFs
  randomBytes(size: number): Uint8Array
  /** Milliseconds now; `Date.now` when absent. The absence grace is measured on it. */
  now?(): number
}

/**
 * How long a task file must stay missing from a folder that **can** be read
 * before its task is called gone: two observations at least this far apart.
 * A `git checkout`, a `git stash` or an editor's save-by-rename takes the file
 * away for a moment — and a branch switch or a stash in a large repository can
 * take longer than five seconds, so the grace is thirty; a missing
 * `.cinna/tasks` (an unmounted volume, a renamed folder) never counts at all.
 */
export const FOLDER_ABSENCE_GRACE_MS = 30_000

/** What the binding's opaque state holds. Read nowhere outside this file. */
interface FolderState {
  file: string
  readDigest: string
  /**
   * The digest of the bytes Cinna last wrote — recognizes Cinna's own write.
   * Not a statement of trust: a push onto outside content writes too.
   */
  writtenDigest?: string
  /**
   * The digest of content Cinna vouches for: its own creation, a write onto
   * content that was already trusted, or the user's approval of outside
   * content (`localHome.trust`). Null = nothing trusted. Absent on a binding
   * stored before this field existed, where `writtenDigest` meant the same.
   */
  trustedDigest?: string | null
  stamp: string
  base: FolderBase
}

/** The two digests a binding carries forward. */
interface FolderDigests {
  written?: string
  trusted?: string
}

/** The owned values as last read — the merge's "what did the file say before". */
interface FolderBase {
  title: string | null
  description: string | null
  priority: string | null
  status: string | null
  /** Editable custom values, JSON-encoded so a comparison is one string compare. */
  custom: Record<string, string>
}

const CAPABILITIES: RemoteTaskCapabilities = {
  assigneeDirectory: false,
  create: true,
  writeStatus: true,
  archive: true,
  writeFields: ['title', 'description', 'priority', 'customFields'],
  comments: false,
  handoffNote: true,
  clearHandoffNote: true,
  writeArtifactKinds: [],
  subtasks: true,
  execute: false,
  asks: false,
  handoffTarget: false,
  transitionTable: false
}

/** One file, read. */
interface Item {
  name: string
  path: string
  parsed: ParsedFolderTask
  text: string
  digest: string
  mtimeMs: number
}

/** One folder, read. */
interface Folder {
  agent: FolderAgentRef
  dir: string
  board: FolderBoard
  /** By file id; a second file claiming an id already seen is skipped. */
  items: Map<string, Item>
  /** Status words as written, file order — the board's "in use". */
  inUse: string[]
  /**
   * Task file names that are there but do not parse, and whose last good read
   * this process does not have — a bound task whose file is one of these is
   * present, not gone.
   */
  unparsed: Set<string>
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

function errnoOf(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code
}

/**
 * A filesystem failure in this seam's words. A permission or a refused symlink
 * will fail the same way next time — `rejected`, the binding kept; anything
 * else (a disk that went away, a full one) is worth another pass.
 */
function asRemoteError(err: unknown, what: string): RemoteTaskError {
  if (err instanceof RemoteTaskError) return err
  const code = errnoOf(err)
  const detail = `${what}: ${err instanceof Error ? err.message : String(err)}`
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS' || code === 'ELOOP' || code === 'EISDIR') {
    return new RemoteTaskError('rejected', 'The task file could not be written.', detail)
  }
  return new RemoteTaskError('unavailable', 'The task folder could not be read.', detail)
}

function notOurs(detail: string): RemoteTaskError {
  return new RemoteTaskError('not_ours', 'This task’s file is no longer in its folder.', detail)
}

/** The file or its folder is not there to read right now — kept, and asked again. */
function notThere(detail: string): RemoteTaskError {
  return new RemoteTaskError('unavailable', 'This task’s file could not be read.', detail)
}

function priorityOf(raw: string | null): TaskPriority {
  const normalized = raw === null ? '' : normalizeStatusWord(raw)
  if (isTaskPriority(normalized)) return normalized
  if (normalized === 'medium') return 'normal'
  if (normalized === 'critical') return 'urgent'
  return 'normal'
}

function baseOf(parsed: ParsedFolderTask): FolderBase {
  const custom: Record<string, string> = {}
  for (const field of parsed.custom) if (field.editable) custom[field.key] = JSON.stringify(field.value)
  return {
    title: parsed.title,
    description: parsed.description,
    priority: parsed.priority,
    status: parsed.status,
    custom
  }
}

function stateOf(binding: RemoteBinding): Partial<FolderState> {
  return binding.state as Partial<FolderState>
}

/** A stored state's digests; an older binding without `trustedDigest` trusted what it wrote. */
function digestsOf(state: Partial<FolderState> | undefined): FolderDigests {
  const written = typeof state?.writtenDigest === 'string' ? state.writtenDigest : undefined
  const trusted = state && 'trustedDigest' in state
    ? (typeof state.trustedDigest === 'string' ? state.trustedDigest : undefined)
    : written
  return { written, trusted }
}

function digestsFor(known: Map<string, Record<string, unknown>>, bindingId: string): FolderDigests {
  return digestsOf(known.get(bindingId) as Partial<FolderState> | undefined)
}

function stemOf(name: string): string {
  return name.replace(/\.md$/i, '')
}

export function createFolderTaskAdapter(world: FolderTaskWorld): RemoteTaskAdapter {
  /**
   * Last read of each file, by absolute path. A file whose stamp still matches
   * is not read again — a pass over a hundred-task folder is one listing.
   */
  const cache = new Map<string, { stamp: string; item: Item }>()
  const boards = new Map<string, { stamp: string; board: FolderBoard }>()
  /** Each agent's board and words in use as last read, for the synchronous `statusWord`. */
  const lastRead = new Map<string, { board: FolderBoard; inUse: readonly string[] }>()
  /**
   * When each bound id was first seen missing from a folder that could be
   * read, by binding id. Cleared when the id shows up again or its folder
   * cannot be read; in memory only, so a restart starts the count again.
   */
  const absentSince = new Map<string, number>()
  const now = (): number => world.now?.() ?? Date.now()

  const forgetAbsences = (agent: FolderAgentRef, keep?: Map<string, Item>): void => {
    for (const key of [...absentSince.keys()]) {
      if (!key.startsWith(`${agent.id}:`)) continue
      if (!keep || keep.has(key.slice(agent.id.length + 1))) absentSince.delete(key)
    }
  }

  const require = (capability: keyof RemoteTaskCapabilities, operation: string): void => {
    const value = CAPABILITIES[capability]
    if (Array.isArray(value) ? value.length === 0 : !value) {
      throw new UnsupportedRemoteOperation(FOLDER_ADAPTER_ID, operation)
    }
  }
  const unsupported = (operation: string): never => {
    throw new UnsupportedRemoteOperation(FOLDER_ADAPTER_ID, operation)
  }

  const tasksDir = (agent: FolderAgentRef): string => join(agent.path, ...FOLDER_TASKS_DIR.split('/'))

  /** The agent and file id a binding names, or a refusal that keeps it. */
  async function locate(binding: RemoteBinding): Promise<{ agent: FolderAgentRef; fileId: string }> {
    if (binding.adapter !== FOLDER_ADAPTER_ID) {
      throw new RemoteTaskError('invalid_request', 'That task is not a folder task.', `adapter ${binding.adapter}`)
    }
    let agents: FolderAgentRef[]
    try {
      agents = await world.agents()
    } catch (err) {
      throw asRemoteError(err, 'listing folder agents')
    }
    const agent = agents.find((candidate) => binding.id.startsWith(`${candidate.id}:`))
    // A disabled or removed agent is not a deleted file: the task stays, and
    // comes back when the agent does. `not_ours` here would delete every task
    // of an agent the user merely switched off.
    if (!agent) {
      throw new RemoteTaskError('unavailable', 'This task’s agent is not available.', `no enabled folder agent for ${binding.id}`)
    }
    return { agent, fileId: binding.id.slice(agent.id.length + 1) }
  }

  /**
   * Read one folder: one listing, plus every file whose stamp moved. Null when
   * `.cinna/tasks` (or the agent folder itself) is not there — which says
   * nothing about any task in it. A listing that fails is `unavailable`, never
   * a refusal: a folder that cannot be read right now is not a verdict on it.
   */
  function readFolder(agent: FolderAgentRef): Folder | null {
    const dir = tasksDir(agent)
    let entries: FolderEntry[] | null
    try {
      entries = world.fs.list(dir)
    } catch (err) {
      forgetAbsences(agent)
      throw notThere(`listing ${dir}: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!entries) {
      forgetAbsences(agent)
      lastRead.delete(agent.id)
      return null
    }
    const folder: Folder = { agent, dir, board: EMPTY_FOLDER_BOARD, items: new Map(), inUse: [], unparsed: new Set() }

    const boardEntry = entries.find((entry) => entry.name === FOLDER_BOARD_FILE && entry.regular)
    if (boardEntry) {
      const path = join(dir, FOLDER_BOARD_FILE)
      const cached = boards.get(path)
      if (cached && cached.stamp === boardEntry.stamp) {
        folder.board = cached.board
      } else {
        try {
          folder.board = parseFolderBoard(world.fs.read(path).toString('utf8'))
          boards.set(path, { stamp: boardEntry.stamp, board: folder.board })
        } catch (err) {
          throw asRemoteError(err, 'reading _board.yaml')
        }
      }
    }

    const names = entries
      .filter((entry) => entry.regular && isFolderTaskFileName(entry.name))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of names) {
      const path = join(dir, entry.name)
      const cached = cache.get(path)
      let item = cached?.stamp === entry.stamp ? cached.item : undefined
      if (!item) {
        let bytes: Buffer
        try {
          bytes = world.fs.read(path)
        } catch (err) {
          // Gone between the listing and the read: skipped this pass, and
          // the absence count decides whether it is really gone. Unreadable:
          // present, so it keeps its last good read if there is one.
          if (errnoOf(err) === 'ENOENT') continue
          if (cached) item = cached.item
          else {
            folder.unparsed.add(entry.name)
            continue
          }
        }
        if (!item) {
          const text = bytes!.toString('utf8')
          const parsed = parseFolderTaskFile(text, stemOf(entry.name))
          if (parsed) {
            item = { name: entry.name, path, parsed, text, digest: sha256(bytes!), mtimeMs: entry.mtimeMs }
            cache.set(path, { stamp: entry.stamp, item })
          } else if (cached) {
            // Half-saved, or a frontmatter fence lost in an edit: the file is
            // there, so the task keeps what it last said rather than leaving.
            item = cached.item
          } else {
            folder.unparsed.add(entry.name)
            continue
          }
        }
      }
      if (folder.items.has(item.parsed.id)) {
        logger.warn('two task files claim one id; the first by name is used', { dir, id: item.parsed.id, file: item.name })
        continue
      }
      folder.items.set(item.parsed.id, item)
      if (item.parsed.status !== null) folder.inUse.push(item.parsed.status)
    }
    forgetAbsences(agent, folder.items)
    lastRead.set(agent.id, { board: folder.board, inUse: folder.inUse })
    return folder
  }

  function bindingFor(folder: Folder, item: Item, digests: FolderDigests = {}): RemoteBinding {
    const state: FolderState = {
      file: item.name,
      readDigest: item.digest,
      stamp: cache.get(item.path)?.stamp ?? '',
      base: baseOf(item.parsed),
      ...(digests.written ? { writtenDigest: digests.written } : {}),
      trustedDigest: digests.trusted ?? null
    }
    return {
      adapter: FOLDER_ADAPTER_ID,
      id: `${folder.agent.id}:${item.parsed.id}`,
      key: item.parsed.id,
      url: null,
      state: state as unknown as Record<string, unknown>
    }
  }

  /**
   * `digests` are what the stored binding carries. The file is trusted
   * (`ours`) exactly when its bytes still hash to the trusted digest — held in
   * the binding, so it survives a restart, and carried forward here so a pull
   * never erases it.
   */
  function snapshotOf(folder: Folder, item: Item, digests: FolderDigests): RemoteTaskSnapshot {
    const { parsed } = item
    const { status } = folderStatusOf(parsed.status, folder.board)
    // From the listing of this same pass, so the counts cost no read.
    let subtaskCount = 0
    let subtaskCompletedCount = 0
    for (const child of folder.items.values()) {
      if (child.parsed.parent !== parsed.id) continue
      subtaskCount += 1
      if (folderStatusOf(child.parsed.status, folder.board).status === 'completed') subtaskCompletedCount += 1
    }
    return {
      binding: bindingFor(folder, item, digests),
      title: parsed.title ?? stemOf(item.name),
      description: parsed.description,
      goal: null,
      status,
      priority: priorityOf(parsed.priority),
      errorMessage: null,
      assignee: { ref: folder.agent.id, name: folder.agent.name, kind: 'agent' },
      parentId: parsed.parent ? `${folder.agent.id}:${parsed.parent}` : null,
      subtaskCount,
      subtaskCompletedCount,
      updatedAt: new Date(item.mtimeMs),
      statusLabel: parsed.status,
      customFields: folderCustomFields(parsed),
      file: {
        path: item.path,
        digest: item.digest,
        ours: digests.trusted !== undefined && digests.trusted === item.digest,
        readOnlyFields: parsed.custom.filter((field) => !field.editable).map((field) => field.key),
        blockedBy: [...parsed.blockedBy]
      }
    }
  }

  /**
   * The bound file as the listing has it. Anything short of finding it is
   * `unavailable` — a write or a subtask listing never decides that a task is
   * gone. Only `fetch` (`confirm`) counts the absence, through {@link confirmGone}.
   */
  async function current(binding: RemoteBinding, confirm = false): Promise<{ folder: Folder; item: Item }> {
    const { agent, fileId } = await locate(binding)
    const folder = readFolder(agent)
    if (!folder) throw notThere(`${tasksDir(agent)} is not there`)
    const item = folder.items.get(fileId)
    if (!item) {
      if (confirm) confirmGone(binding, folder)
      throw notThere(`${fileId} is not in ${folder.dir}`)
    }
    return { folder, item }
  }

  /**
   * Throws `not_ours` once the bound id has been missing from this readable
   * folder on two reads at least {@link FOLDER_ABSENCE_GRACE_MS} apart, and
   * otherwise starts or continues the count. A file that is there but does
   * not parse is not missing.
   */
  function confirmGone(binding: RemoteBinding, folder: Folder): void {
    const name = stateOf(binding).file
    if (typeof name === 'string' && folder.unparsed.has(name)) return
    const since = absentSince.get(binding.id)
    const at = now()
    if (since === undefined) {
      absentSince.set(binding.id, at)
      return
    }
    if (at - since < FOLDER_ABSENCE_GRACE_MS) return
    absentSince.delete(binding.id)
    throw notOurs(`${binding.id} has not been in ${folder.dir} since ${new Date(since).toISOString()}`)
  }

  /**
   * The bound file for a write: its bytes read **now**, not the listing's
   * cached copy. The stamp cache cannot see an outside edit that kept the size
   * and the mtime (`cp -p`, `rsync -t`, a coarse clock), and a patch over the
   * cached text would publish the old content over it. Anything that is not
   * the same task, parsed, is `unavailable`: the write waits for a later pass.
   */
  async function forWrite(binding: RemoteBinding): Promise<{ folder: Folder; item: Item }> {
    const { agent, fileId } = await locate(binding)
    const folder = readFolder(agent)
    if (!folder) throw notThere(`${tasksDir(agent)} is not there`)
    const listed = folder.items.get(fileId)
    if (!listed) throw notThere(`${fileId} is not in ${folder.dir}`)
    let bytes: Buffer
    try {
      bytes = world.fs.read(listed.path)
    } catch (err) {
      if (errnoOf(err) === 'ENOENT') throw notThere(`${listed.name} went away before the write`)
      throw asRemoteError(err, `reading ${listed.name}`)
    }
    const text = bytes.toString('utf8')
    const parsed = parseFolderTaskFile(text, stemOf(listed.name))
    if (!parsed || parsed.id !== fileId) throw notThere(`${listed.name} is not task ${fileId} right now`)
    const digest = sha256(bytes)
    if (digest !== listed.digest) cache.delete(listed.path)
    return { folder, item: { ...listed, text, parsed, digest } }
  }

  /**
   * Publish a patch to the bound file and describe the result as a binding.
   * `prior` is the digests the binding already carried, kept when nothing
   * needed writing.
   *
   * **A write does not launder.** The new bytes are trusted only when the
   * bytes they replace were: a status, field, note or log entry Cinna pushes
   * onto content written outside Cinna leaves that content untrusted, so the
   * dispatcher's approval gate still asks about it. The new digest is still
   * recorded as Cinna's own write.
   */
  function write(folder: Folder, item: Item, patch: FolderTaskPatch, prior: FolderDigests): RemoteBinding {
    const next = patchFolderTaskFile(item.text, patch)
    if (next === item.text) return bindingFor(folder, item, prior)
    let bytes: Buffer
    try {
      bytes = world.fs.replace(item.path, next)
    } catch (err) {
      throw asRemoteError(err, `writing ${item.name}`)
    }
    const digest = sha256(bytes)
    // The listing that follows sees a new stamp and reads the file again; the
    // digest then matches `writtenDigest`, and `trustedDigest` when the
    // content was trusted before this write.
    cache.delete(item.path)
    const text = bytes.toString('utf8')
    const parsed = parseFolderTaskFile(text, stemOf(item.name)) ?? item.parsed
    const trusted = prior.trusted !== undefined && prior.trusted === item.digest ? digest : prior.trusted
    return bindingFor(folder, { ...item, text, parsed, digest }, { written: digest, trusted })
  }

  /** The word to write for a status, honouring a label a person chose when it fits. */
  function wordFor(folder: Folder, item: Item | null, status: TaskStatus, label?: string | null): string | null {
    const currentWord = item?.parsed.status ?? null
    if (label && folderLabelMapsTo(label, status, folder.board)) {
      return currentWord !== null && currentWord.trim() === label.trim() ? null : label.trim()
    }
    return folderWordForStatus(status, currentWord, folder.board, folder.inUse)
  }

  async function writeStatus(
    binding: RemoteBinding,
    status: TaskStatus,
    label?: string | null,
    merge = false
  ): Promise<RemoteBinding> {
    const { folder, item } = await forWrite(binding)
    const prior = digestsOf(stateOf(binding))
    // The merge, as for the other owned fields: a status word the file changed
    // since the last read wins over the local move, which is dropped — the
    // binding's base now matches the file, and the next pull brings its word in.
    const base = stateOf(binding).base
    if (merge && base !== undefined && base.status !== item.parsed.status) return bindingFor(folder, item, prior)
    const word = wordFor(folder, item, status, label)
    return word === null ? bindingFor(folder, item, prior) : write(folder, item, { status: word }, prior)
  }

  function customPatch(
    want: TaskCustomFields | null,
    item: Item,
    base: FolderBase | undefined
  ): Record<string, TaskCustomFieldValue | undefined> | null {
    const fields = want ?? {}
    const inFile = new Map(item.parsed.custom.map((field) => [field.key, field]))
    const patch: Record<string, TaskCustomFieldValue | undefined> = {}
    const fileChanged = (key: string): boolean => {
      if (!base) return false
      const before = base.custom[key]
      const field = inFile.get(key)
      const now = field?.editable ? JSON.stringify(field.value) : undefined
      return before !== now
    }
    for (const [key, value] of Object.entries(fields)) {
      const field = inFile.get(key)
      if (field && !field.editable) continue
      if (fileChanged(key)) continue
      if (field && JSON.stringify(field.value) === JSON.stringify(value)) continue
      patch[key] = value
    }
    for (const field of item.parsed.custom) {
      if (!field.editable || field.key in fields || fileChanged(field.key)) continue
      patch[field.key] = undefined
    }
    return Object.keys(patch).length > 0 ? patch : null
  }

  const adapter: RemoteTaskAdapter = {
    id: FOLDER_ADAPTER_ID,

    capabilities: () => ({
      ...CAPABILITIES,
      writeFields: [...CAPABILITIES.writeFields],
      writeArtifactKinds: [...CAPABILITIES.writeArtifactKinds]
    }),

    // Files on this machine: nothing to link, nothing to sign in to. A folder
    // that cannot be read is a failure of that call, not of the adapter.
    async availability() {
      return { ready: true }
    },

    async listAssignees() {
      return unsupported('listAssignees')
    },

    async create(_userId, task: TaskDto, parent) {
      require('create', 'create')
      if (task.parentTaskId && !parent) {
        throw new RemoteTaskError('invalid_request', 'A subtask needs its parent.', 'parentTaskId set, parent binding missing')
      }
      const agentId = task.assignee.kind === 'agent' ? task.assignee.agentId : null
      let agents: FolderAgentRef[]
      try {
        agents = await world.agents()
      } catch (err) {
        throw asRemoteError(err, 'listing folder agents')
      }
      const agent = agentId ? agents.find((candidate) => candidate.id === agentId) : undefined
      if (!agent) {
        throw new RemoteTaskError('invalid_request', 'That agent has no folder to keep tasks in.', `assignee ${agentId ?? 'none'}`)
      }
      let parentId: string | null = null
      if (parent) {
        if (parent.adapter !== FOLDER_ADAPTER_ID || !parent.id.startsWith(`${agent.id}:`)) {
          throw new RemoteTaskError('invalid_request', 'A subtask must live in its parent’s folder.', `parent ${parent.adapter}:${parent.id}`)
        }
        parentId = parent.id.slice(agent.id.length + 1)
      }

      const dir = tasksDir(agent)
      try {
        world.fs.ensureDir(dir)
      } catch (err) {
        throw asRemoteError(err, 'making the task folder')
      }
      const folder = readFolder(agent)
      if (!folder) throw notThere(`${dir} is not there after making it`)
      if (parentId !== null && !folder.items.has(parentId)) {
        throw new RemoteTaskError('invalid_request', 'The parent task is not in this folder.', `parent ${parentId} is not in ${dir}`)
      }
      let id = folderTaskId(world.randomBytes(8))
      while (folder.items.has(id)) id = folderTaskId(world.randomBytes(8))
      const custom: TaskCustomFields = {}
      for (const [key, value] of Object.entries(task.customFields ?? {})) custom[key] = value
      const content = renderFolderTaskFile({
        id,
        title: task.title,
        status: wordFor(folder, null, task.status) ?? 'new',
        priority: task.priority,
        parent: parentId,
        origin: 'cinna',
        custom,
        description: task.description,
        handoffNote: task.handoffNote
      })
      const slug = folderTaskSlug(task.title)
      for (let attempt = 1; attempt <= 100; attempt += 1) {
        const name = folderTaskFileName(slug, attempt)
        const path = join(dir, name)
        let bytes: Buffer | null
        try {
          bytes = world.fs.create(path, content)
        } catch (err) {
          throw asRemoteError(err, `creating ${name}`)
        }
        if (!bytes) continue
        const digest = sha256(bytes)
        const parsed = parseFolderTaskFile(bytes.toString('utf8'), stemOf(name))
        const item: Item = {
          name, path, digest, mtimeMs: Date.now(), text: bytes.toString('utf8'),
          parsed: parsed ?? (parseFolderTaskFile(content, stemOf(name)) as ParsedFolderTask)
        }
        // Cinna wrote every byte of a file it created: trusted.
        return bindingFor(folder, item, { written: digest, trusted: digest })
      }
      throw new RemoteTaskError('rejected', 'No free file name for this task.', `${slug}.md and 99 more are taken in ${dir}`)
    },

    async putHandoffNote(_userId, binding, note) {
      require('handoffNote', 'putHandoffNote')
      const { folder, item } = await forWrite(binding)
      // Returned, so the sync service stores the new written digest with it.
      return write(folder, item, { handoffNote: note }, digestsOf(stateOf(binding)))
    },

    async pushFields(_userId, binding, fields: Partial<RemoteTaskFields>) {
      require('writeFields', 'pushFields')
      for (const key of Object.keys(fields)) {
        if (!(CAPABILITIES.writeFields as readonly string[]).includes(key)) unsupported(`pushFields(${key})`)
      }
      const { folder, item } = await forWrite(binding)
      // The merge: an owned field the file changed since the last read wins
      // over the local edit, and that edit is dropped — the next pull brings
      // the file's value in.
      const base = stateOf(binding).base
      const changedInFile = (key: 'title' | 'description' | 'priority'): boolean =>
        base !== undefined && base[key] !== item.parsed[key]
      const patch: FolderTaskPatch = {}
      if (fields.title !== undefined && !changedInFile('title') && fields.title !== item.parsed.title) {
        patch.title = fields.title
      }
      if (fields.description !== undefined && !changedInFile('description') &&
        (fields.description ?? null) !== item.parsed.description) {
        patch.description = fields.description
      }
      if (fields.priority !== undefined && !changedInFile('priority') && fields.priority !== priorityOf(item.parsed.priority)) {
        patch.priority = fields.priority
      }
      if (fields.customFields !== undefined) {
        const custom = customPatch(fields.customFields, item, base)
        if (custom) patch.custom = custom
      }
      return write(folder, item, patch, digestsOf(stateOf(binding)))
    },

    async pushStatus(_userId, binding, status, _reason, options) {
      require('writeStatus', 'pushStatus')
      // Filing away is `archive()`'s route, here as everywhere.
      if (status === 'archived') {
        throw new RemoteTaskError('invalid_request', 'Archiving is its own operation.', 'pushStatus(archived)')
      }
      return writeStatus(binding, status, options?.label, true)
    },

    async archive(_userId, binding) {
      require('archive', 'archive')
      return writeStatus(binding, 'archived')
    },

    async fetch(_userId, binding) {
      const { folder, item } = await current(binding, true)
      return snapshotOf(folder, item, digestsOf(stateOf(binding)))
    },

    async liveSession() {
      // A file says nothing about a running turn; Cinna's own runs are local.
      return null
    },

    async list(userId) {
      let agents: FolderAgentRef[]
      let known: Map<string, Record<string, unknown>>
      try {
        agents = await world.agents()
        known = (await world.states?.(userId)) ?? new Map()
      } catch (err) {
        throw asRemoteError(err, 'listing folder agents')
      }
      const snapshots: RemoteTaskSnapshot[] = []
      let failures = 0
      let first: unknown = null
      for (const agent of agents) {
        // One unreadable folder must not hide every other agent's queue. Its
        // tasks are absent from this answer, and the reconcile's `fetch` then
        // keeps them as `unavailable` rather than deleting them.
        try {
          // No `.cinna/tasks` is an agent with no queue yet, or a folder that
          // is away for now: nothing listed, nothing failed, and its bound
          // tasks are kept by `fetch` as `unavailable`.
          const folder = readFolder(agent)
          if (!folder) continue
          for (const item of folder.items.values()) {
            snapshots.push(snapshotOf(folder, item, digestsFor(known, `${agent.id}:${item.parsed.id}`)))
          }
        } catch (err) {
          failures += 1
          first ??= err
          logger.warn('a task folder could not be read', { agentId: agent.id, error: err instanceof Error ? err.message : String(err) })
        }
      }
      if (agents.length > 0 && failures === agents.length) throw asRemoteError(first, 'reading every task folder')
      return snapshots
    },

    async listSubtasks(userId, binding) {
      require('subtasks', 'listSubtasks')
      const { folder, item } = await current(binding)
      let known: Map<string, Record<string, unknown>>
      try {
        known = (await world.states?.(userId)) ?? new Map()
      } catch (err) {
        throw asRemoteError(err, 'reading stored folder bindings')
      }
      return [...folder.items.values()]
        .filter((candidate) => candidate.parsed.parent === item.parsed.id)
        .map((candidate) => snapshotOf(folder, candidate, digestsFor(known, `${folder.agent.id}:${candidate.parsed.id}`)))
    },

    async execute() {
      return unsupported('execute')
    },
    async addComment() {
      return unsupported('addComment')
    },
    async listComments() {
      return unsupported('listComments')
    },
    async putArtifact() {
      return unsupported('putArtifact')
    },
    async listOpenAsks() {
      return unsupported('listOpenAsks')
    },
    async answerAsk() {
      return unsupported('answerAsk')
    },

    localHome: {
      async accepts(agentId) {
        return (await world.agents()).some((agent) => agent.id === agentId)
      },
      async board(_userId, agentId, shown) {
        const agent = (await world.agents()).find((candidate) => candidate.id === agentId)
        if (!agent) return []
        const folder = readFolder(agent)
        const board = folder?.board ?? EMPTY_FOLDER_BOARD
        // A word a task row holds (a file not yet re-read, or one held while
        // its file is briefly gone) is in use as much as the files' words; a
        // task with no word — native, handover, delegation — sits in its
        // status's category.
        const inUse = [...(folder?.inUse ?? [])]
        const occupied = new Set<FolderStatusCategory>()
        for (const task of shown) {
          if (task.statusLabel !== null && task.statusLabel.trim() !== '') inUse.push(task.statusLabel)
          else occupied.add(folderCategoryForStatus(task.status))
        }
        return folderBoardColumns(board, inUse, [...occupied])
      },
      // The bound file, found by id in a fresh listing and read again now: a
      // file that no longer carries this task's id (renamed over, rewritten
      // by somebody) is not this task's and stays. Gone already is done.
      async discard(_userId, binding) {
        const { agent, fileId } = await locate(binding)
        const folder = readFolder(agent)
        const listed = folder?.items.get(fileId)
        if (!listed) return
        let bytes: Buffer
        try {
          bytes = world.fs.read(listed.path)
        } catch (err) {
          if (errnoOf(err) === 'ENOENT') return
          throw asRemoteError(err, `reading ${listed.name}`)
        }
        const parsed = parseFolderTaskFile(bytes.toString('utf8'), stemOf(listed.name))
        if (!parsed || parsed.id !== fileId) return
        try {
          world.fs.remove(listed.path)
        } catch (err) {
          throw asRemoteError(err, `deleting ${listed.name}`)
        }
        cache.delete(listed.path)
        absentSince.delete(binding.id)
      },
      async appendLog(_userId, binding, entry) {
        const { folder, item } = await forWrite(binding)
        // Trusted only if it was (`write`): a file someone else changed since
        // Cinna last trusted it is still theirs after Cinna adds a log entry.
        return write(folder, item, { appendLog: entry }, digestsOf(stateOf(binding)))
      },
      trust(_userId, binding, digest) {
        // The user approved exactly this content; nothing is read or written.
        const state: FolderState = { ...(binding.state as unknown as FolderState), trustedDigest: digest }
        return { ...binding, state: state as unknown as Record<string, unknown> }
      },
      statusWord(remoteId, status, current) {
        const agentId = [...lastRead.keys()].find((id) => remoteId.startsWith(`${id}:`))
        if (agentId === undefined) return undefined
        const { board, inUse } = lastRead.get(agentId)!
        return folderWordForStatus(status, current, board, inUse) ?? current ?? undefined
      }
    },

    // A pull between a local edit and its push keeps the base of every field
    // still owed, so the push still sees the file's own change of that field
    // and lets the file win it. The rest of the state (digests, file name,
    // the other fields' base) moves forward as read.
    stateWhileOwed(stored, incoming, owed) {
      const before = (stored as Partial<FolderState>).base
      const read = (incoming as Partial<FolderState>).base
      if (!before || !read || owed.length === 0) return incoming
      const base: FolderBase = { ...read, custom: { ...read.custom } }
      if (owed.includes('title')) base.title = before.title
      if (owed.includes('description')) base.description = before.description
      if (owed.includes('priority')) base.priority = before.priority
      if (owed.includes('status')) base.status = before.status
      if (owed.includes('customFields')) base.custom = { ...before.custom }
      return { ...incoming, base }
    },

    deepLink: () => null
  }
  return adapter
}
