import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Οι σελίδες του πελάτη (/s/ μενού, /pay/ πληρωμή, /r/ απόδειξη, /h/ ξενοδοχεία)
// δεν είναι η εφαρμογή του μαγαζιού: χωρίς το manifest, για να μην
// προτείνει ο browser «εγκατάσταση Pizza ERP»
if (/^\/(s|pay|r|h)\//.test(window.location.pathname)) {
  document.querySelector('link[rel="manifest"]')?.remove()
  document.querySelector('meta[name="apple-mobile-web-app-title"]')?.remove()
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
