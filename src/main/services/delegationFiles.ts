import { redactCredentialText } from '../security/serviceCredentialRedaction'
import {
  constants, lstatSync, mkdirSync, openSync, closeSync, writeFileSync, linkSync, unlinkSync, readFileSync,
  readdirSync
} from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { HANDOVER_HOW_TO_REPORT, isHandoverId, parseHandoverBrief } from '../../shared/handovers'
import { formatCustom } from '../../shared/folderTasks'
import type { TaskCustomFields, TaskPriority } from '../../shared/tasks'

/** Never follow a project-controlled symlink when writing on a requester's behalf. */
function directory(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) {
    throw new Error('The handover path must be a real directory.')
  }
}

export function handoverPaths(folder: string, id: string) {
  if (!isHandoverId(id)) {
    throw new Error('Use a handover id of 3–64 lowercase letters, digits, dots, dashes or underscores.')
  }
  const path = join(resolve(folder), '.cinna', 'handovers', id)
  return {
    folder: path,
    briefPath: join(path, 'brief.md'),
    reportPath: join(path, 'report.md'),
    revisionsDir: join(path, 'revisions')
  }
}

function ensureTree(folder: string, id: string): ReturnType<typeof handoverPaths> {
  const paths = handoverPaths(folder, id)
  directory(join(resolve(folder), '.cinna'))
  directory(join(resolve(folder), '.cinna', 'handovers'))
  directory(paths.folder)
  return paths
}

function atomicWrite(path: string, content: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
  const fd = openSync(temporary, flags, 0o600)
  try {
    writeFileSync(fd, redactCredentialText(content), 'utf8')
  } finally {
    closeSync(fd)
  }
  try {
    // Publish complete bytes without replacement. rename() can overwrite a
    // ready brief another process created after our existence check.
    linkSync(temporary, path)
  } finally {
    unlinkSync(temporary)
  }
}

export interface DelegationFileInput {
  folder: string
  id: string
  title: string
  brief: string
  /** `null`: the brief says nothing and the receiving folder's setting decides. */
  execution: 'ask' | 'auto' | null
  status: 'draft' | 'ready'
  agentId: string
  chatId: string
  taskId: string | null
  depth: number
  group?: string
  /** Written as `priority:`; absent leaves the task at its default. */
  priority?: TaskPriority
  /** Written as top-level keys, which the receiving side reads as the task's custom fields. */
  customFields?: TaskCustomFields
}

/** The same fields, compared as the brief's reader sees them: absent and empty are one. */
function sameCustomFields(read: TaskCustomFields | null, written: TaskCustomFields | undefined): boolean {
  const left = read ?? {}
  const right = written ?? {}
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length &&
    keys.every((key) => key in right && JSON.stringify(left[key]) === JSON.stringify(right[key]))
}

/** Whether a brief is already written at this id (followed by `createDelegationBrief`'s own checks). */
export function delegationBriefExists(folder: string, id: string): boolean {
  try {
    lstatSync(handoverPaths(folder, id).briefPath)
    return true
  } catch {
    return false
  }
}

export function createDelegationBrief(input: DelegationFileInput) {
  const paths = ensureTree(input.folder, input.id)
  const body = `${input.brief.trim()}\n\n${HANDOVER_HOW_TO_REPORT}`
  try {
    const stat = lstatSync(paths.briefPath)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('The existing brief must be a regular file.')
    const parsed = parseHandoverBrief(readFileSync(paths.briefPath, 'utf8'), { handoverId: input.id })
    const sameBrief =
      parsed.ok &&
      parsed.brief.origin?.agentId === input.agentId &&
      parsed.brief.origin?.chatId === input.chatId &&
      (parsed.brief.origin?.taskId ?? null) === input.taskId &&
      parsed.brief.title === input.title &&
      parsed.brief.body === body &&
      // An omitted `execution` has no opinion and matches whatever the brief says; a stated one must match.
      (input.execution === null || parsed.brief.execution === input.execution) &&
      parsed.brief.group === (input.group ?? null) &&
      parsed.brief.priority === (input.priority ?? null) &&
      sameCustomFields(parsed.brief.customFields, input.customFields)
    if (!parsed.ok || !sameBrief) {
      throw new Error('This handover id already belongs to a different brief. Choose a new id.')
    }
    return { ...paths, status: parsed.brief.status }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const content = [
    '---',
    'cinna_handover: 1',
    `title: ${JSON.stringify(input.title)}`,
    `status: ${input.status}`,
    ...(input.execution ? [`execution: ${input.execution}`] : []),
    'origin:',
    `  agent: ${JSON.stringify(input.agentId)}`,
    `  chat: ${JSON.stringify(input.chatId)}`,
    ...(input.taskId ? [`  task: ${JSON.stringify(input.taskId)}`] : []),
    `depth: ${input.depth}`,
    ...(input.group ? [`group: ${JSON.stringify(input.group)}`] : []),
    ...(input.priority ? [`priority: ${input.priority}`] : []),
    ...Object.entries(input.customFields ?? {}).map(([key, value]) => {
      const token = formatCustom(value)
      return token === '' ? `${key}:` : `${key}: ${token}`
    }),
    '---',
    body,
    ''
  ].join('\n')
  const written = parseHandoverBrief(content, { handoverId: input.id })
  // A custom field that does not read back as itself (a key the brief owns, or
  // one the task-file reader leaves out) would reach the task as something else.
  if (!written.ok || !sameCustomFields(written.brief.customFields, input.customFields)) {
    throw new Error('The brief could not be represented in the handover file format.')
  }
  atomicWrite(paths.briefPath, content)
  return { ...paths, status: input.status }
}

export function createDelegationRevision(folder: string, id: string, message: string): string {
  const paths = ensureTree(folder, id)
  directory(paths.revisionsDir)
  const ordinals = readdirSync(paths.revisionsDir)
    .filter((name) => /^\d{3}\.md$/.test(name))
    .map((name) => Number(name.slice(0, 3)))
  const ordinal = Math.max(0, ...ordinals) + 1
  if (ordinal > 999) throw new Error('This handover already has 999 revisions.')
  const path = join(paths.revisionsDir, `${String(ordinal).padStart(3, '0')}.md`)
  atomicWrite(path, `---\ncinna_handover: 1\n---\n${message.trim()}\n`)
  return path
}
