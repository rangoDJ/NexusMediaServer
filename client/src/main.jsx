import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.jsx'
import { BackdropProvider } from './backdrop/BackdropContext.jsx'
import { applyTheme, storedPreference } from './hooks/useTheme.js'
import './index.css'

// Stamp the theme before the first render. Doing it inside a component would
// paint the default palette for a frame first, which reads as a flash of the
// wrong theme on every load.
applyTheme(storedPreference())

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <BackdropProvider>
        <App />
      </BackdropProvider>
    </BrowserRouter>
  </StrictMode>
)
