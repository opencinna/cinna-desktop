import { createContext, useContext } from 'react'

/**
 * Where the catalog's tiles and detail are rendered: the catalog dialog (app
 * chrome) or Settings → Catalog. The same components serve both, and each
 * takes the type scale of the surface it renders into (ui_guidelines_llm.md
 * "Typography"; ux_rules rule 12) — 14/13/12 under Settings, the denser
 * chrome scale in the dialog.
 */
export type CatalogSurface = 'dialog' | 'settings'

/** The catalog's text sizes on one surface. */
export interface CatalogType {
  /** The detail's title. */
  heading: string
  /** A tile's item name. */
  name: string
  /** Running prose: the detail's description, a menu row. */
  text: string
  /** A tile's description, the detail's facts and versions, a button label. */
  body: string
  /** Badges, chips, the "by …" line, an error under a control. */
  meta: string
  /**
   * A heading inside the detail (Versions, Required credentials): under
   * Settings the sub-heading style the settings pages use (12px uppercase, a
   * step under the section title), in the dialog its own small label.
   */
  subheading: string
}

const TYPE: Record<CatalogSurface, CatalogType> = {
  dialog: {
    heading: 'text-sm',
    name: 'text-xs',
    text: 'text-xs',
    body: 'text-[11px]',
    meta: 'text-[10px]',
    subheading: 'text-[11px] font-medium'
  },
  settings: {
    heading: 'text-[14px]',
    name: 'text-[14px]',
    text: 'text-[13px]',
    body: 'text-[13px]',
    meta: 'text-[12px]',
    subheading: 'text-[12px] font-medium uppercase tracking-wider'
  }
}

const CatalogSurfaceContext = createContext<CatalogSurface>('dialog')

/** Set by Settings → Catalog; everything else is the dialog's scale. */
export const CatalogSurfaceProvider = CatalogSurfaceContext.Provider

export function useCatalogSurface(): CatalogSurface {
  return useContext(CatalogSurfaceContext)
}

export function useCatalogType(): CatalogType {
  return TYPE[useContext(CatalogSurfaceContext)]
}

/** A dialog-scale button class (`text-[11px]`) at the surface's button size. */
export function sizedButton(className: string, type: CatalogType): string {
  return className.replace('text-[11px]', type.body)
}
