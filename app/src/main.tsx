import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { applyTheme, useThemeStore } from './store/useThemeStore'

// Applied synchronously, before the first render — doing this inside a
// React effect instead would paint the light theme for one frame on every
// reload for anyone who picked dark, since effects only run after the
// initial render commits.
applyTheme(useThemeStore.getState().theme)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
