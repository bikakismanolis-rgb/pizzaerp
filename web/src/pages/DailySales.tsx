import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useCompanyId } from '../context/CompanyContext'
import { useMaster } from '../context/MasterData'
import { supabase, errMsg } from '../lib/supabase'
import { tallyMessage } from '../lib/errors'
import { postDoc } from '../lib/docs'
import type { TallyChannel } from '../lib/voice/types'
import { CHANNEL_LABEL, TALLY_CHANNELS, docCode } from '../lib/labels'
import { fmtDate, fmtMoney, fmtQty, round, toNum, today } from '../lib/format'
import { Confirm, ErrorBox, Field, PageTitle, Spinner, useToast } from '../components/ui'

const LS_CHANNEL = 'pizza-erp.channel'

/** Η οθόνη (κανάλι/ημέρα) όπου έγινε μια αλλαγή */
interface At { gen: number; date: string; channel: TallyChannel }

/**
 * Πωλήσεις ημέρας = μετρητής: κάθε +/− (ή πληκτρολόγηση) γράφεται αμέσως στο
 * ανοιχτό πρόχειρο της ημέρας/καναλιού (tally_add), ώστε να το βλέπουν όλες
 * οι συσκευές. Το «Κλείσιμο ημέρας» το καταχωρεί (με backflush).
 */
