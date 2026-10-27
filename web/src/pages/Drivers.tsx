import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useCompanyId } from '../context/CompanyContext'
import { errMsg, supabase } from '../lib/supabase'
import { fmtMoney } from '../lib/format'
import { clock } from '../lib/online'
import { driverUrl, type DriverRow } from '../lib/delivery/api'
import { qrSvg } from '../lib/qr'
import { Confirm, ErrorBox, Field, Modal, PageTitle, Spinner, useToast } from '../components/ui'

/**
 * Διανομείς (0007): ο καθένας με δικό του σύνδεσμο για το κινητό του,
 * σημερινές παραδόσεις, μετρητά που κρατά και εκκαθάριση. Και η ρύθμιση
 * «ο πελάτης βλέπει πού είναι ο διανομέας».
 */
export function Drivers() {
  const companyId = useCompanyId()
  const toast = useToast()
  const [rows, setRows] = useState<DriverRow[] | null | 'missing'>(null)
  const [tracking, setTracking] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [busy, setBusy] = useState(false)
  const [linkFor, setLinkFor] = useState<{ row: DriverRow; token: string | null } | null>(null)
  const [settle, setSettle] = useState<DriverRow | null>(null)

  const load = useCallback(async () => {
    if (!companyId) return
    const [d, s] = await Promise.all([
      supabase.from('v_driver_today').select('*').eq('company_id', companyId).order('name'),
      supabase.from('online_shop').select('driver_tracking').eq('company_id', companyId).maybeSingle(),
    ])
    if (d.error) {
      if (d.error.code === 'PGRST205' || d.error.code === '42P01' || /v_driver_today/.test(d.error.message)) { setRows('missing'); return }
      setError(errMsg(d.error)); return
    }
    setRows(((d.data ?? []) as DriverRow[]).map((r) => ({ ...r, on_way: Number(r.on_way), delivered_today: Number(r.delivered_today), cash_open: Number(r.cash_open) })))
    setTracking(s.data ? !!(s.data as { driver_tracking?: boolean }).driver_tracking : null)
    setError(null)
  }, [companyId])
  useEffect(() => { load() }, [load])
  useEffect(() => { const iv = window.setInterval(load, 30000); return () => window.clearInterval(iv) }, [load])

  const add = async (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    setBusy(true)
    const { error: er } = await supabase.from('driver').insert({ company_id: companyId, name: name.trim(), phone: phone.trim() || null })
    setBusy(false)
    if (er) { toast.err(/row-level security/.test(er.message) ? 'Μόνο ο ιδιοκτήτης προσθέτει διανομείς.' : errMsg(er)); return }
    setName(''); setPhone('')
    toast.ok('Προστέθηκε')
    load()
  }

  const link = async (row: DriverRow, action: 'get' | 'rotate' | 'off') => {
    const { data, error: er } = await supabase.rpc('driver_link', { p_driver: row.driver_id, p_action: action })
    if (er) { toast.err(errMsg(er)); return }
    if (action === 'off') { toast.ok('Ο σύνδεσμος σταμάτησε.'); setLinkFor(null) } else setLinkFor({ row, token: data as string })
    if (action === 'rotate') toast.ok('Νέος σύνδεσμος· ο παλιός δεν δουλεύει πια.')
    load()
  }

  const setActive = async (row: DriverRow, v: boolean) => {
    const { error: er } = await supabase.from('driver').update({ is_active: v }).eq('id', row.driver_id)
    if (er) { toast.err(errMsg(er)); return }
    load()
  }

  const doSettle = async () => {
    const r = settle
    setSettle(null)
    if (!r) return
    const { data, error: er } = await supabase.rpc('driver_settle', { p_driver: r.driver_id })
    if (er) { toast.err(errMsg(er)); return }
    toast.ok(`Εκκαθάριση ${r.name}: ${fmtMoney(Number(data))}`)
    load()
  }

  const toggleTracking = async (v: boolean) => {
    setTracking(v)
    const { data, error: er } = await supabase.from('online_shop').update({ driver_tracking: v }).eq('company_id', companyId).select('driver_tracking')
    if (er || !(data ?? []).length) {
      setTracking(!v)
      toast.err(er ? errMsg(er) : 'Μόνο ο ιδιοκτήτης αλλάζει αυτή τη ρύθμιση.')
    }
  }

  if (rows === null && !error) return <Spinner />
  if (rows === 'missing') {
    return (
      <div>
        <PageTitle title="Διανομείς" />
        <div className="card p-4 text-sm">Η βάση δεν έχει ακόμα τους διανομείς. Χρειάζεται το <code>supabase/migrations/0007_delivery.sql</code> (βλ. README).</div>
      </div>
    )
  }
  const list = Array.isArray(rows) ? rows : []

  return (
    <div>
      <PageTitle title="Διανομείς">
        <Link to="/orders" className="btn-secondary">Παραγγελίες</Link>
      </PageTitle>
      <ErrorBox text={error} />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2 grid gap-3 content-start">
          {list.length === 0 && <div className="card p-4 text-sm text-stone-600">Δεν έχεις βάλει ακόμα διανομείς. Πρόσθεσε τον πρώτο δεξιά.</div>}
          {list.map((r) => (
            <div key={r.driver_id} className={'card p-4 flex flex-wrap items-center gap-3 ' + (r.is_active ? '' : 'opacity-60')}>
              <div className="text-2xl" aria-hidden="true">🛵</div>
              <div className="flex-1 min-w-[10rem]">
                <div className="font-semibold">{r.name}{r.phone && <span className="text-sm text-stone-500 font-normal"> · {r.phone}</span>}</div>
                <div className="text-sm text-stone-600">
                  Σήμερα {r.delivered_today} {r.delivered_today === 1 ? 'παράδοση' : 'παραδόσεις'}
                  {r.on_way > 0 && <> · <b className="text-sky-800">{r.on_way} στον δρόμο</b></>}
                  {r.last_at && r.on_way > 0 && <> · θέση {clock(r.last_at)}</>}
                </div>
              </div>
              <div className="text-right">
                <div className="text-xs text-stone-500">Μετρητά που κρατά</div>
                <div className="font-semibold tabular-nums">{fmtMoney(r.cash_open)}</div>
              </div>
              <div className="flex flex-wrap gap-2 w-full sm:w-auto">
                <button className="btn-primary" disabled={r.cash_open <= 0} onClick={() => setSettle(r)}>Εκκαθάριση</button>
                <button className="btn-secondary" onClick={() => link(r, 'get')}>{r.has_link ? 'Σύνδεσμος' : 'Φτιάξε σύνδεσμο'}</button>
                <button className="btn-ghost" onClick={() => setActive(r, !r.is_active)}>{r.is_active ? 'Ανενεργός' : 'Ενεργός'}</button>
              </div>
            </div>
          ))}
        </div>

        <div className="grid gap-4 content-start">
          <form onSubmit={add} className="card p-4 grid gap-3">
            <h2 className="font-semibold">Νέος διανομέας</h2>
            <Field label="Όνομα"><input className="input" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} placeholder="π.χ. Νίκος" /></Field>
            <Field label="Τηλέφωνο (προαιρετικό)"><input className="input" type="tel" maxLength={20} value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
            <button className="btn-primary" disabled={busy || !name.trim()}>Προσθήκη</button>
          </form>

          {tracking !== null && (
            <div className="card p-4 grid gap-2 text-sm">
              <label className="flex items-start gap-2">
                <input type="checkbox" className="mt-1" checked={tracking} onChange={(e) => toggleTracking(e.target.checked)} />
                <span><b>Ο πελάτης βλέπει πού είναι ο διανομέας</b> (χάρτης στη σελίδα της παραγγελίας του)</span>
              </label>
              <p className="text-xs text-stone-600">
                Μόνο όσο τη φέρνει, και μόνο όσο είναι ανοιχτή η σελίδα στο κινητό του (στο iPhone σταματά όταν κλειδώσει η οθόνη). Κρατιέται
                μόνο η τελευταία θέση και σβήνει μόλις παραδώσει. Ενημέρωσε τους διανομείς πριν το ανοίξεις.
              </p>
            </div>
          )}
          <div className="card p-4 text-xs text-stone-600 grid gap-1">
            <div><b>Πώς δουλεύει:</b> ο διανομέας ανοίγει τον σύνδεσμό του από το κινητό (μία φορά με το QR, μετά «Προσθήκη στην αρχική οθόνη»).</div>
            <div>Βλέπει τις έτοιμες για διανομή, πατά «Την παίρνω», «Πλοήγηση» και «Παραδόθηκε», ή το λέει: «παραδόθηκε η 12».</div>
            <div>Η κουζίνα μπορεί και να τη στείλει: «🛵 Νίκος» στην κάρτα της παραγγελίας.</div>
          </div>
        </div>
      </div>

      {linkFor && (
        <Modal open title={`Σύνδεσμος: ${linkFor.row.name}`} onClose={() => setLinkFor(null)}>
          {linkFor.token && (
            <div className="grid gap-3 text-sm">
              <div className="mx-auto w-48" dangerouslySetInnerHTML={{ __html: qrSvg(driverUrl(linkFor.token)) }} aria-label="QR του συνδέσμου" />
              <a className="text-red-700 underline break-all text-center" href={driverUrl(linkFor.token)} target="_blank" rel="noreferrer">{driverUrl(linkFor.token)}</a>
              <div className="flex flex-wrap gap-2 justify-center">
                <button className="btn-secondary" onClick={() => { void navigator.clipboard?.writeText(driverUrl(linkFor.token!)).then(() => toast.ok('Αντιγράφηκε')) }}>Αντιγραφή</button>
                <a className="btn-secondary" href={`https://wa.me/?text=${encodeURIComponent('Οι διανομές σου: ' + driverUrl(linkFor.token))}`} target="_blank" rel="noreferrer">WhatsApp</a>
                <button className="btn-ghost" onClick={() => link(linkFor.row, 'rotate')}>Νέος σύνδεσμος</button>
                <button className="btn-ghost" onClick={() => link(linkFor.row, 'off')}>Σταμάτα</button>
              </div>
              <p className="text-xs text-stone-500 text-center">Ο σύνδεσμος δείχνει διευθύνσεις και τηλέφωνα πελατών: μόνο στον διανομέα. Αν χαθεί το κινητό, «Νέος σύνδεσμος».</p>
            </div>
          )}
        </Modal>
      )}
      <Confirm open={!!settle} title="Εκκαθάριση"
        text={settle ? `Ο/Η ${settle.name} παραδίδει ${fmtMoney(settle.cash_open)} μετρητά στο ταμείο;` : ''}
        onNo={() => setSettle(null)} onYes={doSettle} />
    </div>
  )
}
