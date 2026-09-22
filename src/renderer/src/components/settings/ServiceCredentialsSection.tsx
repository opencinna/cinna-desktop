import { useState } from 'react'
import { ExternalLink, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useAuthStore } from '../../stores/auth.store'
import type { LocalCredentialType, ServiceCredentialDto } from '../../../../shared/serviceCredentials'
import { credentialResult, useServiceCredentials } from '../../hooks/useServiceCredentials'
import { unwrapIpcError } from '../../utils/ipcError'
import { SettingsButton, SettingsCard, SettingsSection } from './SettingsLayout'
import { CredentialTypePicker, LocalCredentialForm, credentialTypeName } from './LocalCredentialForm'

const cloudErrors: Record<string, string> = {
  reauth_required: 'Sign in again to sync credentials.',
  permission_denied: 'This account is not allowed to download credential values. Check access with the owner or administrator.',
  not_supported: 'This remote does not support credential sync yet. Update Cinna Core on that server.',
  server_error: 'The remote server could not load credentials. Check its logs and try again.',
  invalid_response: 'The remote returned an invalid credential list. Check its Cinna Core version.'
}
export function ServiceCredentialsSection({ cloud = false }: { cloud?: boolean }) {
  const { data, error: loadError, refetch } = useServiceCredentials()
  const profile = useAuthStore(s => s.currentUser)
  const [creating, setCreating] = useState(false)
  const [newType, setNewType] = useState<LocalCredentialType | null>(null)
  const [edit, setEdit] = useState<ServiceCredentialDto | null>(null)
  const [deleting, setDeleting] = useState<ServiceCredentialDto | null>(null)
  const [error, setError] = useState(''), [pending, setPending] = useState(false)
  const closeForm = () => { setCreating(false); setNewType(null); setEdit(null); void refetch() }
  // The shared query includes the active profile; only file delivery errors are local.
  const statusError = data?.error === 'cleanup_failed'
    ? 'Some agent credential files could not be updated. Affected agents will retry before running.'
    : cloud && data?.error ? cloudErrors[data.error] ?? 'Could not sync credentials from this profile. Try again.' : ''
  const errorMessage = error || (loadError ? unwrapIpcError(loadError) : statusError)

  return <SettingsSection title={cloud ? 'Remote credentials' : 'Local credentials'} action={cloud ? <div className="flex items-center gap-2">
    {profile?.cinnaServerUrl && <SettingsButton disabled={pending} onClick={async () => {
      try {
        const result = await window.api.system.openExternal(new URL('/credentials', profile.cinnaServerUrl).toString())
        if (!result.success) setError(result.error)
      } catch (err) { setError(unwrapIpcError(err)) }
    }}><ExternalLink size={14} />Manage on Remote</SettingsButton>}
    <SettingsButton disabled={pending || !profile?.cinnaServerUrl} onClick={async () => {
      if (!profile?.cinnaServerUrl) return
      setPending(true); setError('')
      try { credentialResult(await window.api.serviceCredentials.sync(profile.id, profile.cinnaServerUrl)); await refetch() }
      catch (err) { setError(unwrapIpcError(err)) }
      finally { setPending(false) }
    }}><RefreshCw size={14} className={pending ? 'animate-spin' : undefined} />{pending ? 'Syncing…' : 'Sync Now'}</SettingsButton>
  </div> : !creating && !edit && <SettingsButton onClick={() => { setCreating(true); setNewType(null); setError('') }}><Plus size={14} />Add Credential</SettingsButton>}>
    {cloud && profile?.cinnaServerUrl && <p className="text-[13px] text-[var(--color-text-muted)]">Server: {profile.cinnaServerUrl}</p>}
    {creating && !newType && <CredentialTypePicker onSelect={setNewType} onClose={closeForm} />}
    {(edit || newType) && <LocalCredentialForm key={edit?.id ?? newType} type={(edit?.type ?? newType) as LocalCredentialType} record={edit ?? undefined} onBack={edit ? undefined : () => setNewType(null)} onClose={closeForm} />}
    {data?.items.filter(c => (c.origin === 'cloud') === cloud).map(c => <SettingsCard key={c.id}>
      <div className="flex items-center gap-3"><div className="min-w-0 flex-1"><p className="text-[14px] font-medium">{c.name}</p>
        <p className="text-[13px] text-[var(--color-text-muted)]">{credentialTypeName(c.type)} · {c.status}{cloud ? ` · ${c.relation === 'shared' ? `Shared by ${c.ownerEmail ?? 'owner'}` : 'Owned'}` : ''}</p>
        {c.serviceUri && <p className="mt-1 break-all text-[13px] text-[var(--color-text-muted)]">Service URI: {c.serviceUri}</p>}
        {cloud && !c.localUseAllowed && <p className="mt-1 text-[13px]">The owner must allow use on your computer.</p>}
      </div>{!cloud && <><SettingsButton disabled={creating || !!edit} onClick={() => setEdit(c)}><Pencil size={14} />Edit</SettingsButton><SettingsButton disabled={pending} onClick={() => setDeleting(c)}><Trash2 size={14} />Delete</SettingsButton></>}</div>
    </SettingsCard>)}
    {deleting && <SettingsCard><div role="dialog" aria-label={`Delete ${deleting.name}`}>
      <p className="mb-3 text-[13px]">Delete “{deleting.name}”? You can create it again with new values. Its generated files will be removed after any running turn finishes.</p>
      <div className="flex gap-2"><SettingsButton disabled={pending} onClick={async () => {
        setPending(true); setError('')
        try { credentialResult(await window.api.serviceCredentials.remove(deleting.id)); setDeleting(null); await refetch() }
        catch (err) { setError(unwrapIpcError(err)) } finally { setPending(false) }
      }}>{pending ? 'Deleting…' : 'Delete credential'}</SettingsButton><SettingsButton disabled={pending} onClick={() => setDeleting(null)}>Cancel</SettingsButton></div>
    </div></SettingsCard>}
    {cloud && <p className="text-[13px] text-[var(--color-text-muted)]">{data?.lastSync ? `Last synced ${new Date(data.lastSync).toLocaleTimeString()}` : 'Not synced yet'}</p>}
    {data && !data.secureStorage && <p role="alert">{cloud ? 'Unlock your system keychain to sync credential values.' : 'Unlock your system keychain to save local credential values.'}</p>}
    {errorMessage && <p role="alert" className="text-[13px] text-[var(--color-danger)]">{errorMessage}</p>}
  </SettingsSection>
}
