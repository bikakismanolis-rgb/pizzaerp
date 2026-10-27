import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useCompanyId } from '../context/CompanyContext'
import { supabase } from '../lib/supabase'
import { fmtDate, fmtMoney, monthStart } from '../lib/format'
import {
  clock, DISCOUNT_LABEL, fmtPhone, minutesSince, MODE_LABEL, nestLines, NEW_ORDERS_EVENT, ORDER_STATUS_LABEL, orderSpeech, PAY_STATUS_LABEL,
  PAYMENT_LABEL, READY_MINUTES, readyAt, REJECT_REASONS, shopIsOpen, shopUrl, sourceLabel, type OnlineOrder, type OnlineShop,
} from '../lib/online'
import {
  acceptOrder, autoReceiptOn, cancelOrder, defaultMinutes, doneOrder, loadOrders, loadShop, refundOrder, rejectOrder, runOrderVoice,
  sendOrder, setShopOpen, type OrderResult,
} from '../lib/orders/orderActions'
import type { DriverRow } from '../lib/delivery/api'
import { listNos } from '../lib/orders/orderPick'
import { parseOrderVoice } from '../lib/orders/orderVoice'
import { beep, unlockAudio, useWakeLock } from '../lib/orders/alarm'
import { autoPrintOn, printHtml, setAutoPrint, ticketHtml } from '../lib/orders/ticket'
import { cancelSpeech, speak, ttsSupported, useSpeechRecognition } from '../lib/voice/speech'
import { ErrorBox, MicIcon, Modal, PageTitle, Spinner, useToast } from '../components/ui'
import { FiscalBox } from '../components/FiscalBox'

/**
 * Οθόνη της κουζίνας για τις online παραγγελίες. Ζωντανή (Realtime, και
 * ανανέωση κάθε 20'' για σιγουριά). Νέα παραγγελία: «ντιν» και ανάγνωση
 * φωναχτά, υπενθύμιση όσο περιμένει. Όλα και με φωνή: «δεκτή η 12 σε 20
 * λεπτά», «έφυγε η 12», «απόδειξη για την 12», «διάβασε», «κλείσε τις
 * παραγγελίες». Από κάτω και οι παραγγελίες των ξενοδοχείων (σύνδεσμος).
 */

const SOUND_KEY = 'pizza-erp.orders-sound'
const REMIND_MS = 45000
const POLL_MS = 20000

const readSound = () => { try { return localStorage.getItem(SOUND_KEY) !== '0' } catch { return true } }

interface Month { orders: number; total: number; sources: { source: string; orders: number; total: number }[] }

/** Παραγγελία ξενοδοχείου από τον σύνδεσμο (0006): πρόχειρη πώληση χονδρικής */
interface B2bOrder {
  id: string; created_at: string; wanted_date: string | null; note: string | null; doc_id: string | null
  partner: { name: string } | null; doc: { doc_no: number; total_gross: number; status: string } | null
}

async function loadB2b(companyId: string): Promise<B2bOrder[]> {
  const { data, error } = await supabase.from('b2b_order')
    .select('id, created_at, wanted_date, note, doc_id, partner(name), doc(doc_no, total_gross, status)')
    .eq('company_id', companyId).is('seen_at', null).order('created_at').limit(50)
  if (error) return [] // βάση χωρίς το 0006
  return (data ?? []) as unknown as B2bOrder[]
}

