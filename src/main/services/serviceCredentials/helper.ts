import { chmodSync, existsSync, lstatSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getTemplateRoot } from '../../kit/contractStore'
import { readStamp, stampsMatch, type ManifestStamp } from '../../kit/manifestIo'
import { localAgentService } from '../localAgents/localAgentService'
import { turnLock } from '../localAgents/turnLock'
import { atomicSecret } from './files'
export const credentialHelper = {
  status(id: string) {
    const a = localAgentService.get('__default__', id)
    if (a.kind !== 'kit') return null
    const path = join(a.path, 'scripts/cinna_credentials.py')
    if (!existsSync(path)) return null
    const content = readFileSync(path, 'utf8')
    return { needsUpdate: !content.includes('HELPER_VERSION = "1.4.0"'), stamp: readStamp(path) }
  },
  async update(id: string, stamp: ManifestStamp): Promise<void> {
    await turnLock.withLock(id, 'credential-helper', () => {
      const a = localAgentService.get('__default__', id)
      if (a.kind !== 'kit') throw new Error('This folder does not use the kit helper.')
      const path = join(a.path, 'scripts/cinna_credentials.py')
      if (lstatSync(join(a.path, 'scripts')).isSymbolicLink()) throw new Error('The kit scripts directory must not be a symbolic link.')
      if (!stampsMatch(readStamp(path), stamp)) throw new Error('The helper changed since it was opened. Reload before updating.')
      const mode = statSync(path).mode & 0o777
      atomicSecret(path, readFileSync(join(getTemplateRoot('agent'), 'scripts/cinna_credentials.py'), 'utf8'))
      chmodSync(path, mode)
    })
  }
}
