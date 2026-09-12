import { createAcpProcessPool } from './acpProcessPool'
import { startAcpConnection } from './acpConnection'

/** Shared by runtime dispatch and command configuration lifecycle operations. */
export const acpProcessPool = createAcpProcessPool({ start: startAcpConnection })
