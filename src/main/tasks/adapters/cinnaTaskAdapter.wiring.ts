/**
 * The production world for {@link createCinnaTaskAdapter} — the one file under
 * `tasks/adapters/` that names `cinnaApiFetch`, `cinnaFileService` and the user
 * repository.
 *
 * Separate from the adapter itself for the reason the drivers keep the same
 * split (`agents/drivers/index.ts`): the adapter is where the mapping lives and
 * it has to be drivable against a fake HTTP layer, with no Electron, no
 * database and no credential store. Everything those require is here, behind
 * four functions.
 */

import { cinnaApiFetch, getCinnaServerUrl } from '../../services/cinnaApiService'
import { cinnaFileService, CinnaFileError } from '../../services/cinnaFileService'
import { userRepo } from '../../db/users'
import { createCinnaTaskAdapter, type CinnaWorld } from './cinnaTaskAdapter'
import { RemoteTaskError, type RemoteAvailability, type RemoteTaskAdapter } from './adapter'

const world: CinnaWorld = {
  request: (userId, path, opts) => cinnaApiFetch(userId, path, opts),

  serverUrl: (userId) => getCinnaServerUrl(userId),

  /**
   * Answered from the local user row, never from the network.
   *
   * `availability()` is asked on every render of a bound task, and a task whose
   * service is unreachable must still open — so "is this profile linked" is a
   * question about what is on this machine. The reason is a sentence because it
   * is shown rather than logged.
   */
  linked: (userId): RemoteAvailability => {
    const user = userRepo.get(userId)
    if (!user) {
      return { ready: false, reason: 'This profile no longer exists on this device.' }
    }
    if (user.type !== 'cinna_user') {
      return {
        ready: false,
        reason: 'This profile is not linked to a Cinna account, so nothing is being sent to it.'
      }
    }
    if (!user.cinnaServerUrl) {
      return { ready: false, reason: 'This profile has no Cinna server configured.' }
    }
    return { ready: true }
  },

  /**
   * An upload, with its failures translated into the seam's vocabulary.
   *
   * `cinnaFileService` throws {@link CinnaFileError}, not `CinnaApiError`, and
   * the adapter's classifier does not know that type — so without this an
   * unreadable path, a file type the server refuses and a 413 all arrive as
   * `unavailable` and are retried for ever. The two the desktop can be sure
   * about are named, a 4xx is a refusal, and anything that never became a
   * response stays retryable.
   */
  uploadFile: async (userId, path) => {
    try {
      return (await cinnaFileService.uploadFromPath(userId, path)).id
    } catch (err) {
      if (!(err instanceof CinnaFileError)) throw err
      if (err.code === 'file_not_readable' || err.code === 'file_not_writable') {
        // The remote was never asked, and asking again will not help: the path
        // the artifact names is not one this process can read.
        throw new RemoteTaskError('invalid_request', 'That file could not be read.', err.message)
      }
      if (err.code === 'not_cinna_user' || err.code === 'missing_server_url') {
        throw new RemoteTaskError('unavailable', 'This profile is not connected to Cinna.', err.message)
      }
      if (err.code === 'reauth_required') {
        throw new RemoteTaskError(
          'unavailable',
          'Sign in to Cinna again to upload this file.',
          err.message
        )
      }
      // `upload_failed` is two different failures behind one code — a socket
      // that died, and a file the server will not take — so the status is what
      // separates them. Mapping the whole code one way means either a proxy
      // hiccup loses the user's file, or a rejected file type becomes work
      // every later push redoes first. Neither 415 nor 413 improves on a retry.
      if (err.status !== undefined && err.status >= 400 && err.status < 500) {
        throw new RemoteTaskError('rejected', 'Cinna would not take that file.', err.message)
      }
      throw new RemoteTaskError('unavailable', 'The file could not be uploaded.', err.message)
    }
  }
}

export const cinnaTaskAdapter: RemoteTaskAdapter = createCinnaTaskAdapter(world)
