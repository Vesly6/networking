import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { applyTheme, useDemoThemeStore } from './store/useDemoThemeStore'

// Applied synchronously, before the first render — same reasoning as
// production's main.tsx: doing this inside a React effect would paint
// the light theme for one frame on every reload for a visitor who'd
// picked dark.
applyTheme(useDemoThemeStore.getState().theme)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
