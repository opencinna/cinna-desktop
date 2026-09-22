import { useQuery } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { Plus, Unlink } from 'lucide-react'
import type { LocalAgentDto } from '../../../../../shared/localAgents'
import type { ServiceCredentialAttachmentDto } from '../../../../../shared/serviceCredentials'
import { credentialResult, useCredentialAttachments } from '../../../hooks/useServiceCredentials'
import { unwrapIpcError } from '../../../utils/ipcError'
import { CredentialAttachModal } from './CredentialAttachModal'
import { CredentialsCard, useOpenCredentialsFile } from './ReadOnlyCards'
import { AccountReferenceLabel, CredentialRow, ManageCredentialButton } from '../../settings/CredentialRow'
import { SettingsButton, SettingsIconButton, SettingsInfoTip, SettingsSection } from '../../settings/SettingsLayout'
import { accountReference, credentialHealth, credentialManageUrl, credentialOwnership, type AccountReference } from '../../settings/credentialPresentation'

/** The row's name: the record's, or what stands in for a record that cannot be read. */
function attachmentName(a: ServiceCredentialAttachmentDto): string {
  if (a.state === 'account_unavailable') return 'Account not signed in — unlock or sign in to that profile to use it'
  return a.credential?.name ?? 'Missing credential'
}
export function ServiceCredentialsTab({ agent }: { agent: LocalAgentDto }) {
  const attached = useCredentialAttachments(agent.id)
  const env = useOpenCredentialsFile(agent.id)
  const helper = useQuery({ queryKey: ['credential-helper', agent.id], queryFn: async () => credentialResult(await window.api.serviceCredentials.helper(agent.id)), enabled: agent.kind === 'kit' })
  const [picking, setPicking] = useState(false), [pending, setPending] = useState(false), [error, setError] = useState('')
  // Owned here, not in the modal: an attach outlives the modal closing. Every
  // list write (attach, detach) runs on one chain and applies its change
  // to the group's freshly read list, so no write overwrites another's result.
  const chain = useRef<Promise<unknown>>(Promise.resolve())
  const update = (group: string, change: (refs: string[]) => string[]): Promise<void> => {
    const run = chain.current.catch(() => {}).then(async () => {
      const fresh = (await attached.refetch()).data ?? []
      const refs = fresh.filter(v => v.group === group).map(v => v.ref), next = change(refs)
      if (next.join('\n') !== refs.join('\n')) credentialResult(await window.api.serviceCredentials.setAttachments(agent.id, group, next))
      await attached.refetch()
    })
    chain.current = run
    return run
  }
  const attach = (group: string, ref: string): Promise<void> => update(group, refs => refs.includes(ref) ? refs : [...refs, ref])
  const edit = (group: string, change: (refs: string[]) => string[]) => {
    setPending(true); setError('')
    update(group, change).catch(e => setError(unwrapIpcError(e))).finally(() => setPending(false))
  }
  const groups: { key: string; label: string; reference: AccountReference | null; items: ServiceCredentialAttachmentDto[] }[] = []
  for (const a of attached.data ?? []) {
    const found = groups.find(g => g.key === a.group)
    if (found) found.items.push(a)
    else groups.push({ key: a.group, label: a.groupLabel, reference: a.account && a.serverUrl ? accountReference({ ...a.account, serverUrl: a.serverUrl }) : null, items: [a] })
  }
  return <div className="space-y-4 text-[13px]">
    {agent.kind === 'kit' && <CredentialsCard agent={agent} env={env} />}
    {agent.credentials.some(c => c.overlappingKeys?.length) && <p className="text-[var(--color-text-muted)]">Attached credentials take precedence over these .env fields: {agent.credentials.flatMap(c => c.overlappingKeys ?? []).join(', ')}.</p>}
    <SettingsSection title="Attached Credentials" info={<SettingsInfoTip label="About attached credentials">
        <p>Cinna generates a credentials file from everything attached here{agent.kind === 'bare'
          ? ', kept in Cinna’s storage outside this folder'
          : <> — <code>credentials/credentials.json</code> in this agent’s folder</>}. The agent’s scripts find it through <code>CINNA_CREDENTIALS_PATH</code>; values never go into environment variables or the prompt, which lists only names, types, Service URIs and availability.</p>
        <p className="mt-2">Attach credentials stored on this computer or shared from a signed-in Cinna account. Values in the file are readable by the executing agent{agent.kind === 'kit' && <>, and attached credentials take precedence over matching fields in <code>.env</code></>}.</p>
        <p className="mt-2">Detach removes a credential from the generated file; the credential itself remains.</p>
      </SettingsInfoTip>} action={<SettingsButton disabled={pending} onClick={() => setPicking(true)}><Plus size={14} />Attach</SettingsButton>}>
    {attached.data?.length === 0 && <p className="text-[var(--color-text-muted)]">No credentials attached.</p>}
    {groups.map(group => <section key={group.key} aria-label={group.label} className="space-y-2">
      <h4 className="flex text-[12px] font-semibold text-[var(--color-text-muted)]">{group.reference ? <AccountReferenceLabel reference={group.reference} onError={setError} /> : group.label}</h4>
      <ul className="space-y-2">{group.items.map(a => {
        const name = attachmentName(a), unavailable = a.state === 'account_unavailable'
        const manage = unavailable ? null : credentialManageUrl(a.credential?.cloudId, a.serverUrl)
        const detachName = a.credential?.name ?? (unavailable ? 'credential of a signed-out account' : 'missing credential')
        return <li key={`${a.group}:${a.ref}`}><CredentialRow name={name} type={a.credential?.type} serviceUri={a.credential?.serviceUri} health={credentialHealth(a.credential, a.state)}
          ownership={a.credential ? credentialOwnership(a.credential) : a.origin === 'local' ? credentialOwnership({ origin: 'local', relation: 'owned', ownerEmail: null }) : null}
          actions={<>
            {manage && a.credential && <ManageCredentialButton name={a.credential.name} url={manage} onError={setError} />}
            <SettingsIconButton disabled={pending} title={`Detach ${detachName}`} aria-label={`Detach ${detachName}`} onClick={() => edit(group.key, refs => refs.filter(r => r !== a.ref))}><Unlink size={14} /></SettingsIconButton>
          </>} /></li>
      })}</ul>
    </section>)}
    </SettingsSection>
    {(error || attached.error) && <p role="alert" className="text-[var(--color-danger)]">{error || unwrapIpcError(attached.error)}</p>}
    {helper.data?.needsUpdate && <div className="space-y-1"><SettingsButton disabled={pending || !helper.data.stamp} onClick={async () => {
      if (!helper.data?.stamp) return
      setPending(true); setError('')
      try { credentialResult(await window.api.serviceCredentials.updateHelper(agent.id, helper.data.stamp)); await helper.refetch() } catch (e) { setError(unwrapIpcError(e)) } finally { setPending(false) }
    }}>Update credential helper</SettingsButton><p className="text-[var(--color-text-muted)]">Replaces the older kit reader with support for attached credentials.</p></div>}
    <CredentialAttachModal open={picking} agentId={agent.id} onClose={() => setPicking(false)} onAttach={attach} />
  </div>
}
