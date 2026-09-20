vi.mock('../../host/runtimeHost', async () => {
  const { createDesktopHost } = await import('../../host/desktop/runtimeHost')
  return { runtimeHost: createDesktopHost() }
})
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RemoteTaskError } from './adapter'
import type { CinnaFileErrorCode } from '../../services/cinnaFileService'

/**
 * The production world, and specifically the one call in it that does **not**
 * go through `cinnaApiFetch`.
 *
 * An upload is multipart, through `cinnaFileService`, and that service throws
 * `CinnaFileError` — a different type with different codes from the
 * `CinnaApiError` the adapter's classifier understands. Untranslated, every
 * upload failure falls through to "the service did not answer": an unreadable
 * path and a file type the server refuses both become retryable, for ever.
 *
 * The rest of the world is a one-line pass-through and is exercised by the
 * contract suite; this file is about the translation.
 */

const holder = vi.hoisted(() => ({
  upload: null as null | (() => never),
  user: null as null | { type: string; cinnaServerUrl: string | null }
}))

vi.mock('electron', () => ({ net: { fetch: async () => new Response('{}') } }))
vi.mock('../../logger/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../../db/users', () => ({ userRepo: { get: () => holder.user } }))
vi.mock('../../services/cinnaApiService', () => ({
  cinnaApiFetch: async () => ({}),
  getCinnaServerUrl: () => 'https://cinna.test'
}))
vi.mock('../../services/cinnaFileService', async () => {
  const { DomainError } = await import('../../errors')
  // Mirrors the real class, `status` included — a stub that dropped the fourth
  // argument would have made the 4xx/5xx split untestable while looking fine.
  class CinnaFileError extends DomainError<string> {
    readonly status?: number
    constructor(code: string, message: string, detail?: string, status?: number) {
      super(code, message, detail)
      this.status = status
    }
  }
  return {
    CinnaFileError,
    cinnaFileService: {
      uploadFromPath: async () => {
        if (holder.upload) holder.upload()
        return { id: 'file-1' }
      }
    }
  }
})

const { cinnaTaskAdapter } = await import('./cinnaTaskAdapter.wiring')
const { CinnaFileError } = await import('../../services/cinnaFileService')

const USER = 'u-1'
const BINDING = { adapter: 'cinna', id: 'ct-1', key: 'TASK-1', url: null, state: {} }
const FILE = { kind: 'file' as const, name: 'report.md', ref: '/tmp/report.md' }

beforeEach(() => {
  holder.upload = null
  holder.user = { type: 'cinna_user', cinnaServerUrl: 'https://cinna.test' }
})

describe('what an upload failure means', () => {
  it.each([
    // A path this process cannot read. Asking again will not change that, and
    // the remote was never asked at all.
    ['file_not_readable', 'invalid_request', undefined],
    ['file_not_writable', 'invalid_request', undefined],
    // Nothing to send it to. Worth another pass once the profile is linked.
    ['not_cinna_user', 'unavailable', undefined],
    ['missing_server_url', 'unavailable', undefined],
    ['reauth_required', 'unavailable', undefined],
    // A file the server will not take. `upload_failed` is two failures behind
    // one code and the status is the only thing that separates them — without
    // it, either a proxy hiccup loses the user's file or a rejected file type
    // becomes work every later push redoes first.
    ['upload_failed', 'rejected', 415],
    ['upload_failed', 'rejected', 413],
    ['upload_failed', 'unavailable', 502],
    // A socket that died, or a 5xx. Worth another go.
    ['upload_failed', 'unavailable', undefined]
  ])('%s becomes %s', async (code, expected, status) => {
    holder.upload = () => {
      throw new CinnaFileError(
        code as CinnaFileErrorCode,
        'the upload did not work',
        undefined,
        status as number | undefined
      )
    }
    let thrown: unknown
    try {
      await cinnaTaskAdapter.putArtifact(USER, BINDING, FILE)
    } catch (err) {
      thrown = err
    }
    // Never a raw `CinnaFileError`: a caller that switches on the seam's codes
    // would see none of them and treat it as an unknown adapter fault.
    expect(thrown).toBeInstanceOf(RemoteTaskError)
    expect((thrown as RemoteTaskError).code).toBe(expected)
  })

  it('does not classify an error that is not the file service’s own, and does not lose it', async () => {
    holder.upload = () => {
      throw new TypeError('something else entirely')
    }
    let thrown: unknown
    try {
      await cinnaTaskAdapter.putArtifact(USER, BINDING, FILE)
    } catch (err) {
      thrown = err
    }
    // The wiring rethrows it untouched — it has no basis for a code — and the
    // adapter's own catch gives it the generic one, because the seam requires
    // every failure to be a `RemoteTaskError` (`failure.is_domain`). What must
    // not happen is the cause disappearing: a programming fault dressed as a
    // network blip with nothing left to read.
    expect(thrown).toBeInstanceOf(RemoteTaskError)
    expect((thrown as RemoteTaskError).detail).toContain('something else entirely')
  })
})

describe('whether the profile can reach the service', () => {
  it('answers from the local user row, without touching the network', async () => {
    expect(await cinnaTaskAdapter.availability(USER)).toEqual({ ready: true })
  })

  it.each([
    [null, 'no longer exists'],
    [{ type: 'local_user', cinnaServerUrl: null }, 'not linked'],
    [{ type: 'cinna_user', cinnaServerUrl: null }, 'no Cinna server']
  ])('says why not, in a sentence', async (user, fragment) => {
    holder.user = user as never
    const availability = await cinnaTaskAdapter.availability(USER)
    expect(availability.ready).toBe(false)
    // Shown, not logged: "unavailable" with no reason is a state the user
    // cannot act on.
    expect(availability.reason ?? '').toContain(fragment)
  })
})
