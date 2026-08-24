import { useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useCompany } from '../context/CompanyContext'

interface NavItem { to: string; label: string }
interface NavGroup { title: string; items: NavItem[] }

const NAV: NavGroup[] = [
  { title: '', items: [{ to: '/', label: 'Αρχική' }] },
  {
    title: 'Κινήσεις',
    items: [
      { to: '/daily-sales', label: 'Πωλήσεις ημέρας' },
      { to: '/docs/sale', label: 'Πωλήσεις' },
      { to: '/docs/purchase', label: 'Αγορές' },
      { to: '/docs/production', label: 'Παραγωγές' },
      { to: '/docs/stocktake', label: 'Απογραφές' },
      { to: '/docs/receipt', label: 'Εισπράξεις' },
      { to: '/docs/payment', label: 'Πληρωμές' },
    ],
  },
  {
    title: 'Αρχεία',
    items: [
      { to: '/items', label: 'Είδη & συνταγές' },
      { to: '/partners', label: 'Πελάτες & προμηθευτές' },
    ],
  },
  {
    title: 'Αναφορές',
    items: [
      { to: '/reports/stock', label: 'Υπόλοιπα αποθήκης' },
      { to: '/reports/balances', label: 'Υπόλοιπα συναλλασσομένων' },
      { to: '/reports/sales', label: 'Πωλήσεις ανά πελάτη/είδος' },
      { to: '/reports/purchases', label: 'Αγορές ανά προμηθευτή' },
      { to: '/reports/production-cost', label: 'Κόστος παραγωγής' },
      { to: '/reports/stocktakes', label: 'Αποτελέσματα απογραφών' },
    ],
  },
]

export function Layout() {
  const [open, setOpen] = useState(false)
  const { signOut, user } = useAuth()
  const { company, companies, select } = useCompany()

  const nav = (
    <nav className="flex flex-col gap-4 p-3 text-sm">
      {NAV.map((g, gi) => (
        <div key={gi}>
          {g.title && <div className="px-2 mb-1 text-xs font-semibold uppercase tracking-wide text-stone-400">{g.title}</div>}
          {g.items.map((it) => (
            <NavLink
              key={it.to}
              to={it.to}
              end={it.to === '/'}
              onClick={() => setOpen(false)}
              className={({ isActive }) =>
                'block rounded-md px-2 py-1.5 ' + (isActive ? 'bg-red-700 text-white' : 'text-stone-700 hover:bg-stone-200')
              }
            >
              {it.label}
            </NavLink>
          ))}
        </div>
      ))}
    </nav>
  )

  return (
    <div className="min-h-screen flex">
      {/* Sidebar desktop */}
      <aside className="hidden md:flex md:flex-col w-60 shrink-0 bg-white border-r border-stone-200">
        <div className="px-4 py-4 border-b border-stone-200">
          <div className="text-lg font-bold text-red-700">🍕 Pizza ERP</div>
          <div className="text-xs text-stone-500 truncate">{company?.name}</div>
        </div>
        <div className="flex-1 overflow-y-auto">{nav}</div>
        <div className="p-3 border-t border-stone-200 text-xs text-stone-500">
          <div className="truncate mb-1">{user?.email}</div>
          {companies.length > 1 && (
            <select className="input mb-2 py-1" value={company?.id ?? ''} onChange={(e) => select(e.target.value)}>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )}
          <button className="btn-ghost w-full" onClick={signOut}>Αποσύνδεση</button>
        </div>
      </aside>

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <aside className="absolute left-0 top-0 bottom-0 w-64 bg-white shadow-xl flex flex-col">
            <div className="px-4 py-4 border-b border-stone-200 flex items-center justify-between">
              <div className="text-lg font-bold text-red-700">🍕 Pizza ERP</div>
              <button className="btn-ghost px-2 py-1" onClick={() => setOpen(false)}>✕</button>
            </div>
            <div className="flex-1 overflow-y-auto">{nav}</div>
            <div className="p-3 border-t border-stone-200">
              <button className="btn-ghost w-full" onClick={signOut}>Αποσύνδεση</button>
            </div>
          </aside>
        </div>
      )}

      <div className="flex-1 flex flex-col min-w-0">
        <header className="md:hidden sticky top-0 z-30 bg-white border-b border-stone-200 flex items-center gap-3 px-3 py-2">
          <button className="btn-ghost px-2" onClick={() => setOpen(true)} aria-label="Μενού">☰</button>
          <div className="font-bold text-red-700">🍕 Pizza ERP</div>
          <div className="text-xs text-stone-500 truncate">{company?.name}</div>
        </header>
        <main className="flex-1 p-3 md:p-6 max-w-7xl w-full mx-auto">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
