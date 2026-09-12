/** The executable and argv are passed directly to spawn, without an implicit shell. */
export interface CustomAgentConfig {
  launcher: 'custom'
  command: string[]
  /** Absolute directory on the machine where the ACP agent runs. */
  cwd: string
  /** Optional directory for the local child (for example, the SSH client). */
  localCwd?: string
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
  if (raw.launcher !== 'custom' || (raw.transport !== undefined && raw.transport !== 'stdio')) {
    throw new Error('This build supports command-line ACP agents over stdio only.')
  }
  if (!Array.isArray(raw.command) || !raw.command.length || raw.command.length > 128 ||
    raw.command.some((part) => typeof part !== 'string' || part.includes('\0') || part.length > 8192) ||
    !(raw.command[0] as string).trim() || JSON.stringify(raw.command).length > 65536) {
    throw new Error('Command must be a JSON array containing an executable and its arguments.')
  }
  const directory = (input: unknown, label: string): string => {
    if (typeof input !== 'string' || input.length > 4096 || /[\0\r\n]/.test(input) ||
      !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(input)) throw new Error(`${label} must be an absolute path.`)
    return input
  }
  return {
    launcher: 'custom', command: [...raw.command] as string[],
    cwd: directory(raw.cwd, 'Working directory'),
    ...(raw.localCwd !== undefined && raw.localCwd !== '' ? { localCwd: directory(raw.localCwd, 'Local process directory') } : {})
  }
}
