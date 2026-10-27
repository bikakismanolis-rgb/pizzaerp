import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { fmtMoney } from '../../lib/format'
import { clock, fmtPhone, nestLines, readyAt } from '../../lib/online'
import {
  driverDelivered, driverPing, driverRelease, driverTake, loadDriverApp, navUrl, type DriverApp, type DriverOrder,
} from '../../lib/delivery/api'
import { parseDriverVoice } from '../../lib/delivery/driverVoice'
import { useWakeLock } from '../../lib/orders/alarm'
import { cancelSpeech, speak, useSpeechRecognition } from '../../lib/voice/speech'
import { Centered, telHref, UUID_RE } from './shared'

/**
 * Το κινητό του διανομέα (/d/:token): έτοιμες για διανομή, «Την παίρνω»,
 * πλοήγηση, «Παραδόθηκε», και με φωνή. Θέση μόνο αν το μαγαζί το έχει
 * ανοίξει και μόνο όσο έχει παραγγελίες στον δρόμο.
 */

const payText = (o: DriverOrder) =>
  o.payment === 'online' && o.pay_status === 'paid' ? 'Πληρωμένη' : o.payment === 'card' ? `Κάρτα ${fmtMoney(o.total)}` : `Μετρητά ${fmtMoney(o.total)}`
const paySpeech = (o: DriverOrder) =>
  o.payment === 'online' && o.pay_status === 'paid' ? 'Πληρωμένη, δεν παίρνεις λεφτά.' : o.payment === 'card' ? `Κάρτα, ${fmtMoney(o.total)}.` : `Μετρητά, ${fmtMoney(o.total)}.`

