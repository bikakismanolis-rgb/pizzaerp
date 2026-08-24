import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useCompanyId } from '../../context/CompanyContext'
import { useLoad } from '../../lib/useLoad'
import { supabase } from '../../lib/supabase'
import { docCode } from '../../lib/labels'
import { fmtDate, fmtMoney, fmtQty } from '../../lib/format'
import { Empty, PageTitle, Spinner } from '../../components/ui'

interface Head { doc_id: string; doc_no: number; doc_date: string; status: string }
interface ResultRow { doc_id: string; item_name: string; item_type: string; unit: string; expected_qty: number; counted_qty: number; diff_qty: number; unit_cost: number; diff_value: number; allocated_value: number; unallocated_value: number }

export function Stocktakes() {
  const companyId = useCompanyId()
  const [selected, setSelected] = useState<string | null>(null)

  const heads = useLoad(async () => {
    const { data, error } = await supabase.from('doc').select('id, doc_no, doc_date, status').eq('company_id', companyId).eq('doc_type', 'stocktake').eq('status', 'posted').order('doc_date', { ascending: false })
    if (error) throw error
    const rows = (data as { id: string; doc_no: number; doc_date: string; status: string }[]).map((d) => ({ doc_id: d.id, doc_no: d.doc_no, doc_date: d.doc_date, status: d.status }))
    if (rows.length && !selected) setSelected(rows[0].doc_id)
    return rows as Head[]
  }, [companyId])

  const result = useLoad(async () => {
    if (!selected) return []
    const { data, error } = await supabase.from('v_stocktake_result').select('*').eq('doc_id', selected)
    if (error) throw error
    return data as ResultRow[]
  }, [selected])

  const tot = (result.data ?? []).reduce((s, r) => ({
    diff: s.diff + Number(r.diff_value), alloc: s.alloc + Number(r.allocated_value), unalloc: s.unalloc + Number(r.unallocated_value),
  }), { diff: 0, alloc: 0, unalloc: 0 })

  return (
    <div>
      <PageTitle title="Αποτελέσματα απογραφών" />
      <div className="card p-3 mb-3 max-w-md">
        <label className="label">Απογραφή</label>
        <select className="input" value={selected ?? ''} onChange={(e) => setSelected(e.target.value)}>
          {(heads.data ?? []).map((h) => <option key={h.doc_id} value={h.doc_id}>{docCode('stocktake', h.doc_no)} — {fmtDate(h.doc_date)}</option>)}
        </select>
      </div>
      {heads.loading ? <Spinner /> : !heads.data?.length ? <Empty text="Δεν υπάρχουν καταχωρημένες απογραφές." /> : result.loading ? <Spinner /> : (
        <>
          <div className="grid gap-2 sm:grid-cols-3 mb-3">
            <div className="card p-3"><div className="text-xs text-stone-500">Συνολική διαφορά</div><div className="text-lg font-semibold">{fmtMoney(tot.diff)}</div></div>
            <div className="card p-3"><div className="text-xs text-stone-500">Επιμερίστηκε σε προϊόντα</div><div className="text-lg font-semibold">{fmtMoney(tot.alloc)}</div></div>
            <div className="card p-3"><div className="text-xs text-stone-500">Ανεπιμέριστο (φύρα/απώλεια)</div><div className="text-lg font-semibold">{fmtMoney(tot.unalloc)}</div></div>
          </div>
          <div className="card overflow-x-auto">
            <table className="tbl">
              <thead><tr><th>Είδος</th><th className="num">Αναμεν.</th><th className="num">Μετρημ.</th><th className="num">Διαφορά</th><th className="num">Αξία</th><th className="num">Επιμερίστηκε</th><th className="num">Ανεπιμέριστο</th></tr></thead>
              <tbody>
                {(result.data ?? []).map((r) => (
                  <tr key={r.item_name}>
                    <td>{r.item_name}</td>
                    <td className="num">{fmtQty(r.expected_qty)}</td>
                    <td className="num">{fmtQty(r.counted_qty)}</td>
                    <td className={'num ' + (Number(r.diff_qty) < 0 ? 'text-red-700' : Number(r.diff_qty) > 0 ? 'text-emerald-700' : '')}>{fmtQty(r.diff_qty)}</td>
                    <td className="num">{fmtMoney(r.diff_value)}</td>
                    <td className="num">{fmtMoney(r.allocated_value)}</td>
                    <td className="num">{fmtMoney(r.unallocated_value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3">
            <Link to={`/docs/stocktake/${selected}`} className="btn-secondary">Άνοιγμα παραστατικού</Link>
          </div>
        </>
      )}
    </div>
  )
}
