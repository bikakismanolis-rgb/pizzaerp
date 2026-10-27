import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useMaster } from '../../context/MasterData'
import { supabase } from '../../lib/supabase'
import type { Doc, DocType } from '../../lib/types'
import { CHANNEL_LABEL } from '../../lib/labels'
import { fmtCost, fmtDate, fmtMoney, round, toNum, today } from '../../lib/format'
import { ErrorBox, Field, NumInput, Spinner } from '../../components/ui'
import { ItemPicker, PartnerPicker } from '../../components/Pickers'
import type { LineInput } from '../../lib/docs'
import { useDocEditor } from './useDocEditor'
import { DocShell } from './DocShell'

interface Row { key: number; item_id: string | null; qty: string; unit_price: string; discount_pct: string; vat_rate: string }

/** Αγορά ή Πώληση: κοινή δομή με γραμμές (είδος, ποσότητα, τιμή, ΦΠΑ) */
export function TradeDoc({ docType }: { docType: DocType }) {
  const { id } = useParams()
  const isNew = !id || id === 'new'
  const isSale = docType === 'sale'
  const { itemById } = useMaster()

  const ed = useDocEditor({ docType, isNew, id, initialFields: () => ({ doc_date: today() }) })
  const { doc, lines, loading, saving, posting } = ed

  const [date, setDate] = useState(today())
  const [partnerId, setPartnerId] = useState<string | null>(null)
  const [channel, setChannel] = useState<Doc['channel']>(isSale ? 'wholesale' : null)
  const [refNo, setRefNo] = useState('')
  const [notes, setNotes] = useState('')
  const [rows, setRows] = useState<Row[]>([])
  const [seq, setSeq] = useState(1)
  const posted = doc?.status === 'posted'
  // ανοιχτές πωλήσεις ημέρας: μόνο προβολή (οι γραμμές αλλάζουν από άλλες οθόνες/συσκευές)
  const running = ed.runningOpen
  const locked = posted || running

  const nextKey = () => { const k = seq; setSeq(seq + 1); return k }
  const addRow = () => setRows((r) => [...r, { key: nextKey(), item_id: null, qty: '', unit_price: '', discount_pct: '0', vat_rate: '13' }])

  // αρχικοποίηση από φορτωμένο παραστατικό
  useEffect(() => {
    // μία κενή γραμμή σε νέο (ασφαλές και όταν το effect τρέχει δύο φορές)
    if (!doc) { const k = nextKey(); setRows((r) => r.length ? r : [{ key: k, item_id: null, qty: '', unit_price: '', discount_pct: '0', vat_rate: '13' }]); return }
    setDate(doc.doc_date); setPartnerId(doc.partner_id); setChannel(doc.channel); setRefNo(doc.ref_no ?? ''); setNotes(doc.notes ?? '')
    const itemRows = lines.filter((l) => l.role === 'item')
    setRows(itemRows.map((l, i) => ({ key: i + 1, item_id: l.item_id, qty: String(l.qty), unit_price: String(l.unit_price), discount_pct: String(l.discount_pct), vat_rate: String(l.vat_rate) })))
    setSeq(itemRows.length + 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.id, doc?.status, ed.ver])

  // Στην πώληση: όταν αλλάζει είδος ή πελάτης, φέρε τιμή πελάτη
  const applyPrice = async (rowKey: number, itemId: string | null) => {
    if (!isSale || !itemId) return
    const { data } = await supabase.rpc('item_price_for', { p_item: itemId, p_partner: partnerId })
    const price = data as number | null
    const it = itemById.get(itemId)
    setRows((rs) => rs.map((r) => r.key === rowKey ? { ...r, unit_price: price != null ? String(price) : r.unit_price, vat_rate: it ? String(it.vat_rate) : r.vat_rate } : r))
  }

  const setCost = (rowKey: number, itemId: string | null) => {
    // Στην αγορά προτείνουμε το τρέχον μέσο κόστος ως τιμή, τον ΦΠΑ του είδους
    const it = itemId ? itemById.get(itemId) : null
    setRows((rs) => rs.map((r) => r.key === rowKey ? {
      ...r,
      vat_rate: it ? String(it.vat_rate) : r.vat_rate,
      unit_price: !isSale && it && (!r.unit_price || r.unit_price === '0') && it.avg_cost ? String(it.avg_cost) : r.unit_price,
    } : r))
  }

  const totals = useMemo(() => {
    let net = 0, vat = 0
    for (const r of rows) {
      const line = toNum(r.qty) * toNum(r.unit_price) * (1 - toNum(r.discount_pct) / 100)
      net += line
      vat += line * toNum(r.vat_rate) / 100
    }
    return { net: round(net), vat: round(vat), gross: round(net + vat) }
  }, [rows])

  const validRows = rows.filter((r) => r.item_id && toNum(r.qty) > 0)
  const canSave = validRows.length > 0 && (!isSale ? !!partnerId : true)

  const buildFields = (): Partial<Doc> => ({
    doc_date: date,
    partner_id: partnerId,
    channel: isSale ? channel : null,
    ref_no: refNo.trim() || null,
    notes: notes.trim() || null,
  })
  const buildLines = (): LineInput[] => validRows.map((r, i) => ({
    line_no: i + 1, role: 'item', item_id: r.item_id!, qty: toNum(r.qty),
    unit_price: toNum(r.unit_price), discount_pct: toNum(r.discount_pct), vat_rate: toNum(r.vat_rate),
  }))

  if (loading) return <Spinner />

  const pickerTypes = isSale ? (['finished'] as const) : undefined

  return (
    <DocShell
      docType={docType} doc={doc} isNew={isNew} saving={saving} posting={posting} canSave={canSave}
      onSave={() => ed.saveDraft(buildFields(), buildLines(), { navigate: true })}
      onPost={() => ed.post(buildFields(), buildLines())}
      onUnpost={ed.unpost}
      onDelete={ed.remove}
      running={running ? { what: `οι πωλήσεις ημέρας ${doc?.channel ? CHANNEL_LABEL[doc.channel] : ''} της ${fmtDate(date)}`, onPost: ed.postRunning, onDetach: ed.detachRunning } : null}
    >
      <ErrorBox text={ed.error} />
      {running && (
        <div className="rounded-md bg-amber-50 border border-amber-200 text-amber-900 text-sm px-3 py-2 mb-3">
          Πωλήσεις ημέρας σε εξέλιξη: γεμίζουν από τις <Link className="underline" to="/daily-sales">Πωλήσεις ημέρας</Link> και
          το <Link className="underline" to="/voice">Πες το</Link>, γι' αυτό εδώ μόνο φαίνονται. Κλείνουν με «Κλείσιμο ημέρας»
          ή αυτόματα την επόμενη μέρα. Για αλλαγή τιμής ή γραμμών: «Χειροκίνητη επεξεργασία».
        </div>
      )}
      <div className="card p-4 mb-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Ημερομηνία"><input type="date" className="input" value={date} disabled={locked} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label={isSale ? 'Πελάτης' : 'Προμηθευτής'} className={isSale ? '' : 'lg:col-span-2'}>
          <PartnerPicker kind={isSale ? 'customer' : 'supplier'} value={partnerId} disabled={locked}
            onChange={(v) => { setPartnerId(v); if (isSale) rows.forEach((r) => applyPrice(r.key, r.item_id)) }} />
        </Field>
        {isSale && (
          <Field label="Κανάλι">
            <select className="input" value={channel ?? ''} disabled={locked} onChange={(e) => setChannel(e.target.value as Doc['channel'])}>
              {(['wholesale', 'efood', 'wolt', 'box', 'phone', 'store'] as const).map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>)}
              {/* το site το γράφει μόνο η αποδοχή online παραγγελίας */}
              {channel === 'site' && <option value="site">{CHANNEL_LABEL.site}</option>}
            </select>
          </Field>
        )}
        {!isSale && <Field label="Αρ. παραστατικού προμηθευτή"><input className="input" value={refNo} disabled={locked} onChange={(e) => setRefNo(e.target.value)} /></Field>}
      </div>

      <div className="card overflow-x-auto">
        <table className="tbl">
          <thead>
            <tr>
              <th className="min-w-[14rem]">Είδος</th>
              <th className="num w-24">Ποσότητα</th>
              <th className="num w-28">{isSale ? 'Τιμή' : 'Κόστος/μον.'}</th>
              <th className="num w-20">Έκπτ.%</th>
              <th className="num w-20">ΦΠΑ%</th>
              <th className="num w-28">Καθαρή</th>
              {!locked && <th className="w-8"></th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, idx) => {
              const it = r.item_id ? itemById.get(r.item_id) : null
              const net = toNum(r.qty) * toNum(r.unit_price) * (1 - toNum(r.discount_pct) / 100)
              return (
                <tr key={r.key}>
                  <td>
                    <ItemPicker value={r.item_id} types={pickerTypes as unknown as undefined} disabled={locked}
                      onChange={(v) => { setRows((rs) => rs.map((x, i) => i === idx ? { ...x, item_id: v } : x)); if (isSale) applyPrice(r.key, v); else setCost(r.key, v) }} />
                    {it && <div className="text-xs text-stone-500 mt-0.5">{it.unit}{!isSale && ` · μέσο κόστος ${fmtCost(it.avg_cost)}`}</div>}
                  </td>
                  <td><NumInput value={r.qty} disabled={locked} onChange={(v) => setRows((rs) => rs.map((x, i) => i === idx ? { ...x, qty: v } : x))} /></td>
                  <td><NumInput value={r.unit_price} disabled={locked} onChange={(v) => setRows((rs) => rs.map((x, i) => i === idx ? { ...x, unit_price: v } : x))} /></td>
                  <td><NumInput value={r.discount_pct} disabled={locked} onChange={(v) => setRows((rs) => rs.map((x, i) => i === idx ? { ...x, discount_pct: v } : x))} /></td>
                  <td><NumInput value={r.vat_rate} disabled={locked} onChange={(v) => setRows((rs) => rs.map((x, i) => i === idx ? { ...x, vat_rate: v } : x))} /></td>
                  <td className="num">{fmtMoney(net)}</td>
                  {!locked && <td><button className="btn-ghost px-2 py-1" onClick={() => setRows((rs) => rs.filter((_, i) => i !== idx))}>✕</button></td>}
                </tr>
              )
            })}
          </tbody>
        </table>
        {!locked && <div className="p-3"><button className="btn-secondary" onClick={addRow}>+ Γραμμή</button></div>}
      </div>

      <div className="flex flex-col items-end gap-1 mt-3 text-sm">
        <div>Καθαρή αξία: <b className="tabular-nums">{fmtMoney(totals.net)}</b></div>
        <div>ΦΠΑ: <b className="tabular-nums">{fmtMoney(totals.vat)}</b></div>
        <div className="text-base">Σύνολο: <b className="tabular-nums">{fmtMoney(totals.gross)}</b></div>
      </div>

      <div className="card p-4 mt-3">
        <Field label="Σημειώσεις"><textarea className="input" rows={2} value={notes} disabled={locked} onChange={(e) => setNotes(e.target.value)} /></Field>
      </div>
    </DocShell>
  )
}
