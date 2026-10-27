import { lazy, Suspense } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { ToastProvider, Spinner } from './components/ui'

// η εφαρμογή του μαγαζιού (login, αποθήκη, «Πες το», παραγγελίες)
const StaffApp = lazy(() => import('./StaffApp').then((m) => ({ default: m.StaffApp })))
// η σελίδα του πελάτη: χωρίς login, χωρίς τίποτα από την υπόλοιπη εφαρμογή
const Shop = lazy(() => import('./pages/shop/Shop').then((m) => ({ default: m.Shop })))
const OrderStatusPage = lazy(() => import('./pages/shop/OrderStatusPage').then((m) => ({ default: m.OrderStatusPage })))

const pageSpinner = <div className="min-h-screen flex items-center justify-center"><Spinner /></div>

export default function App() {
  return (
    <ToastProvider>
      <BrowserRouter>
        <Suspense fallback={pageSpinner}>
          <Routes>
            <Route path="/s/:slug" element={<Shop />} />
            <Route path="/s/:slug/o/:token" element={<OrderStatusPage />} />
            <Route path="*" element={<StaffApp />} />
          </Routes>
        </Suspense>
      </BrowserRouter>
    </ToastProvider>
  )
}
