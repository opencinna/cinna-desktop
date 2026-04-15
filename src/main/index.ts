import { app, shell, BrowserWindow, Menu } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { registerAllIpcHandlers } from './ipc'
import { initDatabase, getDb } from './db/client'
import { llmProviders } from './db/schema'
import { registerAdapter } from './llm/registry'
import { createAdapter } from './ipc/llm.ipc'
import { decryptApiKey } from './security/keystore'
import { mcpProviders } from './db/schema'
import { mcpManager } from './mcp/manager'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 10 },
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow!.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.cinna.desktop')

  const menu = Menu.buildFromTemplate([
    { role: 'appMenu' },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    { role: 'windowMenu' }
  ])
  Menu.setApplicationMenu(menu)

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  initDatabase()
  registerAllIpcHandlers()
  initLLMProviders()
  initMcpProviders()

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('will-quit', async () => {
  await mcpManager.disconnectAll()
})

function initLLMProviders(): void {
  const db = getDb()
  const providers = db.select().from(llmProviders).all()
  for (const provider of providers) {
    if (provider.enabled && provider.apiKeyEncrypted) {
      try {
        const apiKey = decryptApiKey(provider.apiKeyEncrypted)
        const adapter = createAdapter(provider.type, apiKey, provider.id)
        if (adapter) {
          registerAdapter(provider.id, adapter)
        }
      } catch (err) {
        console.error(`Failed to init provider ${provider.name}:`, err)
      }
    }
  }
}

function initMcpProviders(): void {
  const db = getDb()
  const providers = db.select().from(mcpProviders).all()
  for (const provider of providers) {
    if (provider.enabled) {
      mcpManager
        .connect({
          id: provider.id,
          name: provider.name,
          transportType: provider.transportType as 'stdio' | 'sse' | 'streamable-http',
          command: provider.command ?? undefined,
          args: (provider.args as string[]) ?? undefined,
          url: provider.url ?? undefined,
          env: (provider.env as Record<string, string>) ?? undefined,
          enabled: true,
          authTokensEncrypted: provider.authTokensEncrypted ?? undefined,
          clientInfo: (provider.clientInfo as Record<string, unknown>) ?? undefined
        })
        .catch((err) => console.error(`Failed to init MCP ${provider.name}:`, err))
    }
  }
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}
