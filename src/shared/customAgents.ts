/** The executable and argv are passed directly to spawn, without an implicit shell. */
export interface StdioAcpConfig {
  transport?: 'stdio'
  launcher: 'custom'
  command: string[]
  /** Absolute directory on the machine where the ACP agent runs. */
  cwd: string
  /** Optional directory for the local child (for example, the SSH client). */
  localCwd?: string
}

/** An external ACP agent, either a command or the experimental WebSocket profile. */
export type CustomAgentConfig = StdioAcpConfig | RemoteAcpConfig

export interface RemoteAcpConfig {
  launcher: 'custom'
  transport: 'websocket'
  url: string
  /** Workspace on the server, never a directory the desktop opens. */
  cwd: string
}

export function parseAcpAccessToken(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string' || value.length > 8192 || /[^\x21-\x7e]/.test(value)) throw new Error('Enter a bearer token without spaces or control characters.')
  return value
}

export function parseRemoteAcpConfig(value: unknown): RemoteAcpConfig {
  const raw = value as Record<string, unknown> | null
  if (!raw || raw.launcher !== 'custom' || raw.transport !== 'websocket' || typeof raw.url !== 'string' || raw.url.length > 4096) throw new Error('Enter an ACP WebSocket endpoint.')
  let url: URL
  try { url = new URL(raw.url) } catch { throw new Error('Enter a valid ws:// or wss:// ACP endpoint.') }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'wss:' && !(url.protocol === 'ws:' && loopback)) || url.username || url.password || url.search || url.hash || raw.url.includes('?') || raw.url.includes('#')) {
    throw new Error('Use wss:// (ws:// is allowed on localhost), without credentials, query parameters, or fragments. Enter the token separately.')
  }
  return { launcher: 'custom', transport: 'websocket', url: url.href, cwd: absoluteDirectory(raw.cwd, 'Remote working directory') }
}

function absoluteDirectory(input: unknown, label: string): string {
  if (typeof input !== 'string' || input.length > 4096 || /[\0\r\n]/.test(input) ||
    !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(input)) throw new Error(`${label} must be an absolute path.`)
  return input
}

export interface CustomAgentTestResult {
  token: string
  name: string
  version: string | null
  authMethods: { id: string; name: string; description: string | null }[]
}

export function parseCustomAgentConfig(value: unknown): CustomAgentConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Enter a command and working directory.')
  const raw = value as Record<string, unknown>
  if (raw.transport === 'websocket') return parseRemoteAcpConfig(raw)
  if (raw.launcher !== 'custom' || (raw.transport !== undefined && raw.transport !== 'stdio')) {
    throw new Error('Choose a supported ACP transport: stdio or WebSocket.')
  }
  if (!Array.isArray(raw.command) || !raw.command.length || raw.command.length > 128 ||
    raw.command.some((part) => typeof part !== 'string' || part.includes('\0') || part.length > 8192) ||
    !(raw.command[0] as string).trim() || JSON.stringify(raw.command).length > 65536) {
    throw new Error('Command must be a JSON array containing an executable and its arguments.')
  }
  return {
    launcher: 'custom', command: [...raw.command] as string[],
    cwd: absoluteDirectory(raw.cwd, 'Working directory'),
    ...(raw.localCwd !== undefined && raw.localCwd !== '' ? { localCwd: absoluteDirectory(raw.localCwd, 'Local process directory') } : {})
  }
}
