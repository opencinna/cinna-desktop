import { dialog, shell, type BrowserWindow } from 'electron'
import { getProfileScopeUserId, getSettingsScopeUserId } from '../../auth/scope'
import { appSettingsService } from '../appSettingsService'
import { isGuardedLocation } from '../localAgents/homePath'
import { localAgentService, openInTextEditor } from '../localAgents/localAgentService'
import { launchEditor } from '../localAgents/openInService'
import { toolDetectionService } from '../localAgents/toolDetectionService'
import { createAgentFileService } from './agentFileService'
import { consentDialogOptions, createConsentRegistry, type ConsentPrompt } from './consent'
import { findDefaultEditor } from './openStrategy'

/**
 * The production wiring of {@link createAgentFileService}. Folder agents live
 * in the settings scope; approvals are keyed by the profile scope.
 */
export const agentFileService = createAgentFileService({
  locateAgent: (agentId) => localAgentService.locate(getSettingsScopeUserId(), agentId).agentDir,
  agentName: (agentId) => {
    try {
      return localAgentService.get(getSettingsScopeUserId(), agentId).name
    } catch {
      return 'this agent'
    }
  },
  getConsentUserId: getProfileScopeUserId,
  consent: createConsentRegistry(),
  platform: process.platform,
  isGuardedLocation: (path) => isGuardedLocation(path),
  getDefaultEditor: () =>
    findDefaultEditor(appSettingsService.getAll().localAgentsDefaultTool, (id) =>
      toolDetectionService.get(id)
    ),
  launchEditor,
  openPath: (path) => shell.openPath(path),
  openInTextEditor,
  showItemInFolder: (path) => shell.showItemInFolder(path)
})

/** Ask with a native dialog attached to the window that asked, so it cannot be skipped. */
export function nativeConsentPrompt(win: BrowserWindow | null): ConsentPrompt {
  return async (request) => {
    const options = consentDialogOptions(request, process.platform)
    const result = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
    return { approved: result.response === 0, rememberDir: result.checkboxChecked }
  }
}
