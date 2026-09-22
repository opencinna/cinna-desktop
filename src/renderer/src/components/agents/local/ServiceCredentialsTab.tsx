import { useQuery } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import type { LocalAgentDto } from '../../../../../shared/localAgents'
import type { ServiceCredentialAttachmentDto } from '../../../../../shared/serviceCredentials'
import { credentialResult, useCredentialAttachments } from '../../../hooks/useServiceCredentials'
import { unwrapIpcError } from '../../../utils/ipcError'
import { CredentialAttachModal } from './CredentialAttachModal'
import { CredentialsCard, useOpenCredentialsFile } from './ReadOnlyCards'
const button = 'rounded border border-[var(--color-border)] px-2 py-1 text-[var(--color-accent)] disabled:opacity-50'
export function ServiceCredentialsTab({ agent }: { agent: LocalAgentDto }) {
  const attached = useCredentialAttachments(agent.id)
  const env = useOpenCredentialsFile(agent.id)
  const helper = useQuery({ queryKey: ['credential-helper', agent.id], queryFn: async () => credentialResult(await window.api.serviceCredentials.helper(agent.id)), enabled: agent.kind === 'kit' })
  const [picking, setPicking] = useState(false), [pending, setPending] = useState(false), [error, setError] = useState('')
  // Owned here, not in the modal: an attach outlives the modal closing. Every
  // list write (attach, detach, reorder) runs on one chain and applies its change
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
  const moveUp = (ref: string) => (refs: string[]) => {
    const next = [...refs], i = next.indexOf(ref)
    if (i > 0) [next[i - 1], next[i]] = [next[i], next[i - 1]]
    return next
  }
  const groups: { key: string; label: string; items: ServiceCredentialAttachmentDto[] }[] = []
  for (const a of attached.data ?? []) {
    const found = groups.find(g => g.key === a.group)
    if (found) found.items.push(a); else groups.push({ key: a.group, label: a.groupLabel, items: [a] })
  }
  return <div className="space-y-4 text-[13px]">
    <p>{agent.kind === 'bare' ? 'Attached values are kept outside this folder, in Cinna’s storage.' : 'Attached values are written to this agent’s credentials folder.'} Values stored on this computer are readable by the executing agent.</p>
    <div><button className={button} disabled={pending} onClick={() => setPicking(true)}><Plus size={13} className="mr-1 inline" />Attach</button></div>
    {groups.map(group => <section key={group.key} aria-label={group.label} className="space-y-2">
      <h4 className="text-[12px] font-semibold text-[var(--color-text-muted)]">{group.label}</h4>
      <ul className="space-y-2">{group.items.map((a, i) => <li key={`${a.group}:${a.ref}`} className="rounded border border-[var(--color-border)] p-3"><div className="flex items-center gap-2"><span className="flex-1">{a.state === 'account_unavailable'
        ? 'Account not signed in — unlock or sign in to that profile to use it'
        : <>{a.credential?.name ?? 'Missing credential'} · {a.state.replaceAll('_', ' ')}{a.credential?.serviceUri ? ` · ${a.credential.serviceUri}` : ''}</>}</span>
        {a.state !== 'account_unavailable' && <button className={button} disabled={pending || i === 0} onClick={() => edit(group.key, moveUp(a.ref))}>Move up</button>}
        <button className={button} disabled={pending} onClick={() => edit(group.key, refs => refs.filter(r => r !== a.ref))}>Detach</button></div></li>)}</ul>
    </section>)}
    <p className="text-[var(--color-text-muted)]">Detach updates generated files; the credential record remains.</p>
    {(error || attached.error) && <p role="alert" className="text-[var(--color-danger)]">{error || unwrapIpcError(attached.error)}</p>}
    {helper.data?.needsUpdate && <div><button className={button} disabled={pending || !helper.data.stamp} onClick={async () => {
      if (!helper.data?.stamp) return
      setPending(true); setError('')
      try { credentialResult(await window.api.serviceCredentials.updateHelper(agent.id, helper.data.stamp)); await helper.refetch() } catch (e) { setError(unwrapIpcError(e)) } finally { setPending(false) }
    }}>Update credential helper</button><p className="text-[var(--color-text-muted)]">Replaces the older kit reader with support for attached credentials.</p></div>}
    {agent.credentials.some(c => c.overlappingKeys?.length) && <p className="text-[var(--color-text-muted)]">Attached credentials take precedence over these .env fields: {agent.credentials.flatMap(c => c.overlappingKeys ?? []).join(', ')}.</p>}
    {agent.kind === 'kit' && <CredentialsCard agent={agent} env={env} />}
    <CredentialAttachModal open={picking} agentId={agent.id} onClose={() => setPicking(false)} onAttach={attach} />
  </div>
}
