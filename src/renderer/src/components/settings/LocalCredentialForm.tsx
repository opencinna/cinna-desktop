import { useId, useState } from 'react'
import { ArrowLeft, Database, FileKey, KeyRound, Mail, Search, Send, type LucideIcon } from 'lucide-react'
import type { LocalCredentialType, ServiceCredentialDto } from '../../../../shared/serviceCredentials'
import { credentialResult } from '../../hooks/useServiceCredentials'
import { unwrapIpcError } from '../../utils/ipcError'
import { SettingsButton, SettingsCard, SettingsLabel, settingsInputClass } from './SettingsLayout'

const credentialTypes: { type: LocalCredentialType; name: string; description: string; icon: LucideIcon }[] = [
  { type: 'api_token', name: 'API token', description: 'Bearer tokens and custom API headers', icon: KeyRound },
  { type: 'email_imap', name: 'Email · IMAP', description: 'Read mail from an email account', icon: Mail },
  { type: 'email_smtp', name: 'Email · SMTP', description: 'Send mail through an email server', icon: Send },
  { type: 'odoo', name: 'Odoo', description: 'Connect to an Odoo database', icon: Database },
  { type: 'google_service_account', name: 'Google service account', description: 'Use a service account JSON key', icon: FileKey }
]
export const credentialTypeName = (type: string) => credentialTypes.find(c => c.type === type)?.name ?? type.replaceAll('_', ' ')
export const serviceUriHelp = 'A non-secret identifier for the service, such as slack.com or work-mail. Agents use it together with the credential type to match the correct credential to a required slot. Use the same Service URI on the credential and the agent’s requirement.'

