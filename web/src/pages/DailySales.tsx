import { useMemo, useState } from 'react'
import { useCompanyId } from '../context/CompanyContext'
import { useMaster } from '../context/MasterData'
import { supabase, errMsg } from '../lib/supabase'
import { createDraft, postDoc, replaceLines, type LineInput } from '../lib/docs'
import type { Channel, Doc } from '../lib/types'
import { CHANNEL_LABEL } from '../lib/labels'
import { fmtMoney, round, toNum, today } from '../lib/format'
import { ErrorBox, Field, NumInput, PageTitle, useToast } from '../components/ui'

/**
 * Πωλήσεις ημέρας: γρήγορη καταχώρηση λιανικής. Λίστα με τα προϊόντα
 * "κατά παραγγελία" και ποσότητα δίπλα. Δημιουργεί μία πώληση (με backflush).
 */
export function DailySales() {
  const companyId = useCompanyId()
  const { items } = useMaster()
  const toast = useToast()
  const [date, setDate] = useState(today())
  const [channel, setChannel] = useState<Channel>('efood')
  const [qty, setQty] = useState<Map<string, string>>(new Map())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const products = useMemo(
    () => items.filter((i) => i.item_type === 'finished' && i.is_active && i.make_to_order),
    [items],
  )

  const setQ = (id: string, v: string) => setQty((m) => new Map(m).set(id, v))
  const bump = (id: string, d: number) => setQty((m) => { const cur = toNum(m.get(id)); const n = Math.max(0, cur + d); return new Map(m).set(id, n ? String(n) : '') })

  const lines = products.map((p) => ({ p, q: toNum(qty.get(p.id)) })).filter((x) => x.q > 0)
  const total = round(lines.reduce((s, x) => s + x.q * Number(x.p.sale_price) * (1 + Number(x.p.vat_rate) / 100), 0))

  const submit = async () => {
    if (lines.length === 0) return
    setBusy(true); setError(null)
    try {
      const fields: Partial<Doc> = { doc_date: date, channel, notes: 'Πωλήσεις ημέρας' }
      const docId = await createDraft(companyId, 'sale', fields)
      const docLines: LineInput[] = lines.map((x, i) => ({
        line_no: i + 1, role: 'item', item_id: x.p.id, qty: x.q,
        unit_price: Number(x.p.sale_price), vat_rate: Number(x.p.vat_rate),
      }))
      await replaceLines(companyId, docId, docLines)
      await postDoc(docId)
      // ανανέωση μέσων κοστών ειδών
      await supabase.from('item').select('id').limit(1)
      toast.ok('Καταχωρήθηκε η πώληση ημέρας')
      setQty(new Map())
    } catch (e) { setError(errMsg(e)); toast.err(errMsg(e)) } finally { setBusy(false) }
  }

  return (
    <div>
      <PageTitle title="Πωλήσεις ημέρας" />
      <ErrorBox text={error} />

      {products.length === 0 ? (
        <div className="card p-6 text-sm text-stone-600">
          Δεν υπάρχουν προϊόντα λιανικής. Πήγαινε στα «Είδη», φτιάξε τις πίτσες ως «Έτοιμα προϊόντα» και τσέκαρε «Φτιάχνεται κατά παραγγελία».
        </div>
      ) : (
        <>
          <div className="card p-4 mb-3 flex flex-wrap gap-3 items-end">
            <Field label="Ημερομηνία"><input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
            <Field label="Κανάλι">
              <select className="input" value={channel} onChange={(e) => setChannel(e.target.value as Channel)}>
                {(['efood', 'phone', 'store'] as Channel[]).map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>)}
              </select>
            </Field>
            <div className="text-sm text-stone-600 flex-1 min-w-[12rem]">Οι πίτσες θα «κατέβουν» αυτόματα από την αποθήκη μαζί με τα υλικά τους (ζυμάρι, τυρί κλπ).</div>
          </div>

          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {products.map((p) => (
              <div key={p.id} className="card p-3 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{p.name}</div>
                  <div className="text-xs text-stone-500">{fmtMoney(p.sale_price)} + {p.vat_rate}% ΦΠΑ</div>
                </div>
                <div className="flex items-center gap-1">
                  <button className="btn-secondary px-2 py-1" onClick={() => bump(p.id, -1)}>−</button>
                  <div className="w-16"><NumInput value={qty.get(p.id) ?? ''} onChange={(v) => setQ(p.id, v)} min={0} placeholder="0" /></div>
                  <button className="btn-secondary px-2 py-1" onClick={() => bump(p.id, +1)}>+</button>
                </div>
              </div>
            ))}
          </div>

          <div className="sticky bottom-0 mt-4 bg-white border border-stone-200 rounded-lg shadow p-3 flex items-center justify-between">
            <div className="text-sm">
              {lines.length} είδη · Σύνολο (με ΦΠΑ): <b className="tabular-nums">{fmtMoney(total)}</b>
            </div>
            <button className="btn-primary" onClick={submit} disabled={busy || lines.length === 0}>
              {busy ? 'Καταχώρηση...' : 'Καταχώρηση πώλησης'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
