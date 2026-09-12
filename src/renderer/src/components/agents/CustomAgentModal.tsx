import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { useAuthStore } from '../../stores/auth.store'
import { useUIStore } from '../../stores/ui.store'
import { unwrapIpcError } from '../../utils/ipcError'
import { parseCustomAgentConfig, type CustomAgentTestResult } from '../../../../shared/customAgents'
import type { StoredPermissionGrant } from '../../../../shared/localAgentRequests'

const FIELD = 'mt-1 w-full min-w-0 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-2 text-xs text-[var(--color-text)] focus:outline-none focus:border-[var(--color-accent)] disabled:opacity-50'
const BUTTON = 'min-w-28 rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] disabled:opacity-50'

export function CustomAgentModal({ agentId, onClose }: { agentId?: string; onClose(): void }): React.JSX.Element {
  const profile = useAuthStore((state) => state.currentUser?.id)
  const queryClient = useQueryClient()
  const [command, setCommand] = useState('')
  const [cwd, setCwd] = useState('')
  const [localCwd, setLocalCwd] = useState('')
  const [name, setName] = useState('')
  const [more, setMore] = useState(false)
  const [grants, setGrants] = useState<StoredPermissionGrant[]>([])
  const [tested, setTested] = useState<{ identity: string; result: CustomAgentTestResult } | null>(null)
  const [busy, setBusy] = useState<'loading' | 'testing' | 'saving' | 'revoking' | null>(agentId ? 'loading' : null)
  const [error, setError] = useState('')
  const mounted = useRef(true), generation = useRef(0)
  const identity = JSON.stringify([command, cwd, localCwd])
  const current = (token: number): boolean => mounted.current && generation.current === token && useAuthStore.getState().currentUser?.id === profile
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++ } }, [])
  useEffect(() => {
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape' && !busy) onClose() }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [busy, onClose])
  useEffect(() => {
    if (!agentId) return
    const token = ++generation.current
    void window.api.customAgents.configuration(agentId).then((value) => {
      if (!current(token)) return
      setCommand(JSON.stringify(value.config.command)); setCwd(value.config.cwd)
      setLocalCwd(value.config.localCwd ?? ''); setName(value.name); setGrants(value.grants)
    }).catch((err) => { if (current(token)) setError(unwrapIpcError(err, 'Could not read this command.')) })
      .finally(() => { if (current(token)) setBusy(null) })
  }, [agentId, profile])
  const config = (): ReturnType<typeof parseCustomAgentConfig> => {
    let argv: unknown
    try { argv = JSON.parse(command) } catch { throw new Error('Enter the command as a JSON array, for example ["ssh", "-T", "host", "opencode acp"].') }
    return parseCustomAgentConfig({ launcher: 'custom', command: argv, cwd, ...(localCwd ? { localCwd } : {}) })
  }
  const test = async (): Promise<void> => {
    if (busy) return
    const token = ++generation.current
    setBusy('testing'); setError(''); setTested(null)
    try {
      const result = await window.api.customAgents.test({ ...(agentId ? { id: agentId } : {}), config: config() })
      if (current(token)) setTested({ identity, result })
    } catch (err) { if (current(token)) setError(unwrapIpcError(err, 'The command did not answer initialization.')) }
    finally { if (current(token)) setBusy(null) }
  }
  const startChat = (id: string): void => {
    const ui = useUIStore.getState(); ui.setPendingAgentId(id); ui.setActiveView('chat'); ui.setSidebarTab('chats'); onClose()
  }
  const save = async (): Promise<void> => {
    if (busy || tested?.identity !== identity) return
    const token = ++generation.current
    setBusy('saving'); setError('')
    try {
      const result = await window.api.customAgents.save({ ...(agentId ? { id: agentId } : {}), ...(name.trim() ? { name: name.trim() } : {}), config: config(), testToken: tested.result.token })
      if (!current(token)) return
      await queryClient.invalidateQueries({ queryKey: ['agents'] })
      if (!current(token)) return
      if (agentId) onClose(); else startChat(result.id)
    } catch (err) { if (current(token)) setError(unwrapIpcError(err, 'Could not save this command.')) }
    finally { if (current(token)) setBusy(null) }
  }
  const revoke = async (key: string): Promise<void> => {
    if (!agentId || busy) return
    const token = ++generation.current
    setBusy('revoking'); setError('')
    try { await window.api.customAgents.revokeGrant({ id: agentId, key }); if (current(token)) setGrants((values) => values.filter((value) => value.key !== key)) }
    catch (err) { if (current(token)) setError(unwrapIpcError(err, 'Could not revoke this permission.')) }
    finally { if (current(token)) setBusy(null) }
  }
  const result = tested?.identity === identity ? tested.result : null
  return createPortal(<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 p-4">
    <div role="dialog" aria-modal="true" aria-label={agentId ? 'Command-line agent' : 'Add command-line agent'} className="w-full max-w-[34rem] max-h-[90vh] overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-6 shadow-lg">
      <div className="flex items-center justify-between gap-3"><h2 className="text-base font-semibold">{agentId ? 'Command-line agent' : 'Add command-line agent'}</h2><button type="button" aria-label="Close" disabled={!!busy} onClick={onClose} className="p-1 text-[var(--color-text)] disabled:opacity-50"><X size={16} /></button></div>
      <p className="mt-2 text-[11px] text-[var(--color-text-muted)]">Run an ACP command as your user, locally or through SSH. SSH uses your existing keys and host configuration.</p>
      <form className="mt-5 space-y-3" onSubmit={(event) => { event.preventDefault(); void save() }}>
        <label className="block text-xs">Command<textarea autoFocus className={`${FIELD} h-20 resize-none font-mono`} value={command} disabled={!!busy} placeholder={'["ssh", "-T", "-o", "BatchMode=yes", "host", "opencode acp"]'} onChange={(event) => setCommand(event.target.value)} /></label>
        <p className="text-[11px] text-[var(--color-text-muted)]">Enter executable and arguments as a JSON array. Output must be ACP; diagnostics belong on stderr.</p>
        <label className="block text-xs">Working directory<input className={FIELD} value={cwd} disabled={!!busy} placeholder="/remote/workspace" onChange={(event) => setCwd(event.target.value)} /></label>
        <button type="button" className="text-xs font-medium text-[var(--color-accent)]" aria-expanded={more} disabled={!!busy} onClick={() => setMore(!more)}>{more ? 'Fewer options' : 'More options'}</button>
        {more && <div className="space-y-3"><label className="block text-xs">Name<input className={FIELD} value={name} disabled={!!busy} maxLength={200} placeholder="Use the agent’s name" onChange={(event) => setName(event.target.value)} /></label><label className="block text-xs">Local process directory<input className={FIELD} value={localCwd} disabled={!!busy} placeholder="Your home directory" onChange={(event) => setLocalCwd(event.target.value)} /></label><p className="text-[11px] text-[var(--color-text-muted)]">This is where the local command starts. Working directory above is sent to the agent and may be on another machine.</p></div>}
        <div className="flex justify-end"><button type="button" className={BUTTON} disabled={!!busy || !command || !cwd} onClick={() => void test()}>{busy === 'testing' ? 'Testing…' : 'Test'}</button></div>
        <div className="h-24 overflow-y-auto [overflow-wrap:anywhere] text-[11px] leading-4 text-[var(--color-text-secondary)]" aria-live="polite">
          {result ? <><p className="font-medium break-words">Initialization succeeded: {result.name}{result.version ? ` · ${result.version}` : ''}</p><p>Authentication methods: {result.authMethods.map((method) => method.name).join(', ') || 'None advertised'}.</p><p>This checks the protocol connection. Sign in with the configured CLI separately if it requires authentication.</p></> : <p>Test runs initialization only, then closes the command. It sends no chat message and does not sign in.</p>}
        </div>
        <div role="alert" className="h-12 overflow-y-auto [overflow-wrap:anywhere] text-[11px] leading-4 text-[var(--color-danger)]">{error}</div>
        <div className="flex justify-end gap-2">{agentId && <button type="button" className={BUTTON} disabled={!!busy} onClick={() => startChat(agentId)}>Start chat</button>}<button type="submit" className={`${BUTTON} bg-[var(--color-accent)] text-white`} disabled={!!busy || !result}>{busy === 'saving' ? 'Saving…' : agentId ? 'Save' : 'Add agent'}</button></div>
        {agentId && <details className="border-t border-[var(--color-border)] pt-3 text-xs"><summary className="cursor-pointer font-medium text-[var(--color-accent)]">Remembered permissions ({grants.length})</summary><div className="mt-2 max-h-36 space-y-2 overflow-y-auto">{grants.length ? grants.map((grant) => <div key={grant.key} className="flex items-start gap-2"><span className="min-w-0 flex-1 break-all text-[11px]">{grant.action}: {grant.pattern}</span><button type="button" className="shrink-0 text-[11px] text-[var(--color-accent)] disabled:opacity-50" disabled={!!busy} onClick={() => void revoke(grant.key)}>Revoke</button></div>) : <p className="text-[11px] text-[var(--color-text-muted)]">No remembered permissions for this configuration.</p>}</div></details>}
      </form>
    </div>
  </div>, document.body)
}
