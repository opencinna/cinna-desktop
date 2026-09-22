import type { ServiceCredentialBundle, ServiceCredentialEntry, ServiceCredentialInput } from '../../../shared/serviceCredentials'
import { LOCAL_CREDENTIAL_TYPES } from '../../../shared/serviceCredentials'
const fields: Record<string, string[]> = {
  email_imap: ['host', 'port', 'login', 'password', 'is_ssl'],
  email_smtp: ['host', 'port', 'username', 'password', 'from_email', 'use_tls', 'use_ssl'],
  odoo: ['url', 'database_name', 'login', 'api_token'],
  google_service_account: ['type', 'project_id', 'private_key_id', 'private_key', 'client_email', 'client_id', 'auth_uri', 'token_uri', 'auth_provider_x509_cert_url', 'client_x509_cert_url', 'universe_domain'],
  api_token: ['api_token', 'api_token_type', 'api_token_template']
}
const required: Record<string, string[]> = {
  api_token: ['api_token'], email_imap: ['host', 'port', 'login', 'password'],
  email_smtp: ['host', 'port', 'username', 'password', 'from_email'], odoo: ['url', 'database_name', 'login', 'api_token'],
  google_service_account: ['type', 'project_id', 'private_key', 'client_email']
}
export function validateLocal(input: ServiceCredentialInput): Record<string, unknown> {
  if (!LOCAL_CREDENTIAL_TYPES.includes(input.type) || !input.name?.trim() || input.name.length > 255) throw new Error('Enter a name and supported credential type.')
  const values = input.values ?? {}
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Invalid credential fields.')
  const result: Record<string, unknown> = {}
  for (const key of fields[input.type]) if (values[key] !== undefined) {
    const v = values[key]
    if (!['string', 'number', 'boolean'].includes(typeof v)) throw new Error('Invalid credential field.')
    result[key] = v
  }
  if (result.port !== undefined && (!Number.isInteger(Number(result.port)) || Number(result.port) < 1 || Number(result.port) > 65535)) throw new Error('Port must be between 1 and 65535.')
  if (result.port !== undefined) result.port = Number(result.port)
  return result
}
export function localComplete(type: string, values: Record<string, unknown>): boolean {
  return (required[type] ?? []).every(k => values[k] !== undefined && values[k] !== '') &&
    !(type === 'api_token' && values.api_token_type === 'custom' && !values.api_token_template)
}
/** Pinned to Core's environment whitelist and token/SA transforms. */
export function localBundle(id: string, input: ServiceCredentialInput, values: Record<string, unknown>): ServiceCredentialBundle {
  let data = { ...values }
  let serviceAccount: Record<string, unknown> | null = null
  if (input.type === 'api_token') {
    const template = values.api_token_type === 'custom' ? String(values.api_token_template ?? 'Authorization: Bearer {TOKEN}') : 'Authorization: Bearer {TOKEN}'
    const header = template.replaceAll('{TOKEN}', String(values.api_token ?? ''))
    const colon = header.indexOf(':')
    data = colon < 0 ? { http_header_name: 'Authorization', http_header_value: header } : { http_header_name: header.slice(0, colon).trim(), http_header_value: header.slice(colon + 1).trim() }
    if (input.serviceUri) data.service_uri = input.serviceUri
  } else if (input.type === 'google_service_account') {
    serviceAccount = data
    data = { file_path: `credentials/${id}.json`, project_id: data.project_id, client_email: data.client_email }
  }
  const entry: ServiceCredentialEntry = { id, name: input.name.trim(), type: input.type, notes: input.notes ?? null,
    service_uri: input.serviceUri || null, is_placeholder: !localComplete(input.type, values), credential_data: data }
  return { id, revision: '', entry, service_account_file: serviceAccount, ssh_key: null }
}
