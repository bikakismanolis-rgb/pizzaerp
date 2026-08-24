import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useMaster } from '../../context/MasterData'
import { supabase } from '../../lib/supabase'
import type { Doc, ItemType, StockBalance } from '../../lib/types'
import { ITEM_TYPE_LABEL } from '../../lib/labels'
import { fmtMoney, fmtQty, toNum, today } from '../../lib/format'
import { ErrorBox, Field, NumInput, Spinner } from '../../components/ui'
import type { LineInput } from '../../lib/docs'
import { useDocEditor } from './useDocEditor'
import { DocShell } from './DocShell'

interface Row { item_id: string; counted: string; include: boolean }

/**
 * Απογραφή: λίστα ειδών με μετρημένη ποσότητα. Στα καταχωρημένα δείχνει
 * αναμενόμενο / μετρημένο / διαφορά / αξία.
 */
export function StocktakeDoc() {
  const { id } = useParams()
  const isNew = !id || id === 'new'
  const { items, itemById } = useMaster()

  const ed = useDocEditor({ docType: 'stocktake', isNew, id, initialFields: () => ({ doc_date: today() }) })
  const { doc, lines, loading, saving, posting } = ed
  const posted = doc?.status === 'posted'

  const [date, setDate] = useState(today())
  const [notes, setNotes] = useState('')
  const [typeFilter, setTypeFilter] = useState<ItemType | ''>('')
  const [rows, setRows] = useState<Map<string, Row>>(new Map())
  const [expected, setExpected] = useState<Map<string, number>>(new Map())

  // αναμενόμενα υπόλοιπα για βοήθεια (μόνο σε νέο/πρόχειρο)
  useEffect(() => {
    if (posted) return
    supabase.from('v_stock_balance').select('item_id, on_hand').then(({ data }) => {
      setExpected(new Map(((data ?? []) as Pick<StockBalance, 'item_id' | 'on_hand'>[]).map((b) => [b.item_id, Number(b.on_hand)])))
    })
  }, [posted, doc?.id])

  useEffect(() => {
    if (!doc) return
    setDate(doc.doc_date); setNotes(doc.notes ?? '')
    setRows(new Map(lines.map((l) => [l.item_id, { item_id: l.item_id, counted: String(l.qty), include: true }])))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.id, doc?.status])

  const activeItems = useMemo(() => items.filter((i) => i.is_active && (!typeFilter || i.item_type === typeFilter)), [items, typeFilter])

  const setCounted = (itemId: string, v: string) => {
    setRows((m) => {
      const n = new Map(m)
      const cur = n.get(itemId) ?? { item_id: itemId, counted: '', include: true }
      n.set(itemId, { ...cur, counted: v, include: true })
      return n
    })
  }

  const fillAllExpected = () => {
    setRows((m) => {
      const n = new Map(m)
      for (const it of activeItems) {
        const exp = expected.get(it.id) ?? 0
        n.set(it.id, { item_id: it.id, counted: String(exp), include: true })
      }
      return n
    })
  }

  const countedRows = [...rows.values()].filter((r) => r.include && r.counted !== '')
  const canSave = countedRows.length > 0

  const buildFields = (): Partial<Doc> => ({ doc_date: date, notes: notes.trim() || null })
  const buildLines = (): LineInput[] => countedRows.map((r, i) => ({ line_no: i + 1, role: 'item', item_id: r.item_id, qty: toNum(r.counted) }))

  if (loading) return <Spinner />

  // Καταχωρημένη προβολή: από τις γραμμές
  if (posted) {
    return (
      <DocShell docType="stocktake" doc={doc} isNew={false} saving={saving} posting={posting} canSave={false}
        onSave={() => {}} onPost={() => {}} onUnpost={ed.unpost} onDelete={ed.remove}>
        <ErrorBox text={ed.error} />
        <div className="mb-3 text-sm text-stone-600">Ημερομηνία: {date}</div>
        <div className="card overflow-x-auto">
          <table className="tbl">
            <thead><tr><th>Είδος</th><th>Τύπος</th><th className="num">Αναμενόμενο</th><th className="num">Μετρημένο</th><th className="num">Διαφορά</th><th className="num">Αξία διαφοράς</th></tr></thead>
            <tbody>
              {lines.map((l) => {
                const it = itemById.get(l.item_id)
                const diff = Number(l.diff_qty ?? 0)
                return (
                  <tr key={l.id}>
                    <td>{it?.name}</td>
                    <td>{it && ITEM_TYPE_LABEL[it.item_type]}</td>
                    <td className="num">{fmtQty(l.expected_qty)}</td>
                    <td className="num">{fmtQty(l.qty)}</td>
                    <td className={'num ' + (diff < 0 ? 'text-red-700' : diff > 0 ? 'text-emerald-700' : '')}>{fmtQty(diff)}</td>
                    <td className="num">{fmtMoney(l.diff_value)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-stone-500 mt-2">Θετική αξία = έλλειμμα (επιβάρυνση κόστους). Δες αναλυτικά στην αναφορά «Αποτελέσματα απογραφών».</p>
      </DocShell>
    )
  }

  return (
    <DocShell docType="stocktake" doc={doc} isNew={isNew} saving={saving} posting={posting} canSave={canSave}
      onSave={() => ed.saveDraft(buildFields(), buildLines(), { navigate: true })}
      onPost={() => ed.post(buildFields(), buildLines())}
      onUnpost={ed.unpost} onDelete={ed.remove}>
      <ErrorBox text={ed.error} />
      <div className="card p-4 mb-3 flex flex-wrap gap-3 items-end">
        <Field label="Ημερομηνία"><input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Τύπος ειδών">
          <select className="input" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as ItemType | '')}>
            <option value="">Όλα</option><option value="raw">Πρώτες ύλες</option><option value="semi">Ημιέτοιμα</option><option value="finished">Έτοιμα</option>
          </select>
        </Field>
        <button className="btn-secondary" onClick={fillAllExpected}>Συμπλήρωση με αναμενόμενα</button>
      </div>

      <p className="text-sm text-stone-600 mb-2">Γράψε τη μετρημένη ποσότητα σε όσα είδη μέτρησες. Τα κενά αγνοούνται. Για σωστή κοστολόγηση, μία φορά τον μήνα μέτρα τα πάντα.</p>

      <div className="card overflow-x-auto">
        <table className="tbl">
          <thead><tr><th>Κωδικός</th><th>Είδος</th><th>Τύπος</th><th>Μον.</th><th className="num">Αναμενόμενο</th><th className="num w-32">Μετρημένο</th></tr></thead>
          <tbody>
            {activeItems.map((it) => {
              const r = rows.get(it.id)
              const exp = expected.get(it.id) ?? 0
              return (
                <tr key={it.id}>
                  <td className="whitespace-nowrap">{it.code}</td>
                  <td>{it.name}</td>
                  <td>{ITEM_TYPE_LABEL[it.item_type]}</td>
                  <td>{it.unit}</td>
                  <td className="num text-stone-500">{fmtQty(exp)}</td>
                  <td><NumInput value={r?.counted ?? ''} onChange={(v) => setCounted(it.id, v)} min={0} placeholder="—" /></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="card p-4 mt-3">
        <Field label="Σημειώσεις"><textarea className="input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      </div>
    </DocShell>
  )
}
