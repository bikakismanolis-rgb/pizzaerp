import { lazy, Suspense } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { ToastProvider, Spinner } from './components/ui'

// η εφαρμογή του μαγαζιού (login, αποθήκη, «Πες το», παραγγελίες)
const StaffApp = lazy(() => import('./StaffApp').then((m) => ({ default: m.StaffApp })))
// η σελίδα του πελάτη: χωρίς login, χωρίς τίποτα από την υπόλοιπη εφαρμογή
const Shop = lazy(() => import('./pages/shop/Shop').then((m) => ({ default: m.Shop })))
const OrderStatusPage = lazy(() => import('./pages/shop/OrderStatusPage').then((m) => ({ default: m.OrderStatusPage })))
const VivaReturn = lazy(() => import('./pages/shop/PayPages').then((m) => ({ default: m.VivaReturn })))
const TestPay = lazy(() => import('./pages/shop/PayPages').then((m) => ({ default: m.TestPay })))
const ReceiptPage = lazy(() => import('./pages/shop/ReceiptPage').then((m) => ({ default: m.ReceiptPage })))
const PrivacyPage = lazy(() => import('./pages/shop/PrivacyPage').then((m) => ({ default: m.PrivacyPage })))
const DriverPage = lazy(() => import('./pages/shop/DriverPage').then((m) => ({ default: m.DriverPage })))
const HotelOrder = lazy(() => import('./pages/shop/HotelOrder').then((m) => ({ default: m.HotelOrder })))

const pageSpinner = <div className="min-h-screen flex items-center justify-center"><Spinner /></div>

export default function App() {
  return (
    <ToastProvider>
      <BrowserRouter>
        <Suspense fallback={pageSpinner}>
          <Routes>
            <Route path="/s/:slug" element={<Shop />} />
            <Route path="/s/:slug/o/:token" element={<OrderStatusPage />} />
            <Route path="/s/:slug/privacy" element={<PrivacyPage />} />
            <Route path="/pay/viva" element={<VivaReturn />} />
            <Route path="/pay/test" element={<TestPay />} />
            <Route path="/r/:token" element={<ReceiptPage />} />
            <Route path="/h/:token" element={<HotelOrder />} />
            <Route path="/d/:token" element={<DriverPage />} />
            <Route path="*" element={<StaffApp />} />
          </Routes>
        </Suspense>
      </BrowserRouter>
    </ToastProvider>
  )
}
