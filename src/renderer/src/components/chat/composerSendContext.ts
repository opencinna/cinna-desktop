import { createContext } from 'react'
import type { DashboardContext } from '../../../../shared/dashboards'

/**
 * What a hosting surface adds to every message its composer sends. The
 * dashboard's chat panel provides it around its `ChatWorkspace`, so the
 * panel's sends carry the `dashboardContext` the chip shows (README D7) and
 * no other composer does. Read at send time, so the context is the one on
 * screen when the user pressed Send.
 */
export interface ComposerSendExtras {
  dashboardContext: () => DashboardContext | null
}

export const ComposerSendExtrasContext = createContext<ComposerSendExtras | null>(null)
