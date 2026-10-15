import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useCompanyId } from '../context/CompanyContext'
import { useMaster } from '../context/MasterData'
import { supabase, errMsg } from '../lib/supabase'
import { postDoc } from '../lib/docs'
import type { TallyChannel } from '../lib/voice/types'
import { CHANNEL_LABEL, TALLY_CHANNELS, docCode } from '../lib/labels'
import { fmtDate, fmtMoney, fmtQty, round, toNum, today } from '../lib/format'
import { Confirm, ErrorBox, Field, PageTitle, Spinner, useToast } from '../components/ui'

const LS_CHANNEL = 'pizza-erp.channel'

/**
 * Πωλήσεις ημέρας = μετρητής: κάθε +/− (ή πληκτρολόγηση) γράφεται αμέσως στο
 * ανοιχτό πρόχειρο της ημέρας/καναλιού (tally_add), ώστε να το βλέπουν όλες
 * οι συσκευές. Το «Κλείσιμο ημέρας» το καταχωρεί (με backflush).
 */
export function DailySales() {
  const companyId = useCompanyId()
  const { items, refresh } = useMaster()
  const toast = useToast()
  const [date, setDate] = useState(today())
  const [channel, setChannelState] = useState<TallyChannel>(() => {
    try {
      const c = localStorage.getItem(LS_CHANNEL) as TallyChannel | null
      if (c && TALLY_CHANNELS.includes(c)) return c
    } catch { /* ignore */ }
    return 'efood'
  })
  const setChannel = (c: TallyChannel) => {
    setChannelState(c)
    try { localStorage.setItem(LS_CHANNEL, c) } catch { /* ignore */ }
  }

  // ό,τι ξέρουμε ότι έχει γραφτεί στη βάση + αλλαγές που περιμένουν απάντηση
  // (refs: σωστοί υπολογισμοί και με γρήγορα διαδοχικά πατήματα)
  const baseRef = useRef(new Map<string, number>())
  const inflightRef = useRef(new Map<string, number>())
  const keyRef = useRef('')
  const [, setTick] = useState(0)
  const rerender = () => setTick((t) => t + 1)
  // ό,τι πληκτρολογείται (πριν σταλεί)
  const [edit, setEdit] = useState<Map<string, string>>(new Map())
  const [running, setRunning] = useState<string | null>(null)
  const [posted, setPosted] = useState<{ id: string; doc_no: number }[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [closing, setClosing] = useState(false)
  const [askClose, setAskClose] = useState(false)
  const timers = useRef(new Map<string, number>())
  const busyRef = useRef(0)
  const base = baseRef.current
  const inflight = inflightRef.current

  const retail = useMemo(() => items.filter((i) => i.item_type === 'finished' && i.is_active && i.make_to_order), [items])
  // + ό,τι άλλο έτοιμο έχει ήδη μπει (π.χ. από το «Πες το»)
  const products = [...retail, ...items.filter((i) => i.item_type === 'finished' && !retail.includes(i) && (base.get(i.id) ?? 0) > 0)]

  /** Φόρτωση του ανοιχτού πρόχειρου (date, channel) */
  const load = useCallback(async (quiet = false) => {
    if (!companyId) return
    if (!quiet) setLoading(true)
    try {
      const { data, error: e } = await supabase.from('doc')
        .select('id, doc_no, status, is_running, doc_line(item_id, qty)')
        .eq('company_id', companyId).eq('doc_type', 'sale').eq('doc_date', date).eq('channel', channel).eq('is_auto', false)
        .order('doc_no')
      if (e) throw e
      const docs = (data ?? []) as unknown as { id: string; doc_no: number; status: string; is_running: boolean; doc_line: { item_id: string; qty: number }[] }[]
      const run = docs.find((d) => d.is_running && d.status === 'draft')
      // στο μεταξύ μπορεί να πατήθηκε κάτι: δεν πατάμε πάνω σε εκκρεμότητες
      if (busyRef.current > 0) return
      const m = new Map<string, number>()
      for (const l of run?.doc_line ?? []) m.set(l.item_id, round((m.get(l.item_id) ?? 0) + Number(l.qty), 4))
      baseRef.current = m
      setRunning(run ? run.id : null)
      setPosted(docs.filter((d) => d.status === 'posted').map((d) => ({ id: d.id, doc_no: d.doc_no })))
      setError(null)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [companyId, date, channel])

  useEffect(() => {
    keyRef.current = `${date}|${channel}`
    for (const t of timers.current.values()) window.clearTimeout(t)
    timers.current.clear()
    baseRef.current = new Map(); inflightRef.current = new Map()
    setEdit(new Map())
    load()
  }, [load, date, channel])

  // άλλη συσκευή μπορεί να πρόσθεσε: ξαναφόρτωση όταν γυρνάμε στη σελίδα
  useEffect(() => {
    const h = () => { if (document.visibilityState === 'visible') load(true) }
    window.addEventListener('focus', h)
    document.addEventListener('visibilitychange', h)
    return () => { window.removeEventListener('focus', h); document.removeEventListener('visibilitychange', h) }
  }, [load])

  useEffect(() => () => { for (const t of timers.current.values()) window.clearTimeout(t) }, [])

  const confirmed = (id: string) => round((baseRef.current.get(id) ?? 0) + (inflightRef.current.get(id) ?? 0), 4)

  /** Στέλνει διαφορά ποσότητας· αισιόδοξα στην οθόνη, επαναφορά σε λάθος */
  const send = async (itemId: string, delta: number) => {
    delta = round(delta, 4)
    if (!delta) return
    const key = keyRef.current
    const add = (m: Map<string, number>, d: number) => { const v = round((m.get(itemId) ?? 0) + d, 4); if (v > 0 || (v < 0 && m === inflightRef.current)) m.set(itemId, v); else m.delete(itemId) }
    busyRef.current++
    add(inflightRef.current, delta)
    rerender()
    try {
      const { data, error: e } = await supabase.rpc('tally_add', { p_company: companyId, p_date: date, p_channel: channel, p_item: itemId, p_delta: delta })
      if (e) throw e
      if (keyRef.current === key) {
        add(baseRef.current, delta)
        setRunning((data as string | null) ?? null)
      }
    } catch (e) {
      toast.err(errMsg(e))
    } finally {
      if (keyRef.current === key) add(inflightRef.current, -delta)
      busyRef.current--
      rerender()
    }
  }

  const bump = (itemId: string, d: number) => {
    const t = timers.current.get(itemId)
    if (t) { window.clearTimeout(t); timers.current.delete(itemId) }
    const typed = edit.get(itemId)
    const cur = typed !== undefined ? Math.max(0, toNum(typed)) : confirmed(itemId)
    const next = Math.max(0, round(cur + d, 4))
    setEdit((m) => { const n = new Map(m); n.delete(itemId); return n })
    send(itemId, next - confirmed(itemId))
  }

  const commitTyped = (itemId: string, v: string) => {
    timers.current.delete(itemId)
    setEdit((m) => { const n = new Map(m); n.delete(itemId); return n })
    const target = Math.max(0, round(toNum(v), 4))
    send(itemId, target - confirmed(itemId))
  }

  const type = (itemId: string, v: string) => {
    setEdit((m) => new Map(m).set(itemId, v))
    const t = timers.current.get(itemId)
    if (t) window.clearTimeout(t)
    timers.current.set(itemId, window.setTimeout(() => commitTyped(itemId, v), 900))
  }

  const flush = (itemId: string) => {
    const t = timers.current.get(itemId)
    const v = edit.get(itemId)
    if (t && v !== undefined) { window.clearTimeout(t); commitTyped(itemId, v) }
  }

  const shown = (id: string) => edit.get(id) ?? (confirmed(id) ? String(confirmed(id)) : '')
  const lineQty = (id: string) => (edit.has(id) ? Math.max(0, toNum(edit.get(id))) : confirmed(id))
  const totalQty = products.reduce((s, p) => s + lineQty(p.id), 0)
  const total = round(products.reduce((s, p) => s + lineQty(p.id) * Number(p.sale_price) * (1 + Number(p.vat_rate) / 100), 0))
  const pending = inflight.size > 0 || edit.size > 0

  const closeDay = async () => {
    setAskClose(false)
    if (!running) return
    setClosing(true)
    try {
      await postDoc(running)
      await refresh() // νέα μέσα κόστη μετά το backflush
      toast.ok(`Καταχωρήθηκε η πώληση ${CHANNEL_LABEL[channel]} της ${fmtDate(date)}`)
      await load(true)
    } catch (e) { setError(errMsg(e)); toast.err(errMsg(e)) } finally { setClosing(false) }
  }

  const isPast = date < today()

  return (
    <div className="pb-24">
      <PageTitle title="Πωλήσεις ημέρας">
        <Link to="/voice" className="btn-secondary">🎤 Πες το</Link>
      </PageTitle>
      <ErrorBox text={error} />

      <div className="card p-3 mb-3 flex flex-col gap-3">
        <div className="flex gap-2 flex-wrap">
          {TALLY_CHANNELS.map((c) => (
            <button key={c} type="button" onClick={() => setChannel(c)}
              className={'shrink-0 rounded-full px-4 py-2 text-sm font-medium border ' + (c === channel ? 'bg-red-700 text-white border-red-700' : 'bg-white text-stone-700 border-stone-300')}>
              {CHANNEL_LABEL[c]}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-3 items-end">
          <Field label="Ημερομηνία"><input type="date" className="input" value={date} max={today()} onChange={(e) => e.target.value && setDate(e.target.value)} /></Field>
          <div className="text-xs text-stone-500 flex-1 min-w-[12rem]">
            Κάθε αλλαγή αποθηκεύεται αμέσως. Οι πίτσες «κατεβαίνουν» από την αποθήκη μαζί με τα υλικά τους όταν κλείσει η μέρα.
          </div>
        </div>
        {isPast && running && (
          <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-2 py-1">
            Παλιά ημέρα: κλείνει αυτόματα με την επόμενη σύνδεση ή με «Κλείσιμο ημέρας».
          </div>
        )}
        {posted.length > 0 && (
          <div className="text-xs text-stone-600">
            Ήδη καταχωρημένες για {CHANNEL_LABEL[channel]} {fmtDate(date)}:{' '}
            {posted.map((p, i) => (
              <span key={p.id}>{i > 0 && ', '}<Link className="text-red-700 hover:underline" to={`/docs/sale/${p.id}`}>{docCode('sale', p.doc_no)}</Link></span>
            ))}
            . Ό,τι προσθέσεις τώρα μπαίνει σε νέα.
          </div>
        )}
      </div>

      {loading ? <Spinner /> : products.length === 0 ? (
        <div className="card p-6 text-sm text-stone-600">
          Δεν υπάρχουν προϊόντα λιανικής. Πήγαινε στα «Είδη», φτιάξε τις πίτσες ως «Έτοιμα προϊόντα» και τσέκαρε «Φτιάχνεται κατά παραγγελία».
        </div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {products.map((p) => {
            const q = lineQty(p.id)
            const busy = inflight.has(p.id)
            return (
              <div key={p.id} className={'card p-2 pl-3 flex items-center gap-2 ' + (q > 0 ? 'border-red-200' : '')}>
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{p.name}</div>
                  <div className="text-xs text-stone-500">{fmtMoney(Number(p.sale_price) * (1 + Number(p.vat_rate) / 100))} με ΦΠΑ{busy && ' · αποθήκευση…'}</div>
                </div>
                <button type="button" className="btn-secondary h-11 w-11 p-0 text-xl" aria-label={`Μείον ${p.name}`}
                  onClick={() => bump(p.id, -1)} disabled={q <= 0}>−</button>
                <input
                  type="number" inputMode="decimal" min={0} step="any" placeholder="0"
                  className="input num w-14 h-11 px-1 text-center text-base font-semibold"
                  value={shown(p.id)}
                  onFocus={(e) => e.target.select()}
                  onChange={(e) => type(p.id, e.target.value)}
                  onBlur={() => flush(p.id)}
                  onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                />
                <button type="button" className="btn-primary h-11 w-11 p-0 text-xl" aria-label={`Συν ${p.name}`}
                  onClick={() => bump(p.id, +1)}>+</button>
              </div>
            )
          })}
        </div>
      )}

      <div className="fixed bottom-0 left-0 right-0 md:left-60 z-20 bg-white border-t border-stone-200 shadow-[0_-2px_8px_rgba(0,0,0,0.06)] px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] flex items-center gap-3">
        <div className="text-sm flex-1 min-w-0">
          <div className="truncate">{CHANNEL_LABEL[channel]} · {fmtQty(totalQty)} τεμ</div>
          <div className="text-xs text-stone-500 truncate">Σύνολο με ΦΠΑ <b className="tabular-nums text-stone-800">{fmtMoney(total)}</b>{pending && ' · αποθήκευση…'}</div>
        </div>
        <button className="btn-primary h-11 px-4" onClick={() => setAskClose(true)} disabled={closing || pending || !running || totalQty <= 0}>
          {closing ? 'Κλείσιμο…' : 'Κλείσιμο ημέρας'}
        </button>
      </div>

      <Confirm
        open={askClose}
        title="Κλείσιμο ημέρας"
        text={`Να καταχωρηθούν οι πωλήσεις ${CHANNEL_LABEL[channel]} της ${fmtDate(date)} (${fmtQty(totalQty)} τεμ, ${fmtMoney(total)}); Μετά δεν αλλάζουν από εδώ.`}
        onYes={closeDay}
        onNo={() => setAskClose(false)}
      />
    </div>
  )
}
