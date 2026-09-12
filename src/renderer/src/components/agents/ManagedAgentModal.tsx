import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { useProviders } from '../../hooks/useProviders'
import { useAuthStore } from '../../stores/auth.store'
import { useUIStore } from '../../stores/ui.store'
import { unwrapIpcError } from '../../utils/ipcError'
import type { ManagedAgentChoices } from '../../../../shared/managedAgents'

const FIELD = 'mt-1 w-full min-w-0 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-2 text-xs text-[var(--color-text)] focus:outline-none focus:border-[var(--color-accent)] disabled:opacity-50'
const BUTTON = 'min-w-28 rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] disabled:opacity-50'

export function ManagedAgentModal({ agentId, onClose }: { agentId?: string; onClose(): void }): React.JSX.Element {
  const { data: providers } = useProviders()
  const queryClient = useQueryClient()
  const profile = useAuthStore((state) => state.currentUser?.id)
  const [credentialId, setCredentialId] = useState('')
  const [remoteId, setRemoteId] = useState('')
  const [environmentId, setEnvironmentId] = useState('')
  const [workspace, setWorkspace] = useState('')
  const [name, setName] = useState('')
  const [version, setVersion] = useState('')
  const [choices, setChoices] = useState<ManagedAgentChoices | null>(null)
  const [loadedFor, setLoadedFor] = useState('')
  const [busy, setBusy] = useState<'loading' | 'saving' | null>(agentId ? 'loading' : null)
  const [error, setError] = useState('')
  const [more, setMore] = useState(false)
  const mounted = useRef(true)
  const generation = useRef(0)
  const identity = JSON.stringify([credentialId, workspace.trim()])
  const eligible = (providers ?? []).filter((item) => item.type === 'anthropic' && item.enabled && item.hasApiKey && !item.unsupported)
  const current = (token: number): boolean => mounted.current && generation.current === token && useAuthStore.getState().currentUser?.id === profile

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; generation.current++ }
  }, [])
  useEffect(() => {
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape' && !busy) onClose() }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [busy, onClose])
  useEffect(() => {
    if (!agentId) return
    const token = ++generation.current
    void window.api.managedAgents.configuration(agentId).then((saved) => {
      if (!current(token)) return
      setCredentialId(saved.config.credentialId); setRemoteId(saved.config.agentId)
      setEnvironmentId(saved.config.environmentId); setWorkspace(saved.config.workspaceId ?? '')
      setVersion(saved.config.version?.toString() ?? ''); setName(saved.name)
      setChoices({ agents: [{ id: saved.config.agentId, name: saved.config.agentId, description: null, version: saved.config.version ?? 1 }], environments: [{ id: saved.config.environmentId, name: saved.config.environmentId }] })
    }).catch((err) => { if (current(token)) setError(unwrapIpcError(err, 'Could not read this agent.')) })
      .finally(() => { if (current(token)) setBusy(null) })
  }, [agentId, profile]) // profile-scoped results cannot fill another profile's form.

  const load = async (): Promise<void> => {
    if (!credentialId || busy) return
    const token = ++generation.current
    setBusy('loading'); setError('')
    try {
      const result = await window.api.managedAgents.choices({ credentialId, ...(workspace.trim() ? { workspaceId: workspace.trim() } : {}) })
      if (!current(token)) return
      setChoices(result); setLoadedFor(identity)
      setRemoteId((id) => result.agents.some((item) => item.id === id) ? id : result.agents.length === 1 ? result.agents[0].id : '')
      setEnvironmentId((id) => result.environments.some((item) => item.id === id) ? id : result.environments.length === 1 ? result.environments[0].id : '')
      if (!result.agents.length || !result.environments.length) setError('This workspace needs an existing agent and environment in Claude before one can be added here.')
    } catch (err) { if (current(token)) setError(unwrapIpcError(err, 'Could not load this Claude workspace.')) }
    finally { if (current(token)) setBusy(null) }
  }
  const startChat = (id: string): void => {
    const ui = useUIStore.getState()
    ui.setPendingAgentId(id); ui.setActiveView('chat'); ui.setSidebarTab('chats')
    onClose()
  }
  const save = async (): Promise<void> => {
    if (busy || loadedFor !== identity || !remoteId || !environmentId) return
    const token = ++generation.current
    setBusy('saving'); setError('')
    try {
      const result = await window.api.managedAgents.save({ ...(agentId ? { id: agentId } : {}), ...(name.trim() ? { name: name.trim() } : {}), config: {
        credentialId, agentId: remoteId, environmentId,
        ...(workspace.trim() ? { workspaceId: workspace.trim() } : {}),
        ...(version ? { version: Number(version) } : {})
      } })
      if (!current(token)) return
      await queryClient.invalidateQueries({ queryKey: ['agents'] })
      if (!current(token)) return
      if (agentId) onClose(); else startChat(result.id)
    } catch (err) { if (current(token)) setError(unwrapIpcError(err, 'Could not save this Managed agent.')) }
    finally { if (current(token)) setBusy(null) }
  }

  return createPortal(<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 p-4">
    <div role="dialog" aria-modal="true" aria-label={agentId ? 'Managed agent' : 'Add Managed agent'} className="w-full max-w-[30rem] max-h-[90vh] overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-6 shadow-lg">
      <div className="flex items-center justify-between gap-3"><h2 className="text-base font-semibold">{agentId ? 'Managed agent' : 'Add Managed agent'}</h2><button type="button" aria-label="Close" disabled={!!busy} onClick={onClose} className="p-1 text-[var(--color-text)] disabled:opacity-50"><X size={16} /></button></div>
      <p className="mt-2 text-[11px] text-[var(--color-text-muted)]">Use an existing agent and environment from your Claude workspace.</p>
      <form className="mt-5 space-y-3" onSubmit={(event) => { event.preventDefault(); void save() }}>
        <div className="flex items-end gap-2"><label className="min-w-0 flex-1 text-xs">Credential<select autoFocus className={FIELD} disabled={!!busy} value={credentialId} onChange={(event) => setCredentialId(event.target.value)}><option value="">Choose an API credential</option>{eligible.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><button type="button" className={`${BUTTON} w-32 shrink-0 h-[34px]`} disabled={!!busy || !credentialId} onClick={() => void load()}>{busy === 'loading' ? 'Loading…' : 'Load workspace'}</button></div>
        <label className="block text-xs">Agent<select className={FIELD} disabled={!!busy || loadedFor !== identity} value={remoteId} onChange={(event) => setRemoteId(event.target.value)}><option value="">Choose a Managed agent</option>{choices?.agents.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label className="block text-xs">Environment<select className={FIELD} disabled={!!busy || loadedFor !== identity} value={environmentId} onChange={(event) => setEnvironmentId(event.target.value)}><option value="">Choose an environment</option>{choices?.environments.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <button type="button" className="text-xs font-medium text-[var(--color-accent)]" aria-expanded={more} disabled={!!busy} onClick={() => setMore(!more)}>{more ? 'Fewer options' : 'More options'}</button>
        {more && <div className="space-y-3"><label className="block text-xs">Name<input className={FIELD} disabled={!!busy} value={name} maxLength={200} placeholder="Use the agent’s name" onChange={(event) => setName(event.target.value)} /></label><label className="block text-xs">Workspace ID<input className={FIELD} disabled={!!busy} value={workspace} placeholder="Credential’s workspace" onChange={(event) => setWorkspace(event.target.value)} /></label><label className="block text-xs">Agent version<input className={FIELD} disabled={!!busy} type="number" min={1} step={1} value={version} placeholder="Latest" onChange={(event) => setVersion(event.target.value)} /></label></div>}
        <div role="alert" className="h-12 overflow-y-auto text-[11px] leading-4 text-[var(--color-danger)]">{error || (!eligible.length && providers ? 'Add an Anthropic API key in Settings → AI Credentials first.' : '')}</div>
        <div className="flex justify-end gap-2">{agentId && <button type="button" className={BUTTON} disabled={!!busy} onClick={() => startChat(agentId)}>Start chat</button>}<button type="submit" className={`${BUTTON} bg-[var(--color-accent)] text-white`} disabled={!!busy || loadedFor !== identity || !remoteId || !environmentId}>{busy === 'saving' ? 'Saving…' : agentId ? 'Save' : 'Add agent'}</button></div>
      </form>
    </div>
  </div>, document.body)
}
