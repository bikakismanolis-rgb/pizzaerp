import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useCompany, useCompanyId } from '../context/CompanyContext'
import { useMaster } from '../context/MasterData'
import { useLoad } from '../lib/useLoad'
import { supabase } from '../lib/supabase'
import type { DocType, StockBalance } from '../lib/types'
import { DOC_TYPE_LABEL } from '../lib/labels'
import { fmtDate, fmtMoney, fmtQty, today } from '../lib/format'
import { clock, shopIsOpen, type OnlineShop } from '../lib/online'
import { monthAcc } from '../lib/overhead'
import { loadMonthNumbers, type MonthNumbers } from '../lib/money'
import { loadShop, setShopOpen } from '../lib/orders/orderActions'
import { MicIcon, Spinner, useToast } from '../components/ui'

/**
 * Αρχική: τα τέσσερα της ημέρας με μεγάλα κουμπιά, αν δέχεται online
 * παραγγελίες, τι μένει τον μήνα, και ό,τι θέλει προσοχή (ανοιχτά, τελειώνουν).
 */

interface Draft { id: string; doc_type: DocType; doc_no: number; doc_date: string }

const greeting = () => {
  const h = Number(new Date().toLocaleTimeString('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Europe/Athens' }))
  return h >= 5 && h < 12 ? 'Καλημέρα' : 'Καλησπέρα'
}

