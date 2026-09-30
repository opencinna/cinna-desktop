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
    // An SVG is shown as the picture it draws, not as its XML.
    expect(previewKindFor('logo.svg', 'image/svg+xml')).toBe('image')
  })

  it('lets the extension win over the MIME type', () => {
    expect(previewKindFor('notes.txt', 'text/x-python')).toBe('text')
  })
})

describe('the image kind', () => {
  it('previews png, jpg/jpeg, gif, webp, bmp and svg by extension', () => {
    for (const name of ['shot.png', 'photo.JPG', 'photo.jpeg', 'anim.gif', 'pic.webp', 'old.bmp', 'logo.svg']) {
      expect(previewKindFor(name)).toBe('image')
    }
  })

  it('falls back to the image MIME types, and the extension still wins', () => {
    for (const mime of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/svg+xml']) {
      expect(previewKindFor('pasted', mime)).toBe('image')
    }
    expect(previewKindFor('notes.txt', 'image/png')).toBe('text')
    expect(previewKindFor('shot.png', 'application/octet-stream')).toBe('image')
  })

  it('leaves HEIC and TIFF to the download', () => {
    expect(previewKindFor('IMG_0001.HEIC', 'image/heic')).toBeNull()
    expect(previewKindFor('scan.tiff', 'image/tiff')).toBeNull()
    expect(previewKindFor('scan.tif')).toBeNull()
  })

  it('is not offered for an agent file, which is read as text', () => {
    expect(agentFilePreviewKindFor('/agent/out/chart.png')).toBeNull()
    expect(agentFilePreviewKindFor('/agent/out/logo.svg')).toBeNull()
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
