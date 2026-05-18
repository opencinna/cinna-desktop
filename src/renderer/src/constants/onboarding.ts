const ONBOARDING_DONE_KEY = 'cinna-onboarding-completed'
const ONBOARDING_FORCE_KEY = 'cinna-onboarding-force-next-launch'

// Memoize the consume so StrictMode's double-invocation of useState
// initializers (and any remount of OnboardingGate) sees a stable result and
// the localStorage mutation happens exactly once per session.
let _forceConsumed: boolean | null = null

export function consumeForceOnboarding(): boolean {
  if (_forceConsumed !== null) return _forceConsumed
  const armed = localStorage.getItem(ONBOARDING_FORCE_KEY) === '1'
  if (armed) {
    localStorage.removeItem(ONBOARDING_FORCE_KEY)
    localStorage.removeItem(ONBOARDING_DONE_KEY)
  }
  _forceConsumed = armed
  return armed
}

export function isForceOnboardingArmed(): boolean {
  return localStorage.getItem(ONBOARDING_FORCE_KEY) === '1'
}

export function setForceOnboarding(enabled: boolean): void {
  if (enabled) {
    localStorage.setItem(ONBOARDING_FORCE_KEY, '1')
  } else {
    localStorage.removeItem(ONBOARDING_FORCE_KEY)
  }
}

export function isOnboardingDismissed(): boolean {
  return localStorage.getItem(ONBOARDING_DONE_KEY) === '1'
}

export function markOnboardingDismissed(): void {
  localStorage.setItem(ONBOARDING_DONE_KEY, '1')
}