export function Dashboard() {
  const companyId = useCompanyId()
  const { company } = useCompany()
  const { items, ready } = useMaster()
  const toast = useToast()
  const [busy, setBusy] = useState(false)

  const data = useLoad(async () => {
    const [month, below, drafts, shop, fresh] = await Promise.all([
      loadMonthNumbers(companyId, today()).catch(() => null as MonthNumbers | null),
      supabase.from('v_stock_balance').select('*').eq('company_id', companyId).eq('below_min', true),
      supabase.from('doc').select('id, doc_type, doc_no, doc_date').eq('company_id', companyId).eq('status', 'draft').eq('is_running', false)
        .order('doc_date', { ascending: false }).limit(5),
      loadShop(companyId).catch(() => 'missing' as const),
      supabase.from('online_order').select('id', { count: 'exact', head: true }).eq('company_id', companyId).eq('status', 'new'),
    ])
    return {
      month,
      below: (below.data ?? []) as StockBalance[],
      drafts: (drafts.data ?? []) as Draft[],
      shop: shop === 'missing' ? null : (shop as OnlineShop | null),
      fresh: fresh.error ? 0 : fresh.count ?? 0,
    }
  }, [companyId])

  if (data.loading && !data.data) return <Spinner />
  const d = data.data
  const open = d?.shop ? shopIsOpen(d.shop) : false

  const toggleOpen = async (v: boolean) => {
    if (!v && !window.confirm('Να κλείσουν οι online παραγγελίες; Οι πελάτες δεν θα μπορούν να παραγγείλουν από τη σελίδα.')) return
    setBusy(true)
    try { toast.ok((await setShopOpen(companyId, v)).text) } catch (e) { toast.err(e instanceof Error ? e.message : String(e)) }
    setBusy(false)
    data.reload()
  }

  const m = d?.month
  return (
    <div className="max-w-4xl">
      <h1 className="text-2xl font-semibold mb-3">{greeting()}{company?.name ? `, ${company.name}` : ''}</h1>

      {ready && items.length === 0 && <FirstSteps />}

      {/* τα τέσσερα της ημέρας */}
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4 mb-4">
        <Tile to="/voice" tone="red" icon={<MicIcon className="h-8 w-8" />} title="Πες το" text="Πες τι έγινε" />
        <Tile to="/orders" tone={d && d.fresh > 0 ? 'amber' : 'white'} icon="🛎️" title="Παραγγελίες"
          text={d && d.fresh > 0 ? `${d.fresh} ${d.fresh === 1 ? 'νέα' : 'νέες'}!` : 'Καμία νέα'} />
        <Tile to="/daily-sales" icon="📋" title="Πωλήσεις ημέρας" text="efood, Wolt, μαγαζί" />
        <Tile to="/docs/purchase/new" icon="🚚" title="Ήρθε εμπόρευμα" text="Νέα αγορά" />
      </div>

      {/* online παραγγελίες ανοιχτές; */}
      {d?.shop && (
        <div className={'card p-3 mb-4 flex flex-wrap items-center gap-3 ' + (open ? 'border-emerald-300 bg-emerald-50' : '')}>
          <div className="flex-1 min-w-[12rem] font-medium">
            {open ? `🟢 Δεχόμαστε online παραγγελίες ως τις ${clock(d.shop.open_until!)}` : '⚪ Κλειστό για online παραγγελίες'}
          </div>
          {open
            ? <button className="btn-secondary h-12" disabled={busy} onClick={() => toggleOpen(false)}>Κλείσε</button>
            : <button className="btn-primary h-12" disabled={busy} onClick={() => toggleOpen(true)}>Άνοιξε τις παραγγελίες</button>}
        </div>
      )}

      {/* ο μήνας */}
      {m && (
        <Link to="/reports/profit" className="card p-4 mb-4 block hover:bg-stone-50">
          <div className="text-sm text-stone-600 mb-1">Τον {monthAcc(m.month)} ως σήμερα</div>
          {m.net === 0 && m.cogs === 0 && m.overhead === 0 ? (
            <div className="text-base">Δεν έχει περαστεί πώληση ακόμα αυτό τον μήνα.</div>
          ) : (
          <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
            <Money label="Πωλήσεις (χωρίς ΦΠΑ)" value={m.net} />
            <Money label="Υλικά" value={-m.cogs} />
            {m.overhead > 0 && <Money label={`Γενικά έξοδα (${m.days} μέρες)`} value={-m.overhead} />}
            <div className="ml-auto text-right">
              <div className="text-sm text-stone-600">{m.overhead > 0 ? 'Μένουν' : 'Μένουν μετά τα υλικά'}</div>
              <div className={'text-3xl font-bold tabular-nums ' + (m.profit < 0 ? 'text-red-700' : 'text-emerald-800')}>{fmtMoney(m.profit)}</div>
            </div>
          </div>
          )}
          {m.openNet > 0 && (
            <div className="text-sm text-amber-800 mt-2">+ {fmtMoney(m.openNet)} από ανοιχτές πωλήσεις ημέρας ({fmtQty(m.openQty)} τεμ.): μετράνε όταν κλείσει η μέρα.</div>
          )}
          <div className="text-sm text-red-700 mt-2">Δες τι αφήνει κάθε πίτσα →</div>
        </Link>
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        {d && d.drafts.length > 0 && (
          <div className="card p-4 border-amber-300">
            <h2 className="font-semibold mb-1">Δεν έχουν περαστεί ακόμα</h2>
            <p className="text-sm text-stone-600 mb-2">Κρατήθηκαν για αργότερα και δεν μετράνε. Άνοιξέ τα και πάτα «Πέρασέ το».</p>
            <ul className="grid gap-1">
              {d.drafts.map((x) => (
                <li key={x.id}>
                  <Link className="text-red-700 underline" to={`/docs/${x.doc_type}/${x.id}`}>{DOC_TYPE_LABEL[x.doc_type]} {x.doc_no} · {fmtDate(x.doc_date)}</Link>
                </li>
              ))}
            </ul>
          </div>
        )}
        {d && d.below.length > 0 && (
          <div className="card p-4">
            <h2 className="font-semibold mb-2">Τελειώνουν</h2>
            <ul className="grid gap-1">
              {d.below.map((b) => (
                <li key={b.item_id} className="flex justify-between gap-2">
                  <Link to={`/reports/item-ledger/${b.item_id}`} className="text-red-700 underline">{b.name}</Link>
                  <span className="tabular-nums"><b className="text-red-700">{fmtQty(b.on_hand)} {b.unit}</b> <span className="text-stone-500">(θέλουμε {fmtQty(b.min_stock)})</span></span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-2 mt-4 text-sm">
        <Link to="/docs/sale/new" className="btn-secondary">Πώληση σε ξενοδοχείο / μαγαζί</Link>
        <Link to="/docs/production/new" className="btn-secondary">Φτιάξαμε (παραγωγή)</Link>
        <Link to="/docs/stocktake/new" className="btn-secondary">Μέτρηση αποθήκης</Link>
        <a href="/odigos.pdf" target="_blank" rel="noreferrer" className="btn-ghost">📄 Οδηγός για εκτύπωση</a>
      </div>
    </div>
  )
}

function Tile({ to, icon, title, text, tone = 'white' }: { to: string; icon: ReactNode; title: string; text: string; tone?: 'red' | 'amber' | 'white' }) {
  const cls = tone === 'red' ? 'bg-red-700 border-red-700 text-white hover:bg-red-800'
    : tone === 'amber' ? 'bg-amber-300 border-amber-400 text-amber-950 hover:bg-amber-200 animate-pulse'
    : 'bg-white hover:bg-stone-50'
  return (
    <Link to={to} className={'card min-h-28 p-4 flex flex-col justify-between active:scale-[0.98] transition ' + cls}>
      <span className="text-3xl leading-none" aria-hidden="true">{icon}</span>
      <span>
        <span className="block text-lg font-semibold leading-tight">{title}</span>
        <span className={'block text-sm ' + (tone === 'red' ? 'text-white/85' : '')}>{text}</span>
      </span>
    </Link>
  )
}

function Money({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="text-sm text-stone-600">{label}</div>
      <div className="text-xl font-semibold tabular-nums">{value <= -0.005 ? `− ${fmtMoney(-value)}` : fmtMoney(Math.abs(value))}</div>
    </div>
  )
}

/** Πρώτη φορά (κανένα είδος): τι κάνω πρώτα */
function FirstSteps() {
  return (
    <div className="card p-4 mb-4 border-2 border-red-200">
      <h2 className="text-lg font-semibold mb-2">Ξεκίνα σε 3 βήματα</h2>
      <ol className="grid gap-2 list-decimal list-inside">
        <li>
          Πες στο <Link className="underline text-red-700" to="/voice">«Πες το»</Link>: «<b>νέα πίτσα μαργαρίτα 9 ευρώ</b>» (ή πρόσθεσέ την στα{' '}
          <Link className="underline text-red-700" to="/items/new">Είδη</Link>).
        </li>
        <li>Πες τι μπαίνει μέσα: «<b>η μαργαρίτα θέλει ένα ζυμάρι και 120 γραμμάρια μοτσαρέλα</b>».</li>
        <li>Όταν έρθει εμπόρευμα: «<b>ήρθαν από τον μύλο δέκα σακιά αλεύρι</b>».</li>
      </ol>
      <p className="text-sm text-stone-600 mt-2">
        Μετά, οι πωλήσεις: «efood δύο μαργαρίτες». Για online παραγγελίες από τη δική σου σελίδα: <Link className="underline text-red-700" to="/orders/settings">Ρυθμίσεις σελίδας</Link>.
      </p>
    </div>
  )
}
