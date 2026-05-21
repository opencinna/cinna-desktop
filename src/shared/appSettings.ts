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
}

export type AppSettingKey = keyof AppSettingsSchema

export const CHAT_TITLE_UPDATED_CHANNEL = 'chats:title-updated'

export interface ChatTitleUpdatedPayload {
  chatId: string
  title: string
}
