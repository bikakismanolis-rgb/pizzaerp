import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useCompanyId } from '../context/CompanyContext'
import { useLoad } from '../lib/useLoad'
import { supabase } from '../lib/supabase'
import type { DocListRow, DocType } from '../lib/types'
import { CHANNEL_LABEL, DOC_TYPE_LABEL_PLURAL, STATUS_LABEL, docCode } from '../lib/labels'
import { fmtDate, fmtMoney, monthStart, today } from '../lib/format'
import { Badge, Empty, PageTitle, Spinner } from '../components/ui'

export function DocList() {
  const { type } = useParams<{ type: DocType }>()
  const docType = type as DocType
  const companyId = useCompanyId()
  const [from, setFrom] = useState(monthStart())
  const [to, setTo] = useState(today())
  const [status, setStatus] = useState<'' | 'draft' | 'posted'>('')

  const rows = useLoad(async () => {
    let query = supabase.from('v_doc_list').select('*').eq('company_id', companyId).eq('doc_type', docType)
      .gte('doc_date', from).lte('doc_date', to).order('doc_no', { ascending: false })
    const { data, error } = await query
    if (error) throw error
    return (data as DocListRow[])
  }, [companyId, docType, from, to])

  const list = useMemo(() => (rows.data ?? []).filter((r) => !status || r.status === status), [rows.data, status])

  const isMoney = docType !== 'production'
  const showPartner = docType === 'purchase' || docType === 'sale' || docType === 'receipt' || docType === 'payment'
  const showChannel = docType === 'sale'
  const showProduced = docType === 'production'

  return (
    <div>
      <PageTitle title={DOC_TYPE_LABEL_PLURAL[docType]}>
        <Link to={`/docs/${docType}/new`} className="btn-primary">+ Νέο</Link>
      </PageTitle>

      <div className="card p-3 mb-3 flex flex-wrap gap-2 items-end">
        <div><label className="label">Από</label><input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div><label className="label">Έως</label><input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        <div><label className="label">Κατάσταση</label>
          <select className="input" value={status} onChange={(e) => setStatus(e.target.value as '' | 'draft' | 'posted')}>
            <option value="">Όλες</option><option value="draft">Πρόχειρα</option><option value="posted">Καταχωρημένα</option>
          </select>
        </div>
      </div>

      <div className="card overflow-x-auto">
        {rows.loading ? <Spinner /> : list.length === 0 ? <Empty /> : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Αριθμός</th><th>Ημ/νία</th>
                {showPartner && <th>Συναλλασσόμενος</th>}
                {showChannel && <th>Κανάλι</th>}
                {showProduced && <th>Προϊόν</th>}
                <th className="num">{isMoney ? 'Αξία' : 'Κόστος'}</th>
                <th>Κατάσταση</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap">
                    <Link to={`/docs/${docType}/${r.id}`} className="text-red-700 hover:underline font-medium">{docCode(docType, r.doc_no)}</Link>
                    {r.is_auto && <span className="text-xs text-stone-400 ml-1">(αυτόματο)</span>}
                    {r.is_running && r.status === 'draft' && <Badge className="bg-amber-100 text-amber-800 ml-1">σε εξέλιξη</Badge>}
                  </td>
                  <td className="whitespace-nowrap">{fmtDate(r.doc_date)}</td>
                  {showPartner && <td>{r.partner_name}</td>}
                  {showChannel && <td>{r.channel ? CHANNEL_LABEL[r.channel] : ''}</td>}
                  {showProduced && <td>{r.produced_item_name}</td>}
                  <td className="num">{fmtMoney(docType === 'receipt' || docType === 'payment' ? (r.amount ?? 0) : (isMoney ? r.total_gross : r.total_net))}</td>
                  <td>
                    <Badge className={r.status === 'posted' ? 'bg-emerald-100 text-emerald-800' : 'bg-stone-200 text-stone-700'}>
                      {STATUS_LABEL[r.status]}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
