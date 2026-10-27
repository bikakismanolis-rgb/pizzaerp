import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { callFunction } from '../../lib/edge'
import { fmtMoney } from '../../lib/format'
import { Centered } from './shared'

/**
 * Σελίδες επιστροφής από την πληρωμή:
 *   /pay/viva  : το Viva γυρίζει εδώ (Success και Failure URL) με ?s=…&t=…
 *   /pay/test  : η δοκιμαστική πληρωμή («Πλήρωσε» / «Αποτυχία»)
 * Και οι δύο ρωτούν τον server (pay-return) και πάνε στη σελίδα της παραγγελίας.
 */

type ReturnResult = { token: string; slug: string; state: string; error?: string }

const orderPath = (r: ReturnResult) => `/s/${r.slug}/o/${r.token}`

export function VivaReturn() {
  const [q] = useSearchParams()
  const nav = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const once = useRef(false)

  const check = () => {
    setError(null)
    callFunction<ReturnResult>('pay-return', { provider: 'viva', params: { s: q.get('s') ?? '', t: q.get('t') ?? '' } })
      .then((r) => nav(orderPath(r), { replace: true }))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }
  useEffect(() => {
    if (once.current) return
    once.current = true
    check()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!q.get('s')) return <Centered>Δεν βρέθηκαν τα στοιχεία της πληρωμής.</Centered>
  if (error) {
    return (
      <Centered>
        <p>{error}</p>
        <button className="btn-primary" onClick={check}>Ξανά</button>
      </Centered>
    )
  }
  return <Centered>Ελέγχουμε την πληρωμή...</Centered>
}

export function TestPay() {
  const [q] = useSearchParams()
  const nav = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ref = q.get('ref') ?? ''
  const amount = Number(q.get('a') ?? 0)

  const finish = async (result: 'ok' | 'fail') => {
    setBusy(true)
    setError(null)
    try {
      const r = await callFunction<ReturnResult>('pay-return', { provider: 'test', params: { ref, result } })
      nav(orderPath(r), { replace: true })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  if (!ref) return <Centered>Δεν βρέθηκαν τα στοιχεία της πληρωμής.</Centered>
  return (
    <div className="min-h-screen bg-stone-100 flex items-center justify-center p-4">
      <div className="card p-6 w-full max-w-sm text-center grid gap-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-amber-800 bg-amber-50 border border-amber-200 rounded-md py-1">
          Δοκιμαστική πληρωμή · χωρίς χρήματα
        </div>
        <div className="text-stone-600 text-sm">Ποσό</div>
        <div className="text-3xl font-bold tabular-nums">{fmtMoney(amount)}</div>
        <p className="text-sm text-stone-600">
          Έτσι θα φαίνεται η μετάβαση στη σελίδα πληρωμής. Με Viva ή Stripe εδώ ο πελάτης βάζει κάρτα ή πληρώνει με IRIS.
        </p>
        {error && <div role="alert" className="rounded-md bg-red-50 border border-red-200 text-red-800 text-sm px-3 py-2">{error}</div>}
        <button className="btn-primary h-12 text-base" disabled={busy} onClick={() => finish('ok')}>Πλήρωσε (δοκιμή)</button>
        <button className="btn-secondary" disabled={busy} onClick={() => finish('fail')}>Αποτυχία πληρωμής (δοκιμή)</button>
      </div>
    </div>
  )
}
