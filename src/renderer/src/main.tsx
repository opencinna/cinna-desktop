import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { initBrandTheme } from './stores/brandTheme.store'
import { initCaretFade } from './utils/caretFade'

initCaretFade()

// The brand (the active profile's server theme) is applied before React
// mounts, so the first frame already shows it rather than stock Cinna.
void initBrandTheme({ background: true })
  .catch(() => undefined)
  .then(() => {
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <App />
      </StrictMode>
    )
  })
