import { create } from 'zustand'

/** Where the Add skill modal's skills come from: the catalog, or the skills marketplaces connected to Cinna. */
export type SkillSource = 'catalog' | 'marketplaces'

/**
 * The Add skill modal's last chosen source, for this session (ux_rules rule
 * 4): someone adding several marketplace skills, one agent after another,
 * does not pick Marketplaces each time. Not persisted — a fresh start opens
 * on Catalog.
 */
interface SkillAddSourceStore {
  source: SkillSource
  setSource: (source: SkillSource) => void
}

export const useSkillAddSourceStore = create<SkillAddSourceStore>((set) => ({
  source: 'catalog',
  setSource: (source) => set({ source })
}))
