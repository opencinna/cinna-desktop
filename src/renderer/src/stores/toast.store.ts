import { create } from 'zustand'

interface ToastState {
  toast: { id: number; message: string } | null
  show: (message: string) => void
  dismiss: () => void
}
export const useToastStore = create<ToastState>((set) => ({
  toast: null,
  show: (message) => set({ toast: { id: Date.now(), message } }),
  dismiss: () => set({ toast: null })
}))
