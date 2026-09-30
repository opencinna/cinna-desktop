import { describe, expect, it } from 'vitest'
import { previewKindFor } from './filePreview'
import { agentFilePreviewKindFor } from './agentFiles'

describe('previewKindFor', () => {
  it('highlights python by extension, then by MIME', () => {
    expect(previewKindFor('train.py')).toBe('python')
    expect(previewKindFor('stubs.PYI')).toBe('python')
    expect(previewKindFor('script', 'text/x-python')).toBe('python')
  })

  it('renders xml and its dialects as xml, by extension, then by MIME', () => {
    for (const ext of ['xml', 'xsd', 'xsl', 'xslt', 'plist', 'rss', 'atom', 'kml', 'gpx', 'csproj', 'XAML']) {
      expect(previewKindFor(`file.${ext}`)).toBe('xml')
    }
    expect(previewKindFor('feed', 'application/xml')).toBe('xml')
    expect(previewKindFor('feed', 'text/xml')).toBe('xml')
    expect(previewKindFor('logo.svg', 'image/svg+xml')).toBeNull()
  })

  it('lets the extension win over the MIME type', () => {
    expect(previewKindFor('notes.txt', 'text/x-python')).toBe('text')
  })
})

describe('the html kind', () => {
  it('renders html, htm and xhtml by extension, for attachments and agent files', () => {
    for (const name of ['report.html', 'INDEX.HTM', 'page.xhtml']) {
      expect(previewKindFor(name)).toBe('html')
      expect(agentFilePreviewKindFor(`/agent/out/${name}`)).toBe('html')
    }
  })

  it('falls back to the html MIME types', () => {
    expect(previewKindFor('download', 'text/html')).toBe('html')
    expect(previewKindFor('download', 'application/xhtml+xml')).toBe('html')
  })

  it('leaves other code as it was', () => {
    expect(previewKindFor('page.html.txt')).toBe('text')
    expect(agentFilePreviewKindFor('/agent/style.css')).toBe('text')
  })
})
