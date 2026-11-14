/** `hello`, `layout.ensure`, `disk.usage`, `transcript.*`, `kv.*`. */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statfsSync, type Dirent } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { VAULTD_PROTOCOL, type TranscriptOp } from '../../../../../src/shared/vault/protocol'
import { layoutDirs } from './config'
import type { Ctx, Handler } from './context'
import { writeJsonAtomic } from './jsonFile'
import { chownTo } from './users'
import { CHAT_ID, invalid, KV_KEY } from './util'

export function layoutReady(ctx: Ctx): boolean {
  return layoutDirs(ctx.layout).every(([dir]) => existsSync(dir))
}

export const hello: Handler = async (ctx) => {
  let image = { version: ctx.config.fake ? 'fake' : 'unknown', node: process.version, uv: '' }
  if (ctx.config.imageFile) {
    try {
      const parsed = JSON.parse(readFileSync(ctx.config.imageFile, 'utf8')) as Record<string, unknown>
      image = {
        version: typeof parsed.version === 'string' ? parsed.version : image.version,
        node: typeof parsed.node === 'string' ? parsed.node : image.node,
        uv: typeof parsed.uv === 'string' ? parsed.uv : image.uv
      }
    } catch {
      // No image file: report what is known.
    }
  }
  return { protocol: VAULTD_PROTOCOL, image, layoutReady: layoutReady(ctx), fake: ctx.config.fake }
}

export const layoutEnsure: Handler = async (ctx) => {
  for (const [dir, mode, owner] of layoutDirs(ctx.layout)) {
    mkdirSync(dir, { recursive: true, mode: mode & 0o777 })
    // Owner first: chown clears the setgid bit chmod sets.
    chownTo(ctx, dir, owner)
    chmodSync(dir, mode)
  }
  return {}
}

export const diskUsage: Handler = async (ctx) => {
  const stat = statfsSync(ctx.config.root)
  return { usedBytes: (stat.blocks - stat.bfree) * stat.bsize, sizeBytes: stat.blocks * stat.bsize }
}

// ---------------------------------------------------------------------------
// Transcripts (D30): one append-only journal per vault chat.

function chatId(value: unknown): string {
  if (typeof value !== 'string' || !CHAT_ID.test(value)) throw invalid('Invalid chat id.')
  return value
}

const TABLES = ['messages', 'inflight']

function checkOp(op: unknown): TranscriptOp {
  if (typeof op !== 'object' || op === null) throw invalid('Invalid transcript op.')
  const o = op as Record<string, unknown>
  if (o.op === 'put' && TABLES.includes(o.table as string) && typeof o.row === 'object' && o.row !== null &&
      typeof (o.row as Record<string, unknown>).id === 'string') return o as unknown as TranscriptOp
  if (o.op === 'delete' && TABLES.includes(o.table as string) && typeof o.id === 'string') return o as unknown as TranscriptOp
  if (o.op === 'chat' && typeof o.updatedAt === 'number' && (o.title === undefined || typeof o.title === 'string')) {
    return o as unknown as TranscriptOp
  }
  throw invalid('Invalid transcript op.')
}

const journal = (ctx: Ctx, id: string): string => join(ctx.layout.transcripts, `${id}.jsonl`)

export const transcriptAppend: Handler = async (ctx, params) => {
  const id = chatId(params.chatId)
  if (!Array.isArray(params.ops)) throw invalid('Invalid transcript ops.')
  const ops = params.ops.map(checkOp)
  if (ops.length === 0) return {}
  mkdirSync(ctx.layout.transcripts, { recursive: true, mode: 0o700 })
  const text = ops.map((op) => JSON.stringify(op) + '\n').join('')
  await ctx.serial(`transcript:${id}`, async () => {
    const handle = await open(journal(ctx, id), 'a', 0o600)
    try {
      await handle.writeFile(text)
      await handle.sync()
    } finally {
      await handle.close()
    }
  })
  return {}
}

export const transcriptRead: Handler = async (ctx, params) => {
  const id = chatId(params.chatId)
  let text: string
  try {
    text = readFileSync(journal(ctx, id), 'utf8')
  } catch {
    return { ops: [] }
  }
  const ops: TranscriptOp[] = []
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      ops.push(JSON.parse(line) as TranscriptOp)
    } catch {
      // A torn last line from a crash mid-append: the ops before it stand.
    }
  }
  return { ops }
}

export const transcriptList: Handler = async (ctx) => {
  let entries: Dirent[]
  try {
    entries = readdirSync(ctx.layout.transcripts, { withFileTypes: true })
  } catch {
    return { chatIds: [] }
  }
  const chatIds = entries
    .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
    .map((e) => e.name.slice(0, -'.jsonl'.length))
    .filter((id) => CHAT_ID.test(id))
    .sort()
  return { chatIds }
}

export const transcriptDelete: Handler = async (ctx, params) => {
  const id = chatId(params.chatId)
  await ctx.serial(`transcript:${id}`, async () => rmSync(journal(ctx, id), { force: true }))
  return {}
}

// ---------------------------------------------------------------------------
// kv: one small JSON document, rewritten atomically.

const MAX_KV_BYTES = 4 * 1024 * 1024

function readKv(ctx: Ctx): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(ctx.layout.kv, 'utf8')) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function kvKey(value: unknown): string {
  if (typeof value !== 'string' || !KV_KEY.test(value)) throw invalid('Invalid key.')
  return value
}

export const kvGet: Handler = async (ctx, params) => {
  const key = kvKey(params.key)
  const all = readKv(ctx)
  return { value: Object.prototype.hasOwnProperty.call(all, key) ? all[key] : null }
}

export const kvPut: Handler = async (ctx, params) => {
  const key = kvKey(params.key)
  if (!('value' in params)) throw invalid('Missing value.')
  mkdirSync(ctx.layout.state, { recursive: true, mode: 0o700 })
  await ctx.serial('kv', async () => {
    const all = readKv(ctx)
    if (params.value === null) delete all[key]
    else all[key] = params.value
    if (Buffer.byteLength(JSON.stringify(all)) > MAX_KV_BYTES) throw invalid('The vault key-value store is full.')
    await writeJsonAtomic(ctx.layout.kv, all, 0o600)
  })
  return {}
}
