/** References to existing Claude resources. Credentials themselves stay in main. */
export interface ManagedAgentConfig {
  credentialId: string
  agentId: string
  environmentId: string
  version?: number
  workspaceId?: string
}

export interface ManagedAgentChoices {
  agents: { id: string; name: string; description: string | null; version: number }[]
  environments: { id: string; name: string }[]
}

export function parseManagedAgentConfig(value: unknown): ManagedAgentConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Choose a credential, Managed agent and environment.')
  const record = value as Record<string, unknown>
  const read = (key: string, required: boolean): string | undefined => {
    const raw = record[key]
    if (raw === undefined && !required) return undefined
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 512 || /[\u0000-\u001f]/.test(raw)) {
      throw new Error(`Invalid Managed agent ${key}.`)
    }
    return raw.trim()
  }
  if (record.version !== undefined && (!Number.isSafeInteger(record.version) || (record.version as number) < 1)) {
    throw new Error('Invalid Managed agent version.')
  }
  return {
    credentialId: read('credentialId', true)!,
    agentId: read('agentId', true)!,
    environmentId: read('environmentId', true)!,
    ...(record.version !== undefined ? { version: record.version as number } : {}),
    ...(record.workspaceId !== undefined ? { workspaceId: read('workspaceId', false) } : {})
  }
}
