/**
 * Domain error types shared across services and IPC handlers. Each error has a
 * stable `code` that crosses the IPC boundary unchanged, plus a user-facing
 * `message` and optional `detail`.
 */

export type ProviderErrorCode =
  | 'not_found'
  | 'unsupported_type'
  | 'missing_api_key'
  | 'not_activated'
  | 'read_only'
  | 'list_models_failed'
  /** A keyless credential's host is not something that can be fetched. */
  | 'invalid_host'
  /**
   * A write tried to change an existing credential's provider type.
   *
   * Distinct from `read_only`, which is routine — it fires whenever the UI and
   * account-config sync race over a managed row. This one has no legitimate
   * caller at all, so filing both under one code would make a security guard's
   * log line indistinguishable from noise that occurs normally.
   */
  | 'type_immutable'

export type McpErrorCode =
  | 'not_found'
  | 'not_activated'
  | 'invalid_transport'
  | 'invalid_auth_type'
  | 'connect_failed'
  | 'registry_unknown'
  | 'registry_unreachable'

export type ChatErrorCode =
  | 'not_found'
  | 'not_configured'
  | 'adapter_unavailable'
  | 'not_activated'

export type ChatModeErrorCode = 'not_found' | 'read_only'

export type AuthErrorCode =
  | 'not_found'
  | 'username_taken'
  | 'username_required'
  | 'password_required'
  | 'password_too_weak'
  | 'invalid_password'
  | 'default_user_immutable'
  | 'oauth_failed'
  | 'missing_server_url'
  | 'invalid_user_type'
  | 'identity_mismatch'

export type AgentErrorCode =
  | 'not_found'
  | 'not_activated'
  | 'unsupported_protocol'
  | 'no_card_url'
  | 'no_endpoint'
  | 'remote_immutable'
  /** A folder agent: the folder on disk is the agent, so the row is not the
   *  thing to delete. Distinct from `remote_immutable`, which the renderer
   *  explains as "managed by Cinna sync" — the wrong story entirely. */
  | 'folder_immutable'
  | 'invalid_id'
  | 'sync_reauth_required'
  | 'sync_failed'
  | 'update_failed'

export type AgentStatusErrorCode =
  | 'not_found'
  | 'forbidden'
  | 'remote_unreachable'
  | 'unknown'

export type JobErrorCode =
  | 'not_found'
  | 'not_activated'
  | 'unsupported_type'
  | 'missing_dependency'
  /**
   * The job names an agent that does not exist on this device at all, so it
   * cannot run here. Distinct from `missing_dependency`, which means a
   * reference the job holds has gone dangling. Neither code reaches the
   * renderer — `ipcMain.handle` drops it (see `ipc/_wrap.ts`) — but they
   * separate two genuinely different conditions in the main-side log, and a
   * code reused across conditions teaches the next person grepping it the
   * wrong thing.
   */
  | 'incomplete_setup'
  | 'invalid_input'

export type NoteErrorCode =
  | 'not_found'
  | 'not_activated'
  | 'invalid_input'

export type CinnaApiErrorCode =
  | 'not_cinna_user'
  | 'missing_server_url'
  | 'reauth_required'
  | 'request_failed'
  | 'invalid_response'

export type FileErrorCode =
  | 'not_found'
  | 'invalid_scope'
  | 'missing_chat_id'
  | 'chat_not_found'
  | 'read_failed'
  | 'write_failed'
  | 'unsupported_source'

export type AppSettingsErrorCode = 'invalid_key' | 'invalid_value'

export type SyncErrorCode =
  | 'not_cinna_user'
  | 'not_initialized'
  | 'already_initialized'
  | 'locked'
  | 'no_device_key'
  | 'no_recovery_key'
  | 'no_passphrase'
  | 'invalid_recovery'
  | 'pairing_failed'
  // Pairing commit-then-reveal handshake (sealer side):
  | 'cancelled'
  | 'timeout'
  | 'tampered'
  | 'sas_mismatch'
  | 'bad_request'

export type KitErrorCode =
  | 'contract_missing'
  | 'contract_unreadable'
  | 'invalid_path'
  | 'manifest_not_found'
  | 'manifest_unreadable'
  | 'manifest_invalid_json'
  | 'manifest_not_object'
  | 'manifest_modified'
  | 'write_failed'
  | 'export_failed'

/**
 * The agents-home domain: roots, the scanner, the scaffolder and the in-place
 * page editors. Kit-level failures (a bad manifest, a missing contract) keep
 * using {@link KitErrorCode} — this covers what happens *around* a folder.
 */
export type LocalAgentErrorCode =
  /** No agent row / folder for that id. */
  | 'not_found'
  /** No root row for that id, or the root is gone from disk. */
  | 'root_not_found'
  /** The last remaining root, or the default home, cannot be removed. */
  | 'root_immutable'
  /** A path the renderer supplied is not a plausible, permitted agents path. */
  | 'invalid_path'
  /** The target folder already exists — the scaffolder never writes into one. */
  | 'already_exists'
  /** The proposed name/slug/field value is not usable. */
  | 'invalid_input'
  /**
   * The file changed on disk since the editor read it, so the write was
   * refused. The renderer turns this into a reload prompt and must never
   * retry — a retry with a fresh stamp is exactly the clobber the guard
   * exists to prevent. The manifest's equivalent is
   * `KitError('manifest_modified')`; see `STALE_WRITE_ERROR_CODES`.
   */
  | 'file_modified'
  /** A turn holds the per-agent lock; the desktop never writes mid-stream. */
  | 'turn_in_progress'
  /**
   * The agents home is in a macOS-guarded folder and the user has not been told
   * yet. Not a failure of anything the user did: the caller's job is to explain
   * the folder and call `homeAccessService.grant`, not to report an error.
   */
  | 'home_consent_required'
  /**
   * macOS refused the write into the agents home — the Documents-folder prompt
   * was declined, or the grant was revoked in System Settings. Distinct from
   * `write_failed` because the only fix is a different folder or a flipped
   * switch, and both are things the app can offer.
   */
  | 'home_access_denied'
  /** Creating the home, copying a template, or writing a file failed. */
  | 'write_failed'

