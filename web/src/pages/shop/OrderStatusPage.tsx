import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { errMsg, supabase } from '../../lib/supabase'
import { fmtMoney } from '../../lib/format'
import { clock, MODE_LABEL, PAYMENT_LABEL, readyAt, type OrderStatusInfo } from '../../lib/online'
import { ShopHeader } from './shared'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** «Πού είναι η παραγγελία μου» (/s/:slug/o/:token): ανανεώνεται μόνη της */
export function OrderStatusPage() {
  const { slug = '', token = '' } = useParams()
  const [info, setInfo] = useState<OrderStatusInfo | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!UUID_RE.test(token)) { setInfo(null); return }
    const { data, error: e } = await supabase.rpc('order_status', { p_token: token })
    if (e) { setError(errMsg(e)); return }
    setError(null)
    setInfo((data as OrderStatusInfo | null) ?? null)
  }, [token])

  useEffect(() => { load() }, [load])
  const live = !info || info.status === 'new' || info.status === 'accepted'
  useEffect(() => {
    if (!live) return
    const iv = window.setInterval(load, 15000)
    const h = () => { if (document.visibilityState === 'visible') load() }
    document.addEventListener('visibilitychange', h)
    return () => { window.clearInterval(iv); document.removeEventListener('visibilitychange', h) }
  }, [live, load])
  useEffect(() => { if (info) document.title = `Παραγγελία #${info.order_no} · ${info.shop.name}` }, [info])

  if (info === undefined) {
    return <div className="min-h-screen flex items-center justify-center text-stone-600 p-6 text-center">{error ?? 'Φόρτωση...'}</div>
  }
  if (info === null) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3 p-6 text-center text-stone-700">
        <p>Δεν βρέθηκε η παραγγελία.</p>
        <Link className="btn-primary" to={`/s/${slug}`}>Στο μενού</Link>
      </div>
    )
  }

  const at = readyAt(info)
  const phone = info.shop.phone
  const tel = phone ? <a className="underline font-medium" href={`tel:${phone.replace(/\s/g, '')}`}>{phone}</a> : null
  let icon = '⏳', title = '', text: ReactNode = null
  switch (info.status) {
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
      text = <>{info.reason ? `${info.reason}. ` : ''}{tel && <>Πάρε μας τηλέφωνο: {tel}</>}</>
      break
    case 'cancelled':
      icon = '✖'
      title = 'Ακυρώθηκε'
      text = <>{info.reason ? `${info.reason}. ` : ''}{tel && <>Για ό,τι χρειαστείς: {tel}</>}</>
      break
  }

  return (
    <div className="min-h-screen bg-stone-100 pb-10">
      <ShopHeader name={info.shop.name} phone={phone} />
      <div className="max-w-2xl mx-auto px-4">
        <div className="card p-5 mt-4 text-center" aria-live="polite">
          <div className="text-4xl mb-2" aria-hidden="true">{icon}</div>
          <div className="text-sm text-stone-500">Παραγγελία #{info.order_no} · {clock(info.created_at)}</div>
          <h2 className="text-xl font-semibold mt-1">{title}</h2>
          {text && <p className="text-stone-700 mt-2">{text}</p>}
          {live && <p className="text-xs text-stone-400 mt-3">Η σελίδα ανανεώνεται μόνη της.</p>}
        </div>

        <div className="card p-4 mt-3 text-sm">
          <div className="flex justify-between mb-2 text-stone-600">
            <span>{MODE_LABEL[info.mode]} · {PAYMENT_LABEL[info.payment]}</span>
            <span>{info.name}</span>
          </div>
          <ul className="divide-y divide-stone-100">
            {info.lines.map((l, i) => (
              <li key={i} className="py-1.5 flex gap-2">
                <span className="tabular-nums w-8">{l.qty}×</span>
                <span className="flex-1">{l.name}{l.note && <span className="text-stone-500"> ({l.note})</span>}</span>
                <span className="tabular-nums">{fmtMoney(l.qty * l.price)}</span>
              </li>
            ))}
          </ul>
          {Number(info.delivery_fee) > 0 && (
            <div className="flex justify-between pt-2"><span>Μεταφορικά</span><span className="tabular-nums">{fmtMoney(info.delivery_fee)}</span></div>
          )}
          <div className="flex justify-between pt-2 text-base font-semibold"><span>Σύνολο</span><span className="tabular-nums">{fmtMoney(info.total)}</span></div>
        </div>

        <div className="text-center mt-4">
          <Link className="btn-secondary" to={`/s/${info.shop.slug}`}>Νέα παραγγελία</Link>
        </div>
      </div>
    </div>
  )
}
