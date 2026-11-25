import { describe, expect, it, vi } from 'vitest'

vi.mock('./scope', () => ({ getProfileScopeUserId: () => 'profile-a' }))
const { activatedProfileUserId, installActivatedCheck } = await import('./activatedProfile')

describe('activatedProfileUserId: the profile a run the app starts records', () => {
  it('none before the hub installs the check and while no profile is activated; the active one once it is', () => {
    expect(activatedProfileUserId()).toBeNull()
    let activated = false
    installActivatedCheck(() => activated)
    expect(activatedProfileUserId()).toBeNull()
    activated = true
    expect(activatedProfileUserId()).toBe('profile-a')
  })
})
