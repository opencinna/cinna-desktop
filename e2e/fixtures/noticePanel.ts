import type { Locator } from '@playwright/test'

/**
 * Until the composer notice panel holding `inside` has stopped moving: its
 * rise from under the message box and any row unfolding or folding (the
 * border's endless orbit aside). Two boxes measured one after the other
 * mid-rise come from different frames, so measure only once it has settled.
 */
export async function noticePanelSettled(inside: Locator): Promise<void> {
  await inside.evaluate(async (el) => {
    const panel = el.closest('.composer-notice-panel')
    if (!panel) return
    const moving = panel.getAnimations({ subtree: true }).filter((a) => a.effect?.getTiming().iterations !== Infinity)
    await Promise.all(moving.map((a) => a.finished.catch(() => undefined)))
  })
}
