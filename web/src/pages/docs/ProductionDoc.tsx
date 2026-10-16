import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useMaster } from '../../context/MasterData'
import { supabase } from '../../lib/supabase'
import type { Bom, BomLine, Doc } from '../../lib/types'
import { fmtCost, round, toNum, today } from '../../lib/format'
import { ErrorBox, Field, NumInput, Spinner } from '../../components/ui'
import { ItemPicker } from '../../components/Pickers'
import type { LineInput } from '../../lib/docs'
import { useDocEditor } from './useDocEditor'
import { DocShell } from './DocShell'

interface CompRow { key: number; item_id: string | null; qty: string }

/** Παραγωγή: προϊόν + ποσότητα, με ανάλωση συστατικών από τη συνταγή (τροποποιήσιμη) */
export function ProductionDoc() {
  const { id } = useParams()
  const isNew = !id || id === 'new'
  const { itemById } = useMaster()

  const ed = useDocEditor({ docType: 'production', isNew, id, initialFields: () => ({ doc_date: today() }) })
  const { doc, lines, loading, saving, posting } = ed

  const [date, setDate] = useState(today())
  const [outputId, setOutputId] = useState<string | null>(null)
  const [outQty, setOutQty] = useState('')
  const [notes, setNotes] = useState('')
  const [comps, setComps] = useState<CompRow[]>([])
  const [seq, setSeq] = useState(1)
  const [autoScaled, setAutoScaled] = useState(true) // αν true, κλιμακώνουμε τη συνταγή αυτόματα
  const posted = doc?.status === 'posted'

  const nextKey = () => { const k = seq; setSeq(seq + 1); return k }

  useEffect(() => {
    if (!doc) return
    setDate(doc.doc_date); setNotes(doc.notes ?? '')
    const out = lines.find((l) => l.role === 'output')
    const ins = lines.filter((l) => l.role === 'input')
    setOutputId(out?.item_id ?? null)
    setOutQty(out ? String(out.qty) : '')
    setComps(ins.map((l, i) => ({ key: i + 1, item_id: l.item_id, qty: String(l.qty) })))
    setSeq(ins.length + 1)
    setAutoScaled(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.id, doc?.status])

  // Φόρτωση συνταγής όταν αλλάζει προϊόν (σε νέο/πρόχειρο)
  const loadRecipe = async (itemId: string | null, qty: number) => {
    if (!itemId) { setComps([]); return }
    const { data: b } = await supabase.from('bom').select('*').eq('item_id', itemId).eq('is_default', true).eq('is_active', true).maybeSingle()
    if (!b) { setComps([]); return }
    const bom = b as Bom
    const { data: bl } = await supabase.from('bom_line').select('*').eq('bom_id', bom.id).order('line_no')
    const factor = qty > 0 && bom.output_qty > 0 ? qty / bom.output_qty : 1
    setComps(((bl ?? []) as BomLine[]).map((l, i) => ({ key: i + 1, item_id: l.component_item_id, qty: String(round(l.qty * factor, 4)) })))
    setSeq((bl ?? []).length + 1)
    setAutoScaled(true)
  }

  // Όταν αλλάζει η ποσότητα παραγωγής και είμαστε σε auto mode, ξανακλιμακώνουμε
  const onQtyChange = async (v: string) => {
    setOutQty(v)
    if (autoScaled && outputId) await loadRecipe(outputId, toNum(v))
  }

  const outItem = outputId ? itemById.get(outputId) : null
  const baseCost = useMemo(() => comps.reduce((s, c) => {
    const it = c.item_id ? itemById.get(c.item_id) : null
    return s + (it ? toNum(c.qty) * Number(it.avg_cost) : 0)
  }, 0), [comps, itemById])
  const unitCost = toNum(outQty) > 0 ? baseCost / toNum(outQty) : 0

  const validComps = comps.filter((c) => c.item_id && toNum(c.qty) > 0)
  const canSave = !!outputId && toNum(outQty) > 0 && validComps.length > 0

  const buildFields = (): Partial<Doc> => ({ doc_date: date, notes: notes.trim() || null })
  const buildLines = (): LineInput[] => [
    { line_no: 1, role: 'output', item_id: outputId!, qty: toNum(outQty) },
    ...validComps.map((c, i) => ({ line_no: i + 2, role: 'input' as const, item_id: c.item_id!, qty: toNum(c.qty) })),
  ]

  if (loading) return <Spinner />

  return (
    <DocShell
      docType="production" doc={doc} isNew={isNew} saving={saving} posting={posting} canSave={canSave}
      onSave={() => ed.saveDraft(buildFields(), buildLines(), { navigate: true })}
      onPost={() => ed.post(buildFields(), buildLines())}
      onUnpost={ed.unpost}
      onDelete={ed.remove}
    >
      <ErrorBox text={ed.error} />
      <div className="card p-4 mb-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4 items-end">
        <Field label="Ημερομηνία"><input type="date" className="input" value={date} disabled={posted} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Προϊόν (ημιέτοιμο ή έτοιμο)" className="lg:col-span-2">
          <ItemPicker value={outputId} types={['semi', 'finished']} disabled={posted}
            onChange={(v) => { setOutputId(v); loadRecipe(v, toNum(outQty)) }} />
        </Field>
        <Field label={`Ποσότητα ${outItem ? '(' + outItem.unit + ')' : ''}`}>
          <NumInput value={outQty} disabled={posted} onChange={onQtyChange} min={0} />
        </Field>
      </div>

      {!posted && outItem?.item_type === 'semi' && outItem.make_to_order && (
        <div className="rounded-md bg-amber-50 border border-amber-200 text-amber-900 text-sm px-3 py-2 mb-3">
          Το «{outItem.name}» γίνεται ήδη αυτόματα όταν το χρειάζεται μια πώληση ή παραγωγή. Πέρασε παραγωγή μόνο αν φτιάξατε απόθεμα από πριν.
        </div>
      )}

      <div className="card overflow-x-auto">
        <div className="flex items-center justify-between px-3 pt-3">
          <h2 className="font-semibold text-sm">Αναλώσεις (συστατικά)</h2>
          {!posted && outputId && (
            <button className="btn-ghost text-xs" onClick={() => loadRecipe(outputId, toNum(outQty))}>↻ Επαναφορά από συνταγή</button>
          )}
        </div>
        <table className="tbl mt-2">
          <thead><tr><th className="min-w-[14rem]">Συστατικό</th><th className="num w-28">Ποσότητα</th><th className="num w-28">Κόστος</th>{!posted && <th className="w-8"></th>}</tr></thead>
          <tbody>
            {comps.map((c, idx) => {
              const it = c.item_id ? itemById.get(c.item_id) : null
              return (
                <tr key={c.key}>
                  <td>
                    <ItemPicker value={c.item_id} types={outItem?.item_type === 'semi' ? ['raw'] : ['raw', 'semi']} disabled={posted}
                      onChange={(v) => setComps((cs) => { setAutoScaled(false); return cs.map((x, i) => i === idx ? { ...x, item_id: v } : x) })} />
                    {it && <div className="text-xs text-stone-500 mt-0.5">{it.unit} · μέσο κόστος {fmtCost(it.avg_cost)}</div>}
                  </td>
                  <td><NumInput value={c.qty} disabled={posted} onChange={(v) => setComps((cs) => { setAutoScaled(false); return cs.map((x, i) => i === idx ? { ...x, qty: v } : x) })} /></td>
                  <td className="num text-xs">{it ? fmtCost(toNum(c.qty) * Number(it.avg_cost)) : ''}</td>
                  {!posted && <td><button className="btn-ghost px-2 py-1" onClick={() => setComps((cs) => cs.filter((_, i) => i !== idx))}>✕</button></td>}
                </tr>
              )
            })}
          </tbody>
        </table>
        {!posted && <div className="p-3"><button className="btn-secondary" onClick={() => setComps((cs) => [...cs, { key: nextKey(), item_id: null, qty: '' }])}>+ Συστατικό</button></div>}
      </div>

      <div className="flex flex-col items-end gap-1 mt-3 text-sm">
        <div>Συνολικό κόστος: <b className="tabular-nums">{fmtCost(round(baseCost, 4))}</b></div>
        <div className="text-base">Κόστος ανά {outItem?.unit ?? 'μονάδα'}: <b className="tabular-nums">{fmtCost(round(unitCost, 4))}</b></div>
      </div>

      <div className="card p-4 mt-3">
        <Field label="Σημειώσεις"><textarea className="input" rows={2} value={notes} disabled={posted} onChange={(e) => setNotes(e.target.value)} /></Field>
      </div>
    </DocShell>
  )
}
