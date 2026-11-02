import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useCompany } from '../context/CompanyContext'
import { useMaster } from '../context/MasterData'
import { supabase } from '../lib/supabase'
import { CHANNEL_LABEL } from '../lib/labels'
import { NEW_ORDERS_EVENT } from '../lib/online'
import { fmtDate, today } from '../lib/format'
import type { Channel } from '../lib/types'
import { MicIcon, useToast } from './ui'

interface NavItem { to: string; label: string }
interface NavGroup { title: string; items: NavItem[] }

/** Τα καθημερινά: πάντα φαίνονται */
const MAIN: NavItem[] = [
  { to: '/', label: '🏠 Αρχική' },
  { to: '/voice', label: '🎤 Πες το' },
  { to: '/orders', label: '🛎️ Παραγγελίες' },
  { to: '/daily-sales', label: '📋 Πωλήσεις ημέρας' },
  { to: '/docs/purchase', label: '🚚 Αγορές (ήρθε εμπόρευμα)' },
  { to: '/reports/profit', label: '💶 Κέρδος του μήνα' },
]

/** Τα υπόλοιπα, κάτω από «Περισσότερα» */
const NAV: NavGroup[] = [
  {
    title: 'Κινήσεις',
    items: [
      { to: '/docs/sale', label: 'Πωλήσεις (όλες)' },
      { to: '/docs/production', label: 'Παραγωγές' },
      { to: '/docs/stocktake', label: 'Μετρήσεις αποθήκης' },
      { to: '/docs/receipt', label: 'Εισπράξεις (μας πλήρωσαν)' },
      { to: '/docs/payment', label: 'Πληρωμές (πληρώσαμε)' },
      { to: '/fiscal', label: 'Αποδείξεις & τιμολόγια' },
      { to: '/costs', label: 'Γενικά έξοδα (ρεύμα, ενοίκιο…)' },
    ],
  },
  {
    title: 'Τα στοιχεία μας',
    items: [
      { to: '/items', label: 'Είδη & συνταγές' },
      { to: '/partners', label: 'Πελάτες & προμηθευτές' },
      { to: '/orders/drivers', label: 'Διανομείς' },
      { to: '/team', label: 'Υπάλληλοι' },
      { to: '/voice/words', label: 'Οι λέξεις μας (για το «Πες το»)' },
    ],
  },
  {
    title: 'Αναφορές',
    items: [
      { to: '/reports/stock', label: 'Τι έχουμε στην αποθήκη' },
      { to: '/reports/balances', label: 'Ποιος χρωστάει, τι χρωστάμε' },
      { to: '/reports/sales', label: 'Πωλήσεις ανά πελάτη / είδος' },
      { to: '/reports/purchases', label: 'Αγορές ανά προμηθευτή' },
      { to: '/reports/production-cost', label: 'Κόστος παραγωγής' },
      { to: '/reports/stocktakes', label: 'Τι βγήκε στις μετρήσεις' },
    ],
  },
]

const MORE_KEY = 'pizza-erp.menu-more'

// ---------------------------------------------------------------------
// Αυτόματο κλείσιμο προηγούμενων ημερών: μία φορά ανά εταιρεία/ημέρα/συνεδρία.
// Η ημέρα ξαναϋπολογίζεται όταν η εφαρμογή ξαναγίνεται ορατή (κινητό/tablet
// που έμεινε ανοιχτό από χθες). Αν η κλήση αποτύχει, ξαναδοκιμάζει τότε.
// ---------------------------------------------------------------------
const autoCloseDone = new Set<string>()

interface CloseRow { doc_id: string; doc_no: number; doc_date: string; channel: Channel | null; ok: boolean; message: string }

const short = (d: string) => fmtDate(d).slice(0, 5)
const rowLabel = (r: CloseRow) => `${short(r.doc_date)} ${r.channel ? CHANNEL_LABEL[r.channel] : '—'}`

