import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { useParams } from 'react-router-dom'
import { errMsg, supabase } from '../../lib/supabase'
import { fmtDate, fmtMoney, fmtQty, round, toNum } from '../../lib/format'
import { grossPrice } from '../../lib/online'
import { Centered, ShopHeader, UUID_RE } from './shared'

/**
 * Παραγγελία πελάτη χονδρικής (ξενοδοχείο, καφέ…) από τον δικό του
 * σύνδεσμο (/h/:token), χωρίς λογαριασμό. Γίνεται πρόχειρη πώληση με τις
 * τιμές του πελάτη· το μαγαζί την ελέγχει και την καταχωρεί.
 */

interface B2bItem { id: string; name: string; unit: string; price: number; vat_rate: number; last_qty: number | null }
interface B2bMenu {
  company: string; phone: string | null; partner: string; items: B2bItem[]
  recent: { created_at: string; wanted_date: string | null; doc_no: number | null; status: string | null }[]
}

const tomorrow = () => {
  const d = new Date(Date.now() + 86400000)
  return d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Athens' })
}

export function HotelOrder() {
  const { token = '' } = useParams()
  const [menu, setMenu] = useState<B2bMenu | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [qty, setQty] = useState<Record<string, string>>({})
  const [date, setDate] = useState(tomorrow)
  const [note, setNote] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState<number | null>(null)

  const load = useCallback(async () => {
    if (!UUID_RE.test(token)) { setMenu(null); return }
    const { data, error: e } = await supabase.rpc('b2b_menu', { p_token: token })
    if (e) { setError(errMsg(e)); return }
    setMenu((data as B2bMenu | null) ?? null)
  }, [token])
  useEffect(() => { load() }, [load])
  useEffect(() => { if (menu) document.title = `Παραγγελία · ${menu.company}` }, [menu])

  const lines = useMemo(() => (menu?.items ?? [])
    .map((i) => ({ item: i, qty: toNum(qty[i.id]) }))
    .filter((l) => l.qty > 0), [menu, qty])
  const total = round(lines.reduce((s, l) => s + l.qty * grossPrice(l.item.price, l.item.vat_rate), 0))
  const hasLast = (menu?.items ?? []).some((i) => Number(i.last_qty) > 0)

  const sameAsLast = () => {
    const next: Record<string, string> = {}
    for (const i of menu?.items ?? []) if (Number(i.last_qty) > 0) next[i.id] = String(Number(i.last_qty))
    setQty(next)
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (lines.length === 0) { setError('Γράψε ποσότητα σε ένα τουλάχιστον είδος.'); return }
    setSending(true)
    const { data, error: er } = await supabase.rpc('b2b_order_place', {
      p_token: token,
      p_order: { lines: lines.map((l) => ({ item_id: l.item.id, qty: String(round(l.qty, 3)) })), note: note.trim() || null, wanted_date: date || null },
    })
    setSending(false)
    if (er) { setError(errMsg(er)); return }
    setSent((data as { doc_no: number }).doc_no)
    setQty({})
    setNote('')
    load()
  }

  if (menu === undefined) return <Centered>{error ?? 'Φόρτωση...'}</Centered>
  if (menu === null) return <Centered>Ο σύνδεσμος δεν ισχύει. Ζήτησε νέο από το μαγαζί.</Centered>

  return (
    <div className="min-h-screen bg-stone-100 pb-10">
      <ShopHeader name={menu.company} phone={menu.phone} />
      <div className="max-w-2xl mx-auto px-4">
        <p className="mt-4 text-stone-700">Παραγγελία για <b>{menu.partner}</b></p>

        {sent !== null && (
          <div role="status" className="card p-4 mt-3 border-green-300 bg-green-50 text-green-900">
            Η παραγγελία στάλθηκε (αρ. {sent}). Το μαγαζί θα την ελέγξει και θα σας ενημερώσει αν λείπει κάτι.
          </div>
        )}

        <form onSubmit={submit} className="grid gap-3 mt-3">
          {hasLast && (
            <button type="button" className="btn-secondary justify-self-start" onClick={sameAsLast}>Όπως την τελευταία φορά</button>
          )}
          <div className="card divide-y divide-stone-100">
            {menu.items.length === 0 && <p className="p-4 text-stone-500">Δεν υπάρχουν είδη για παραγγελία. Πάρτε τηλέφωνο στο μαγαζί.</p>}
            {menu.items.map((i) => (
              <label key={i.id} className="flex items-center gap-3 p-3">
                <span className="flex-1 min-w-0">
                  <span className="block font-medium">{i.name}</span>
                  <span className="block text-sm text-stone-500 tabular-nums">
                    {fmtMoney(i.price)} / {i.unit} + ΦΠΑ {i.vat_rate}%
                    {Number(i.last_qty) > 0 && <> · την τελευταία φορά {fmtQty(i.last_qty)}</>}
                  </span>
                </span>
                <input className="input w-24 text-right" inputMode="decimal" aria-label={`Ποσότητα ${i.name}`} placeholder="0"
                  value={qty[i.id] ?? ''} onChange={(e) => setQty({ ...qty, [i.id]: e.target.value })} />
              </label>
            ))}
          </div>
          <div className="card p-4 grid gap-3">
            <label className="block">
              <span className="label">Για πότε</span>
              <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
            <label className="block">
              <span className="label">Σημείωση (προαιρετικό)</span>
              <textarea className="input" rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
            </label>
            <div className="flex justify-between font-semibold"><span>Σύνολο με ΦΠΑ (περίπου)</span><span className="tabular-nums">{fmtMoney(total)}</span></div>
          </div>
          {error && <div role="alert" className="rounded-md bg-red-50 border border-red-200 text-red-800 text-sm px-3 py-2">{error}</div>}
          <button className="btn-primary h-12 text-base" disabled={sending || lines.length === 0}>
            {sending ? 'Αποστολή...' : 'Στείλε την παραγγελία'}
          </button>
        </form>

        {menu.recent.length > 0 && (
          <div className="card p-4 mt-4 text-sm">
            <div className="font-semibold mb-2">Οι τελευταίες σας παραγγελίες</div>
            <ul className="divide-y divide-stone-100">
              {menu.recent.map((r, k) => (
                <li key={k} className="py-1.5 flex justify-between gap-2">
                  <span>{new Date(r.created_at).toLocaleDateString('el-GR', { timeZone: 'Europe/Athens' })}{r.wanted_date && <> · για {fmtDate(r.wanted_date)}</>}</span>
                  <span className="text-stone-600">{r.status === 'posted' ? 'Καταχωρήθηκε' : r.status === 'draft' ? 'Στάλθηκε' : 'Ακυρώθηκε'}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}
