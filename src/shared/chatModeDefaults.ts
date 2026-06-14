/**
 * Effective default chat-mode resolution, shared by the main process
 * (`chatModeService.resolveEffectiveDefault`) and the renderer
 * (`useDefaultChatMode`, jobs) so both agree on which mode auto-applies.
 *
 * The default-profile (local) modes and the account-provisioned (managed) modes
 * each carry their OWN `isDefault` flag — neither is forced to clear the other.
 * This picks the one effective default per precedence:
 *
 *   - `prioritizeAccountDefaults = false` (default): the local default wins; the
 *     account default applies only when there is no local default.
 *   - `prioritizeAccountDefaults = true`: the account default wins; the local
 *     default applies only when there is no account default.
 *
 * A locally-disabled account (managed) default does not count. When no mode is
 * flagged default on either side, the result is `null` — nothing auto-applies.
 */

export interface ResolvableMode {
  id: string
  isDefault: boolean
  /** True for account-provisioned (Cinna-managed) modes. */
  managed: boolean
  /** Effective local enable state — false only for a disabled managed mode. */
  enabled: boolean
}

export function resolveDefaultModeId(
  modes: readonly ResolvableMode[],
  prioritizeAccountDefaults: boolean
): string | null {
  const localDefault = modes.find((m) => !m.managed && m.isDefault) ?? null
  const accountDefault = modes.find((m) => m.managed && m.isDefault && m.enabled) ?? null

  const primary = prioritizeAccountDefaults ? accountDefault : localDefault
  const secondary = prioritizeAccountDefaults ? localDefault : accountDefault

  return (primary ?? secondary)?.id ?? null
}