export function Orders() {
  const companyId = useCompanyId()
  const toast = useToast()
  const [shop, setShop] = useState<OnlineShop | null | 'missing' | undefined>(undefined)
  const [orders, setOrders] = useState<OnlineOrder[]>([])
  const [b2b, setB2b] = useState<B2bOrder[]>([])
  const [drivers, setDrivers] = useState<DriverRow[]>([])
  const [autoReceipt, setAutoReceipt] = useState(false)
  const [autoPrint, setAutoPrintState] = useState(autoPrintOn)
  const [month, setMonth] = useState<Month | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [soundOn, setSoundOn] = useState(readSound)
  const [touched, setTouched] = useState(() => !!(navigator as unknown as { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive)
  const [rejectFor, setRejectFor] = useState<OnlineOrder | null>(null)
  const [cancelFor, setCancelFor] = useState<OnlineOrder | null>(null)
  const [answer, setAnswer] = useState<OrderResult | null>(null)
  const [heard, setHeard] = useState('')
  const [typed, setTyped] = useState('')
  const [now, setNow] = useState(Date.now())
  const [minutes, setMinutes] = useState(defaultMinutes)
  const sr = useSpeechRecognition()
  const seen = useRef<Set<string> | null>(null)
  const seenB2b = useRef<Set<string> | null>(null)
  // σε refs: οι χρονομετρητές δεν ξαναστήνονται σε κάθε ανανέωση
  const soundRef = useRef(soundOn)
  soundRef.current = soundOn && touched
  const srRef = useRef(sr)
  srRef.current = sr
  useWakeLock(true)

  const say = useCallback((t: string) => { if (soundRef.current && t && !srRef.current.active()) void speak(t) }, [])

  // -------------------------------------------------------------------
  // Φόρτωση, ζωντανή ενημέρωση
  // -------------------------------------------------------------------
  const loadSeq = useRef(0)
  const load = useCallback(async () => {
    if (!companyId) return
    const my = ++loadSeq.current
    try {
      const s = await loadShop(companyId)
      if (my !== loadSeq.current) return
      setShop(s)
      if (s === 'missing') return
      const [os, m, bo, src, dr] = await Promise.all([
        loadOrders(companyId),
        supabase.from('v_online_month').select('orders, total').eq('company_id', companyId).eq('month', monthStart()).maybeSingle(),
        loadB2b(companyId),
        // βάση χωρίς το 0006: καμία πηγή
        supabase.from('v_online_source').select('source, orders, total').eq('company_id', companyId).eq('month', monthStart()),
        // βάση χωρίς το 0007: κανένας διανομέας
        supabase.from('v_driver_today').select('*').eq('company_id', companyId).order('name'),
      ])
      if (my !== loadSeq.current) return
      setOrders(os)
      setB2b(bo)
      setDrivers(dr.error ? [] : ((dr.data ?? []) as DriverRow[]).map((d) => ({ ...d, on_way: Number(d.on_way), cash_open: Number(d.cash_open) })))
      const sources = (src.error ? [] : (src.data ?? []) as Month['sources']).map((x) => ({ ...x, orders: Number(x.orders), total: Number(x.total) }))
        .sort((a, b) => b.orders - a.orders)
      setMonth(m.data ? { orders: Number(m.data.orders), total: Number(m.data.total), sources } : { orders: 0, total: 0, sources: [] })
      setError(null)
    } catch (e) {
      if (my === loadSeq.current) setError(e instanceof Error ? e.message : String(e))
    }
  }, [companyId])

  useEffect(() => { load() }, [load])
  useEffect(() => { if (companyId) autoReceiptOn(companyId).then(setAutoReceipt) }, [companyId])
  const timer = useRef<number | undefined>(undefined)
  const loadSoon = useCallback(() => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(load, 300)
  }, [load])

  useEffect(() => {
    if (!companyId || shop === 'missing') return
    const ch = supabase
      .channel(`online-orders-${companyId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'online_order', filter: `company_id=eq.${companyId}` }, () => loadSoon())
      .subscribe()
    const iv = window.setInterval(load, POLL_MS)
    const h = () => { if (document.visibilityState === 'visible') load() }
    document.addEventListener('visibilitychange', h)
    return () => {
      void supabase.removeChannel(ch)
      window.clearInterval(iv)
      document.removeEventListener('visibilitychange', h)
    }
  }, [companyId, shop === 'missing', load, loadSoon]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const iv = window.setInterval(() => setNow(Date.now()), 15000)
    return () => window.clearInterval(iv)
  }, [])

  // το πρώτο άγγιγμα ξεκλειδώνει ήχο και φωνή
  useEffect(() => {
    if (touched) return
    const h = () => { unlockAudio(); setTouched(true) }
    document.addEventListener('pointerdown', h, { once: true })
    document.addEventListener('keydown', h, { once: true })
    return () => { document.removeEventListener('pointerdown', h); document.removeEventListener('keydown', h) }
  }, [touched])

  useEffect(() => () => { cancelSpeech(); sr.abort() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const fresh = useMemo(() => orders.filter((o) => o.status === 'new'), [orders])
  const cooking = useMemo(() => orders.filter((o) => o.status === 'accepted'), [orders])
  const finished = useMemo(() => orders.filter((o) => ['done', 'rejected', 'cancelled'].includes(o.status)).reverse(), [orders])
  // πληρώνονται online τώρα: η κουζίνα τις βλέπει μόλις πληρωθούν
  const paying = useMemo(() => orders.filter((o) => o.status === 'awaiting_payment'), [orders])

  // νέες παραγγελίες: ντιν + ανάγνωση (όχι για όσες υπήρχαν όταν άνοιξε η
  // σελίδα). Όσες περιμένουν πληρωμή δεν μετράνε ως «είδα» ακόμα.
  useEffect(() => {
    if (shop === undefined || shop === 'missing') return
    const shown = orders.filter((o) => o.status !== 'awaiting_payment')
    if (seen.current === null) {
      seen.current = new Set(shown.map((o) => o.id))
      return
    }
    const arrivals = fresh.filter((o) => !seen.current!.has(o.id))
    for (const o of shown) seen.current.add(o.id)
    if (arrivals.length === 0) return
    if (soundOn) beep()
    window.setTimeout(() => say(arrivals.map(orderSpeech).join(' ')), 900)
  }, [orders, fresh, shop, soundOn, say])

  // ξενοδοχεία: ένα «ντιν» και το όνομα
  useEffect(() => {
    if (shop === undefined || shop === 'missing') return
    if (seenB2b.current === null) { seenB2b.current = new Set(b2b.map((b) => b.id)); return }
    const arrivals = b2b.filter((b) => !seenB2b.current!.has(b.id))
    for (const b of b2b) seenB2b.current.add(b.id)
    if (arrivals.length === 0) return
    if (soundOn) beep(1)
    window.setTimeout(() => say(arrivals.map((b) => `Νέα παραγγελία χονδρικής από ${b.partner?.name ?? 'πελάτη'}.`).join(' ')), 900)
  }, [b2b, shop, soundOn, say])

  // όσο περιμένει νέα παραγγελία: υπενθύμιση
  const freshRef = useRef(fresh)
  freshRef.current = fresh
  useEffect(() => {
    if (!soundOn) return
    const iv = window.setInterval(() => {
      if (srRef.current.active()) return
      const waiting = freshRef.current.filter((o) => Date.now() - new Date(o.created_at).getTime() > REMIND_MS)
      if (waiting.length === 0) return
      beep(2, true)
      window.setTimeout(() => say(`Περιμένει ${waiting.length === 1 ? 'η παραγγελία' : 'οι παραγγελίες'} ${listNos(waiting)}.`), 700)
    }, REMIND_MS)
    return () => window.clearInterval(iv)
  }, [soundOn, say])

  // ο αριθμός στο μενού ενημερώνεται αμέσως (όχι στον επόμενο έλεγχο του)
  useEffect(() => {
    if (shop === undefined || shop === 'missing') return
    window.dispatchEvent(new CustomEvent(NEW_ORDERS_EVENT, { detail: fresh.length }))
  }, [fresh.length, shop])

  // στον τίτλο της καρτέλας: πόσες περιμένουν
  useEffect(() => {
    const before = document.title
    document.title = fresh.length ? `(${fresh.length}) Νέες παραγγελίες` : 'Παραγγελίες'
    return () => { document.title = before }
  }, [fresh.length])

  // -------------------------------------------------------------------
  // Ενέργειες
  // -------------------------------------------------------------------
  const act = async (id: string, fn: () => Promise<OrderResult>) => {
    setBusy(id)
    try {
      const r = await fn()
      if (r.ok) toast.ok(r.text); else toast.err(r.text)
    } catch (e) {
      toast.err(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
      load()
    }
  }

  const toggleOpen = (open: boolean) => act('shop', () => setShopOpen(companyId, open))

  // δελτίο κουζίνας: με το κουμπί, ή μόνο του στην αποδοχή (ρύθμιση της συσκευής)
  const shopTitle = shop && shop !== 'missing' ? shop.title : ''
  const printOrder = (o: OnlineOrder) => printHtml(ticketHtml(o, shopTitle))
  const printFresh = async (id: string) => {
    try {
      const o = (await loadOrders(companyId)).find((x) => x.id === id)
      if (o) printOrder(o)
    } catch { /* το τύπωμα δεν είναι κρίσιμο */ }
  }
  const accept = (o: OnlineOrder, m: number) => act(o.id, async () => {
    const r = await acceptOrder(o, m, { autoReceipt })
    if (r.ok && autoPrint && r.acceptedId) void printFresh(r.acceptedId)
    return r
  })
  const toggleAutoPrint = () => { const v = !autoPrint; setAutoPrintState(v); setAutoPrint(v) }

  const toggleSound = () => {
    const v = !soundOn
    setSoundOn(v)
    try { localStorage.setItem(SOUND_KEY, v ? '1' : '0') } catch { /* ignore */ }
    unlockAudio()
    if (v) { beep(1); void speak('Ο ήχος είναι ανοιχτός.') } else cancelSpeech()
  }

  // -------------------------------------------------------------------
  // Φωνή
  // -------------------------------------------------------------------
  const onText = async (text: string) => {
    const t = text.trim()
    if (!t) return
    setHeard(t)
    const cmd = parseOrderVoice(t)
    if (!cmd) {
      const m = 'Δεν κατάλαβα. Πες π.χ. «δεκτή η 12 σε 20 λεπτά», «απόρριψε την 12», «έφυγε η 12», «απόδειξη για την 12», «διάβασε», «κλείσε τις παραγγελίες».'
      setAnswer({ ok: false, text: m })
      void speak('Δεν κατάλαβα. Πες για παράδειγμα, δεκτή η δώδεκα σε είκοσι λεπτά.')
      return
    }
    if (cmd.kind === 'stop') { cancelSpeech(); setAnswer(null); return }
    setBusy('voice')
    const r = await runOrderVoice(cmd, companyId)
    if (r.ok && autoPrint && r.acceptedId) void printFresh(r.acceptedId)
    setBusy(null)
    setAnswer(r)
    if (r.text) void speak(r.speech ?? r.text)
    load()
  }
  const listen = () => {
    unlockAudio()
    setTouched(true)
    cancelSpeech()
    sr.start({ onFinal: (t) => { void onText(t) } })
  }
  const submitTyped = (e: FormEvent) => { e.preventDefault(); const t = typed; setTyped(''); void onText(t) }

  // -------------------------------------------------------------------
  if (shop === undefined && !error) return <Spinner />
  if (shop === 'missing') {
    return (
      <div>
        <PageTitle title="Παραγγελίες" />
        <div className="card p-4 text-sm">
          Η βάση δεν έχει ακόμα τις online παραγγελίες. Χρειάζεται να εφαρμοστεί το <code>supabase/migrations/0005_online.sql</code> (βλ. README).
        </div>
      </div>
    )
  }

  const open = shop ? shopIsOpen(shop, now) : false

  return (
    <div className="pb-24">
      <PageTitle title="Παραγγελίες">
        <button className={soundOn ? 'btn-secondary' : 'btn-danger'} onClick={toggleSound} aria-pressed={soundOn}>
          {soundOn ? '🔊 Ήχος' : '🔇 Χωρίς ήχο'}
        </button>
        <button className="btn-secondary" onClick={toggleAutoPrint} aria-pressed={autoPrint}
          title="Τύπωμα του δελτίου κουζίνας όταν γίνεται δεκτή μια παραγγελία (σε αυτή τη συσκευή)">
          🖨 {autoPrint ? 'Τύπωμα στην αποδοχή' : 'Χωρίς τύπωμα'}
        </button>
        <Link to="/orders/drivers" className="btn-secondary">Διανομείς</Link>
        <Link to="/orders/customers" className="btn-secondary">Πελάτες</Link>
        <Link to="/orders/settings" className="btn-secondary">Ρυθμίσεις site</Link>
      </PageTitle>
      <ErrorBox text={error} />

      {soundOn && !touched && (
        <button className="w-full rounded-md bg-amber-100 border border-amber-300 text-amber-900 text-sm px-3 py-3 mb-3 text-left" onClick={() => { unlockAudio(); setTouched(true) }}>
          👆 Άγγιξε εδώ μία φορά για να ακούγονται οι νέες παραγγελίες (ο browser δεν αφήνει ήχο πριν από το πρώτο άγγιγμα).
        </button>
      )}

      {shop === null ? (
        <div className="card p-4 mb-4">
          <h2 className="font-semibold mb-1">Δεν έχεις στήσει ακόμα το site</h2>
          <p className="text-sm text-stone-600 mb-3">Διάλεξε διεύθυνση, ποια είδη φαίνονται και αν κάνεις διανομή. Παίρνει δύο λεπτά.</p>
          <Link to="/orders/settings" className="btn-primary">Στήσε το site</Link>
        </div>
      ) : shop && (
        <div className={'card p-4 mb-4 flex flex-wrap items-center gap-3 ' + (open ? 'border-emerald-300 bg-emerald-50' : '')}>
          <div className="flex-1 min-w-[12rem]">
            <div className="font-semibold">{open ? `🟢 Δεχόμαστε παραγγελίες ως τις ${clock(shop.open_until!)}` : '⚪ Κλειστό για online παραγγελίες'}</div>
            <a className="text-xs text-red-700 underline break-all" href={shopUrl(shop.slug)} target="_blank" rel="noreferrer">{shopUrl(shop.slug)}</a>
          </div>
          {open
            ? <button className="btn-secondary h-12 px-5" disabled={busy === 'shop'} onClick={() => toggleOpen(false)}>Κλείσε</button>
            : <button className="btn-primary h-12 px-5" disabled={busy === 'shop'} onClick={() => toggleOpen(true)}>Άνοιξε τις παραγγελίες</button>}
        </div>
      )}

      {/* Φωνή */}
      <div className="card p-3 mb-4 flex flex-wrap items-center gap-3">
        <button className={'h-14 w-14 shrink-0 rounded-full text-white flex items-center justify-center active:scale-95 transition ' + (sr.listening ? 'bg-red-900 animate-pulse' : 'bg-red-700')}
          onClick={() => (sr.listening ? sr.stop() : listen())} aria-label={sr.listening ? 'Σταμάτα' : 'Πες το'} disabled={busy === 'voice'}>
          <MicIcon className="h-7 w-7" />
        </button>
        <div className="flex-1 min-w-[12rem] text-sm">
          {sr.listening
            ? <div className="text-stone-700">{sr.interim || 'Σε ακούω…'}</div>
            : heard
              ? <div className="text-stone-500">«{heard}»</div>
              : <div className="text-stone-500">Πες «δεκτή η 12 σε 20 λεπτά», «έφυγε η 12», «απόδειξη για την 12», «διάβασε», «κλείσε τις παραγγελίες».</div>}
          {answer?.text && <div className={answer.ok ? 'text-emerald-800 font-medium' : 'text-red-800 font-medium'}>{answer.text}</div>}
          {sr.error && <div className="text-red-800">{sr.error}</div>}
        </div>
        <form onSubmit={submitTyped} className="w-full sm:w-auto flex gap-2">
          <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="ή γράψε: δεκτή η 12" aria-label="Εντολή" />
          <button className="btn-secondary" disabled={!typed.trim()}>OK</button>
        </form>
        {!ttsSupported() && <div className="text-xs text-stone-500 w-full">Αυτή η συσκευή δεν διαβάζει φωναχτά· οι νέες παραγγελίες ακούγονται μόνο με «ντιν».</div>}
      </div>

      {/* Νέες */}
      <h2 className="font-semibold mb-2">Νέες {fresh.length > 0 && <span className="badge bg-amber-200 text-amber-900">{fresh.length}</span>}</h2>
      {fresh.length === 0 && <p className="text-sm text-stone-500 mb-4">Καμία νέα παραγγελία.{shop && !open ? ' Το site είναι κλειστό.' : ''}</p>}
      {paying.length > 0 && (
        <p className="text-xs text-stone-500 -mt-2 mb-3">
          Πληρώνουν online τώρα: {paying.map((o) => `#${o.order_no} ${o.customer_name}`).join(', ')}. Έρχονται εδώ μόλις πληρωθούν.
        </p>
      )}
      <div className="grid gap-3 lg:grid-cols-2 mb-6">
        {fresh.map((o) => (
          <OrderCard key={o.id} o={o} now={now} tone="new" onPrint={() => printOrder(o)}>
            <div className="text-xs text-stone-500 mb-1">Δεκτή, έτοιμη σε:</div>
            <div className="flex flex-wrap gap-2">
              {READY_MINUTES.map((m) => (
                <button key={m} disabled={!!busy}
                  className={(m === minutes ? 'btn-primary' : 'btn-secondary') + ' h-12 min-w-[3.5rem] text-base'}
                  onClick={() => { setMinutes(m); void accept(o, m) }}>
                  {m}'
                </button>
              ))}
              <button className="btn-danger h-12 ml-auto" disabled={!!busy} onClick={() => setRejectFor(o)}>Απόρριψη</button>
            </div>
          </OrderCard>
        ))}
      </div>

      {/* Σε ετοιμασία */}
      <h2 className="font-semibold mb-2">Σε ετοιμασία {cooking.length > 0 && <span className="badge bg-sky-100 text-sky-800">{cooking.length}</span>}</h2>
      {cooking.length === 0 && <p className="text-sm text-stone-500 mb-4">Τίποτα σε ετοιμασία.</p>}
      <div className="grid gap-3 lg:grid-cols-2 mb-6">
        {cooking.map((o) => (
          <OrderCard key={o.id} o={o} now={now} tone="cooking" onPrint={() => printOrder(o)}>
            <div className="flex flex-wrap gap-2">
              <button className="btn-primary h-12 px-6 text-base" disabled={!!busy} onClick={() => act(o.id, () => doneOrder(o))}>
                {o.mode === 'delivery' ? '🛵 Έφυγε' : '✅ Παραδόθηκε'}
              </button>
              {o.mode === 'delivery' && drivers.filter((d) => d.is_active).map((d) => (
                <button key={d.driver_id} className="btn-secondary h-12" disabled={!!busy} onClick={() => act(o.id, () => sendOrder(o, d))}
                  title={`Έφυγε με ${d.name}`}>
                  🛵 {d.name}
                </button>
              ))}
              <button className="btn-ghost h-12 ml-auto" disabled={!!busy} onClick={() => setCancelFor(o)}>Ακύρωση…</button>
            </div>
            <div className="mt-2"><FiscalBox compact order={o.id} /></div>
          </OrderCard>
        ))}
      </div>

      {/* Ξενοδοχεία */}
      {b2b.length > 0 && (
        <>
          <h2 className="font-semibold mb-2">Χονδρική από σύνδεσμο <span className="badge bg-violet-100 text-violet-800">{b2b.length}</span></h2>
          <div className="grid gap-3 lg:grid-cols-2 mb-6">
            {b2b.map((b) => (
              <div key={b.id} className="card p-4 border-2 border-violet-200 text-sm">
                <div className="flex items-start gap-3">
                  <div className="flex-1">
                    <div className="font-semibold text-base">{b.partner?.name ?? 'Πελάτης'}</div>
                    <div className="text-stone-600">
                      {clock(b.created_at)}{b.wanted_date && <> · για <b>{fmtDate(b.wanted_date)}</b></>}
                      {b.doc && <> · ΠΩ-{b.doc.doc_no} · {fmtMoney(b.doc.total_gross)}</>}
                    </div>
                    {b.note && <div className="mt-1 text-amber-900">📝 {b.note}</div>}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 mt-3">
                  {b.doc_id && <Link className="btn-primary h-11" to={`/docs/sale/${b.doc_id}`}>Άνοιξε την πώληση</Link>}
                  <button className="btn-ghost h-11 ml-auto" disabled={!!busy}
                    onClick={() => act(b.id, async () => {
                      const { error: e } = await supabase.rpc('b2b_seen', { p_id: b.id })
                      if (e) throw new Error(e.message)
                      return { ok: true, text: 'Εντάξει.' }
                    })}>Το είδα</button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Διανομείς: στον δρόμο και μετρητά */}
      {drivers.some((d) => d.on_way > 0 || d.cash_open > 0) && (
        <div className="card p-4 mb-4 text-sm flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="font-semibold">Διανομείς:</span>
          {drivers.filter((d) => d.on_way > 0 || d.cash_open > 0).map((d) => (
            <span key={d.driver_id}>🛵 {d.name}{d.on_way > 0 && <> · <b>{d.on_way}</b> στον δρόμο</>}{d.cash_open > 0 && <> · {fmtMoney(d.cash_open)} μετρητά</>}</span>
          ))}
          <Link className="underline ml-auto" to="/orders/drivers">Εκκαθάριση</Link>
        </div>
      )}

      {/* Μήνας */}
      {month && shop && (
        <div className="card p-4 mb-4 text-sm">
          <div>
            Αυτόν τον μήνα από το site: <b>{month.orders}</b> {month.orders === 1 ? 'παραγγελία' : 'παραγγελίες'}, <b>{fmtMoney(month.total)}</b>.
          </div>
          {month.sources.some((x) => x.source) && (
            <div className="text-stone-600 mt-1">
              Από πού: {month.sources.map((x) => `${sourceLabel(x.source)} ${x.orders}`).join(' · ')}
            </div>
          )}
          {shop.compare_fee_pct ? (
            <div className="text-emerald-800 mt-1">
              Σε πλατφόρμα με προμήθεια {Number(shop.compare_fee_pct)}% θα πλήρωνες περίπου <b>{fmtMoney(month.total * Number(shop.compare_fee_pct) / 100)}</b>.
            </div>
          ) : (
            <div className="text-stone-500 mt-1">Βάλε την προμήθεια της πλατφόρμας στις <Link className="underline" to="/orders/settings">Ρυθμίσεις site</Link> για να βλέπεις τι γλιτώνεις.</div>
          )}
        </div>
      )}

      {/* Τελείωσαν */}
      {finished.length > 0 && (
        <details className="card p-4">
          <summary className="cursor-pointer font-semibold">Σήμερα, τελειωμένες ({finished.length})</summary>
          <table className="tbl mt-2">
            <tbody>
              {finished.map((o) => (
                <tr key={o.id}>
                  <td className="w-12 font-semibold">#{o.order_no}</td>
                  <td>{clock(o.created_at)}</td>
                  <td>
                    {o.customer_name}
                    {o.driver_id && (
                      <div className="text-xs text-stone-500">
                        🛵 {drivers.find((d) => d.driver_id === o.driver_id)?.name ?? 'διανομέας'}
                        {o.status === 'done' && (o.delivered_at ? ` · παραδόθηκε ${clock(o.delivered_at)}` : ' · στον δρόμο')}
                      </div>
                    )}
                  </td>
                  <td>
                    <span className={'badge ' + (o.status === 'done' ? 'bg-emerald-100 text-emerald-800' : 'bg-stone-200 text-stone-700')}>{ORDER_STATUS_LABEL[o.status]}</span>
                    {o.reason && <span className="text-xs text-stone-500"> · {o.reason}</span>}
                    {o.pay_status && o.pay_status !== 'none' && o.pay_status !== 'paid' && (
                      <span className={'badge ml-1 ' + (o.pay_status === 'refund_failed' ? 'bg-red-100 text-red-800' : 'bg-sky-100 text-sky-800')}>{PAY_STATUS_LABEL[o.pay_status]}</span>
                    )}
                    {(o.status === 'done' || o.status === 'cancelled') && (
                      <div className="mt-1"><FiscalBox compact order={o.id} allowNew={o.status === 'done'} /></div>
                    )}
                  </td>
                  <td className="num">{fmtMoney(o.total)}</td>
                  <td className="text-right whitespace-nowrap">
                    {(o.pay_status === 'refund_failed' || o.pay_status === 'refund_pending') && (
                      <button className="btn-secondary px-2 py-1 text-xs mr-1" disabled={!!busy} onClick={() => act(o.id, () => refundOrder(o))}>Επιστροφή χρημάτων</button>
                    )}
                    {o.status === 'done' && <button className="btn-ghost px-2 py-1 text-xs" disabled={!!busy} onClick={() => setCancelFor(o)}>Ακύρωση…</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {finished.some((o) => o.stock_note) && <p className="text-xs text-amber-800 mt-2">{finished.filter((o) => o.stock_note).map((o) => `#${o.order_no}: ${o.stock_note}`).join(' · ')}</p>}
        </details>
      )}

      <RejectModal order={rejectFor} onClose={() => setRejectFor(null)} onReject={(o, reason) => { setRejectFor(null); void act(o.id, () => rejectOrder(o, reason)) }} />
      <CancelModal order={cancelFor} onClose={() => setCancelFor(null)} onCancel={(o, reason) => { setCancelFor(null); void act(o.id, () => cancelOrder(o, reason)) }} />
    </div>
  )
}

// ---------------------------------------------------------------------
function OrderCard({ o, now, tone, onPrint, children }: { o: OnlineOrder; now: number; tone: 'new' | 'cooking'; onPrint: () => void; children: ReactNode }) {
  const at = readyAt(o)
  const ago = minutesSince(o.created_at, now)
  return (
    <div className={'card p-4 border-2 ' + (tone === 'new' ? 'border-amber-400' : 'border-sky-200')}>
      <div className="flex items-start gap-3 mb-2">
        <div className="text-3xl font-bold tabular-nums">#{o.order_no}</div>
        <div className="flex-1 min-w-0 text-sm">
          <div className="font-semibold">{o.customer_name} · <a className="text-red-700 underline" href={`tel:${o.phone}`}>{fmtPhone(o.phone)}</a></div>
          <div className="text-stone-600">
            {clock(o.created_at)} ({ago === 0 ? 'τώρα' : `πριν ${ago}'`})
            {tone === 'cooking' && at && <> · έτοιμη <b className={at.getTime() < now ? 'text-red-700' : ''}>{clock(at)}</b></>}
          </div>
        </div>
        <div className="text-right text-sm">
          <div className="flex items-center justify-end gap-1">
            <button className="btn-ghost px-1.5 py-0.5" onClick={onPrint} aria-label={`Τύπωσε την #${o.order_no}`} title="Τύπωσε">🖨</button>
            <span className="font-semibold tabular-nums">{fmtMoney(o.total)}</span>
          </div>
          {Number(o.discount) > 0 && o.discount_kind && (
            <div className="text-xs text-emerald-800">−{Number(o.discount_pct)}% {DISCOUNT_LABEL[o.discount_kind]}</div>
          )}
          <div className={o.payment === 'online' ? 'text-emerald-800 font-semibold' : 'text-stone-600'}>
            {o.payment === 'online' ? (o.pay_status === 'paid' ? '💳 Πληρωμένη' : PAY_STATUS_LABEL[o.pay_status ?? 'none'] || 'Online') : PAYMENT_LABEL[o.payment]}
          </div>
        </div>
      </div>
      <ul className="text-lg leading-snug mb-2">
        {nestLines(o.online_order_line).map((l) => (
          <li key={l.id}>
            <b className="tabular-nums">{l.qty}×</b> {l.name}
            {l.extras.length > 0 && <span className="text-base text-sky-800"> + {l.extras.map((x) => x.name).join(', ')}</span>}
            {l.note && <span className="text-base text-amber-800"> · {l.note}</span>}
          </li>
        ))}
      </ul>
      <div className="text-sm mb-3">
        <span className="badge bg-stone-200 text-stone-800 mr-1">{MODE_LABEL[o.mode]}</span>
        {o.address && <span>{o.address}</span>}
        {Number(o.delivery_fee) > 0 && <span className="text-stone-500"> · μεταφορικά {fmtMoney(o.delivery_fee)}</span>}
        {o.notes && <div className="mt-1 text-amber-900">📝 {o.notes}</div>}
      </div>
      {o.stock_note && (
        <div className="rounded-md bg-amber-50 border border-amber-200 text-amber-900 text-xs px-3 py-2 mb-3">
          Δεν πέρασε στην αποθήκη: {o.stock_note}
          {o.sale_doc_id && <> · <Link className="underline" to={`/docs/sale/${o.sale_doc_id}`}>Άνοιξε την πώληση</Link> για να τη διορθώσεις και να την καταχωρήσεις.</>}
        </div>
      )}
      {children}
    </div>
  )
}

function RejectModal({ order, onClose, onReject }: { order: OnlineOrder | null; onClose: () => void; onReject: (o: OnlineOrder, reason: string | null) => void }) {
  const [text, setText] = useState('')
  useEffect(() => { setText('') }, [order?.id])
  if (!order) return null
  return (
    <Modal open title={`Απόρριψη #${order.order_no}`} onClose={onClose}>
      <p className="text-sm text-stone-600 mb-3">
        Ο πελάτης βλέπει τον λόγο στη σελίδα του. Καμία κίνηση στην αποθήκη.
        {order.payment === 'online' && order.pay_status === 'paid' && <b> Είναι πληρωμένη online: τα χρήματα επιστρέφονται αμέσως.</b>}
      </p>
      <div className="grid gap-2 mb-3">
        {REJECT_REASONS.map((r) => <button key={r} className="btn-secondary h-11 justify-start" onClick={() => onReject(order, r)}>{r}</button>)}
      </div>
      <form onSubmit={(e) => { e.preventDefault(); onReject(order, text.trim() || null) }} className="flex gap-2">
        <input className="input" maxLength={200} value={text} onChange={(e) => setText(e.target.value)} placeholder="Άλλος λόγος (προαιρετικό)" />
        <button className="btn-danger">Απόρριψη</button>
      </form>
    </Modal>
  )
}

function CancelModal({ order, onClose, onCancel }: { order: OnlineOrder | null; onClose: () => void; onCancel: (o: OnlineOrder, reason: string | null) => void }) {
  const [text, setText] = useState('')
  useEffect(() => { setText('') }, [order?.id])
  if (!order) return null
  return (
    <Modal open title={`Ακύρωση #${order.order_no}`} onClose={onClose}>
      <p className="text-sm text-stone-600 mb-3">
        Η πώληση της παραγγελίας ακυρώνεται και το απόθεμα γυρίζει, εκτός αν την έχει ήδη μετρήσει απογραφή (τότε μένει, και το λέει).
        {order.payment === 'online' && order.pay_status === 'paid' && <b> Είναι πληρωμένη online: τα χρήματα επιστρέφονται αμέσως.</b>}
        {' '}Αν βγήκε απόδειξη, κάνε και πιστωτικό (κουμπί «Πιστωτικό…»).
      </p>
      <form onSubmit={(e) => { e.preventDefault(); onCancel(order, text.trim() || null) }} className="grid gap-3">
        <input className="input" maxLength={200} value={text} onChange={(e) => setText(e.target.value)} placeholder="Λόγος (π.χ. δεν ήταν σπίτι)" />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>Πίσω</button>
          <button className="btn-danger">Ακύρωση παραγγελίας</button>
        </div>
      </form>
    </Modal>
  )
}