export function DriverPage() {
  const { token = '' } = useParams()
  const [app, setApp] = useState<DriverApp | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [gps, setGps] = useState<'off' | 'on' | 'denied' | 'none'>('off')
  const sr = useSpeechRecognition()

  const load = useCallback(async () => {
    if (!UUID_RE.test(token)) { setApp(null); return }
    try {
      setApp(await loadDriverApp(token))
      setError(null)
    } catch (e) {
      const t = e instanceof Error ? e.message : String(e)
      if (/δεν ισχύει/.test(t)) setApp(null); else setError(t)
    }
  }, [token])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    const iv = window.setInterval(load, 15000)
    const h = () => { if (document.visibilityState === 'visible') load() }
    document.addEventListener('visibilitychange', h)
    return () => { window.clearInterval(iv); document.removeEventListener('visibilitychange', h) }
  }, [load])
  useEffect(() => { document.title = app ? `Διανομή · ${app.shop.name}` : 'Διανομή' }, [app])

  const onWay = (app?.mine.length ?? 0) > 0
  // όσο έχει παραγγελίες στον δρόμο: η οθόνη δεν σβήνει (και η θέση συνεχίζει)
  useWakeLock(onWay)

  // θέση: μόνο αν το μαγαζί το έχει ανοίξει, μόνο όσο έχει παραγγελίες στον δρόμο
  const tracking = !!app?.shop.tracking && onWay
  const lastPing = useRef(0)
  useEffect(() => {
    if (!tracking) { setGps('off'); return }
    if (!('geolocation' in navigator)) { setGps('none'); return }
    const id = navigator.geolocation.watchPosition((p) => {
      setGps('on')
      if (Date.now() - lastPing.current < 10000) return
      lastPing.current = Date.now()
      void driverPing(token, p.coords.latitude, p.coords.longitude, p.coords.accuracy ?? null).catch(() => {})
    }, (e) => setGps(e.code === e.PERMISSION_DENIED ? 'denied' : 'off'), { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 })
    return () => navigator.geolocation.clearWatch(id)
  }, [tracking, token])

  const say = (t: string) => { void speak(t) }
  const run = async (fn: () => Promise<string>) => {
    setBusy(true)
    setMsg(null)
    try {
      const t = await fn()
      setMsg({ ok: true, text: t })
      say(t)
    } catch (e) {
      const t = e instanceof Error ? e.message : String(e)
      setMsg({ ok: false, text: t })
      say(t)
    } finally {
      setBusy(false)
      load()
    }
  }
  const take = (o: DriverOrder) => run(async () => { await driverTake(token, o.id); return `Πήρες την ${o.order_no}. ${o.address ?? ''}. ${paySpeech(o)}` })
  const delivered = (o: DriverOrder) => run(async () => {
    const r = await driverDelivered(token, o.id)
    return `Παραδόθηκε η ${o.order_no}.${Number(r.cash) > 0 ? ` Κράτα ${fmtMoney(r.cash)} μετρητά.` : ''}`
  })
  const release = (o: DriverOrder) => run(async () => { await driverRelease(token, o.id); return `Η ${o.order_no} γύρισε στις έτοιμες.` })

  const readNext = () => {
    if (!app) return
    if (app.mine.length) {
      say(app.mine.map((o) => `Η ${o.order_no}: ${o.address ?? ''}. ${paySpeech(o)}`).join(' '))
    } else if (app.ready.length) {
      say(`Έτοιμες για διανομή: ${app.ready.map((o) => `η ${o.order_no}, ${o.address ?? ''}`).join('. ')}.`)
    } else say('Δεν υπάρχει τίποτα για διανομή.')
  }

  const pick = (list: DriverOrder[], no: number | null, what: string): DriverOrder | string => {
    if (no !== null) return list.find((o) => o.order_no === no) ?? `Δεν βρίσκω την ${no} ${what}.`
    if (list.length === 1) return list[0]
    return list.length === 0 ? `Δεν έχεις παραγγελία ${what}.` : `Ποια; Πες τον αριθμό: ${list.map((o) => o.order_no).join(', ')}.`
  }
  const onVoice = (text: string) => {
    const c = parseDriverVoice(text)
    if (!app) return
    if (!c) { say('Δεν κατάλαβα. Πες «παραδόθηκε» ή «την παίρνω η 12».'); setMsg({ ok: false, text: `«${text}»: δεν κατάλαβα.` }); return }
    if (c.kind === 'read') { readNext(); return }
    const list = c.kind === 'take' ? app.ready : app.mine
    const o = pick(list, c.no, c.kind === 'take' ? 'στις έτοιμες' : 'στον δρόμο')
    if (typeof o === 'string') { say(o); setMsg({ ok: false, text: o }); return }
    if (c.kind === 'take') void take(o)
    else if (c.kind === 'delivered') void delivered(o)
    else void release(o)
  }
  const listen = () => { cancelSpeech(); sr.start({ onFinal: onVoice }) }

  if (app === undefined) return <Centered>{error ?? 'Φόρτωση...'}</Centered>
  if (app === null) return <Centered>Ο σύνδεσμος δεν ισχύει. Ζήτησε νέο από το μαγαζί.</Centered>

  return (
    <div className="min-h-screen bg-stone-100 pb-28">
      <header className="bg-stone-900 text-white">
        <div className="max-w-xl mx-auto px-4 py-3 flex items-center gap-3">
          <div className="text-2xl" aria-hidden="true">🛵</div>
          <div className="flex-1 min-w-0">
            <div className="font-bold truncate">{app.driver.name}</div>
            <div className="text-xs opacity-80 truncate">{app.shop.name}</div>
          </div>
          {app.shop.phone && <a className="rounded-md bg-white/15 px-3 py-2 text-sm" href={telHref(app.shop.phone)}>📞 Μαγαζί</a>}
        </div>
      </header>

      <div className="max-w-xl mx-auto px-4">
        {error && <div role="alert" className="mt-3 rounded-md bg-amber-50 border border-amber-200 text-amber-900 text-sm px-3 py-2">{error}</div>}
        {msg && (
          <div role="status" className={'mt-3 rounded-md text-sm px-3 py-2 border ' + (msg.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-900' : 'bg-red-50 border-red-200 text-red-800')}>
            {msg.text}
          </div>
        )}
        {tracking && (
          <div className="mt-3 text-xs text-stone-600">
            {gps === 'on' ? '📍 Ο πελάτης βλέπει πού είσαι όσο τη φέρνεις (σταματά μόλις την παραδώσεις).'
              : gps === 'denied' ? '📍 Δεν δόθηκε άδεια για τη θέση: ο πελάτης δεν βλέπει πού είσαι.'
              : gps === 'none' ? '📍 Η συσκευή δεν δίνει θέση.' : '📍 Περιμένω τη θέση…'}
          </div>
        )}

        <h2 className="font-semibold mt-4 mb-2">Στον δρόμο {app.mine.length > 0 && <span className="badge bg-sky-100 text-sky-800">{app.mine.length}</span>}</h2>
        {app.mine.length === 0 && <p className="text-sm text-stone-500">Καμία. Πάρε μια από τις έτοιμες.</p>}
        <div className="grid gap-3">
          {app.mine.map((o) => (
            <div key={o.id} className="card p-4 border-2 border-sky-300">
              <OrderHead o={o} />
              <div className="grid grid-cols-2 gap-2 mt-3">
                {o.address && <a className="btn-secondary h-12 text-base" href={navUrl(o.address)} target="_blank" rel="noreferrer">🧭 Πλοήγηση</a>}
                <a className="btn-secondary h-12 text-base" href={telHref(o.phone)}>📞 Πελάτης</a>
              </div>
              <button className="btn-primary h-14 w-full mt-2 text-lg" disabled={busy} onClick={() => delivered(o)}>✅ Παραδόθηκε</button>
              <button className="btn-ghost w-full mt-1 text-sm" disabled={busy} onClick={() => release(o)}>Δεν την πήρα τελικά</button>
            </div>
          ))}
        </div>

        <h2 className="font-semibold mt-5 mb-2">Έτοιμες για διανομή {app.ready.length > 0 && <span className="badge bg-amber-200 text-amber-900">{app.ready.length}</span>}</h2>
        {app.ready.length === 0 && <p className="text-sm text-stone-500">Τίποτα αυτή τη στιγμή. Η σελίδα ανανεώνεται μόνη της.</p>}
        <div className="grid gap-3">
          {app.ready.map((o) => (
            <div key={o.id} className="card p-4">
              <OrderHead o={o} />
              <button className="btn-primary h-12 w-full mt-3 text-base" disabled={busy} onClick={() => take(o)}>🛵 Την παίρνω</button>
            </div>
          ))}
        </div>

        <div className="card p-4 mt-5 text-sm flex justify-between">
          <span>Σήμερα: <b>{app.delivered_today}</b> {app.delivered_today === 1 ? 'παράδοση' : 'παραδόσεις'}</span>
          <span>Μετρητά για το ταμείο: <b>{fmtMoney(app.cash_open)}</b></span>
        </div>
      </div>

      <div className="fixed inset-x-0 bottom-0 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] bg-white border-t border-stone-200">
        <div className="max-w-xl mx-auto flex items-center gap-3">
          <button className={'h-14 w-14 shrink-0 rounded-full text-white flex items-center justify-center ' + (sr.listening ? 'bg-red-900 animate-pulse' : 'bg-red-700')}
            onClick={() => (sr.listening ? sr.stop() : listen())} aria-label={sr.listening ? 'Σταμάτα' : 'Πες το'}>🎤</button>
          <div className="flex-1 text-sm text-stone-600">
            {sr.listening ? (sr.interim || 'Σε ακούω…') : sr.error ?? '«παραδόθηκε», «την παίρνω η 12», «διάβασε»'}
          </div>
          <button className="btn-secondary" onClick={readNext}>🔊</button>
        </div>
      </div>
    </div>
  )
}

function OrderHead({ o }: { o: DriverOrder }) {
  const at = readyAt(o)
  return (
    <>
      <div className="flex items-start gap-3">
        <div className="text-3xl font-bold tabular-nums">#{o.order_no}</div>
        <div className="flex-1 min-w-0">
          <div className="text-lg font-semibold leading-snug">{o.address}</div>
          <div className="text-sm text-stone-600">{o.customer_name} · {fmtPhone(o.phone)}{at && o.status === 'accepted' ? ` · έτοιμη ${clock(at)}` : ''}</div>
        </div>
      </div>
      <div className={'mt-2 inline-block rounded-md px-2 py-1 text-sm font-semibold ' + (o.payment === 'online' && o.pay_status === 'paid' ? 'bg-emerald-100 text-emerald-900' : 'bg-amber-100 text-amber-900')}>
        {payText(o)}
      </div>
      {o.notes && <div className="mt-2 text-sm text-amber-900">📝 {o.notes}</div>}
      <details className="mt-2 text-sm">
        <summary className="cursor-pointer text-stone-600">Τι έχει μέσα ({nestLines(o.lines).reduce((s, l) => s + l.qty, 0)})</summary>
        <ul className="mt-1">
          {nestLines(o.lines).map((l) => (
            <li key={l.line_no}>{l.qty}× {l.name}{l.extras.length > 0 && ` + ${l.extras.map((x) => x.name).join(', ')}`}</li>
          ))}
        </ul>
      </details>
    </>
  )
}
