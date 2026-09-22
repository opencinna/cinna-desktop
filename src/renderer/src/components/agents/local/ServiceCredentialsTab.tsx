import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import type { LocalAgentDto } from '../../../../../shared/localAgents'
import { credentialResult, useCredentialAttachments, useServiceCredentials } from '../../../hooks/useServiceCredentials'
import { unwrapIpcError } from '../../../utils/ipcError'
import { CredentialsCard, useOpenCredentialsFile } from './ReadOnlyCards'
const button = 'rounded border border-[var(--color-border)] px-2 py-1 text-[var(--color-accent)] disabled:opacity-50'
export function ServiceCredentialsTab({ agent }: { agent: LocalAgentDto }) {
  const available = useServiceCredentials(), attached = useCredentialAttachments(agent.id)
  const env = useOpenCredentialsFile(agent.id)
  const helper = useQuery({ queryKey: ['credential-helper', agent.id], queryFn: async () => credentialResult(await window.api.serviceCredentials.helper(agent.id)), enabled: agent.kind === 'kit' })
  const [selection, setSelection] = useState(''), [pending, setPending] = useState(false), [error, setError] = useState('')
  const setRefs = async (origin: 'local' | 'cloud', refs: string[]) => {
    setPending(true); setError('')
    try { credentialResult(await window.api.serviceCredentials.setAttachments(agent.id, origin, refs)); await attached.refetch(); setSelection('') }
    catch (e) { setError(unwrapIpcError(e)) } finally { setPending(false) }
  }
  return <div className="space-y-4 text-[13px]">
    <p>{agent.kind === 'bare' ? 'Attached values are kept outside this folder, in Cinna’s storage.' : 'Attached values are written to this agent’s credentials folder.'} Values stored on this computer are readable by the executing agent.</p>
    <div className="flex gap-2"><select aria-label="Credential to attach" className="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-2" value={selection} onChange={e => setSelection(e.target.value)}><option value="">Choose a credential</option>{available.data?.items.filter(c => !attached.data?.some(a => a.origin === c.origin && a.ref === (c.cloudId ?? c.id))).map(c => <option key={c.id} value={c.id} disabled={!c.localUseAllowed}>{c.name} ({c.origin}){!c.localUseAllowed ? ' — owner has not allowed local use' : ''}</option>)}</select><button disabled={!selection || pending} className={button} onClick={() => { const c = available.data?.items.find(v => v.id === selection); if (c) void setRefs(c.origin, [...(attached.data ?? []).filter(a => a.origin === c.origin).map(a => a.ref), c.cloudId ?? c.id]) }}>{pending ? 'Updating…' : 'Attach'}</button></div>
    <ul className="space-y-2">{attached.data?.map(a => <li key={`${a.origin}:${a.ref}`} className="rounded border border-[var(--color-border)] p-3"><div className="flex items-center gap-2"><span className="flex-1">{a.credential?.name ?? 'Missing credential'} · {a.state.replaceAll('_', ' ')}{a.credential?.serviceUri ? ` · ${a.credential.serviceUri}` : ''}</span><button className={button} disabled={pending || attached.data.filter(v => v.origin === a.origin)[0] === a} onClick={() => { const refs = attached.data!.filter(v => v.origin === a.origin).map(v => v.ref); const i = refs.indexOf(a.ref); [refs[i - 1], refs[i]] = [refs[i], refs[i - 1]]; void setRefs(a.origin, refs) }}>Move up</button><button className={button} disabled={pending} onClick={() => void setRefs(a.origin, attached.data!.filter(v => v.origin === a.origin && v.ref !== a.ref).map(v => v.ref))}>Detach</button></div>{a.credential?.type === 'ssh_key' && <p>Key material is not installed locally.</p>}</li>)}</ul>
    <p className="text-[var(--color-text-muted)]">Detach updates generated files; the credential record remains.</p>
    {(error || attached.error || available.error) && <p role="alert" className="text-[var(--color-danger)]">{error || unwrapIpcError(attached.error ?? available.error)}</p>}
    {helper.data?.needsUpdate && <div><button className={button} disabled={pending || !helper.data.stamp} onClick={async () => {
      if (!helper.data?.stamp) return
      setPending(true); setError('')
      try { credentialResult(await window.api.serviceCredentials.updateHelper(agent.id, helper.data.stamp)); await helper.refetch() } catch (e) { setError(unwrapIpcError(e)) } finally { setPending(false) }
    }}>Update credential helper</button><p className="text-[var(--color-text-muted)]">Replaces the older kit reader with support for attached credentials.</p></div>}
    {agent.credentials.some(c => c.overlappingKeys?.length) && <p className="text-[var(--color-text-muted)]">Attached credentials take precedence over these .env fields: {agent.credentials.flatMap(c => c.overlappingKeys ?? []).join(', ')}.</p>}
    {agent.kind === 'kit' && <CredentialsCard agent={agent} env={env} />}
  </div>
}
