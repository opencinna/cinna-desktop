import { BrowserWindow, dialog, type OpenDialogOptions, type WebContents } from 'electron'

/**
 * The Run Script form's Choose…: a native open dialog over the window that
 * asked, starting in the agent's folder. Desktop only; core answers the
 * folder and turns the choice into the path the form writes
 * (`userCommandService.argPathFolder`, `relativeArgPath`).
 *
 * A file or, on macOS, a folder: a parameter may name either, and only macOS
 * lets one dialog pick both.
 */
export async function chooseArgPathDialog(sender: WebContents, folder: string): Promise<string | null> {
  const options: OpenDialogOptions = {
    title: 'Choose a path',
    defaultPath: folder,
    properties: process.platform === 'darwin' ? ['openFile', 'openDirectory'] : ['openFile']
  }
  const win = BrowserWindow.fromWebContents(sender)
  const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  if (picked.canceled || picked.filePaths.length === 0) return null
  return picked.filePaths[0]
}
