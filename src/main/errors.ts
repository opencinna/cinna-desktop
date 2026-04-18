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

export type McpErrorCode =
  | 'not_found'
  | 'not_activated'
  | 'invalid_transport'
  | 'connect_failed'

export type ChatErrorCode =
  | 'not_found'
  | 'not_configured'
  | 'adapter_unavailable'
  | 'not_activated'

export type AuthErrorCode =
  | 'not_found'
  | 'username_taken'
  | 'username_required'
  | 'password_required'
  | 'invalid_password'
  | 'default_user_immutable'
  | 'oauth_failed'
  | 'missing_server_url'

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

export class ProviderError extends DomainError<ProviderErrorCode> {}
export class McpError extends DomainError<McpErrorCode> {}
export class ChatError extends DomainError<ChatErrorCode> {}
export class AuthError extends DomainError<AuthErrorCode> {}

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
