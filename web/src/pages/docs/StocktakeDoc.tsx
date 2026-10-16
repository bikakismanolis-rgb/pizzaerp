import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMaster } from '../../context/MasterData'
import { errMsg, supabase } from '../../lib/supabase'
import type { Doc, ItemType, StockBalance } from '../../lib/types'
import { COUNT_MOMENT, ITEM_TYPE_LABEL } from '../../lib/labels'
import { fmtDate, fmtMoney, fmtQty, toNum, today } from '../../lib/format'
import { Confirm, ErrorBox, Field, NumInput, Spinner, useToast } from '../../components/ui'
import type { LineInput } from '../../lib/docs'
import { useDocEditor } from './useDocEditor'
import { DocShell } from './DocShell'

interface Row { item_id: string; counted: string; include: boolean }

/** doc_line.stock_cut (0004): η στιγμή που μετρήθηκε το είδος από το «Πες το» */
type CutLine = { item_id: string; stock_cut?: number | null }

/**
 * Απογραφή: λίστα ειδών με μετρημένη ποσότητα. Στα καταχωρημένα δείχνει
 * αναμενόμενο / μετρημένο / διαφορά / αξία.
 */
export function StocktakeDoc() {
  const { id } = useParams()
  const isNew = !id || id === 'new'
  const { items, itemById } = useMaster()
  const nav = useNavigate()
  const toast = useToast()

  const ed = useDocEditor({ docType: 'stocktake', isNew, id, initialFields: () => ({ doc_date: today() }) })
  const { doc, lines, loading, saving, posting } = ed
  const posted = doc?.status === 'posted'

  const [date, setDate] = useState(today())
  const [notes, setNotes] = useState('')
  const [typeFilter, setTypeFilter] = useState<ItemType | ''>('')
  const [rows, setRows] = useState<Map<string, Row>>(new Map())
  const [expected, setExpected] = useState<Map<string, number>>(new Map())
  // απογραφή σε εξέλιξη: είδος που βγαίνει (για διόρθωση κίνησης πριν από τη μέτρηση)
  const [askOut, setAskOut] = useState<{ itemId: string; text: string } | null>(null)

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
  }, [doc?.id, doc?.status, ed.ver])

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
  // είδη που μετρήθηκαν από το «Πες το»: κρατούν τη στιγμή της μέτρησης και μετά από αλλαγή με το χέρι
  const cuts = new Map((lines as CutLine[]).filter((l) => l.stock_cut != null).map((l) => [l.item_id, Number(l.stock_cut)]))
  const buildLines = (): LineInput[] => countedRows.map((r, i) => ({
    line_no: i + 1, role: 'item', item_id: r.item_id, qty: toNum(r.counted),
    ...(cuts.has(r.item_id) ? { stock_cut: cuts.get(r.item_id)! } : {}),
  }))

  /**
   * Βγάζει ένα είδος από την απογραφή σε εξέλιξη (η μέτρηση και η στιγμή της
   * σβήνονται): μετά διορθώνεται ό,τι ήταν πριν από τη μέτρηση και το είδος
   * ξαναμετριέται. Η απογραφή μένει σε εξέλιξη (ή σβήνεται, αν άδειασε).
   */
  const takeOut = async (itemId: string) => {
    setAskOut(null)
    if (!doc) return
    try {
      const { data, error } = await supabase.rpc('stocktake_count', { p_company: ed.companyId, p_date: doc.doc_date, p_item: itemId, p_qty: null })
      if (error) throw error
      toast.ok(`Βγήκε το «${itemById.get(itemId)?.name ?? ''}». Μέτρησέ το ξανά όταν διορθώσεις ό,τι χρειάζεται.`)
      if (!data) nav('/docs/stocktake')
      else await ed.reload()
    } catch (e) { ed.setError(errMsg(e)); toast.err(errMsg(e)) }
  }

  if (loading) return <Spinner />

  // Απογραφή σε εξέλιξη: γεμίζει από το «Πες το» (και από άλλες συσκευές), άρα
  // μόνο προβολή· καταχώρηση όπως είναι στη βάση, όχι με τις γραμμές της οθόνης
  if (ed.runningOpen && doc) {
    return (
      <DocShell docType="stocktake" doc={doc} isNew={false} saving={saving} posting={posting} canSave={false}
        onSave={() => {}} onPost={() => {}} onUnpost={ed.unpost} onDelete={ed.remove}
        running={{ what: `οι μετρήσεις της απογραφής ${fmtDate(doc.doc_date)}`, onPost: ed.postRunning, onDetach: ed.detachRunning }}>
        <ErrorBox text={ed.error} />
        <div className="rounded-md bg-amber-50 border border-amber-200 text-amber-900 text-sm px-3 py-2 mb-3">
          Απογραφή σε εξέλιξη ({fmtDate(doc.doc_date)}): γεμίζει από το <Link className="underline" to="/voice">Πες το</Link>{' '}
          (π.χ. «μέτρησα μοτσαρέλα έξι κιλά»), γι' αυτό εδώ μόνο φαίνεται. Για αλλαγές με το χέρι: «Χειροκίνητη επεξεργασία».
        </div>
        <CountNote running />
        <div className="card overflow-x-auto">
          <table className="tbl">
            <thead><tr><th>Είδος</th><th className="hidden sm:table-cell">Τύπος</th><th className="hidden sm:table-cell">Μον.</th><th className="num hidden sm:table-cell">Υπόλοιπο τώρα</th><th className="num">Μετρημένο</th><th></th></tr></thead>
            <tbody>
              {lines.map((l) => {
                const it = itemById.get(l.item_id)
                return (
                  <tr key={l.id}>
                    <td>{it?.name}</td>
                    <td className="hidden sm:table-cell">{it && ITEM_TYPE_LABEL[it.item_type]}</td>
                    <td className="hidden sm:table-cell">{it?.unit}</td>
                    <td className="num text-stone-500 hidden sm:table-cell">{fmtQty(expected.get(l.item_id) ?? 0)}</td>
                    <td className="num font-semibold whitespace-nowrap">{fmtQty(l.qty)}<span className="sm:hidden font-normal text-stone-500"> {it?.unit}</span></td>
                    <td className="text-right">
                      <button type="button" className="btn-ghost h-9 px-2 text-sm" aria-label={`Βγάλε ${it?.name ?? ''}`}
                        onClick={() => setAskOut({ itemId: l.item_id, text: `${it?.name ?? ''}: ${fmtQty(l.qty)} ${it?.unit ?? ''}` })}>Βγάλε</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-stone-500 mt-2">
          {lines.length} {lines.length === 1 ? 'είδος' : 'είδη'} μετρημένα μέχρι τώρα. Για διόρθωση κίνησης που έγινε πριν από τη
          μέτρηση ενός είδους (π.χ. λάθος παραλαβή): «Βγάλε» το είδος, διόρθωσε την κίνηση και μέτρησέ το ξανά.
        </p>
        <Confirm open={!!askOut} title="Να βγει από την απογραφή;"
          text={`${askOut?.text ?? ''}. Η μέτρηση σβήνεται· όταν το ξαναμετρήσεις, μετράει από εκείνη τη στιγμή.`}
          onYes={() => askOut && takeOut(askOut.itemId)} onNo={() => setAskOut(null)} danger />
      </DocShell>
    )
  }

  // Καταχωρημένη προβολή: από τις γραμμές
  if (posted) {
    return (
      <DocShell docType="stocktake" doc={doc} isNew={false} saving={saving} posting={posting} canSave={false}
        onSave={() => {}} onPost={() => {}} onUnpost={ed.unpost} onDelete={ed.remove}>
        <ErrorBox text={ed.error} />
        <div className="mb-3 text-sm text-stone-600">Ημερομηνία: {fmtDate(date)}</div>
        <div className="card overflow-x-auto">
          <table className="tbl">
            <thead><tr><th>Είδος</th><th className="hidden sm:table-cell">Τύπος</th><th className="num">Αναμενόμενο</th><th className="num">Μετρημένο</th><th className="num">Διαφορά</th><th className="num">Αξία διαφοράς</th></tr></thead>
            <tbody>
              {lines.map((l) => {
                const it = itemById.get(l.item_id)
                const diff = Number(l.diff_qty ?? 0)
                return (
                  <tr key={l.id}>
                    <td>{it?.name}</td>
                    <td className="hidden sm:table-cell">{it && ITEM_TYPE_LABEL[it.item_type]}</td>
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

      <CountNote date={date} />

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

/**
 * Η μέτρηση μετράει «τη στιγμή που γίνεται»: από το «Πες το» τη στιγμή που
 * ειπώθηκε κάθε είδος, από εδώ (με το χέρι) τη στιγμή της καταχώρησης. Ό,τι
 * πουληθεί ή φτιαχτεί μετά μετράει για μετά· κλειδώνουν μόνο όσα ήταν πριν.
 */
function CountNote({ date, running }: { date?: string; running?: boolean }) {
  return (
    <div className="rounded-md border text-sm px-3 py-2 mb-3 bg-stone-50 border-stone-200 text-stone-600">
      {running ? COUNT_MOMENT : (
        <>
          Η μέτρηση μετράει τη στιγμή της καταχώρησης: πρώτα καταχωρούνται οι ανοιχτές πωλήσεις ημέρας ως τότε που κινούν τα
          μετρημένα είδη. Ό,τι πουληθεί ή φτιαχτεί μετά, μετράει για μετά.
          {date && date < today() && <> Με παλιότερη ημερομηνία ({fmtDate(date)}) μετράει στο τέλος εκείνης της μέρας.</>}
          {' '}Κινήσεις πριν από τη μέτρηση δεν αλλάζουν μετά (κλειδώνουν).
        </>
      )}
    </div>
  )
}
