import { useState } from 'react'
import { Trash2, ChevronDown, Wrench, Shield, Unlink } from 'lucide-react'
import { useUpsertMcpProvider, useDeleteMcpProvider, useConnectMcp, useDisconnectMcp } from '../../hooks/useMcp'
import { AnimatedCollapse } from '../ui/AnimatedCollapse'
import { mcpHealth } from './mcpPresentation'
import { DeleteMcpProviderDialog } from './DeleteMcpProviderDialog'
import { formatEnvVars, parseEnvVars } from '../../utils/envVars'
import { AddonRow } from '../agents/local/AddonRow'
import { EnvSlotFields } from '../agents/local/AddonPickerDetail'
import { CredentialStatusGlyph } from './CredentialRow'
import { SettingsBadge, SettingsButton, SettingsIconButton } from './SettingsLayout'
import { STDIO_RUNTIME_TEXT } from '../../../../shared/stdioRuntimeText'
import { useAddonPolicy } from '../../hooks/useAddonDirectory'

export const MCP_CARD_TEXT = {
  fromPlugin: (title: string | undefined) => (title ? `From ${title}` : 'From a plugin'),
  fromPluginTitle: 'A plugin on an agent added it; it goes when the plugin is removed from the agent’s Addons tab'
} as const

interface MCPProviderCardProps {
  provider: {
    id: string
    name: string
    transportType: string
    command?: string
    args?: string[]
    url?: string
    env?: Record<string, string>
    enabled: boolean
    hasAuth: boolean
    authType: string
    status: string
    tools: Array<{ name: string; description: string }>
    error?: string
    /** A plugin owns it: only its settings values, sign-in and on/off are editable. */
    managedBy?: string
    /** The owning plugin's title, when main sends it; the badge says "From a plugin" otherwise. */
    managedByTitle?: string
    /**
     * Its settings whose values main keeps to itself (a plugin's connector, or
     * a local one made from a directory entry), with whether each has one: the
     * form asks one password field per name instead of KEY=VALUE text.
     */
    envSlots?: Array<{ name: string; hasValue: boolean }>
  }
  /**
   * Set where the card lists a connector attached to an agent (its Addons
   * tab): the card is drawn as one of that tab's addon rows (`AddonRow`),
   * and offers Detach instead of Delete — the connector itself stays in
   * Settings → MCP. The toggle and the edit form behave as in Settings.
   * Detach asks first, inside the card (as a skill row's Remove does);
   * `pending` while it runs, and a refusal is the card's last line (rule 6).
   */
  detach?: { onDetach: () => void; pending?: boolean; error?: string | null }
}

