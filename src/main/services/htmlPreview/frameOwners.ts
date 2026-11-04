/**
 * Which renderer opened each dashboard frame token, so a renderer that goes
 * away without unmounting its frames — a window reload, a renderer crash, a
 * closed window — releases them all at once. A frame is otherwise released
 * only by its React effect cleanup, which never runs then; a cloud tile's
 * page state would keep telling core the page listens for highlights (D6.5).
 *
 * Owners are opaque numbers (a webContents id); the desktop host says when
 * one is gone (`host/desktop/dashboardFrameOwners.ts`). Core module: no Electron.
 */
export interface FrameOwners {
  /** `token` was opened by `owner`. */
  own: (owner: number, token: string) => void
  /** `token` was released by its renderer: no longer tracked. */
  forget: (token: unknown) => void
  /** `owner` is gone: release every token it still holds; answers how many. */
  releaseOwner: (owner: number) => number
  /** Tokens `owner` holds now (tests). */
  tokensOf: (owner: number) => string[]
}

export function createFrameOwners(release: (token: string) => void): FrameOwners {
  const byOwner = new Map<number, Set<string>>()
  const ownerOf = new Map<string, number>()
  return {
    own(owner, token) {
      const previous = ownerOf.get(token)
      if (previous !== undefined) byOwner.get(previous)?.delete(token)
      ownerOf.set(token, owner)
      let set = byOwner.get(owner)
      if (!set) byOwner.set(owner, (set = new Set()))
      set.add(token)
    },
    forget(token) {
      if (typeof token !== 'string') return
      const owner = ownerOf.get(token)
      if (owner === undefined) return
      ownerOf.delete(token)
      const set = byOwner.get(owner)
      set?.delete(token)
      if (set && set.size === 0) byOwner.delete(owner)
    },
    releaseOwner(owner) {
      const set = byOwner.get(owner)
      if (!set) return 0
      byOwner.delete(owner)
      const tokens = [...set]
      for (const token of tokens) {
        ownerOf.delete(token)
        release(token)
      }
      return tokens.length
    },
    tokensOf(owner) {
      return [...(byOwner.get(owner) ?? [])]
    }
  }
}
