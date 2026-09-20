/** Core notifications carry data only. The transport owns windows/subscribers. */
export type EventAudience = 'main' | 'all'
export type EventPublisher = (channel: string, payload: unknown, audience: EventAudience) => void
let publisher: EventPublisher = () => {}

export function installEventPublisher(next: EventPublisher): void {
  publisher = next
}

export function publishEvent(channel: string, payload?: unknown, audience: EventAudience = 'main'): void {
  publisher(channel, payload, audience)
}
