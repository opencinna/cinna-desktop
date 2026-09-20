import { driverFor } from '../agents/drivers'
import { agentReadinessService } from '../services/agentReadinessService'
import { AGENT_READINESS_CHANGED_CHANNEL } from '../../shared/agentDrivers'
import { publishEvent } from '../host/events'

/** Core wiring runs regardless of whether an IPC transport is installed. */
export function installAgentReadiness(): void {
  agentReadinessService.install({
    probe: (userId, row, options) => driverFor(row).readiness(userId, row, options),
    broadcast: (payload) => publishEvent(AGENT_READINESS_CHANGED_CHANNEL, payload)
  })
}
