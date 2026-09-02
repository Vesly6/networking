import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { applyTheme, useThemeStore } from './store/useThemeStore'
import { applySoftphoneHidden, useSoftphoneVisibilityStore } from './store/useSoftphoneVisibilityStore'

// Applied synchronously, before the first render — doing this inside a
// React effect instead would paint the light theme for one frame on every
// reload for anyone who picked dark, since effects only run after the
// initial render commits.
applyTheme(useThemeStore.getState().theme)
// Same reasoning, for the Zadarma softphone widget's hidden/shown
// preference — the attribute has to be on <html> before Softphone.tsx's
// own effect ever calls window.zadarmaWidgetFn(), so the widget never
// flashes visible for a frame (or several seconds, given its own
// key-fetch + script-ready wait) before the CSS rule hiding it applies.
applySoftphoneHidden(useSoftphoneVisibilityStore.getState().hidden)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
