import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { errMsg, supabase } from '../../lib/supabase'
import { callFunction } from '../../lib/edge'
import { fmtMoney } from '../../lib/format'
import { clock, DISCOUNT_LABEL, loyaltyCard, MODE_LABEL, nestLines, PAYMENT_LABEL, readyAt, type OrderStatusInfo } from '../../lib/online'
import { Centered, ShopHeader, telHref, UUID_RE } from './shared'

/**
 * «Πού είναι η παραγγελία μου» (/s/:slug/o/:token): ανανεώνεται μόνη της.
 * Εδώ γυρίζει ο πελάτης και από το Stripe (?pay=stripe&session_id=…).
 */
export function OrderStatusPage() {
  const { slug = '', token = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const [info, setInfo] = useState<OrderStatusInfo | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [payMsg, setPayMsg] = useState<string | null>(null)
  const [paying, setPaying] = useState(false)
  const returned = useRef(false)

  const load = useCallback(async () => {
    if (!UUID_RE.test(token)) { setInfo(null); return }
    const { data, error: e } = await supabase.rpc('order_status', { p_token: token })
    if (e) { setError(errMsg(e)); return }
    setError(null)
    setInfo((data as OrderStatusInfo | null) ?? null)
  }, [token])

  // επιστροφή από το Stripe: ρωτάμε τον server τι έγινε, μετά καθαρό URL
  useEffect(() => {
    const pay = params.get('pay')
    if (!pay || returned.current) { load(); return }
    returned.current = true
    const sid = params.get('session_id')
    const done = () => { setParams({}, { replace: true }); load() }
    if (pay === 'stripe' && sid) {
      callFunction<{ state: string; error?: string }>('pay-return', { provider: 'stripe', params: { session_id: sid } })
        .then((r) => { if (r.state === 'failed') setPayMsg(r.error ?? 'Η πληρωμή δεν έγινε.') })
        .catch((e) => setPayMsg(e instanceof Error ? e.message : String(e)))
        .finally(done)
    } else {
      if (pay === 'cancel') setPayMsg('Η πληρωμή ακυρώθηκε. Μπορείς να δοκιμάσεις ξανά.')
      done()
    }
  }, [params, setParams, load])

  const live = !info || ['new', 'accepted', 'awaiting_payment'].includes(info.status)
    || info.pay_status === 'refund_pending'
  useEffect(() => {
    if (!live) return
    const iv = window.setInterval(load, info?.status === 'awaiting_payment' ? 5000 : 15000)
    const h = () => { if (document.visibilityState === 'visible') load() }
    document.addEventListener('visibilitychange', h)
    return () => { window.clearInterval(iv); document.removeEventListener('visibilitychange', h) }
  }, [live, load, info?.status])
  useEffect(() => { if (info) document.title = `Παραγγελία #${info.order_no} · ${info.shop.name}` }, [info])

  const payAgain = async () => {
    setPaying(true)
    setPayMsg(null)
    try {
      const r = await callFunction<{ redirect: string }>('shop-checkout', { retry_token: token })
      window.location.assign(r.redirect)
    } catch (e) {
      setPayMsg(e instanceof Error ? e.message : String(e))
      setPaying(false)
      load()
    }
  }

  if (info === undefined) return <Centered>{error ?? 'Φόρτωση...'}</Centered>
  if (info === null) {
    return (
      <Centered>
        <p>Δεν βρέθηκε η παραγγελία.</p>
        <Link className="btn-primary" to={`/s/${slug}`}>Στο μενού</Link>
      </Centered>
    )
  }

  const at = readyAt(info)
  const phone = info.shop.phone
  const tel = phone ? <a className="underline font-medium" href={telHref(phone)}>{phone}</a> : null
  const refund = info.pay_status === 'refunded' ? ' Τα χρήματα επιστράφηκαν στην κάρτα σου (φαίνονται σε λίγες μέρες).'
    : info.pay_status === 'refund_pending' ? ' Η επιστροφή των χρημάτων σου είναι σε εξέλιξη.'
    : info.pay_status === 'refund_failed' ? ' Η αυτόματη επιστροφή των χρημάτων δεν έγινε· το μαγαζί θα την κάνει.'
    : ''
  let icon = '⏳', title = '', text: ReactNode = null
  switch (info.status) {
    case 'awaiting_payment':
      icon = '💳'
      title = info.pay_status === 'failed' ? 'Η πληρωμή δεν έγινε' : 'Περιμένουμε την πληρωμή'
      text = info.pay_status === 'failed'
        ? <>Δεν χρεώθηκες. Δοκίμασε ξανά, ή κάνε νέα παραγγελία με άλλο τρόπο πληρωμής.</>
        : <>Αν μόλις πλήρωσες, περίμενε λίγο εδώ (με IRIS μπορεί να αργήσει μερικά λεπτά). Το μαγαζί τη βλέπει μόλις επιβεβαιωθεί η πληρωμή.</>
      break
    case 'expired':
      icon = '⌛'
      title = 'Η πληρωμή δεν ολοκληρώθηκε'
      text = <>Η παραγγελία δεν στάλθηκε στο μαγαζί. Κάνε μια νέα όποτε θέλεις.</>
      break
    case 'new':
      icon = '⏳'
      title = 'Περιμένει επιβεβαίωση'
      text = <>Το μαγαζί είδε την παραγγελία σου. Σε λίγο θα δεις εδώ πότε θα είναι έτοιμη.</>
      break
    case 'accepted':
      icon = '👨‍🍳'
      title = 'Έγινε δεκτή, ετοιμάζεται'
      text = at
        ? <>{info.mode === 'delivery' ? 'Υπολογίζουμε να είναι σε σένα' : 'Θα είναι έτοιμη για παραλαβή'} γύρω στις <b>{clock(at)}</b>.</>
        : <>Ετοιμάζεται.</>
      break
    case 'done':
      icon = info.mode === 'delivery' ? '🛵' : '✅'
      title = info.mode === 'delivery' ? 'Έφυγε, έρχεται!' : 'Παραδόθηκε'
      text = info.mode === 'delivery' ? <>Ο διανομέας είναι καθ' οδόν.</> : <>Καλή όρεξη!</>
      break
    case 'rejected':
      icon = '😔'
      title = 'Δεν μπορούμε να την εξυπηρετήσουμε'
      text = <>{info.reason ? `${info.reason}.` : ''}{refund} {tel && <>Πάρε μας τηλέφωνο: {tel}</>}</>
      break
    case 'cancelled':
      icon = '✖'
      title = 'Ακυρώθηκε'
      text = <>{info.reason ? `${info.reason}.` : ''}{refund} {tel && <>Για ό,τι χρειαστείς: {tel}</>}</>
      break
  }
  const canPay = info.status === 'awaiting_payment' && (info.pay_status === 'failed' || info.pay_status === 'pending')
  const payText = info.payment === 'online'
    ? (info.pay_status === 'paid' || info.pay_status?.startsWith('refund') ? 'Πληρωμένη online' : 'Online πληρωμή')
    : PAYMENT_LABEL[info.payment]

  return (
    <div className="min-h-screen bg-stone-100 pb-10">
      <ShopHeader name={info.shop.name} phone={phone} />
      <div className="max-w-2xl mx-auto px-4">
        <div className="card p-5 mt-4 text-center" aria-live="polite">
          <div className="text-4xl mb-2" aria-hidden="true">{icon}</div>
          <div className="text-sm text-stone-500">Παραγγελία #{info.order_no} · {clock(info.created_at)}</div>
          <h2 className="text-xl font-semibold mt-1">{title}</h2>
          {text && <p className="text-stone-700 mt-2">{text}</p>}
          {payMsg && <p role="alert" className="mt-3 rounded-md bg-amber-50 border border-amber-200 text-amber-900 text-sm px-3 py-2">{payMsg}</p>}
          {canPay && (
            <button className="btn-primary h-12 mt-4 px-6 text-base" disabled={paying} onClick={payAgain}>
              {paying ? 'Μεταφορά στην πληρωμή...' : `${info.pay_status === 'failed' ? 'Δοκίμασε ξανά' : 'Πλήρωσε'} · ${fmtMoney(info.total)}`}
            </button>
          )}
          {info.pay_test && info.payment === 'online' && <p className="text-xs text-amber-800 mt-2">Δοκιμαστική πληρωμή: δεν χρεώθηκε τίποτα.</p>}
          {live && <p className="text-xs text-stone-400 mt-3">Η σελίδα ανανεώνεται μόνη της.</p>}
        </div>

        {info.receipt && (
          <Link to={`/r/${info.receipt}`} className="card p-4 mt-3 flex items-center gap-3 text-sm">
            <span className="text-2xl" aria-hidden="true">🧾</span>
            <span className="flex-1 font-medium">Η απόδειξή σου</span>
            <span className="text-red-700">Δες →</span>
          </Link>
        )}

        <div className="card p-4 mt-3 text-sm">
          <div className="flex justify-between mb-2 text-stone-600">
            <span>{MODE_LABEL[info.mode]} · {payText}</span>
            <span>{info.name}</span>
          </div>
          <ul className="divide-y divide-stone-100">
            {nestLines(info.lines).map((l, i) => (
              <li key={i} className="py-1.5">
                <div className="flex gap-2">
                  <span className="tabular-nums w-8">{l.qty}×</span>
                  <span className="flex-1">{l.name}{l.note && <span className="text-stone-500"> ({l.note})</span>}</span>
                  <span className="tabular-nums">{fmtMoney(l.qty * l.price)}</span>
                </div>
                {l.extras.map((x, j) => (
                  <div key={j} className="flex gap-2 text-stone-600">
                    <span className="w-8" />
                    <span className="flex-1">+ {x.name}</span>
                    <span className="tabular-nums">{fmtMoney(x.qty * x.price)}</span>
                  </div>
                ))}
              </li>
            ))}
          </ul>
          {Number(info.discount) > 0 && info.discount_kind && (
            <div className="flex justify-between pt-2 text-emerald-800">
              <span>Έκπτωση {DISCOUNT_LABEL[info.discount_kind]} {Number(info.discount_pct)}%</span>
              <span className="tabular-nums">−{fmtMoney(info.discount)}</span>
            </div>
          )}
          {Number(info.delivery_fee) > 0 && (
            <div className="flex justify-between pt-2"><span>Μεταφορικά</span><span className="tabular-nums">{fmtMoney(info.delivery_fee)}</span></div>
          )}
          <div className="flex justify-between pt-2 text-base font-semibold"><span>Σύνολο</span><span className="tabular-nums">{fmtMoney(info.total)}</span></div>
        </div>

        {info.loyalty && ['new', 'accepted', 'done'].includes(info.status) && <LoyaltyCard {...info.loyalty} />}

        <div className="text-center mt-4">
          <Link className="btn-secondary" to={`/s/${info.shop.slug}`}>Νέα παραγγελία</Link>
        </div>
      </div>
    </div>
  )
}

/** Κάρτα σφραγίδων: «Κάθε 5η παραγγελία −20%» */
function LoyaltyCard({ every, pct, count }: { every: number; pct: number; count: number }) {
  const k = loyaltyCard(Number(count), Number(every))
  return (
    <div className="card p-4 mt-3 text-center">
      <div className="text-sm font-medium">⭐ Κάθε {every}η παραγγελία −{Number(pct)}%</div>
      <div className="flex justify-center gap-1.5 my-2" aria-label={`${k.filled} από ${every}`}>
        {Array.from({ length: Number(every) }, (_, i) => (
          <span key={i} className={'h-6 w-6 rounded-full border-2 ' + (i < k.filled ? 'bg-amber-400 border-amber-500' : 'border-stone-300')} />
        ))}
      </div>
      <div className="text-sm text-stone-600">
        {k.nextDiscount ? <b className="text-emerald-800">Η επόμενη παραγγελία σου έχει −{Number(pct)}%!</b>
          : `Μετά από ${k.left - 1} ακόμα, η επόμενη έχει −${Number(pct)}%.`}
      </div>
    </div>
  )
}