export function MCPProviderCard({ provider, detach }: MCPProviderCardProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [name, setName] = useState(provider.name)
  const [transportType, setTransportType] = useState(provider.transportType)
  const [command, setCommand] = useState(provider.command ?? '')
  const [args, setArgs] = useState((provider.args ?? []).join(' '))
  const [url, setUrl] = useState(provider.url ?? '')
  const [envStr, setEnvStr] = useState(formatEnvVars(provider.env))
  // Typed values for `envSlots`, never prefilled — empty keeps the stored value.
  const [slotValues, setSlotValues] = useState<Record<string, string>>({})
  const slots = provider.envSlots ?? []
  const [authType, setAuthType] = useState(provider.authType === 'bearer' ? 'bearer' : 'oauth')
  // Never prefilled with the stored token — write-only, left blank to keep it.
  const [bearerToken, setBearerToken] = useState('')
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [confirmingDetach, setConfirmingDetach] = useState(false)

  const upsert = useUpsertMcpProvider()
  const deleteMcp = useDeleteMcpProvider()
  const connectMcp = useConnectMcp()
  const disconnectMcp = useDisconnectMcp()

  // One glyph and tone for a connector wherever it is listed (rule 13).
  const statusGlyph = <CredentialStatusGlyph health={mcpHealth(provider)} />

  const statusLabel =
    provider.status === 'awaiting-auth'
      ? 'Waiting for authorization...'
      : provider.status === 'error'
        ? provider.error ?? 'Error'
        : undefined

  // Local edits diverge from the persisted record. The toggle bypasses the
  // form (it only flips `enabled`) so when the form is dirty we freeze the
  // toggle to avoid silently overwriting the user's in-progress changes.
  const isDirty =
    name !== provider.name ||
    transportType !== provider.transportType ||
    command !== (provider.command ?? '') ||
    args !== (provider.args ?? []).join(' ') ||
    url !== (provider.url ?? '') ||
    envStr !== formatEnvVars(provider.env) ||
    Object.values(slotValues).some((value) => value !== '') ||
    authType !== (provider.authType === 'bearer' ? 'bearer' : 'oauth') ||
    bearerToken.trim() !== ''

  // A plugin's connector: what it runs is the plugin's, shown but not editable.
  const managed = !!provider.managedBy

  const handleSave = (): void => {
    // With slots, every name is sent (a name left out is dropped); an empty value keeps the stored one.
    const envObj =
      slots.length > 0 ? Object.fromEntries(slots.map((slot) => [slot.name, slotValues[slot.name] ?? ''])) : parseEnvVars(envStr)
    const saved = (): void => {
      setBearerToken('')
      setSlotValues({})
    }

    if (managed) {
      // The stored command and args exactly as they are (never re-split on spaces); only the values change.
      upsert.mutate(
        {
          id: provider.id,
          name: provider.name,
          transportType: provider.transportType,
          command: provider.command,
          args: provider.args,
          url: provider.url,
          env: envObj,
          enabled: provider.enabled,
          authType: provider.authType === 'bearer' ? 'bearer' : 'oauth',
          bearerToken: bearerToken.trim() || undefined
        },
        { onSuccess: saved }
      )
      return
    }

    upsert.mutate(
      {
        id: provider.id,
        name,
        transportType,
        command: transportType === 'stdio' ? command : undefined,
        args: transportType === 'stdio' ? args.split(/\s+/).filter(Boolean) : undefined,
        url: transportType !== 'stdio' ? url : undefined,
        env:
          transportType === 'stdio' && Object.keys(envObj).length > 0 ? envObj : undefined,
        enabled: provider.enabled,
        authType: transportType !== 'stdio' ? (authType as 'oauth' | 'bearer') : undefined,
        bearerToken: bearerToken.trim() || undefined
      },
      { onSuccess: saved }
    )
  }

  const handleToggle = (): void => {
    upsert.mutate({
      id: provider.id,
      name: provider.name,
      transportType: provider.transportType,
      command: provider.command,
      args: provider.args,
      url: provider.url,
      env: provider.env,
      enabled: !provider.enabled
    })
  }

  // Refused by the admin's policy: while it still forbids local servers Reconnect could only repeat the refusal,
  // so none is offered; once it allows them, Reconnect clears a refusal recorded in a race with the change.
  // Needs Node.js or Docker keeps it, as the retry once the runtime is installed.
  const stdioAllowed = useAddonPolicy().data?.stdioMcp !== false
  const policyBlocked = provider.status === 'error' && provider.error === STDIO_RUNTIME_TEXT.policy && !stdioAllowed

  const handleReconnect = (): void => {
    connectMcp.mutate(provider.id)
  }

  const handleDisconnect = (): void => {
    disconnectMcp.mutate(provider.id)
  }

  const inputClass =
    'w-full bg-[var(--color-bg)] text-[var(--color-text)] px-2.5 py-1.5 rounded-md text-[14px] border border-[var(--color-border)] focus:border-[var(--color-accent)] focus:outline-none'

  // This switch is the connector's own, for every agent on this computer (a plugin row's is per agent).
  const toggleTitle = isDirty
    ? 'Save or discard your edits first'
    : provider.enabled
      ? `Turn off ${provider.name} on this computer`
      : `Turn on ${provider.name} on this computer`
  const toggle = (
    <button
      onClick={(e) => { e.stopPropagation(); if (!isDirty) handleToggle() }}
      disabled={isDirty}
      title={toggleTitle}
      aria-label={provider.enabled ? `Turn off ${provider.name}` : `Turn on ${provider.name}`}
      className={`relative w-9 h-5 shrink-0 rounded-full transition-colors ${
        provider.enabled ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-border)]'
      } ${isDirty ? 'opacity-50 cursor-not-allowed' : ''}`}
    >
      <div
        className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
          provider.enabled ? 'left-[18px]' : 'left-0.5'
        }`}
      />
    </button>
  )

  const form = (
        <AnimatedCollapse open={expanded}>
          <div className="border-t border-[var(--color-border)] px-4 py-3 space-y-2.5">
            <div>
              <label className="block text-[12px] text-[var(--color-text-muted)] mb-0.5">Name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} readOnly={managed} className={inputClass} />
            </div>

            <div>
                <label className="block text-[12px] text-[var(--color-text-muted)] mb-0.5">Transport</label>
                <select value={transportType} onChange={(e) => setTransportType(e.target.value)} disabled={managed} className={inputClass}>
                  <option value="stdio">stdio</option>
                  <option value="sse">SSE (deprecated)</option>
                  <option value="streamable-http">Streamable HTTP</option>
                </select>
            </div>

            {transportType === 'stdio' ? (
              <>
                <div>
                  <label className="block text-[12px] text-[var(--color-text-muted)] mb-0.5">Command</label>
                  <input value={command} onChange={(e) => setCommand(e.target.value)} readOnly={managed} placeholder="e.g., npx" className={inputClass} />
                </div>
                <div>
                  <label className="block text-[12px] text-[var(--color-text-muted)] mb-0.5">Arguments</label>
                  <input value={args} onChange={(e) => setArgs(e.target.value)} readOnly={managed} placeholder="space separated" className={inputClass} />
                </div>
                {slots.length > 0 ? (
                  <div role="group" aria-label={`Settings for ${provider.name}`}>
                    <p className="block text-[12px] text-[var(--color-text-muted)] mb-0.5">Settings</p>
                    <EnvSlotFields stacked idPrefix={`mcp-card-${provider.id}-env`} slots={slots} values={slotValues} onChange={setSlotValues} />
                  </div>
                ) : (
                  <div>
                    <label className="block text-[12px] text-[var(--color-text-muted)] mb-0.5">Env Vars (KEY=VALUE per line)</label>
                    <textarea
                      value={envStr}
                      onChange={(e) => setEnvStr(e.target.value)}
                      rows={2}
                      placeholder="API_KEY=xxx"
                      className={`${inputClass} resize-none font-mono`}
                    />
                  </div>
                )}
              </>
            ) : (
              <>
                <div>
                  <label className="block text-[12px] text-[var(--color-text-muted)] mb-0.5">URL</label>
                  <input value={url} onChange={(e) => setUrl(e.target.value)} readOnly={managed} placeholder="https://mcp.example.com" className={inputClass} />
                </div>
                <div>
                  <label className="block text-[12px] text-[var(--color-text-muted)] mb-0.5">
                    Authentication
                  </label>
                  <div className="flex gap-1 rounded-md border border-[var(--color-border)] p-0.5">
                    {(['oauth', 'bearer'] as const).map((t) => (
                      <button
                        key={t}
                        disabled={managed}
                        onClick={() => setAuthType(t)}
                        className={`flex-1 px-2 py-1 rounded text-[13px] font-medium transition-colors ${
                          authType === t
                            ? 'bg-[var(--color-accent)] text-white'
                            : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
                        }`}
                      >
                        {t === 'oauth' ? 'OAuth' : 'Bearer Token'}
                      </button>
                    ))}
                  </div>
                </div>
                {authType === 'bearer' && (
                  <div>
                    <label className="block text-[12px] text-[var(--color-text-muted)] mb-0.5">
                      Bearer Token
                    </label>
                    <input
                      type="password"
                      value={bearerToken}
                      onChange={(e) => setBearerToken(e.target.value)}
                      placeholder={
                        provider.hasAuth
                          ? 'Leave blank to keep the current token'
                          : "Paste the server's access token"
                      }
                      className={inputClass}
                    />
                  </div>
                )}
              </>
            )}

            <div className="flex justify-end gap-2">
              {provider.status === 'connected' ? (
                <button
                  onClick={handleDisconnect}
                  className="px-3 py-1.5 rounded-md text-[14px] font-medium border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
                >
                  Disconnect
                </button>
              ) : provider.status !== 'awaiting-auth' && !policyBlocked ? (
                <button
                  onClick={handleReconnect}
                  disabled={connectMcp.isPending}
                  className="min-w-[120px] px-3 py-1.5 rounded-md text-[14px] font-medium border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors disabled:opacity-50"
                >
                  {connectMcp.isPending ? 'Connecting...' : 'Reconnect'}
                </button>
              ) : null}

              <button
                onClick={handleSave}
                className="px-3 py-1.5 rounded-md text-[14px] font-medium bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white transition-colors"
              >
                Save
              </button>
            </div>

            {statusLabel && (
              <p className={`text-[12px] ${
                provider.status === 'awaiting-auth' ? 'text-[var(--color-warning)]' : 'text-[var(--color-danger)]'
              }`}>
                {statusLabel}
              </p>
            )}

            {provider.tools.length > 0 && (
              <div>
                <p className="text-[12px] text-[var(--color-text-muted)] mb-1 flex items-center gap-1">
                  <Wrench size={10} /> {provider.tools.length} tools
                </p>
                <div className="space-y-0.5">
                  {provider.tools.map((tool) => (
                    <div key={tool.name} className="flex items-center gap-1.5 px-1.5 py-0.5 rounded bg-[var(--color-bg)] text-[12px]">
                      <span className="font-mono text-[var(--color-accent)]">{tool.name}</span>
                      <span className="text-[var(--color-text-muted)] truncate">{tool.description}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </AnimatedCollapse>

  )

  // On an agent's Addons tab the card is one row of the tab's single list:
  // the shell every addon shares, with the connector's own toggle, Detach and
  // edit form (ux_rules rule 13). Settings → MCP keeps its own header.
  if (detach) {
    const detachLabel = `Detach ${provider.name} from this agent`
    return (
      <AddonRow
        kind="mcp"
        title={provider.name}
        source={<SettingsBadge title="Set up in Settings → MCP on this computer">On this computer</SettingsBadge>}
        status={statusGlyph}
        dataAttributes={{ 'data-mcp-row': provider.id }}
        expandable={{ expanded, onToggle: () => setExpanded(!expanded) }}
        actions={
          <>
            {toggle}
            <SettingsIconButton
              danger
              onClick={() => setConfirmingDetach(true)}
              disabled={detach.pending || confirmingDetach}
              title={detachLabel}
              aria-label={detachLabel}
            >
              <Unlink size={14} />
            </SettingsIconButton>
          </>
        }
      >
        {form}
        <AnimatedCollapse open={confirmingDetach}>
          <div role="group" aria-label={detachLabel} className="border-t border-[var(--color-border)] px-4 py-3">
            <p className="mb-3 text-[13px]">
              Detach {provider.name} from this agent? The connector stays in Settings → MCP, and other agents keep it.
            </p>
            <div className="flex gap-2">
              <SettingsButton disabled={detach.pending} onClick={detach.onDetach}>
                {detach.pending ? 'Detaching…' : 'Detach'}
              </SettingsButton>
              <SettingsButton disabled={detach.pending} onClick={() => setConfirmingDetach(false)}>
                Cancel
              </SettingsButton>
            </div>
          </div>
        </AnimatedCollapse>
        {detach.error && (
          <p role="alert" className="border-t border-[var(--color-border)] px-4 py-2 text-[13px] text-[var(--color-danger)]">
            {detach.error}
          </p>
        )}
      </AddonRow>
    )
  }

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] overflow-hidden">
      {/* Outside the clickable header: a portal's clicks still bubble up the React tree. */}
      {confirmingDelete && (
        <DeleteMcpProviderDialog
          provider={provider}
          remove={deleteMcp}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}
      <div
        className="flex items-center gap-2 px-4 py-2.5 cursor-pointer hover:bg-[var(--color-bg-hover)] transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {/* A button, so the keyboard can open the form; its click bubbles to the header. The
            status is the same glyph the agent's Addons tab draws (rule 13), its name the sentence. */}
        <button
          type="button"
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-2 rounded text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
        >
          <span className="min-w-0 truncate font-medium text-[14px]">{provider.name}</span>
          {managed && (
            <SettingsBadge title={MCP_CARD_TEXT.fromPluginTitle}>{MCP_CARD_TEXT.fromPlugin(provider.managedByTitle)}</SettingsBadge>
          )}
          {statusGlyph}
        </button>

        {provider.hasAuth && (
          <Shield
            size={12}
            className="text-[var(--color-accent)]"
            aria-label={
              provider.authType === 'bearer' ? 'Bearer token configured' : 'OAuth authenticated'
            }
          />
        )}

        {toggle}

        {/* A plugin's connector goes with its plugin: it is removed from the agent's Addons tab, not here. */}
        {!managed && (
          <button
            onClick={(e) => { e.stopPropagation(); setConfirmingDelete(true) }}
            aria-label={`Delete MCP ${provider.name}`}
            className="p-1 rounded hover:bg-[var(--color-danger)]/20 text-[var(--color-text-muted)] hover:text-[var(--color-danger)] transition-colors"
          >
            <Trash2 size={12} />
          </button>
        )}

        <div className={`p-1 text-[var(--color-text-muted)] transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}>
          <ChevronDown size={12} />
        </div>
      </div>

      {form}
    </div>
  )
}
