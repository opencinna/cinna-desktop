/** Authentication replacement invalidates callers awaiting credentials for the old session. */
const generations = new Map<string, number>()

/** Retry the old operation; the replacement account does not need to sign in again. */
export class CinnaSessionChanged extends Error {
  constructor() {
    super('The Cinna account changed while preparing the request. Try again.')
    this.name = 'CinnaSessionChanged'
  }
}

export function cinnaSessionGeneration(userId: string): number {
  return generations.get(userId) ?? 0
}

export function invalidateCinnaSession(userId: string): void {
  generations.set(userId, cinnaSessionGeneration(userId) + 1)
}
