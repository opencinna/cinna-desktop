/** Values stay in Hub memory. Longest first prevents overlapping-secret leaks. */
const values = new Set<string>()
let pattern: RegExp | null = null
const sensitive = /password|private_key|api_token$|api_key$|access_token|refresh_token|http_header_value|^token$|identity_token|secret/i
export function rememberCredentialSecrets(value: unknown, key = ''): void {
  if (typeof value === 'string' && sensitive.test(key) && value.length >= 8) {
    // Match both decoded output and the JSON string content written to files.
    // This includes PEM newlines, quotes, backslashes and control characters.
    values.add(value)
    values.add(JSON.stringify(value).slice(1, -1))
    if (key === 'http_header_value' && value.startsWith('Bearer ') && value.length >= 15) { values.add(value.slice(7)); values.add(JSON.stringify(value.slice(7)).slice(1, -1)) }
    pattern = null
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) rememberCredentialSecrets(v, k)
  }
}
export function redactCredentialText(text: string): string {
  if (!values.size) return text
  pattern ??= new RegExp([...values].sort((a, b) => b.length - a.length).map(v => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g')
  return text.replace(pattern, '***REDACTED***')
}
export function redactCredentialValues<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (typeof value === 'string') return redactCredentialText(value) as T
  if (!value || typeof value !== 'object') return value
  if (seen.has(value)) return seen.get(value) as T
  if (Array.isArray(value)) {
    const result: unknown[] = []; seen.set(value, result)
    for (const item of value) result.push(redactCredentialValues(item, seen))
    return result as T
  }
  if (Object.getPrototypeOf(value) === Object.prototype) {
    const result: Record<string, unknown> = {}; seen.set(value, result)
    for (const [key, item] of Object.entries(value)) result[key] = redactCredentialValues(item, seen)
    return result as T
  }
  return value
}
/** Keep retired values until shutdown: old turns may finish after profile switch. */
export function clearCredentialRedaction(): void { values.clear(); pattern = null }
/** Persistence adapters redact nested fields without changing query/read behavior. */
export function redactingRepository<T extends object>(repo: T, methods: readonly string[]): T {
  return new Proxy(repo, { get(target, key, receiver) {
    const member = Reflect.get(target, key, receiver)
    if (typeof member !== 'function' || !methods.includes(String(key))) return member
    return (...args: unknown[]) => Reflect.apply(member, receiver, args.map(arg => redactCredentialValues(arg)))
  } })
}
/** Hold only suffixes that could become a known secret on the next chunk. */
export function createCredentialTextStream() {
  let pending = ''
  return {
    push(chunk: string): string {
      pending = redactCredentialText(pending + chunk)
      let hold = 0
      for (const secret of values) {
        const limit = Math.min(secret.length - 1, pending.length)
        for (let length = limit; length > hold; length--) {
          if (pending.endsWith(secret.slice(0, length))) { hold = length; break }
        }
      }
      const ready = pending.slice(0, pending.length - hold)
      pending = pending.slice(pending.length - hold)
      return ready
    },
    finish(): string { const result = redactCredentialText(pending); pending = ''; return result }
  }
}

interface CredentialEventStream {
  push(event: import('../../shared/runEvents').RunEvent): import('../../shared/runEvents').RunEvent[]
  finish(): import('../../shared/runEvents').RunEvent[]
}
export function createCredentialEventStream(): CredentialEventStream {
  const children = new Map<string, { stream: CredentialEventStream; event: import('../../shared/runEvents').RunChildEvent }>()
  const streams = new Map<string, { stream: ReturnType<typeof createCredentialTextStream>; event: import('../../shared/runEvents').RunDeltaEvent }>()
  const drain = (key: string): import('../../shared/runEvents').RunEvent[] => {
    const item = streams.get(key); if (!item) return []
    streams.delete(key)
    const text = item.stream.finish()
    return text ? [{ ...item.event, newPart: undefined, text }] : []
  }
  return {
    push(event: import('../../shared/runEvents').RunEvent): import('../../shared/runEvents').RunEvent[] {
      if (event.type === 'child') {
        let child = children.get(event.toolCallId)
        if (!child) { child = { stream: createCredentialEventStream(), event }; children.set(event.toolCallId, child) }
        return child.stream.push(event.event).map(nested => ({ ...event, event: nested }))
      }
      if (event.type === 'done' || event.type === 'error') return [...this.finish(), redactCredentialValues(event)]
      if (event.type !== 'delta') return [redactCredentialValues(event)]
      const key = JSON.stringify([event.kind, event.toolId, event.parentToolId, event.toolStream])
      const before = event.newPart ? drain(key) : []
      let item = streams.get(key)
      if (!item) { item = { stream: createCredentialTextStream(), event }; streams.set(key, item) }
      const text = item.stream.push(event.text)
      item.event = event
      return [...before, { ...redactCredentialValues(event), text }]
    },
    finish(): import('../../shared/runEvents').RunEvent[] {
      const result = [...streams.keys()].flatMap(drain)
      for (const child of children.values()) result.push(...child.stream.finish().map(event => ({ ...child.event, event })))
      children.clear()
      return result
    }
  }
}
