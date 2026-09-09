import { useEffect, useState } from 'react'

/**
 * `<AgentsHome>/Cloud` — the folder local development creates a per-server
 * workspace under, for the consent copy that promises where it will write.
 *
 * One hook because three surfaces ask the same question — the onboarding step,
 * the consent modal, and the connect screen's (?) — and the answer is only ever
 * used to fill in a sentence. `Cloud` is the [kit contract]'s
 * `workshop.cloud_dir`; it is spelled here purely as a hint, and the main
 * process resolves the real path from the contract when it creates the folder.
 *
 * **Reads the path; does not create it.** This used to go through the roots
 * list, which runs `ensureHome` — so a sentence naming the agents folder
 * created it, and on macOS raised the Documents-folder permission prompt in the
 * middle of signing in, before the app had said a word about agents. It now
 * asks `local-agent:home-state`, which touches nothing. See
 * `main/services/localAgents/homeAccessService.ts`.
 *
 * Returns `''` until it is known, and on failure. A caller that has no path
 * leaves the line out rather than promising a folder it cannot name, which is
 * why nothing here reports an error: there is no version of this worth
 * interrupting a sign-in for.
 *
 * `enabled` exists for the modal, which should not go asking on every state
 * transition it sits through — only while it is actually about to render the
 * question.
 */
export function useAgentsHomeHint(enabled = true): string {
  const [hint, setHint] = useState('')

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    void window.api.localAgents
      .homeState()
      .then((home) => {
        if (!cancelled) setHint(`${home.path}/Cloud`)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [enabled])

  return hint
}
