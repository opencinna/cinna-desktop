/** Platform capabilities supplied by the composition root before starting core services.
 * This module must remain importable under plain Node. Never default to Electron.
 */
export interface RuntimeHost {
  getPath(name: 'userData' | 'home'): string
  getVersion(): string
  getAppPath(): string
  readonly isPackaged: boolean
  readonly resourcesPath: string
  http: { fetch(input: string, init?: RequestInit): Promise<Response> }
  keystore: {
    isEncryptionAvailable(): boolean
    encryptString(plaintext: string): Buffer
    decryptString(encrypted: Buffer): string
  }
  resolveProxy(url: string): Promise<string>
  resolvePackageFile(specifier: string): string
  nodeRuntime(): { command: string; args: string[]; env: Record<string, string> }
  onShutdown(listener: () => void): void
  shell: {
    openExternal(url: string): Promise<void>
    openPath(path: string): Promise<string>
    showItemInFolder(path: string): void
    trashItem(path: string): Promise<void>
  }
}

let installed: RuntimeHost | undefined

export function installRuntimeHost(host: RuntimeHost): void {
  installed = host
}

/** Lazy forwarding keeps imports side-effect free; capabilities resolve at use time. */
export const runtimeHost: RuntimeHost = new Proxy({} as RuntimeHost, {
  get(_target, key: keyof RuntimeHost) {
    if (!installed) throw new Error('Runtime host is not installed. Install it before starting core services.')
    const value = installed[key]
    return typeof value === 'function' ? value.bind(installed) : value
  }
})
