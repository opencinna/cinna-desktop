import { useEffect, useState } from 'react'
import { unwrapIpcError } from './ipcError'
import { useAuthStore } from '../stores/auth.store'

/**
 * Image bytes as `data:` URLs, kept per session so a transcript re-render or
 * remount never fetches the same image twice. Two caches: small thumbnails
 * (`files:read-thumbnail`, at most {@link MAX_THUMBNAIL_READS} in flight, so a
 * transcript full of images does not read them all at once) and full images
 * for the preview (`files:read-image`).
 */

/** Where an image comes from: an attachment, or a composer file not sent yet. */
export type ImageRef =
  | { type: 'attachment'; fileId: string; source: 'cinna' | 'local' }
  | { type: 'path'; path: string }

export type ImageSize = 'thumbnail' | 'full'

export type ImageLoad = { ok: true; dataUrl: string } | { ok: false; error: string }

/** Oldest entries go first past this many. */
const MAX_ENTRIES: Record<ImageSize, number> = { thumbnail: 300, full: 20 }

/** Thumbnail reads in flight at once; the rest wait, newest first, so the chat just opened is not stuck behind the one just left. */
export const MAX_THUMBNAIL_READS = 4

const settled: Record<ImageSize, Map<string, ImageLoad>> = { thumbnail: new Map(), full: new Map() }
const inFlight: Record<ImageSize, Map<string, Promise<ImageLoad>>> = { thumbnail: new Map(), full: new Map() }

let running = 0
const waiting: Array<() => void> = []

async function withThumbnailSlot<T>(run: () => Promise<T>): Promise<T> {
  if (running >= MAX_THUMBNAIL_READS) await new Promise<void>((resolve) => waiting.push(resolve))
  running += 1
  try {
    return await run()
  } finally {
    running -= 1
    waiting.pop()?.()
  }
}

/** A sent attachment's image: by id, in the store its `source` names (Cinna when absent). */
export function attachmentImageRef(attachment: { id: string; source?: 'cinna' | 'local' | 'pending' }): ImageRef {
  return attachment.source === 'pending'
    ? { type: 'path', path: attachment.id }
    : { type: 'attachment', fileId: attachment.id, source: attachment.source ?? 'cinna' }
}

/** Keyed by profile too: what one profile loaded is never served to another without main's ownership check. */
export function imageRefKey(ref: ImageRef): string {
  const profile = useAuthStore.getState().currentUser?.id ?? ''
  return ref.type === 'path' ? `${profile}|path:${ref.path}` : `${profile}|${ref.source}:${ref.fileId}`
}

function remember(size: ImageSize, key: string, load: ImageLoad): void {
  const cache = settled[size]
  cache.delete(key)
  cache.set(key, load)
  while (cache.size > MAX_ENTRIES[size]) cache.delete(cache.keys().next().value as string)
}

/** A loaded image, synchronously — what a component renders on its first paint. */
export function peekImage(ref: ImageRef, size: ImageSize = 'full'): ImageLoad | undefined {
  return settled[size].get(imageRefKey(ref))
}

/**
 * The image, from the cache or main. A failure is returned but not kept, so
 * the next mount (or the preview) asks again.
 */
export function loadImage(ref: ImageRef, size: ImageSize = 'full'): Promise<ImageLoad> {
  const key = imageRefKey(ref)
  const hit = settled[size].get(key)
  if (hit) {
    // Refresh its place: the most recently shown image is the last evicted.
    remember(size, key, hit)
    return Promise.resolve(hit)
  }
  const pending = inFlight[size].get(key)
  if (pending) return pending
  const input = ref.type === 'path' ? { path: ref.path } : { fileId: ref.fileId, source: ref.source }
  const read = (): ReturnType<typeof window.api.files.readImage> =>
    size === 'thumbnail' ? window.api.files.readThumbnail(input) : window.api.files.readImage(input)
  const request = (size === 'thumbnail' ? withThumbnailSlot(read) : read())
    .then(
      (result): ImageLoad => (result.success ? { ok: true, dataUrl: result.dataUrl } : { ok: false, error: result.error }),
      (err: unknown): ImageLoad => ({ ok: false, error: unwrapIpcError(err) })
    )
    .then((load) => {
      inFlight[size].delete(key)
      if (load.ok) remember(size, key, load)
      return load
    })
  inFlight[size].set(key, request)
  return request
}

/**
 * A composer file became an attachment (sent, or ingested into an open chat):
 * its images are already loaded under the path, so the attachment starts from
 * them instead of flashing back to a placeholder.
 */
export function carryImage(from: ImageRef, to: ImageRef): void {
  const fromKey = imageRefKey(from)
  const toKey = imageRefKey(to)
  for (const size of ['thumbnail', 'full'] as const) {
    const hit = settled[size].get(fromKey)
    if (hit?.ok && !settled[size].has(toKey)) remember(size, toKey, hit)
  }
}

/**
 * {@link carryImage} for an ingest: each path to the attachment made from it.
 * Ingest keeps the order of the paths it accepts, so equal lengths map by
 * position; otherwise only a unique filename-and-size match is trusted.
 */
export function carryIngestedImages(
  pending: ReadonlyArray<{ id: string; filename: string; size: number }>,
  ingested: ReadonlyArray<{ id: string; filename: string; size: number; source?: 'cinna' | 'local' }>
): void {
  const target = (file: (typeof ingested)[number]): ImageRef => ({
    type: 'attachment',
    fileId: file.id,
    source: file.source ?? 'cinna'
  })
  if (pending.length === ingested.length) {
    pending.forEach((p, i) => carryImage({ type: 'path', path: p.id }, target(ingested[i])))
    return
  }
  for (const p of pending) {
    const matches = ingested.filter((f) => f.filename === p.filename && f.size === p.size)
    if (matches.length === 1) carryImage({ type: 'path', path: p.id }, target(matches[0]))
  }
}

export type ImageState = { status: 'loading' } | { status: 'ready'; dataUrl: string } | { status: 'error'; error: string }

/** {@link loadImage} as component state; a cached image is `ready` on the first render. */
export function useImage(ref: ImageRef | null, size: ImageSize = 'full'): ImageState {
  const key = ref ? `${size}|${imageRefKey(ref)}` : null
  const initial = (): { key: string | null; state: ImageState } => {
    const hit = ref ? peekImage(ref, size) : undefined
    return { key, state: hit?.ok ? { status: 'ready', dataUrl: hit.dataUrl } : { status: 'loading' } }
  }
  const [current, setCurrent] = useState(initial)
  // A new ref starts from its own cache entry, during render, never from the last one's image.
  let view = current
  if (current.key !== key) {
    view = initial()
    setCurrent(view)
  }
  useEffect(() => {
    if (!ref || view.state.status === 'ready') return
    let live = true
    void loadImage(ref, size).then((load) => {
      if (!live) return
      setCurrent({ key, state: load.ok ? { status: 'ready', dataUrl: load.dataUrl } : { status: 'error', error: load.error } })
    })
    return () => {
      live = false
    }
    // `key` stands for `ref` and `size`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return view.state
}

/** Test-only. */
export function _resetImageCache(): void {
  for (const size of ['thumbnail', 'full'] as const) {
    settled[size].clear()
    inFlight[size].clear()
  }
  running = 0
  waiting.length = 0
}