export function DailySales() {
  const companyId = useCompanyId()
  const { items, ready, refresh } = useMaster()
  const toast = useToast()
  const [date, setDateState] = useState(today())
  // ημερομηνία που διάλεξε ο χρήστης: αλλιώς ακολουθεί τη σημερινή (tablet ανοιχτό από χθες)
  const manualDate = useRef(false)
  const setDate = (d: string) => { manualDate.current = d !== today(); setDateState(d) }
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
  // αυξάνεται σε κάθε αλλαγή καναλιού/ημέρας: απαντήσεις που αφορούν
  // προηγούμενη οθόνη δεν πειράζουν τη νέα
  const genRef = useRef(0)
  // αύξων αριθμός αλλαγών και η τελευταία ανά είδος: μια φόρτωση που ξεκίνησε
  // πριν από μια αλλαγή δεν γράφει πάνω της
  const epochRef = useRef(0)
  const touchedRef = useRef(new Map<string, number>())
  const [, setTick] = useState(0)
  const rerender = () => setTick((t) => t + 1)
  // ό,τι πληκτρολογείται (πριν σταλεί)
  const [edit, setEditState] = useState<Map<string, string>>(new Map())
  const editRef = useRef(edit)
  const setEdit = (f: (m: Map<string, string>) => Map<string, string>) => {
    editRef.current = f(editRef.current)
    setEditState(editRef.current)
  }
  const [running, setRunning] = useState<string | null>(null)
  const [posted, setPosted] = useState<{ id: string; doc_no: number }[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [closing, setClosing] = useState(false)
  const [askClose, setAskClose] = useState(false)
  // πληκτρολογήσεις που περιμένουν να σταλούν (debounce)
  const timers = useRef(new Map<string, { t: number; v: string; at: At }>())
  const base = baseRef.current
  const inflight = inflightRef.current

  const retail = useMemo(() => items.filter((i) => i.item_type === 'finished' && i.is_active && i.make_to_order), [items])
  // + ό,τι άλλο έτοιμο έχει ήδη μπει (π.χ. από το «Πες το»)
  const products = [...retail, ...items.filter((i) => i.item_type === 'finished' && !retail.includes(i) && (base.get(i.id) ?? 0) > 0)]

  /** Φόρτωση του ανοιχτού πρόχειρου (date, channel) */
  const load = useCallback(async (quiet = false) => {
    if (!companyId) return
    const gen = genRef.current
    const startEpoch = epochRef.current
    if (!quiet) setLoading(true)
    try {
      const { data, error: e } = await supabase.from('doc')
        .select('id, doc_no, status, is_running, doc_line(item_id, qty)')
        .eq('company_id', companyId).eq('doc_type', 'sale').eq('doc_date', date).eq('channel', channel).eq('is_auto', false)
        .order('doc_no')
      if (e) throw e
      // στο μεταξύ άλλαξε κανάλι ή ημέρα: η απάντηση δεν αφορά την οθόνη
      if (genRef.current !== gen) return
      const docs = (data ?? []) as unknown as { id: string; doc_no: number; status: string; is_running: boolean; doc_line: { item_id: string; qty: number }[] }[]
      const run = docs.find((d) => d.is_running && d.status === 'draft')
      const fresh = new Map<string, number>()
      for (const l of run?.doc_line ?? []) fresh.set(l.item_id, round((fresh.get(l.item_id) ?? 0) + Number(l.qty), 4))
      // είδη με αποστολή σε εξέλιξη ή αλλαγή μετά την έναρξη της φόρτωσης: κρατάμε το δικό μας
      const keep = (id: string) => inflightRef.current.has(id) || (touchedRef.current.get(id) ?? 0) > startEpoch
      const m = new Map<string, number>()
      for (const [id, q] of baseRef.current) if (keep(id)) m.set(id, q)
      for (const [id, q] of fresh) if (!keep(id)) m.set(id, q)
      baseRef.current = m
      if (run || epochRef.current === startEpoch) setRunning(run ? run.id : null)
      setPosted(docs.filter((d) => d.status === 'posted').map((d) => ({ id: d.id, doc_no: d.doc_no })))
      setError(null)
      rerender()
    } catch (e) {
      if (genRef.current === gen) setError(errMsg(e))
    } finally {
      if (!quiet && genRef.current === gen) setLoading(false)
    }
  }, [companyId, date, channel])

  useEffect(() => {
    genRef.current++
    // ό,τι γράφτηκε και δεν στάλθηκε ακόμα πάει στο κανάλι/ημέρα όπου γράφτηκε
    const waiting = [...timers.current]
    timers.current.clear()
    for (const [id, w] of waiting) { window.clearTimeout(w.t); commitTyped(id, w.v, w.at) }
    baseRef.current = new Map(); inflightRef.current = new Map(); touchedRef.current = new Map()
    setEdit(() => new Map())
    setRunning(null); setPosted([])
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, date, channel])

  // άλλη συσκευή μπορεί να πρόσθεσε: ξαναφόρτωση όταν γυρνάμε στη σελίδα.
  // Νέα μέρα (σελίδα ανοιχτή από χθες): πάμε στη σημερινή, αν δεν διάλεξε ημερομηνία
  // ο χρήστης και δεν περιμένει κάτι να σταλεί.
  useEffect(() => {
    const followToday = () => {
      const t = today()
      if (!manualDate.current && t !== date && editRef.current.size === 0 && inflightRef.current.size === 0) {
        setDateState(t)
        return true
      }
      return false
    }
    const h = () => { if (document.visibilityState === 'visible' && !followToday()) load(true) }
    window.addEventListener('focus', h)
    document.addEventListener('visibilitychange', h)
    const iv = window.setInterval(followToday, 60000)
    return () => { window.removeEventListener('focus', h); document.removeEventListener('visibilitychange', h); window.clearInterval(iv) }
  }, [load, date])

  useEffect(() => () => { for (const w of timers.current.values()) window.clearTimeout(w.t) }, [])

  const confirmed = (id: string) => round((baseRef.current.get(id) ?? 0) + (inflightRef.current.get(id) ?? 0), 4)
  /** η οθόνη τη στιγμή του πατήματος (σε event handler: το τρέχον κανάλι/ημέρα) */
  const at = (): At => ({ gen: genRef.current, date, channel })

  /** Στέλνει διαφορά ποσότητας· αισιόδοξα στην οθόνη, επαναφορά σε λάθος */
  const send = async (itemId: string, delta: number, where: At) => {
    delta = round(delta, 4)
    if (!delta) return
    const here = () => genRef.current === where.gen
    const add = (m: Map<string, number>, d: number) => { const v = round((m.get(itemId) ?? 0) + d, 4); if (v > 0 || (v < 0 && m === inflightRef.current)) m.set(itemId, v); else m.delete(itemId) }
    const mine = here()
    if (mine) {
      touchedRef.current.set(itemId, ++epochRef.current)
      add(inflightRef.current, delta)
      rerender()
    }
    try {
      const { data, error: e } = await supabase.rpc('tally_add', { p_company: companyId, p_date: where.date, p_channel: where.channel, p_item: itemId, p_delta: delta })
      if (e) throw e
      if (here()) {
        add(baseRef.current, delta)
        setRunning((data as string | null) ?? null)
      }
    } catch (e) {
      toast.err(tallyMessage(errMsg(e)))
    } finally {
      if (mine && here()) add(inflightRef.current, -delta)
      rerender()
    }
  }

  /** Ποσότητα του είδους στην ανοιχτή πώληση (date, channel) όπως είναι στη βάση τώρα */
  const serverQty = async (itemId: string, where: At): Promise<number | null> => {
    const { data, error: e } = await supabase.from('doc').select('id, doc_line(item_id, qty)')
      .eq('company_id', companyId).eq('doc_type', 'sale').eq('doc_date', where.date).eq('channel', where.channel)
      .eq('is_running', true).eq('status', 'draft').eq('is_auto', false)
    if (e) return null
    let q = 0
    for (const d of (data ?? []) as unknown as { doc_line: { item_id: string; qty: number }[] }[]) {
      for (const l of d.doc_line) if (l.item_id === itemId) q += Number(l.qty)
    }
    return round(q, 4)
  }

  const bump = (itemId: string, d: number) => {
    const w = timers.current.get(itemId)
    if (w) { window.clearTimeout(w.t); timers.current.delete(itemId) }
    const typed = editRef.current.get(itemId)
    const cur = typed !== undefined ? Math.max(0, toNum(typed)) : confirmed(itemId)
    const next = Math.max(0, round(cur + d, 4))
    setEdit((m) => { const n = new Map(m); n.delete(itemId); return n })
    send(itemId, next - confirmed(itemId), at())
  }

  /**
   * Πληκτρολογημένη ποσότητα = απόλυτη τιμή: διαφορά από ό,τι υπάρχει στη βάση
   * τώρα (φρέσκια ανάγνωση: μπορεί να πρόσθεσε άλλη συσκευή). Αν στο μεταξύ
   * άλλαξε κανάλι/ημέρα, η τιμή πάει εκεί που γράφτηκε.
   */
  const commitTyped = async (itemId: string, v: string, where: At) => {
    timers.current.delete(itemId)
    const here = () => genRef.current === where.gen
    const target = Math.max(0, round(toNum(v), 4))
    const fresh = here() && inflightRef.current.has(itemId) ? null : await serverQty(itemId, where)
    if (here()) {
      // ξαναγράφτηκε άλλη τιμή ή πατήθηκε +/− στο μεταξύ
      if (editRef.current.get(itemId) !== v) return
      if (fresh !== null && !inflightRef.current.has(itemId)) {
        baseRef.current.set(itemId, fresh)
        touchedRef.current.set(itemId, ++epochRef.current)
      }
      setEdit((m) => { const n = new Map(m); n.delete(itemId); return n })
      send(itemId, target - confirmed(itemId), where)
    } else if (fresh !== null) {
      send(itemId, target - fresh, where)
    } else {
      toast.err(`Δεν αποθηκεύτηκε η ποσότητα ${target} (${CHANNEL_LABEL[where.channel]}). Γράψ' την ξανά.`)
    }
  }

  const type = (itemId: string, v: string) => {
    setEdit((m) => new Map(m).set(itemId, v))
    const w = timers.current.get(itemId)
    if (w) window.clearTimeout(w.t)
    const where = at()
    timers.current.set(itemId, { v, at: where, t: window.setTimeout(() => commitTyped(itemId, v, where), 900) })
  }

  const flush = (itemId: string) => {
    const w = timers.current.get(itemId)
    if (w) { window.clearTimeout(w.t); commitTyped(itemId, w.v, w.at) }
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
        <Link to="/voice" className="btn-secondary h-11 inline-flex items-center">🎤 Πες το</Link>
      </PageTitle>
      <ErrorBox text={error} />

      <div className="card p-3 mb-3 flex flex-col gap-3">
        <div className="flex gap-2 flex-wrap">
          {TALLY_CHANNELS.map((c) => (
            <button key={c} type="button" onClick={() => setChannel(c)}
              className={'shrink-0 rounded-full px-4 h-11 text-sm font-medium border ' + (c === channel ? 'bg-red-700 text-white border-red-700' : 'bg-white text-stone-700 border-stone-300')}>
              {CHANNEL_LABEL[c]}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-3 items-end">
          <Field label="Ημερομηνία"><input type="date" className="input h-11" value={date} max={today()} onChange={(e) => e.target.value && setDate(e.target.value)} /></Field>
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

      {loading || !ready ? <Spinner /> : products.length === 0 ? (
        <div className="card p-6 text-sm text-stone-600">
          Δεν υπάρχουν προϊόντα λιανικής. Πήγαινε στα «Είδη», φτιάξε τις πίτσες ως «Έτοιμα προϊόντα» και τσέκαρε «Φτιάχνεται κατά παραγγελία».
        </div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {products.map((p) => {
            const q = lineQty(p.id)
            const busy = inflight.has(p.id)
            const noPrice = !(Number(p.sale_price) > 0)
            return (
              <div key={p.id} className={'card p-2 pl-3 flex items-center gap-2 ' + (q > 0 ? 'border-red-200' : '')}>
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{p.name}</div>
                  <div className={'text-xs ' + (noPrice ? 'text-red-700' : 'text-stone-500')}>
                    {noPrice ? 'Χωρίς τιμή: γράφεται 0 € (βάλε τιμή στα Είδη)' : `${fmtMoney(Number(p.sale_price) * (1 + Number(p.vat_rate) / 100))} με ΦΠΑ`}{busy && ' · αποθήκευση…'}
                  </div>
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
