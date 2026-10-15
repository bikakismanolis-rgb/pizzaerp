import { lazy, Suspense } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import { CompanyProvider, useCompany } from './context/CompanyContext'
import { MasterDataProvider } from './context/MasterData'
import { ToastProvider, Spinner } from './components/ui'
import { Login } from './pages/Login'
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

// «Πες το»: ξεχωριστό κομμάτι (parser + φωνή), φορτώνει όταν χρειαστεί
const Voice = lazy(() => import('./pages/Voice').then((m) => ({ default: m.Voice })))

function Gate() {
  const { session, loading } = useAuth()
  if (loading) return <div className="min-h-screen flex items-center justify-center"><Spinner /></div>
  if (!session) return <Login />
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

export default function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <BrowserRouter>
          <Gate />
        </BrowserRouter>
      </AuthProvider>
    </ToastProvider>
  )
}
