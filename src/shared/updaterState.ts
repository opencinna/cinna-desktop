export type UpdaterState =
  | { phase: 'idle' }
  | { phase: 'downloading'; version: string; percent: number }
  | { phase: 'downloaded'; version: string }

export const UPDATER_BROADCAST_CHANNEL = 'updater:state'
