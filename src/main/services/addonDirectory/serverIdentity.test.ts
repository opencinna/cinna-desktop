import { describe, it, expect } from 'vitest'
import { normalisedServerUrl, serverKeyOfConnector, serverKeyOfInstall } from './serverIdentity'

/** The same MCP server however it was set up: its URL, or the package its command runs. */

describe('serverIdentity', () => {
  it('normalises a URL: case of scheme and host, the default port, a trailing slash, the fragment', () => {
    expect(normalisedServerUrl('HTTPS://Mcp.Example.com:443/v1/mcp/#x')).toBe('https://mcp.example.com/v1/mcp')
    expect(normalisedServerUrl('http://h.example:8080/mcp?team=a')).toBe('http://h.example:8080/mcp?team=a')
    expect(normalisedServerUrl('file:///etc/passwd')).toBeNull()
    expect(normalisedServerUrl('not a url')).toBeNull()
  })

  it('names a directory entry’s server by URL or by registry and package name, never by version', () => {
    expect(serverKeyOfInstall({ mcp: { transport: 'sse', url: 'https://a.example/sse/', auth: 'oauth', requiresAuth: false } })).toBe('url:https://a.example/sse')
    const pkg = (registry: 'npm' | 'pypi' | 'oci', name: string) =>
      serverKeyOfInstall({ mcp: { transport: 'stdio', package: { registry, name, version: '1.0.0', args: [] }, auth: 'none', requiresAuth: false, env: [] } })
    expect(pkg('npm', '@MCP/fs')).toBe('npm:@mcp/fs')
    expect(pkg('pypi', 'Mcp_Server.Git[extra]')).toBe('pypi:mcp-server-git')
    expect(pkg('oci', 'ghcr.io/acme/mcp')).toBe('oci:ghcr.io/acme/mcp')
    expect(serverKeyOfInstall(null)).toBeNull()
    expect(serverKeyOfInstall({ archivePath: '/x' })).toBeNull()
  })

  it('names a connector’s server by the same keys, from its URL or its npx / uvx / docker command', () => {
    expect(serverKeyOfConnector({ transportType: 'streamable-http', url: 'https://A.example/sse' })).toBe('url:https://a.example/sse')
    expect(serverKeyOfConnector({ transportType: 'stdio', command: 'npx', args: ['-y', '@mcp/fs@1.2.0', '--ro'] })).toBe('npm:@mcp/fs')
    expect(serverKeyOfConnector({ transportType: 'stdio', command: 'npx', args: ['some-pkg'] })).toBe('npm:some-pkg')
    expect(serverKeyOfConnector({ transportType: 'stdio', command: '/Users/x/Library/Cinna/uv/bin/uvx', args: ['mcp-server-git==0.6'] })).toBe('pypi:mcp-server-git')
    expect(serverKeyOfConnector({ transportType: 'stdio', command: 'docker', args: ['run', '-i', '--rm', '-e', 'TOKEN', 'ghcr.io/acme/mcp:2'] })).toBe('oci:ghcr.io/acme/mcp')
    expect(serverKeyOfConnector({ transportType: 'stdio', command: 'node', args: ['server.js'] })).toBeNull()
    expect(serverKeyOfConnector({ transportType: 'stdio', command: null })).toBeNull()
  })
})
