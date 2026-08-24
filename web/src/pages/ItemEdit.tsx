import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useCompanyId } from '../context/CompanyContext'
import { useMaster } from '../context/MasterData'
import { errMsg, supabase } from '../lib/supabase'
import type { Bom, BomLine, Item, ItemType } from '../lib/types'
import { ITEM_TYPE_LABEL, UNITS, VAT_RATES } from '../lib/labels'
import { fmtCost, round, toNum } from '../lib/format'
import { Confirm, ErrorBox, Field, NumInput, PageTitle, Spinner, useToast } from '../components/ui'
import { ItemPicker } from '../components/Pickers'

interface BomLineDraft { key: number; component_item_id: string | null; qty: string }

const emptyItem = (company_id: string): Omit<Item, 'id'> => ({
  company_id, code: '', name: '', item_type: 'raw', category: null, unit: 'kg', vat_rate: 13, sale_price: 0,
  avg_cost: 0, make_to_order: false, pack_name: null, pack_qty: null, min_stock: null, is_active: true, notes: null,
})

export function ItemEdit() {
  const { id } = useParams()
  const isNew = !id || id === 'new'
  const companyId = useCompanyId()
  const nav = useNavigate()
  const toast = useToast()
  const { items, itemById, refresh } = useMaster()

  const [item, setItem] = useState<Omit<Item, 'id'> & { id?: string }>(emptyItem(companyId))
  const [bom, setBom] = useState<{ id?: string; output_qty: string; name: string }>({ output_qty: '1', name: 'Βασική' })
  const [lines, setLines] = useState<BomLineDraft[]>([])
  const [loading, setLoading] = useState(!isNew)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [askDelete, setAskDelete] = useState(false)
  const [seq, setSeq] = useState(1)

  const newLine = (): BomLineDraft => { setSeq((s) => s + 1); return { key: seq, component_item_id: null, qty: '' } }

  useEffect(() => {
    if (isNew) return
    let alive = true
    ;(async () => {
      setLoading(true)
      const { data: it, error: e1 } = await supabase.from('item').select('*').eq('id', id).single()
      if (e1) { setError(errMsg(e1)); setLoading(false); return }
      const { data: b } = await supabase.from('bom').select('*').eq('item_id', id).eq('is_default', true).eq('is_active', true).maybeSingle()
      let bl: BomLine[] = []
      if (b) {
        const { data } = await supabase.from('bom_line').select('*').eq('bom_id', (b as Bom).id).order('line_no')
        bl = (data ?? []) as BomLine[]
      }
      if (!alive) return
      setItem(it as Item)
      if (b) setBom({ id: (b as Bom).id, output_qty: String((b as Bom).output_qty), name: (b as Bom).name })
      setLines(bl.map((l, i) => ({ key: i + 1, component_item_id: l.component_item_id, qty: String(l.qty) })))
      setSeq(bl.length + 1)
      setLoading(false)
    })()
    return () => { alive = false }
  }, [id, isNew])

  const set = <K extends keyof Item>(k: K, v: Item[K]) => setItem((s) => ({ ...s, [k]: v }))
  const hasBom = item.item_type !== 'raw'

  // Εκτίμηση κόστους συνταγής από τα τρέχοντα μέσα κόστη
  const outQty = toNum(bom.output_qty)
  const bomCost = lines.reduce((sum, l) => {
    const c = l.component_item_id ? itemById.get(l.component_item_id) : null
    return sum + (c ? toNum(l.qty) * Number(c.avg_cost) : 0)
  }, 0)
  const unitCostEstimate = outQty > 0 ? bomCost / outQty : 0

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const payload = {
        company_id: companyId,
        code: item.code.trim(),
        name: item.name.trim(),
        item_type: item.item_type,
        category: item.category?.trim() || null,
        unit: item.unit,
        vat_rate: toNum(item.vat_rate),
        sale_price: toNum(item.sale_price),
        make_to_order: item.item_type === 'finished' ? item.make_to_order : false,
        pack_name: item.pack_name?.trim() || null,
        pack_qty: item.pack_qty ? toNum(item.pack_qty) : null,
        min_stock: item.min_stock !== null && item.min_stock !== undefined && String(item.min_stock) !== '' ? toNum(item.min_stock) : null,
        is_active: item.is_active,
        notes: item.notes?.trim() || null,
      }
      let itemId = item.id
      if (isNew) {
        const { data, error: er } = await supabase.from('item').insert(payload).select('id').single()
        if (er) throw er
        itemId = (data as { id: string }).id
      } else {
        const { error: er } = await supabase.from('item').update(payload).eq('id', itemId!)
        if (er) throw er
      }

      if (hasBom) {
        const validLines = lines.filter((l) => l.component_item_id && toNum(l.qty) > 0)
        if (validLines.length > 0) {
          let bomId = bom.id
          const bomPayload = { company_id: companyId, item_id: itemId!, name: bom.name || 'Βασική', output_qty: outQty > 0 ? outQty : 1, is_default: true, is_active: true }
          if (bomId) {
            const { error: er } = await supabase.from('bom').update(bomPayload).eq('id', bomId)
            if (er) throw er
            const { error: ed } = await supabase.from('bom_line').delete().eq('bom_id', bomId)
            if (ed) throw ed
          } else {
            const { data, error: er } = await supabase.from('bom').insert(bomPayload).select('id').single()
            if (er) throw er
            bomId = (data as { id: string }).id
          }
          const { error: el } = await supabase.from('bom_line').insert(
            validLines.map((l, i) => ({ company_id: companyId, bom_id: bomId, line_no: i + 1, component_item_id: l.component_item_id, qty: toNum(l.qty) })),
          )
          if (el) throw el
        } else if (bom.id) {
          // αφαιρέθηκαν όλες οι γραμμές: απενεργοποίηση συνταγής
          await supabase.from('bom').update({ is_active: false, is_default: false }).eq('id', bom.id)
        }
      }
      await refresh()
      toast.ok('Αποθηκεύτηκε')
      nav('/items')
    } catch (err) {
      setError(errMsg(err))
    } finally {
      setBusy(false)
    }
  }

  const doDelete = async () => {
    setAskDelete(false)
    setBusy(true)
    const { error: er } = await supabase.from('item').delete().eq('id', item.id!)
    setBusy(false)
    if (er) {
      setError('Δεν διαγράφεται γιατί έχει κινήσεις ή χρησιμοποιείται σε συνταγή. Μπορείς να το κάνεις ανενεργό. (' + errMsg(er) + ')')
      return
    }
    await refresh()
    toast.ok('Διαγράφηκε')
    nav('/items')
  }

  if (loading) return <Spinner />

  const allowedComponentTypes: ItemType[] = item.item_type === 'semi' ? ['raw'] : ['raw', 'semi']
  // δεν επιτρέπεται το ίδιο το είδος ως συστατικό
  const componentItems = items.filter((i) => i.id !== item.id)

  return (
    <form onSubmit={submit}>
      <PageTitle title={isNew ? 'Νέο είδος' : item.name}>
        <Link to="/items" className="btn-secondary">Πίσω</Link>
        {!isNew && <button type="button" className="btn-danger" onClick={() => setAskDelete(true)} disabled={busy}>Διαγραφή</button>}
        <button className="btn-primary" disabled={busy || !item.code.trim() || !item.name.trim()}>Αποθήκευση</button>
      </PageTitle>
      <ErrorBox text={error} />

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card p-4 grid gap-3 sm:grid-cols-2 content-start">
          <Field label="Τύπος">
            <select className="input" value={item.item_type} onChange={(e) => {
              const t = e.target.value as ItemType
              set('item_type', t)
              if (t === 'raw') set('unit', 'kg'); else set('unit', 'τεμ')
            }} disabled={!isNew}>
              {(['raw', 'semi', 'finished'] as ItemType[]).map((t) => <option key={t} value={t}>{ITEM_TYPE_LABEL[t]}</option>)}
            </select>
          </Field>
          <Field label="Κωδικός">
            <input className="input" required value={item.code} onChange={(e) => set('code', e.target.value)} placeholder={item.item_type === 'raw' ? 'π.χ. ΠΥ-001' : item.item_type === 'semi' ? 'π.χ. ΗΜ-001' : 'π.χ. ΠΡ-001'} />
          </Field>
          <Field label="Όνομα" className="sm:col-span-2">
            <input className="input" required value={item.name} onChange={(e) => set('name', e.target.value)} autoFocus={isNew} />
          </Field>
          <Field label="Κατηγορία (προαιρετικό)">
            <input className="input" value={item.category ?? ''} onChange={(e) => set('category', e.target.value)} placeholder="π.χ. Τυριά, Αλλαντικά, Πίτσες" />
          </Field>
          <Field label="Μονάδα μέτρησης">
            <select className="input" value={item.unit} onChange={(e) => set('unit', e.target.value)}>
              {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          </Field>
          <Field label="ΦΠΑ %">
            <select className="input" value={item.vat_rate} onChange={(e) => set('vat_rate', toNum(e.target.value))}>
              {VAT_RATES.map((v) => <option key={v} value={v}>{v}%</option>)}
            </select>
          </Field>
          {item.item_type === 'finished' && (
            <Field label="Τιμή πώλησης (γενική, χωρίς ΦΠΑ)">
              <NumInput value={item.sale_price} onChange={(v) => set('sale_price', v as unknown as number)} min={0} />
            </Field>
          )}
          {item.item_type === 'finished' && (
            <label className="text-sm flex items-center gap-2 sm:col-span-2 mt-1">
              <input type="checkbox" checked={item.make_to_order} onChange={(e) => set('make_to_order', e.target.checked)} />
              <span>Φτιάχνεται κατά παραγγελία (λιανική): η πώληση καταναλώνει αυτόματα τη συνταγή</span>
            </label>
          )}
          {item.item_type === 'raw' && (
            <>
              <Field label="Συσκευασία αγοράς (προαιρετικό)">
                <input className="input" value={item.pack_name ?? ''} onChange={(e) => set('pack_name', e.target.value)} placeholder="π.χ. σακί" />
              </Field>
              <Field label={`Ποσότητα ανά συσκευασία (${item.unit})`}>
                <NumInput value={item.pack_qty ?? ''} onChange={(v) => set('pack_qty', v as unknown as number)} min={0} />
              </Field>
            </>
          )}
          <Field label={`Ελάχιστο απόθεμα (${item.unit}, προαιρετικό)`}>
            <NumInput value={item.min_stock ?? ''} onChange={(v) => set('min_stock', v as unknown as number)} min={0} />
          </Field>
          {!isNew && (
            <Field label="Μέσο κόστος (υπολογίζεται αυτόματα)">
              <input className="input" disabled value={fmtCost(item.avg_cost) + ' / ' + item.unit} />
            </Field>
          )}
          <Field label="Σημειώσεις" className="sm:col-span-2">
            <textarea className="input" rows={2} value={item.notes ?? ''} onChange={(e) => set('notes', e.target.value)} />
          </Field>
          <label className="text-sm flex items-center gap-2 sm:col-span-2">
            <input type="checkbox" checked={item.is_active} onChange={(e) => set('is_active', e.target.checked)} /> Ενεργό
          </label>
        </div>

        {hasBom && (
          <div className="card p-4">
            <div className="flex items-center justify-between mb-2">
              <h2 className="font-semibold">Συνταγή</h2>
              <div className="text-xs text-stone-500">
                {item.item_type === 'semi' ? 'Ημιέτοιμο: μόνο πρώτες ύλες' : 'Έτοιμο: πρώτες ύλες και ημιέτοιμα'}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 mb-3">
              <Field label="Όνομα συνταγής">
                <input className="input" value={bom.name} onChange={(e) => setBom({ ...bom, name: e.target.value })} />
              </Field>
              <Field label={`Παράγει (${item.unit})`}>
                <NumInput value={bom.output_qty} onChange={(v) => setBom({ ...bom, output_qty: v })} min={0} />
              </Field>
            </div>
            <div className="text-xs text-stone-500 mb-2">
              Οι ποσότητες παρακάτω είναι για {outQty || '?'} {item.unit} προϊόντος. Π.χ. "Ζυμάρι, παράγει 40 τεμ: 6.5 kg αλεύρι, 4 L νερό...".
            </div>
            <table className="tbl">
              <thead><tr><th>Συστατικό</th><th className="num w-28">Ποσότητα</th><th className="num w-24">Κόστος</th><th className="w-8"></th></tr></thead>
              <tbody>
                {lines.map((l, idx) => {
                  const c = l.component_item_id ? itemById.get(l.component_item_id) : null
                  return (
                    <tr key={l.key}>
                      <td>
                        <ItemPicker
                          value={l.component_item_id}
                          types={allowedComponentTypes}
                          onChange={(v) => setLines(lines.map((x, i) => (i === idx ? { ...x, component_item_id: v } : x)))}
                          placeholder="Συστατικό..."
                        />
                        {c && <div className="text-xs text-stone-500 mt-0.5">{c.unit} · μέσο κόστος {fmtCost(c.avg_cost)}</div>}
                      </td>
                      <td><NumInput value={l.qty} onChange={(v) => setLines(lines.map((x, i) => (i === idx ? { ...x, qty: v } : x)))} min={0} /></td>
                      <td className="num text-xs">{c ? fmtCost(toNum(l.qty) * Number(c.avg_cost)) : ''}</td>
                      <td><button type="button" className="btn-ghost px-2 py-1" onClick={() => setLines(lines.filter((_, i) => i !== idx))}>✕</button></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            <div className="flex items-center justify-between mt-3">
              <button type="button" className="btn-secondary" onClick={() => setLines([...lines, newLine()])}
                disabled={componentItems.filter((i) => allowedComponentTypes.includes(i.item_type)).length === 0}>
                + Συστατικό
              </button>
              <div className="text-sm">
                Εκτίμηση κόστους: <b>{fmtCost(bomCost)}</b> / {outQty || '?'} {item.unit} = <b>{fmtCost(round(unitCostEstimate, 4))}</b> ανά {item.unit}
              </div>
            </div>
          </div>
        )}
      </div>

      <Confirm open={askDelete} title="Διαγραφή είδους" text={`Να διαγραφεί το είδος "${item.name}";`} onYes={doDelete} onNo={() => setAskDelete(false)} danger />
    </form>
  )
}
