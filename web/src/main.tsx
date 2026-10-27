import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Η σελίδα του πελάτη (/s/...) δεν είναι η εφαρμογή του μαγαζιού: χωρίς το
// manifest, για να μην του προτείνει ο browser «εγκατάσταση Pizza ERP»
if (window.location.pathname.startsWith('/s/')) {
  document.querySelector('link[rel="manifest"]')?.remove()
  document.querySelector('meta[name="apple-mobile-web-app-title"]')?.remove()
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
