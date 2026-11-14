/**
 * What the vault features need from the platform beyond `runtimeHost`: a save
 * dialog for **Export file…** and whether a folder is backed up by Time
 * Machine (the host-copy warning). Installed by the desktop composition root
 * (`host/desktop/vault/installVaultBackend.ts`); a headless host leaves the
 * defaults, which refuse the export and know nothing about backups.
 */
export interface VaultHost {
  /** Ask where to save `defaultName`; the chosen absolute path, or null when cancelled. */
  saveDialog(defaultName: string): Promise<string | null>
  /** True when Time Machine backs `path` up, false when it is excluded, null when unknown. */
  timeMachineIncludes(path: string): Promise<boolean | null>
}

const absent: VaultHost = {
  async saveDialog() {
    throw new Error('This host has no save dialog.')
  },
  async timeMachineIncludes() {
    return null
  }
}

let installed: VaultHost = absent

export function installVaultHost(host: VaultHost): void {
  installed = host
}

export function vaultHost(): VaultHost {
  return installed
}
