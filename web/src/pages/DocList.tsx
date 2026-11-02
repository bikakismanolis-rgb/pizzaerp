import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useCompanyId } from '../context/CompanyContext'
import { useLoad } from '../lib/useLoad'
import { supabase } from '../lib/supabase'
import type { DocListRow, DocType } from '../lib/types'
import { CHANNEL_LABEL, DOC_TYPE_LABEL, DOC_TYPE_LABEL_PLURAL, STATUS_LABEL, docCode } from '../lib/labels'
import { fmtDate, fmtMoney, monthStart, round, today } from '../lib/format'
import { Badge, Empty, PageTitle, Spinner, useNarrow } from '../components/ui'

/** Ποιος είναι ο άλλος στο παραστατικό */
const PARTNER_HEAD: Partial<Record<DocType, string>> = {
  purchase: 'Προμηθευτής', payment: 'Προμηθευτής', sale: 'Πελάτης', receipt: 'Πελάτης',
}

/** Το κουμπί «Νέο»: με το όνομα του τι φτιάχνεις */
const NEW_LABEL: Record<DocType, string> = {
  purchase: 'Νέα αγορά', sale: 'Νέα πώληση', production: 'Νέα παραγωγή',
  stocktake: 'Νέα μέτρηση', receipt: 'Νέα είσπραξη', payment: 'Νέα πληρωμή',
}

export function DocList() {
  const { type } = useParams<{ type: DocType }>()
  const docType = type as DocType
  const companyId = useCompanyId()
  const [from, setFrom] = useState(monthStart())
  const [to, setTo] = useState(today())
  const [status, setStatus] = useState<'' | 'draft' | 'posted'>('')
  const narrow = useNarrow()

  const isMoney = docType !== 'production'
  const isTrade = docType === 'purchase' || docType === 'sale'

  const rows = useLoad(async () => {
    const { data, error } = await supabase.from('v_doc_list').select('*').eq('company_id', companyId).eq('doc_type', docType)
      .gte('doc_date', from).lte('doc_date', to).order('doc_no', { ascending: false })
    if (error) throw error
    const list = data as DocListRow[]
    // Το σύνολο γράφεται στην καταχώρηση· για τα ανοιχτά (π.χ. η πώληση
    // ημέρας που μαζεύει όλο το βράδυ) το βγάζουμε από τις γραμμές.
    const open = isTrade ? list.filter((r) => r.status === 'draft').map((r) => r.id) : []
    if (open.length) {
      const lines = await supabase.from('doc_line').select('doc_id, gross').in('doc_id', open)
      if (!lines.error) {
        const sum = new Map<string, number>()
        for (const l of (lines.data ?? []) as { doc_id: string; gross: number }[]) sum.set(l.doc_id, (sum.get(l.doc_id) ?? 0) + Number(l.gross))
        for (const r of list) if (sum.has(r.id)) r.total_gross = round(sum.get(r.id)!, 2)
      }
    }
    return list
  }, [companyId, docType, from, to])

  const list = useMemo(() => (rows.data ?? []).filter((r) => !status || r.status === status), [rows.data, status])

  const partnerHead = PARTNER_HEAD[docType]
  const showChannel = docType === 'sale'
  const showProduced = docType === 'production'

  const amount = (r: DocListRow) => docType === 'receipt' || docType === 'payment' ? (r.amount ?? 0) : (isMoney ? r.total_gross : r.total_net)
  /** Παραγωγή που δεν περάστηκε: το κόστος βγαίνει στην καταχώρηση */
  const amountText = (r: DocListRow) => !isMoney && r.status === 'draft' ? '—' : fmtMoney(amount(r))
  const badge = (r: DocListRow) => (
    r.is_running && r.status === 'draft'
      ? <Badge className="bg-amber-100 text-amber-800">Ανοιχτή, κλείνει απόψε</Badge>
      : <Badge className={r.status === 'posted' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-900'}>{STATUS_LABEL[r.status]}</Badge>
  )
  const who = (r: DocListRow) => [
    partnerHead ? r.partner_name : null,
    showChannel && r.channel ? CHANNEL_LABEL[r.channel] : null,
    showProduced ? r.produced_item_name : null,
  ].filter(Boolean).join(' · ')

  return (
    <div>
      <PageTitle title={DOC_TYPE_LABEL_PLURAL[docType]}>
        <Link to={`/docs/${docType}/new`} className="btn-primary">+ {NEW_LABEL[docType]}</Link>
      </PageTitle>

      <div className="card p-3 mb-3 flex flex-wrap gap-2 items-end">
        <div><label className="label">Από</label><input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div><label className="label">Έως</label><input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        <div><label className="label">Δείξε</label>
          <select className="input" value={status} onChange={(e) => setStatus(e.target.value as '' | 'draft' | 'posted')}>
            <option value="">Όλα</option><option value="draft">Όσα δεν περάστηκαν</option><option value="posted">Όσα περάστηκαν</option>
          </select>
        </div>
      </div>

      {rows.loading ? <div className="card"><Spinner /></div> : list.length === 0 ? <div className="card"><Empty /></div> : (
        narrow ? (
          /* κινητό: κάρτες, όλη η κάρτα πατιέται */
          <ul className="grid gap-2">
            {list.map((r) => (
              <li key={r.id}>
                <Link to={`/docs/${docType}/${r.id}`} className="card p-3 flex items-center gap-3 active:bg-stone-50">
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold">{DOC_TYPE_LABEL[docType]} {docCode(docType, r.doc_no)} <span className="font-normal text-stone-600">· {fmtDate(r.doc_date)}</span></div>
                    {who(r) && <div className="truncate text-stone-700">{who(r)}</div>}
                    <div className="mt-1">{badge(r)}{r.is_auto && <span className="text-sm text-stone-500 ml-1">(μόνο του)</span>}</div>
                  </div>
                  <div className="text-lg font-semibold tabular-nums whitespace-nowrap">{amountText(r)}</div>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <div className="card overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Αριθμός</th><th>Ημερομηνία</th>
                  {partnerHead && <th>{partnerHead}</th>}
                  {showChannel && <th>Από πού</th>}
                  {showProduced && <th>Τι φτιάχτηκε</th>}
                  <th className="num">{isMoney ? 'Ποσό' : 'Κόστος'}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {list.map((r) => (
                  <tr key={r.id}>
                    <td className="whitespace-nowrap">
                      <Link to={`/docs/${docType}/${r.id}`} className="text-red-700 hover:underline font-medium">{docCode(docType, r.doc_no)}</Link>
                      {r.is_auto && <span className="text-sm text-stone-500 ml-1">(μόνο του)</span>}
                    </td>
                    <td className="whitespace-nowrap">{fmtDate(r.doc_date)}</td>
                    {partnerHead && <td>{r.partner_name}</td>}
                    {showChannel && <td>{r.channel ? CHANNEL_LABEL[r.channel] : ''}</td>}
                    {showProduced && <td>{r.produced_item_name}</td>}
                    <td className="num">{amountText(r)}</td>
                    <td>{badge(r)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  )
}
