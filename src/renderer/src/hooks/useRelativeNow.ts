import { useSyncExternalStore } from 'react'

const TICK_MS = 30_000

const listeners = new Set<() => void>()
let currentNow = new Date()
let intervalId: number | null = null

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  if (intervalId === null) {
    intervalId = window.setInterval(() => {
      currentNow = new Date()
      listeners.forEach((l) => l())
    }, TICK_MS)
  }
  return () => {
    listeners.delete(cb)
    if (listeners.size === 0 && intervalId !== null) {
      window.clearInterval(intervalId)
      intervalId = null
    }
  }
}

function getSnapshot(): Date {
  return currentNow
}

export function useRelativeNow(): Date {
  return useSyncExternalStore(subscribe, getSnapshot)
}
