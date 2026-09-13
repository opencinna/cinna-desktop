/** First released CLI with the desktop account JSON protocol. */
export const MIN_JSON_WORKSPACE_CLI_VERSION = '0.4.0'

export function cliWorkspaceRequirement(installedVersion?: string): string {
  return `Cinna CLI ${MIN_JSON_WORKSPACE_CLI_VERSION} or later is required for JSON workspace support. ${installedVersion ? `Installed: ${installedVersion}.` : 'The installed version is unknown.'} Open Default → Local Development to check for an update. If your server still requires an older version, ask its administrator to update the cinna-cli version it advertises.`
}

export interface CinnaCliUpdate {
  installedVersion: string | null
  targetVersion: string | null
  updateAvailable: boolean
}
