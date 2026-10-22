import { create } from 'zustand'
import { unwrapIpcError } from '../utils/ipcError'

/** What Edit and Run… was opened on: a command in one message of a chat. */
export interface CommandEditRequest {
  chatId: string
  messageId: string
  command: string
  /** The agent's folder as the dialog shows it; null until main has named it. */
  folder: string | null
  /** Why it is here for review ("This command can change…"); null for a command the menu offered Run for. */
  reason: string | null
}

interface UserCommandsState {
  /** The run whose output panel is open, per chat: at most one per chat. */
  panels: Record<string, string>
  edit: CommandEditRequest | null
  /** Bumped on every open, so the dialog starts fresh. */
  editSeq: number
  /** Which button of the dialog is running its start; the dialog cannot be dismissed meanwhile. */
  editPending: 'run' | 'background' | null
  /** Why the last start from the dialog did not happen; shown inside it. */
  editError: string | null
  openPanel: (chatId: string, itemId: string) => void
  closePanel: (chatId: string) => void
  /** Close the chat's panel only if it shows this run (the run was removed). */
  closePanelFor: (chatId: string, itemId: string) => void
  openEdit: (request: CommandEditRequest) => void
  /** Ignored while a start runs: dismissing would cancel nothing. */
  closeEdit: () => void
  /** Run the (edited) command as reviewed. Closes the dialog on success only. */
  submitEdit: (command: string, background: boolean) => Promise<void>
}

/**
 * The renderer side of running a message's command: which output panel is
 * open in which chat, and the Edit and Run… dialog. The dialog's start lives
 * here, not in the dialog, so its answer lands even if the dialog unmounted.
 */
export const useUserCommandsStore = create<UserCommandsState>((set, get) => ({
  panels: {},
  edit: null,
  editSeq: 0,
  editPending: null,
  editError: null,
  openPanel: (chatId, itemId) => set((state) => ({ panels: { ...state.panels, [chatId]: itemId } })),
  closePanel: (chatId) => set((state) => {
    if (!(chatId in state.panels)) return state
    const panels = { ...state.panels }
    delete panels[chatId]
    return { panels }
  }),
  closePanelFor: (chatId, itemId) => {
    if (get().panels[chatId] === itemId) get().closePanel(chatId)
  },
  openEdit: (request) => set((state) => state.editPending
    ? state
    : { edit: request, editSeq: state.editSeq + 1, editError: null }),
  closeEdit: () => set((state) => state.editPending ? state : { edit: null, editError: null }),
  submitEdit: async (command, background) => {
    const request = get().edit
    if (!request || get().editPending) return
    if (command.trim() === '') {
      set({ editError: 'Type a command to run.' })
      return
    }
    set({ editPending: background ? 'background' : 'run', editError: null })
    try {
      const result = await window.api.userCommands.run({
        chatId: request.chatId, messageId: request.messageId, command, reviewed: true
      })
      if (!result.ok) {
        set({ editPending: null, editError: result.reason })
        return
      }
      set({ editPending: null, edit: null, editError: null })
      if (!background) get().openPanel(request.chatId, result.itemId)
    } catch (error) {
      set({ editPending: null, editError: unwrapIpcError(error, 'The command could not be started.') })
    }
  }
}))
