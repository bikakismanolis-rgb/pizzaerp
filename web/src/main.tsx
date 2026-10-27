import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Οι σελίδες του πελάτη (/s/ μενού, /pay/ πληρωμή, /r/ απόδειξη, /h/ ξενοδοχεία)
// και του διανομέα (/d/) δεν είναι η εφαρμογή του μαγαζιού: χωρίς το manifest,
// για να μην προτείνει ο browser «εγκατάσταση Pizza ERP» (η «Προσθήκη στην
// αρχική οθόνη» κρατά τότε τη δική τους διεύθυνση)
if (/^\/(s|pay|r|h|d)\//.test(window.location.pathname)) {
  document.querySelector('link[rel="manifest"]')?.remove()
  document.querySelector('meta[name="apple-mobile-web-app-title"]')?.remove()
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