export function CredentialTypePicker({ onSelect, onClose }: { onSelect: (type: LocalCredentialType) => void; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const matches = credentialTypes.filter(c => `${c.name} ${c.type} ${c.description}`.toLowerCase().includes(query.trim().toLowerCase()))
  return <SettingsCard>
    <div className="mb-3 flex items-center justify-between gap-3"><h3 className="text-[14px] font-medium">Choose credential type</h3><SettingsButton onClick={onClose}>Cancel</SettingsButton></div>
    <div className="relative mb-3"><Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" /><input autoFocus aria-label="Search credential types" placeholder="Search credential types…" className={`${settingsInputClass} pl-8`} value={query} onChange={e => setQuery(e.target.value)} /></div>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
      {matches.map(({ type, name, description, icon: Icon }) => <button key={type} type="button" onClick={() => onSelect(type)} className="flex items-start gap-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-3 text-left transition-colors hover:border-[var(--color-accent)] hover:bg-[var(--color-bg-hover)] focus-visible:outline-[var(--color-accent)]">
        <Icon size={18} className="mt-0.5 shrink-0 text-[var(--color-accent)]" /><span><span className="block text-[14px] font-medium">{name}</span><span className="mt-0.5 block text-[13px] text-[var(--color-text-muted)]">{description}</span></span>
      </button>)}
    </div>
    {!matches.length && <p role="status" className="py-4 text-center text-[13px] text-[var(--color-text-muted)]">No credential types match “{query}”.</p>}
  </SettingsCard>
}

type Field = { key: string; label: string; type?: 'password' | 'number' | 'checkbox'; placeholder?: string }
const fields: Record<LocalCredentialType, Field[]> = {
  api_token: [{ key: 'api_token', label: 'API token', type: 'password' }],
  email_imap: [{ key: 'host', label: 'Mail server', placeholder: 'imap.example.com' }, { key: 'port', label: 'Port', type: 'number' }, { key: 'login', label: 'Login' }, { key: 'password', label: 'Password', type: 'password' }, { key: 'is_ssl', label: 'Use SSL', type: 'checkbox' }],
  email_smtp: [{ key: 'host', label: 'Mail server', placeholder: 'smtp.example.com' }, { key: 'port', label: 'Port', type: 'number' }, { key: 'username', label: 'Username' }, { key: 'password', label: 'Password', type: 'password' }, { key: 'from_email', label: 'Sender email' }, { key: 'use_tls', label: 'Use STARTTLS', type: 'checkbox' }, { key: 'use_ssl', label: 'Use SSL', type: 'checkbox' }],
  odoo: [{ key: 'url', label: 'Odoo URL', placeholder: 'https://odoo.example.com' }, { key: 'database_name', label: 'Database name' }, { key: 'login', label: 'Login' }, { key: 'api_token', label: 'API token', type: 'password' }],
  google_service_account: []
}
function defaults(type: LocalCredentialType): Record<string, string | boolean> {
  if (type === 'api_token') return { api_token_type: 'bearer' }
  if (type === 'email_imap') return { port: '993', is_ssl: true }
  if (type === 'email_smtp') return { port: '587', use_tls: true, use_ssl: false }
  return {}
}
export function LocalCredentialForm({ type, record, onBack, onClose }: { type: LocalCredentialType; record?: ServiceCredentialDto; onBack?: () => void; onClose: () => void }) {
  const id = useId()
  const [name, setName] = useState(record?.name ?? '')
  const [serviceUri, setServiceUri] = useState(record?.serviceUri ?? '')
  const [notes, setNotes] = useState(record?.notes ?? '')
  const [values, setValues] = useState<Record<string, string | boolean>>(() => defaults(type))
  const [replace, setReplace] = useState(!record)
  const [error, setError] = useState(''), [pending, setPending] = useState(false)
  return <SettingsCard>
    <form className="space-y-3" onSubmit={async e => {
      e.preventDefault(); setPending(true); setError('')
      try {
        let data: Record<string, unknown> | undefined
        if (replace) {
          if (type === 'google_service_account') {
            try { data = JSON.parse(String(values.service_account_json ?? '{}')) } catch { throw new Error('Enter valid service account JSON.') }
          } else {
            data = { ...values }
            if (type === 'api_token' && values.api_token_type !== 'custom') delete data.api_token_template
          }
        }
        credentialResult(await window.api.serviceCredentials.save({ id: record?.id, name, type, serviceUri: serviceUri.trim(), notes, values: data }))
        setValues({}); onClose()
      } catch (err) { setError(unwrapIpcError(err)) } finally { setPending(false) }
    }}>
      <div className="flex items-center gap-2"><h3 className="flex-1 text-[14px] font-medium">{record ? 'Edit' : 'New'} {credentialTypeName(type)}</h3>{onBack && <SettingsButton disabled={pending} onClick={onBack}><ArrowLeft size={14} />Change type</SettingsButton>}</div>
      <fieldset disabled={pending} className="space-y-3">
        <div className="space-y-1"><SettingsLabel htmlFor={`${id}-name`}>Name</SettingsLabel><input id={`${id}-name`} required autoFocus className={settingsInputClass} value={name} onChange={e => setName(e.target.value)} /></div>
        <div className="space-y-1"><SettingsLabel htmlFor={`${id}-service-uri`} info={serviceUriHelp}>Service URI</SettingsLabel><input id={`${id}-service-uri`} className={settingsInputClass} placeholder="e.g. slack.com or work-mail" value={serviceUri} onChange={e => setServiceUri(e.target.value)} /></div>
        {record && <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={replace} onChange={e => setReplace(e.target.checked)} />Replace stored values</label>}
        {replace && <>
          {fields[type].map(field => <div key={field.key} className="space-y-1">
            {field.type === 'checkbox' ? <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={values[field.key] === true} onChange={e => setValues(v => ({ ...v, [field.key]: e.target.checked }))} />{field.label}</label>
              : <><SettingsLabel htmlFor={`${id}-${field.key}`}>{field.label}</SettingsLabel><input id={`${id}-${field.key}`} className={settingsInputClass} autoComplete="off" type={field.type ?? 'text'} placeholder={field.placeholder} value={String(values[field.key] ?? '')} onChange={e => setValues(v => ({ ...v, [field.key]: e.target.value }))} /></>}
          </div>)}
          {type === 'api_token' && <>
            <div className="space-y-1"><SettingsLabel htmlFor={`${id}-header`}>Authentication header</SettingsLabel><select id={`${id}-header`} className={settingsInputClass} value={String(values.api_token_type)} onChange={e => setValues(v => ({ ...v, api_token_type: e.target.value }))}><option value="bearer">Bearer token</option><option value="custom">Custom header</option></select></div>
            {values.api_token_type === 'custom' && <div className="space-y-1"><SettingsLabel htmlFor={`${id}-template`} info="Use {TOKEN} where the token value belongs, for example X-API-Key: {TOKEN}. This template is not secret.">Header template</SettingsLabel><input id={`${id}-template`} className={settingsInputClass} placeholder="X-API-Key: {TOKEN}" value={String(values.api_token_template ?? '')} onChange={e => setValues(v => ({ ...v, api_token_template: e.target.value }))} /></div>}
          </>}
          {type === 'google_service_account' && <div className="space-y-1"><SettingsLabel htmlFor={`${id}-json`}>Service account JSON</SettingsLabel><textarea id={`${id}-json`} className={`${settingsInputClass} font-mono`} rows={7} autoComplete="off" value={String(values.service_account_json ?? '')} onChange={e => setValues(v => ({ ...v, service_account_json: e.target.value }))} /></div>}
        </>}
        <details><summary className="cursor-pointer text-[13px] font-medium text-[var(--color-accent)]">More options</summary><div className="mt-3 space-y-1"><SettingsLabel htmlFor={`${id}-notes`}>Notes</SettingsLabel><textarea id={`${id}-notes`} className={settingsInputClass} value={notes} onChange={e => setNotes(e.target.value)} /></div></details>
      </fieldset>
      <div className="flex justify-end gap-2 pt-1"><SettingsButton disabled={pending} onClick={onClose}>Cancel</SettingsButton><button type="submit" disabled={pending || !name.trim()} className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-[14px] font-medium text-white transition-colors hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-30">{pending ? 'Saving…' : 'Save'}</button></div>
      {error && <p role="alert" className="text-[var(--color-danger)] text-[13px]">{error}</p>}
    </form>
  </SettingsCard>
}
