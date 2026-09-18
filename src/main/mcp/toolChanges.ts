const listeners = new Set<(providerId: string) => void>()

export function onMcpToolsChanged(listener: (providerId: string) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function notifyMcpToolsChanged(providerId: string): void {
  for (const listener of listeners) listener(providerId)
}
