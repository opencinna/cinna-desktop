import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Plus, Unlink } from 'lucide-react'
import type { LocalAgentDto } from '../../../../../shared/localAgents'
import type { OAuthConnectFlow, ServiceCredentialAttachmentDto } from '../../../../../shared/serviceCredentials'
import { credentialResult, oauthFlowKey, useCredentialAttachOptions, useCredentialAttachments, useOAuthConnectFlow } from '../../../hooks/useServiceCredentials'
import { unwrapIpcError } from '../../../utils/ipcError'
import { CredentialAttachModal } from './CredentialAttachModal'
import { credentialTypeName, credentialTypeTitle } from '../../settings/LocalCredentialForm'
import { CredentialsCard, useOpenCredentialsFile } from './ReadOnlyCards'
import { AccountReferenceLabel, CredentialRow, ManageCredentialButton } from '../../settings/CredentialRow'
import { SettingsButton, SettingsIconButton, SettingsInfoTip, SettingsSection } from '../../settings/SettingsLayout'
import { accountReference, credentialHealth, credentialManageUrl, credentialOwnership, oauthFlowHealth, type AccountReference } from '../../settings/credentialPresentation'

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
  const queryClient = useQueryClient()
  // Reconnect starts the flow here and opens the attach modal on it: the modal shows a waiting flow.
  const reconnect = async (group: string, ref: string) => {
    setPending(true); setError('')
    try {
      const flow = credentialResult(await window.api.serviceCredentials.reconnectOAuth(agent.id, group, ref))
      queryClient.setQueryData(oauthFlowKey(agent.id), flow)
      setPicking(true)
    } catch (e) { setError(unwrapIpcError(e)) } finally { setPending(false) }
  }
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
  // A Google connect in progress (New or Reconnect) is shown here too, so leaving the modal does not
  // hide it (rule 6): on its record's row for a Reconnect, else as a row of its own in its account.
  const flowQuery = useOAuthConnectFlow(agent.id)
  const flow = flowQuery.data && flowQuery.data.state !== 'attached' ? flowQuery.data : null
  // An attached flow's record joins the list: fetch it now, so its row does not wait for the next refresh.
  const attachedFlow = flowQuery.data?.state === 'attached' ? flowQuery.data.id : null
  const refetchAttached = attached.refetch
  useEffect(() => { if (attachedFlow) void refetchAttached() }, [attachedFlow, refetchAttached])
  const cancelFlow = async (f: OAuthConnectFlow) => {
    setPending(true); setError('')
    try {
      credentialResult(await window.api.serviceCredentials.cancelOAuth(agent.id, f.id))
      queryClient.setQueryData(oauthFlowKey(agent.id), null)
    } catch (e) { setError(unwrapIpcError(e)) } finally { setPending(false) }
  }
  const flowActions = (f: OAuthConnectFlow, name: string) => <>
    <SettingsButton disabled={pending} aria-label={`Open ${name} sign-in`} title="Show this sign-in in Attach credential" onClick={() => setPicking(true)}>Open</SettingsButton>
    <SettingsButton disabled={pending} aria-label={`Cancel ${name} sign-in`} onClick={() => void cancelFlow(f)}>Cancel</SettingsButton>
  </>

  const groups: { key: string; label: string; reference: AccountReference | null; detail?: string; items: ServiceCredentialAttachmentDto[]; flow?: OAuthConnectFlow }[] = []
  for (const a of attached.data ?? []) {
    const found = groups.find(g => g.key === a.group)
    if (found) found.items.push(a)
    else groups.push({ key: a.group, label: a.groupLabel, reference: a.account && a.serverUrl ? accountReference({ ...a.account, serverUrl: a.serverUrl }) : null, items: [a] })
  }
  const flowRecord = flow?.reconnect ? (attached.data ?? []).find(a => a.group === flow.group && a.ref === flow.credentialId) : undefined
  const flowGroupKnown = !!flow && groups.some(g => g.key === flow.group)
  // An account with nothing attached yet is headed from the picker's groups.
  const options = useCredentialAttachOptions(agent.id, !!flow && !!attached.data && !flowRecord && !flowGroupKnown)
  if (flow && !flowRecord && attached.data) {
    const found = groups.find(g => g.key === flow.group)
    if (found) found.flow = flow
    else {
      const option = options.data?.groups.find(g => g.key === flow.group)
      groups.push({ key: flow.group, label: option?.label ?? 'Signed-in account', reference: null, detail: option?.detail, items: [], flow })
    }
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
    {attached.data?.length === 0 && !flow && <p className="text-[var(--color-text-muted)]">No credentials attached.</p>}
    {groups.map(group => <section key={group.key} aria-label={group.label} className="space-y-2">
      <h4 className="flex text-[12px] font-semibold text-[var(--color-text-muted)]">{group.reference ? <AccountReferenceLabel reference={group.reference} onError={setError} />
        : group.detail ? <span className="min-w-0 truncate"><span className="text-[var(--color-text-secondary)]">{group.label}</span> {group.detail}</span> : group.label}</h4>
      <ul className="space-y-2">{group.items.map(a => {
        const name = attachmentName(a), unavailable = a.state === 'account_unavailable'
        const manage = unavailable ? null : credentialManageUrl(a.credential?.cloudId, a.serverUrl)
        const detachName = a.credential?.name ?? (unavailable ? 'credential of a signed-out account' : 'missing credential')
        const reconnecting = flowRecord === a ? flow : null
        // Only the owner can sign a record in again: a shared one's health names whom to ask instead.
        const canReconnect = !reconnecting && (a.state === 'pending_authorization' || a.state === 'reauth_required') && a.credential?.relation === 'owned'
        return <li key={`${a.group}:${a.ref}`}><CredentialRow name={name} type={a.credential?.type} typeTitle={a.credential ? credentialTypeTitle(a.credential) : undefined} serviceUri={a.credential?.serviceUri}
          account={a.credential?.grantedUserEmail} health={reconnecting ? oauthFlowHealth(reconnecting) : credentialHealth(a.credential, a.state)}
          ownership={a.credential ? credentialOwnership(a.credential) : a.origin === 'local' ? credentialOwnership({ origin: 'local', relation: 'owned', ownerEmail: null }) : null}
          actions={<>
            {reconnecting && a.credential && flowActions(reconnecting, a.credential.name)}
            {canReconnect && a.credential &&
              <SettingsButton disabled={pending} aria-label={`Reconnect ${a.credential.name}`} title="Sign in to Google again" onClick={() => void reconnect(group.key, a.ref)}>Reconnect</SettingsButton>}
            {manage && a.credential && <ManageCredentialButton name={a.credential.name} url={manage} onError={setError} />}
            <SettingsIconButton disabled={pending} title={`Detach ${detachName}`} aria-label={`Detach ${detachName}`} onClick={() => edit(group.key, refs => refs.filter(r => r !== a.ref))}><Unlink size={14} /></SettingsIconButton>
          </>} /></li>
      })}
      {group.flow && (() => {
        const name = credentialTypeName(group.flow.type)
        return <li key={`flow:${group.flow.id}`}><CredentialRow name={name} type={group.flow.type} health={oauthFlowHealth(group.flow)}
          ownership={credentialOwnership({ origin: 'cloud', relation: 'owned', ownerEmail: null })} actions={flowActions(group.flow, name)} /></li>
      })()}</ul>
    </section>)}
    </SettingsSection>
    {(error || attached.error) && <p role="alert" className="text-[var(--color-danger)]">{error || unwrapIpcError(attached.error)}</p>}
    {helper.data?.needsUpdate && <div className="space-y-1"><SettingsButton disabled={pending || !helper.data.stamp} onClick={async () => {
      if (!helper.data?.stamp) return
      setPending(true); setError('')
      try { credentialResult(await window.api.serviceCredentials.updateHelper(agent.id, helper.data.stamp)); await helper.refetch() } catch (e) { setError(unwrapIpcError(e)) } finally { setPending(false) }
    }}>Update credential helper</SettingsButton><p className="text-[var(--color-text-muted)]">Replaces the older kit reader with support for attached credentials and Agent API keys.</p></div>}
    <CredentialAttachModal open={picking} agentId={agent.id} onClose={() => setPicking(false)} onAttach={attach} />
  </div>
}
