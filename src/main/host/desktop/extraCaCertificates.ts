import { join } from 'node:path'
import { applyExtraCaCertificates } from '../../../../resources/node-extra-ca/extra-ca.cjs'
import { createLogger } from '../../logger/logger'

const logger = createLogger('tls')

/**
 * `NODE_EXTRA_CA_CERTS` for the main process. The packaged app's NodeOptions
 * fuse (electron-builder.yml) makes Electron ignore the variable, so the SDKs'
 * Node fetch would fail behind a TLS-inspecting proxy. Call before any network
 * use. Never throws; an unusable file costs one warning.
 */
export function installExtraCaCertificates(env: NodeJS.ProcessEnv = process.env): number {
  const added = applyExtraCaCertificates(env, (message) => logger.warn(message))
  if (added > 0) logger.info('added extra CA certificates', { count: added, file: env.NODE_EXTRA_CA_CERTS })
  return added
}

/**
 * What a run-as-node child needs in its environment to find the extra CA file:
 * Electron deletes `NODE_EXTRA_CA_CERTS` from it, so the path travels as
 * `CINNA_EXTRA_CA_CERTS`, which the preload reads (and turns back into
 * `NODE_EXTRA_CA_CERTS` for the child's own children).
 */
export function extraCaChildEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const file = env.NODE_EXTRA_CA_CERTS
  return file ? { CINNA_EXTRA_CA_CERTS: file } : {}
}

/**
 * The `--require` preload that does the same in ELECTRON_RUN_AS_NODE children.
 * `resources/**` is unpacked, so it is a real file next to app.asar.
 */
export function extraCaPreloadPath(input: { isPackaged: boolean; resourcesPath: string; appPath: string }): string {
  return input.isPackaged
    ? join(input.resourcesPath, 'app.asar.unpacked', 'resources', 'node-extra-ca', 'preload.cjs')
    : join(input.appPath, 'resources', 'node-extra-ca', 'preload.cjs')
}