/**
 * The local developer tooling around an agent folder: detecting installed
 * assistants and editors, and the "Open in…" launchers. Distinct from
 * {@link LocalAgentErrorCode}, which covers the folder itself — these are
 * failures of the machine's tools and of the launch, not of the agent.
 */
export type LocalToolsErrorCode =
  /** The folder is missing, is not a directory, or is not an absolute path. */
  | 'invalid_folder'
  /** The folder is not inside any registered agents root. */
  | 'forbidden_path'
  /** No agents root is registered yet, so nothing can be opened. */
  | 'no_roots'
  /** The requested tool id is unknown, or not installed on this machine. */
  | 'tool_unavailable'
  /** The tool exists but cannot serve the requested action (e.g. an editor asked to run a turn). */
  | 'unsupported_action'
  /** No terminal emulator / launcher could be found on this platform. */
  | 'no_terminal'
  /** macOS refused the Apple Event that drives Terminal/iTerm (TCC, error -1743). */
  | 'automation_denied'
  /** The launcher process itself failed to start. */
  | 'launch_failed'

export class DomainError<TCode extends string = string> extends Error {
  readonly code: TCode
  readonly detail?: string

  constructor(code: TCode, message: string, detail?: string) {
    super(message)
    this.name = this.constructor.name
    this.code = code
    this.detail = detail
  }
}

export class KitError extends DomainError<KitErrorCode> {}
export class LocalAgentError extends DomainError<LocalAgentErrorCode> {}
export class LocalToolsError extends DomainError<LocalToolsErrorCode> {}
export class ProviderError extends DomainError<ProviderErrorCode> {}
export class McpError extends DomainError<McpErrorCode> {}
export class ChatError extends DomainError<ChatErrorCode> {}
export class ChatModeError extends DomainError<ChatModeErrorCode> {}
export class AuthError extends DomainError<AuthErrorCode> {}
export class AgentError extends DomainError<AgentErrorCode> {}
export class AgentStatusError extends DomainError<AgentStatusErrorCode> {}
export class JobError extends DomainError<JobErrorCode> {}
export class NoteError extends DomainError<NoteErrorCode> {}
export class CinnaApiError extends DomainError<CinnaApiErrorCode> {}
export class FileError extends DomainError<FileErrorCode> {}
export class AppSettingsError extends DomainError<AppSettingsErrorCode> {}
export class SyncError extends DomainError<SyncErrorCode> {}

export interface IpcErrorShape {
  code: string
  message: string
  detail?: string
}

export interface IpcOk<T> {
  ok: true
  data: T
}

export interface IpcErr {
  ok: false
  error: IpcErrorShape
}

export type IpcResult<T> = IpcOk<T> | IpcErr

export function ipcErrorShape(err: unknown): IpcErrorShape {
  if (err instanceof DomainError) {
    return { code: err.code, message: err.message, detail: err.detail }
  }
  const msg = err instanceof Error ? err.message : String(err)
  return { code: 'unknown', message: msg }
}

/**
 * The managed local-dev toolchain: uv, Mutagen and cinna-cli, installed into
 * `<userData>/localdev` by `src/main/localdev/toolchain.ts`.
 *
 * These codes are the contract between the installer and the local-dev
 * reconciler, which turns each one into a user-facing "needs attention" reason
 * — so a code is never reused for a second condition and never renamed without
 * changing that mapping.
 */
export type ToolchainErrorCode =
  /** No pinned uv build for this `${platform}-${arch}`. The UI explains; it does not retry. */
  | 'unsupported_platform'
  /**
   * The server pinned a Mutagen version this desktop holds no digest for. The
   * honest answer is "update Cinna Desktop" — never an unverified download.
   */
  | 'unknown_mutagen_version'
  /** The bytes never arrived: HTTP error, timeout, dead socket. Retryable. */
  | 'download_failed'
  /** The bytes arrived and were not the pinned ones. Nothing was published. */
  | 'checksum_mismatch'
  /** The archive would not unpack, or held none of what was expected. */
  | 'extract_failed'
  /** `uv tool install cinna-cli` failed, or produced no runnable `cinna`. */
  | 'install_failed'

/**
 * A managed-toolchain failure, naming the component it happened in.
 *
 * `tool` is `'uv' | 'mutagen' | 'cinna-cli'` — a `ToolchainToolId`, spelled as
 * a string here so this module stays free of imports from the installer that
 * imports it. It exists because the components install *concurrently*: the
 * reconciler can no longer work out which checklist row a failure belongs to by
 * asking which one is currently active, since several are, and marking the
 * wrong row failed accuses a download that is downloading perfectly well.
 * `detail` is not a substitute — it carries a stderr tail or a path in exactly
 * the cases that matter most.
 */
export class ToolchainError extends DomainError<ToolchainErrorCode> {
  readonly tool?: string

  constructor(code: ToolchainErrorCode, message: string, detail?: string, tool?: string) {
    super(code, message, detail)
    this.tool = tool
  }
}
