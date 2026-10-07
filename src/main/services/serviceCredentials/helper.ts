import { chmodSync, existsSync, lstatSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getTemplateRoot } from '../../kit/contractStore'
import { readStamp, stampsMatch, type ManifestStamp } from '../../kit/manifestIo'
import { localAgentService } from '../localAgents/localAgentService'
import { turnLock } from '../localAgents/turnLock'
import { compareVersionStrings } from '../../../shared/kit/contractVersion'
import { atomicSecret } from './files'

const HELPER_PATH = 'scripts/cinna_credentials.py'
const versionOf = (content: string): string | null => /^HELPER_VERSION\s*=\s*["']([^"']+)["']/m.exec(content)?.[1] ?? null
// Read once: the bundled kit does not change while the app runs.
let bundled: string | null | undefined
function bundledVersion(): string | null {
  if (bundled === undefined) bundled = versionOf(readFileSync(join(getTemplateRoot('agent'), HELPER_PATH), 'utf8'))
  return bundled
}

export const credentialHelper = {
  status(id: string) {
    const a = localAgentService.get('__default__', id)
    if (a.kind !== 'kit') return null
    const path = join(a.path, HELPER_PATH)
    if (!existsSync(path)) return null
    // Older than the bundled reader, or too old to carry a version at all.
    const version = versionOf(readFileSync(path, 'utf8'))
    return { needsUpdate: version === null || compareVersionStrings(version, bundledVersion()) < 0, stamp: readStamp(path) }
  },
  async update(id: string, stamp: ManifestStamp): Promise<void> {
    await turnLock.withLock(id, 'credential-helper', () => {
      const a = localAgentService.get('__default__', id)
      if (a.kind !== 'kit') throw new Error('This folder does not use the kit helper.')
      const path = join(a.path, HELPER_PATH)
      if (lstatSync(join(a.path, 'scripts')).isSymbolicLink()) throw new Error('The kit scripts directory must not be a symbolic link.')
      if (!stampsMatch(readStamp(path), stamp)) throw new Error('The helper changed since it was opened. Reload before updating.')
      const mode = statSync(path).mode & 0o777
      atomicSecret(path, readFileSync(join(getTemplateRoot('agent'), HELPER_PATH), 'utf8'))
      chmodSync(path, mode)
    })
  }
}