function useAutoCloseRunning(companyId: string | undefined) {
  const toast = useToast()
  const { refresh } = useMaster()
  const [day, setDay] = useState(today)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    const h = () => {
      if (document.visibilityState !== 'visible') return
      setDay(today())
      setNonce((n) => n + 1)
    }
    window.addEventListener('focus', h)
    document.addEventListener('visibilitychange', h)
    return () => { window.removeEventListener('focus', h); document.removeEventListener('visibilitychange', h) }
  }, [])

  useEffect(() => {
    if (!companyId) return
    const key = `pizza-erp.autoclose.${companyId}.${day}`
    // σε εξέλιξη ή έγινε (και StrictMode)
    if (autoCloseDone.has(key)) return
    try { if (sessionStorage.getItem(key)) { autoCloseDone.add(key); return } } catch { /* ignore */ }
    autoCloseDone.add(key)
    ;(async () => {
      const { data, error } = await supabase.rpc('close_running', { p_company: companyId, p_before: day })
      if (error) {
        console.warn('close_running:', error.message)
        // χωρίς 0004 δεν έχει νόημα να ξαναδοκιμάσει· αλλιώς ξανά στο επόμενο focus
        if (error.code !== 'PGRST202') autoCloseDone.delete(key)
        return
      }
      try { sessionStorage.setItem(key, '1') } catch { /* ignore */ }
      const rows = (data ?? []) as CloseRow[]
      if (rows.length === 0) return
      // μία ειδοποίηση ανά ημέρα για όσα έκλεισαν, μία συνολική για τις αποτυχίες
      const byDate = new Map<string, string[]>()
      for (const r of rows.filter((x) => x.ok)) {
        byDate.set(r.doc_date, [...(byDate.get(r.doc_date) ?? []), r.channel ? CHANNEL_LABEL[r.channel] : '—'])
      }
      for (const [d, chs] of byDate) toast.ok(`Έκλεισαν αυτόματα οι πωλήσεις της ${short(d)} (${chs.join(', ')})`)
      const failed = rows.filter((x) => !x.ok)
      if (failed.length === 1) {
        const r = failed[0]
        toast.err(`Δεν έκλεισε η πώληση ημέρας ${rowLabel(r)} (αρ. ${r.doc_no}): ${r.message}. Δες τις Πωλήσεις.`)
      } else if (failed.length > 1) {
        const list = failed.slice(0, 4).map(rowLabel).join(', ') + (failed.length > 4 ? ` και ${failed.length - 4} ακόμα` : '')
        toast.err(`Δεν έκλεισαν ${failed.length} πωλήσεις ημέρας (${list}): ${failed[0].message}. Δες τις Πωλήσεις (σε εξέλιξη).`)
      }
      if (byDate.size > 0) await refresh()
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, day, nonce])
}

// ---------------------------------------------------------------------
// Νέες online παραγγελίες: αριθμός στο μενού, από όποια σελίδα κι αν είσαι.
// Βάση χωρίς 0005: σιωπηλά τίποτα.
// ---------------------------------------------------------------------
function useNewOrders(companyId: string | undefined): number {
  const [n, setN] = useState(0)
  useEffect(() => {
    if (!companyId) return
    let alive = true
    let off = false
    const check = async () => {
      if (off || document.visibilityState !== 'visible') return
      const { count, error } = await supabase.from('online_order').select('id', { count: 'exact', head: true })
        .eq('company_id', companyId).eq('status', 'new')
      if (!alive) return
      if (error) { off = true; return }
      setN(count ?? 0)
    }
    void check()
    const iv = window.setInterval(check, 30000)
    document.addEventListener('visibilitychange', check)
    const fromOrders = (e: Event) => { const v = (e as CustomEvent<number>).detail; if (typeof v === 'number') setN(v) }
    window.addEventListener(NEW_ORDERS_EVENT, fromOrders)
    return () => {
      alive = false
      window.clearInterval(iv)
      document.removeEventListener('visibilitychange', check)
      window.removeEventListener(NEW_ORDERS_EVENT, fromOrders)
    }
  }, [companyId])
  return n
}

export function Layout() {
  const [open, setOpen] = useState(false)
  const { signOut, user } = useAuth()
  const { company, companies, select } = useCompany()
  const { pathname } = useLocation()
  useAutoCloseRunning(company?.id)
  const newOrders = useNewOrders(company?.id)
  // το στρογγυλό μικρόφωνο: όχι στο «Πες το», στις Πωλήσεις ημέρας και στις
  // Παραγγελίες (έχουν δικό τους μικρόφωνο / τα κουμπιά θα κρύβονταν από κάτω του)
  // όχι στην αρχική: εκεί υπάρχει το μεγάλο κόκκινο «Πες το»
  const showMic = pathname !== '/' && !/^\/voice\/?$/.test(pathname) && !pathname.startsWith('/daily-sales') && !/^\/orders\/?$/.test(pathname)

  // «Περισσότερα»: ανοιχτό αν το άνοιξε κάποτε ή αν είμαστε σε σελίδα του
  const inMore = NAV.some((g) => g.items.some((it) => pathname === it.to || pathname.startsWith(it.to + '/')))
    && !MAIN.some((it) => it.to !== '/' && (pathname === it.to || pathname.startsWith(it.to + '/')))
  const [more, setMore] = useState(() => { try { return localStorage.getItem(MORE_KEY) === '1' } catch { return false } })
  const toggleMore = () => { const v = !more; setMore(v); try { localStorage.setItem(MORE_KEY, v ? '1' : '0') } catch { /* ignore */ } }
  const link = (it: NavItem, big = false) => (
    <NavLink
      key={it.to}
      to={it.to}
      end={it.to === '/' || it.to === '/voice' || it.to === '/orders'}
      onClick={() => setOpen(false)}
      className={({ isActive }) =>
        'flex items-center rounded-md px-3 ' + (big ? 'min-h-12 text-base font-medium ' : 'min-h-11 ') + (isActive ? 'bg-red-700 text-white' : 'text-stone-800 hover:bg-stone-200')
      }
    >
      {it.label}
      {it.to === '/orders' && newOrders > 0 && (
        <span className="ml-2 inline-flex min-w-[1.5rem] justify-center rounded-full bg-amber-400 px-1.5 text-sm font-bold text-amber-950">{newOrders}</span>
      )}
    </NavLink>
  )
  const nav = (
    <nav className="flex flex-col gap-1 p-3 text-[15px]">
      {MAIN.map((it) => link(it, true))}
      <button type="button" className="mt-2 flex items-center justify-between min-h-12 rounded-md px-3 text-stone-700 hover:bg-stone-200 font-medium"
        onClick={toggleMore} aria-expanded={more || inMore}>
        <span>Περισσότερα</span><span aria-hidden="true">{more || inMore ? '▾' : '▸'}</span>
      </button>
      {(more || inMore) && NAV.map((g, gi) => (
        <div key={gi} className="mt-2">
          <div className="px-3 mb-1 text-sm font-semibold text-stone-600">{g.title}</div>
          {g.items.map((it) => link(it))}
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
        <header className="md:hidden sticky top-0 z-30 bg-white border-b border-stone-200 flex items-center gap-3 px-2 py-1">
          <button className="btn-ghost h-11 w-11 p-0 text-xl" onClick={() => setOpen(true)} aria-label="Μενού">☰</button>
          <div className="font-bold text-red-700">🍕 Pizza ERP</div>
          <div className="text-xs text-stone-500 truncate flex-1">{company?.name}</div>
          {newOrders > 0 && !pathname.startsWith('/orders') && (
            <Link to="/orders" className="rounded-full bg-amber-400 text-amber-950 text-xs font-bold px-3 py-1.5 mr-1">🛎️ {newOrders} νέ{newOrders === 1 ? 'α' : 'ες'}</Link>
          )}
        </header>
        <main className={'flex-1 p-3 md:p-6 max-w-7xl w-full mx-auto ' + (showMic ? 'pb-24 md:pb-6' : '')}>
          <Outlet />
        </main>
      </div>

      {/* Στρογγυλό μικρόφωνο σε κινητό: πάει στο «Πες το» και ακούει αμέσως */}
      {showMic && (
        <Link
          to="/voice"
          state={{ listen: true }}
          aria-label="Πες το"
          className="md:hidden fixed right-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-30 h-14 w-14 rounded-full bg-red-700 text-white shadow-lg flex items-center justify-center active:scale-95 transition"
        >
          <MicIcon className="h-7 w-7" />
        </Link>
      )}
    </div>
  )
}
