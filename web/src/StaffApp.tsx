import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import { CompanyProvider, useCompany } from './context/CompanyContext'
import { MasterDataProvider } from './context/MasterData'
import { Spinner } from './components/ui'
import { Login, NewPassword } from './pages/Login'
import { CompanySetup } from './pages/CompanySetup'
import { Layout } from './components/Layout'
import { Dashboard } from './pages/Dashboard'
import { Items } from './pages/Items'
import { ItemEdit } from './pages/ItemEdit'
import { Partners } from './pages/Partners'
import { PartnerEdit } from './pages/PartnerEdit'
import { DocList } from './pages/DocList'
import { DocRouter } from './pages/docs/DocRouter'
import { DailySales } from './pages/DailySales'
import { StockReport } from './pages/reports/StockReport'
import { ItemLedger } from './pages/reports/ItemLedger'
import { Balances } from './pages/reports/Balances'
import { SalesReport } from './pages/reports/SalesReport'
import { PurchasesReport } from './pages/reports/PurchasesReport'
import { ProductionCost } from './pages/reports/ProductionCost'
import { Stocktakes } from './pages/reports/Stocktakes'

/**
 * Η εφαρμογή του μαγαζιού (με login). Ξεχωριστό κομμάτι από τη σελίδα του
 * πελάτη: ο πελάτης δεν κατεβάζει αποθήκη, αναφορές και «Πες το».
 */

// «Πες το»: ξεχωριστό κομμάτι (parser + φωνή), φορτώνει όταν χρειαστεί
const Voice = lazy(() => import('./pages/Voice').then((m) => ({ default: m.Voice })))
const VoiceWords = lazy(() => import('./pages/VoiceWords').then((m) => ({ default: m.VoiceWords })))
// online παραγγελίες: η κουζίνα και οι ρυθμίσεις του site
const Orders = lazy(() => import('./pages/Orders').then((m) => ({ default: m.Orders })))
const ShopSettings = lazy(() => import('./pages/ShopSettings').then((m) => ({ default: m.ShopSettings })))
// γενικά έξοδα και κέρδος (μόνο ο ιδιοκτήτης)
const Overheads = lazy(() => import('./pages/Overheads').then((m) => ({ default: m.Overheads })))
const Team = lazy(() => import('./pages/Team').then((m) => ({ default: m.Team })))
const Profit = lazy(() => import('./pages/reports/Profit').then((m) => ({ default: m.Profit })))
const Drivers = lazy(() => import('./pages/Drivers').then((m) => ({ default: m.Drivers })))
const SiteCustomers = lazy(() => import('./pages/SiteCustomers').then((m) => ({ default: m.SiteCustomers })))
// παραστατικά: λίστα και ρυθμίσεις
const FiscalList = lazy(() => import('./pages/Fiscal').then((m) => ({ default: m.FiscalList })))
const FiscalSettingsPage = lazy(() => import('./pages/Fiscal').then((m) => ({ default: m.FiscalSettingsPage })))

function Gate() {
  const { session, loading, recovering } = useAuth()
  if (loading) return <div className="min-h-screen flex items-center justify-center"><Spinner /></div>
  if (!session) return <Login />
  // ήρθε από το email «Ξέχασα τον κωδικό»
  if (recovering) return <NewPassword />
  return (
    <CompanyProvider>
      <CompanyGate />
    </CompanyProvider>
  )
}

function CompanyGate() {
  const { company, loading } = useCompany()
  if (loading) return <div className="min-h-screen flex items-center justify-center"><Spinner /></div>
  if (!company) return <CompanySetup />
  return (
    <MasterDataProvider>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="voice" element={<Suspense fallback={<Spinner />}><Voice /></Suspense>} />
          <Route path="voice/words" element={<Suspense fallback={<Spinner />}><VoiceWords /></Suspense>} />
          <Route path="orders" element={<Suspense fallback={<Spinner />}><Orders /></Suspense>} />
          <Route path="orders/settings" element={<Suspense fallback={<Spinner />}><ShopSettings /></Suspense>} />
          <Route path="orders/customers" element={<Suspense fallback={<Spinner />}><SiteCustomers /></Suspense>} />
          <Route path="orders/drivers" element={<Suspense fallback={<Spinner />}><Drivers /></Suspense>} />
          <Route path="fiscal" element={<Suspense fallback={<Spinner />}><FiscalList /></Suspense>} />
          <Route path="fiscal/settings" element={<Suspense fallback={<Spinner />}><FiscalSettingsPage /></Suspense>} />
          <Route path="costs" element={<Suspense fallback={<Spinner />}><Overheads /></Suspense>} />
          <Route path="team" element={<Suspense fallback={<Spinner />}><Team /></Suspense>} />
          <Route path="reports/profit" element={<Suspense fallback={<Spinner />}><Profit /></Suspense>} />
          <Route path="daily-sales" element={<DailySales />} />
          <Route path="items" element={<Items />} />
          <Route path="items/:id" element={<ItemEdit />} />
          <Route path="partners" element={<Partners />} />
          <Route path="partners/:id" element={<PartnerEdit />} />
          <Route path="docs/:type" element={<DocList />} />
          <Route path="docs/:type/:id" element={<DocRouter />} />
          <Route path="reports/stock" element={<StockReport />} />
          <Route path="reports/item-ledger/:itemId?" element={<ItemLedger />} />
          <Route path="reports/balances" element={<Balances />} />
          <Route path="reports/sales" element={<SalesReport />} />
          <Route path="reports/purchases" element={<PurchasesReport />} />
          <Route path="reports/production-cost" element={<ProductionCost />} />
          <Route path="reports/stocktakes" element={<Stocktakes />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </MasterDataProvider>
  )
}

export function StaffApp() {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  )
}
