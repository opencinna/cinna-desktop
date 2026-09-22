import { useRef, useState } from 'react'
import { ExternalLink, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useAuthStore } from '../../stores/auth.store'
import type { LocalCredentialType, ServiceCredentialDto } from '../../../../shared/serviceCredentials'
import { credentialResult, useServiceCredentials } from '../../hooks/useServiceCredentials'
import { unwrapIpcError } from '../../utils/ipcError'
import { AnimatedCollapse } from '../ui/AnimatedCollapse'
import { SettingsAddButton, SettingsButton, SettingsIconButton, SettingsInfoTip, SettingsSection } from './SettingsLayout'
import { CredentialTypePicker, LocalCredentialForm } from './LocalCredentialForm'
import { AccountReferenceLabel, CredentialRow, ManageCredentialButton, openExternalUrl } from './CredentialRow'
import { credentialHealth, credentialManageUrl, credentialOwnership, profileReference } from './credentialPresentation'

export const cloudErrors: Record<string, string> = {
  reauth_required: 'Sign in again to sync credentials.',
  permission_denied: 'This account is not allowed to download credential values. Check access with the owner or administrator.',
  not_supported: 'This remote does not support credential sync yet. Update Cinna Core on that server.',
  server_error: 'The remote server could not load credentials. Check its logs and try again.',
  invalid_response: 'The remote returned an invalid credential list. Check its Cinna Core version.'
}
export function ServiceCredentialsSection({ cloud = false }: { cloud?: boolean }) {
  const { data, error: loadError, refetch } = useServiceCredentials()
  const profile = useAuthStore(s => s.currentUser)
  // One surface open at a time: the add flow, or one row's edit form / delete confirm.
  const [creating, setCreating] = useState(false)
  const [newType, setNewType] = useState<LocalCredentialType | null>(null)
  const [open, setOpen] = useState<{ id: string; mode: 'edit' | 'delete' } | null>(null)
  const [error, setError] = useState(''), [pending, setPending] = useState(false)
  // A closing row keeps showing what it showed while it animates shut.
  const shownMode = useRef(new Map<string, 'edit' | 'delete'>())
  if (open) shownMode.current.set(open.id, open.mode)
  const closeForm = () => { setCreating(false); setNewType(null); setOpen(null); void refetch() }
  const openRow = (id: string, mode: 'edit' | 'delete') => {
    if (pending) return
    setCreating(false); setNewType(null); setError('')
    setOpen(o => o?.id === id && (mode === 'edit' || o.mode === mode) ? null : { id, mode })
  }
  // An open form holds unsaved input: nothing else may replace it until it is saved or cancelled.
  const formOpen = creating || open?.mode === 'edit'
  // The shared query includes the active profile; only file delivery errors are local.
  const statusError = data?.error === 'cleanup_failed'
    ? 'Some agent credential files could not be updated. Affected agents will retry before running.'
    : cloud && data?.error ? cloudErrors[data.error] ?? 'Could not sync credentials from this profile. Try again.' : ''
  const errorMessage = error || (loadError ? unwrapIpcError(loadError) : statusError)
  const reference = cloud && profile ? profileReference(profile) : null
  const items = data?.items.filter(c => (c.origin === 'cloud') === cloud) ?? []
  const remove = async (c: ServiceCredentialDto) => {
    setPending(true); setError('')
    try { credentialResult(await window.api.serviceCredentials.remove(c.id)); setOpen(null); await refetch() }
    catch (err) { setError(unwrapIpcError(err)) } finally { setPending(false) }
  }

  return <SettingsSection title={cloud ? 'Remote credentials' : 'Local credentials'} info={cloud ? <SettingsInfoTip label="About remote credentials">
    This is not the full list of credentials on the server. The server sends only those that local agents on this computer can use; the rest, such as automatic, bundle and server-driven OAuth credentials, stay on the server. Manage all of them on the remote.
  </SettingsInfoTip> : undefined} action={cloud ? <div className="flex items-center gap-2">
    {profile?.cinnaServerUrl && <SettingsButton disabled={pending} onClick={() => {
      // Suffix-joined like the per-credential link, so a Core under a path prefix keeps it.
      if (profile.cinnaServerUrl) void openExternalUrl(profile.cinnaServerUrl.replace(/\/+$/, '') + '/credentials', setError)
    }}><ExternalLink size={14} />Manage on Remote</SettingsButton>}
    <SettingsButton disabled={pending || !profile?.cinnaServerUrl} onClick={async () => {
      if (!profile?.cinnaServerUrl) return
      setPending(true); setError('')
      try { credentialResult(await window.api.serviceCredentials.sync(profile.id, profile.cinnaServerUrl)); await refetch() }
      catch (err) { setError(unwrapIpcError(err)) }
      finally { setPending(false) }
    }}><RefreshCw size={14} className={pending ? 'animate-spin' : undefined} />{pending ? 'Syncing…' : 'Sync Now'}</SettingsButton>
  </div> : undefined}>
    {reference && <p className="flex text-[13px] text-[var(--color-text-muted)]"><AccountReferenceLabel reference={reference} onError={setError} /></p>}
    {items.map(c => cloud
      ? <CredentialRow key={c.id} name={c.name} type={c.type} serviceUri={c.serviceUri} health={credentialHealth(c)} ownership={credentialOwnership(c)}
        actions={(() => { const url = credentialManageUrl(c.cloudId, profile?.cinnaServerUrl); return url ? <ManageCredentialButton name={c.name} url={url} onError={setError} /> : null })()} />
      : <CredentialRow key={c.id} name={c.name} type={c.type} serviceUri={c.serviceUri} health={credentialHealth(c)} ownership={credentialOwnership(c)}
        expandable={{ expanded: open?.id === c.id, onToggle: () => openRow(c.id, 'edit'), disabled: formOpen && open?.id !== c.id }}
        actions={<SettingsIconButton danger disabled={pending || formOpen} title={`Delete ${c.name}`} aria-label={`Delete ${c.name}`} onClick={() => openRow(c.id, 'delete')}><Trash2 size={14} /></SettingsIconButton>}>
        <AnimatedCollapse open={open?.id === c.id}>
          <div className="border-t border-[var(--color-border)] px-4 py-3">
            {shownMode.current.get(c.id) === 'delete'
              ? <div role="group" aria-label={`Delete ${c.name}`}>
                <p className="mb-3 text-[13px]">Delete “{c.name}”? You can create it again with new values. Its generated files will be removed after any running turn finishes.</p>
                <div className="flex gap-2"><SettingsButton disabled={pending} onClick={() => void remove(c)}>{pending ? 'Deleting…' : 'Delete credential'}</SettingsButton><SettingsButton disabled={pending} onClick={() => setOpen(null)}>Cancel</SettingsButton></div>
              </div>
              : <LocalCredentialForm key={c.id} framed={false} type={c.type as LocalCredentialType} record={c} onClose={closeForm} />}
          </div>
        </AnimatedCollapse>
      </CredentialRow>)}
    {!cloud && (creating && !newType ? <CredentialTypePicker onSelect={setNewType} onClose={closeForm} />
      : newType ? <LocalCredentialForm key={newType} type={newType} onBack={() => setNewType(null)} onClose={closeForm} />
        : <SettingsAddButton disabled={pending || formOpen} onClick={() => { setOpen(null); setCreating(true); setNewType(null); setError('') }}><Plus size={14} />Add Credential</SettingsAddButton>)}
    {cloud && <p className="text-[13px] text-[var(--color-text-muted)]">{data?.lastSync ? `Last synced ${new Date(data.lastSync).toLocaleTimeString()}` : 'Not synced yet'}</p>}
    {data && !data.secureStorage && <p role="alert">{cloud ? 'Unlock your system keychain to sync credential values.' : 'Unlock your system keychain to save local credential values.'}</p>}
    {errorMessage && <p role="alert" className="text-[13px] text-[var(--color-danger)]">{errorMessage}</p>}
  </SettingsSection>
}
