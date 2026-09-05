/**
 * Local development readiness, for the active Cinna profile.
 *
 * "Local development" here means the three things a user needs before they can
 * work on a Cinna agent on their own machine: a desktop-owned toolchain (uv,
 * cinna-cli, Mutagen), a cinna-cli **account workspace** under the Agents Home,
 * and a valid account token in it. The desktop installs and orchestrates; every
 * bit of workspace and sync semantics belongs to cinna-cli, which is why none of
 * the phases below describe files — only where the whole thing has got to.
 *
 * Broadcast like {@link UpdaterState}: one process-global value, pushed on every
 * transition, pulled by whoever mounts late. It is per *profile* in the sense
 * that switching accounts re-reconciles, but only one profile is active at a
 * time so there is only ever one state.
 */

export type LocalDevAttentionReason =
  /** The account token in the workspace is dead. Repair re-mints it. */
  | 'token_expired'
  /** A tool could not be installed or verified — including "this app is too old". */
  | 'toolchain'
  /** cinna-cli could not create or read the account workspace. */
  | 'workspace'
  /** The server could not be reached. Nothing is wrong; try again. */
  | 'network'

export type LocalDevState =
  /**
   * Nothing has been checked yet — no Cinna profile is active, or the first
   * reconcile has not run. Deliberately distinct from `unsupported`: "we have
   * not looked" and "this server does not offer it" produce the same empty UI
   * but very different answers to "why is there no Repair button".
   */
  | { phase: 'idle' }
  /**
   * Local development is not on offer. `server` means the instance's discovery
   * document has no `local_dev` block; `role` means the account lacks the
   * `agent-developer` / `admin` role, which the server enforces by refusing to
   * mint a setup token. Both are supported states, not failures — the UI
   * explains `role` and says who to ask.
   */
  | { phase: 'unsupported'; reason: 'server' | 'role' }
  /** Waiting on the user. Nothing has been downloaded or written yet. */
  | { phase: 'consent'; host: string }
  /**
   * Asked and declined, and remembered so the prompt does not return every
   * launch. Separate from `idle` because Settings has to offer "Set up local
   * development" here and "nothing to do" there, and a screen that has to guess
   * which one it is looking at will eventually guess wrong.
   */
  | { phase: 'declined'; host: string }
  /** Working. `step` is user-visible text straight from the installer or cinna-cli. */
  | { phase: 'installing'; step: string; percent?: number }
  /**
   * `cinnaBinPath` is the managed binary's location, not an invitation to run
   * it from the renderer — the renderer has no spawn. It is here so Settings
   * can show where the toolchain lives and so the PATH opt-in has one source of
   * truth for what it links.
   */
  | {
      phase: 'ready'
      workspacePath: string
      cliVersion: string
      cinnaBinPath: string
      /**
       * Which cinna-cli surface this install actually has.
       *
       * `json` is the full one: machine-readable progress, a token state the
       * desktop can read, and `cinna account set-token` to refresh an expired
       * token in place. `legacy` is a cinna-cli that predates those — the
       * server pins the version, so the desktop can be handed one — and it
       * still works, with two visible costs: the install shows one step rather
       * than several, and an expired account token cannot be refreshed
       * silently. Settings says so; it is not hidden behind a working badge.
       */
      protocol: 'json' | 'legacy'
    }
  /** Broken in a way re-running the reconciler can fix. `detail` is shown. */
  | { phase: 'attention'; reason: LocalDevAttentionReason; detail: string }

/** Main → renderer push on every {@link LocalDevState} transition. */
export const LOCAL_DEV_STATE_CHANNEL = 'localdev:state'

/**
 * The `local_dev` block of `/.well-known/cinna-desktop`.
 *
 * Optional, and its absence is the whole answer: an instance that does not
 * publish it is not offering local development to desktops, and the desktop
 * must not go looking for the endpoints anyway. Versions are the server's
 * choice; the desktop verifies what it downloads against its own tables and
 * refuses a Mutagen version it has no digest for.
 */
export interface CinnaLocalDev {
  setup_token_endpoint: string
  cinna_cli_version: string
  mutagen_version: string
}
