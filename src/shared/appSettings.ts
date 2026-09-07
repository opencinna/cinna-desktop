/**
 * Schema for the installation-global app settings store. Lives in `shared`
 * so the renderer (via preload) and the main process repo see the same
 * source of truth. Add a key here, then mirror it in the main-side
 * `appSettingsRepo` defaults.
 */
export interface AppSettingsSchema {
  /**
   * When true, the chat-title autogeneration feature runs in the background
   * after the first user message in a chat.
   */
  autoChatTitles: boolean
  /**
   * When true, the macOS menu-bar (status-bar) tray icon is created alongside
   * the main window. Toggling at runtime creates or destroys the tray live.
   */
  enableTrayIcon: boolean
  /**
   * When true, the new-chat screen shows a rotating one-line hint bar teaching
   * composer shortcuts. Purely a renderer feature — no main-side reaction.
   * Per-hint retirement counters live in localStorage, not here.
   */
  showHints: boolean
  /**
   * When true, an account-provisioned (Cinna) default chat mode takes precedence
   * over the local default-profile default. Off by default — the local default
   * wins, and the account default only applies when no local default is set.
   * See `shared/chatModeDefaults.ts` for the resolution.
   */
  prioritizeAccountDefaults: boolean
  /**
   * Absolute path of the agents home — the workshop folder local agents are
   * scaffolded into. Empty means "the built-in default", `~/Documents/CinnaAgents`,
   * which is what a fresh install uses; `agentsHomeService` resolves and
   * validates the value on every read, so a path that is not a plausible agents
   * home falls back to the default rather than being written to.
   */
  localAgentsHome: string
  /**
   * Absolute path of an `opencode` binary to run folder agents with. Empty
   * means "resolve one" — a user-installed `opencode` on the login-shell PATH
   * first, else the pinned version this app downloads and verifies. An explicit
   * path always wins, and is never version-checked: the point of setting it is
   * to run the one you named.
   *
   * Unlike `localAgentsHome` this is a *file*, not a directory the app writes
   * into, so `appSettingsService` only checks that it is absolute — whether it
   * is a runnable engine is answered by `binaryResolver`, which has to ask the
   * file itself and reports the answer as engine state rather than as a
   * rejected setting.
   */
  localAgentsEnginePath: string
  /**
   * The developer tool a local agent folder opens in by default — a
   * {@link LocalToolId} of a `cli-assistant` or `editor`, or empty for "ask".
   * The agent page's Open-in button launches it in one click, and picking a
   * tool from that button's menu (or from the new-agent flow) rewrites it:
   * most people build every agent with the same assistant, so the last
   * choice is the right default and nobody should have to go to Settings to
   * say so. Settings → Local Agents can still set or clear it explicitly.
   *
   * Validated against the known ids, not against what is installed: a tool
   * can be uninstalled after being chosen, and the renderer resolves the id
   * against the detected list on every read, falling back to "ask".
   */
  localAgentsDefaultTool: string
  /**
   * When true, creating a local agent opens the new folder in the default tool
   * straight away instead of asking which tool to build it with. Meaningless
   * without `localAgentsDefaultTool`; the new-agent flow asks as before when
   * the default is unset or not installed.
   */
  localAgentsAutoOpen: boolean
  /**
   * When true, the agent page's "Runs with" panel offers the raw model list
   * instead of the Simple / Medium / Complex tier.
   *
   * A remembered preference, not a mode: it decides the view only for an agent
   * whose manifest expresses neither choice. An agent that names a model is
   * always shown the model picker and one that names a tier is always shown the
   * tier, because a panel that hid what the file says would misreport what the
   * agent runs on — the one thing this panel exists to get right.
   */
  localAgentsModelAdvanced: boolean
  /**
   * Which Cinna hosts the user has agreed to set up local development for, as
   * a JSON object of `{ "<host>": true | false }`.
   *
   * A string rather than a nested object because this store is one flat KV
   * table validated by `typeof`, and because consent is genuinely per host: one
   * desktop can hold accounts on several instances, and agreeing to install a
   * toolchain and create a folder for one says nothing about another. `false`
   * is a real answer — the user declined — and is what keeps the prompt from
   * reappearing on every launch; Settings can flip it back.
   *
   * Absent host = never asked.
   */
  localDevConsent: string
}

export type AppSettingKey = keyof AppSettingsSchema

export const CHAT_TITLE_UPDATED_CHANNEL = 'chats:title-updated'

export interface ChatTitleUpdatedPayload {
  chatId: string
  title: string
}
