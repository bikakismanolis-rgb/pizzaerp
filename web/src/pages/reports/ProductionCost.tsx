import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useCompanyId } from '../../context/CompanyContext'
import { useLoad } from '../../lib/useLoad'
import { supabase } from '../../lib/supabase'
import { docCode } from '../../lib/labels'
import { fmtCost, fmtDate, fmtMoney, fmtQty, monthStart, today } from '../../lib/format'
import { Badge, Empty, PageTitle, Spinner } from '../../components/ui'

interface Row { doc_id: string; doc_no: number; doc_date: string; is_auto: boolean; item_name: string; item_type: string; produced_qty: number; base_cost: number; alloc_cost: number; actual_cost: number; base_unit_cost: number; actual_unit_cost: number; is_final: boolean }

export function ProductionCost() {
  const companyId = useCompanyId()
  const [from, setFrom] = useState(monthStart())
  const [to, setTo] = useState(today())
  const [view, setView] = useState<'byItem' | 'byDoc'>('byItem')

  const rep = useLoad(async () => {
    const { data, error } = await supabase.from('v_production_cost').select('*').eq('company_id', companyId).gte('doc_date', from).lte('doc_date', to).order('doc_date')
    if (error) throw error
    return data as Row[]
  }, [companyId, from, to])

  const byItem = useMemo(() => {
    const map = new Map<string, { name: string; qty: number; base: number; alloc: number; actual: number; final: boolean }>()
    for (const r of rep.data ?? []) {
      const g = map.get(r.item_name) ?? { name: r.item_name, qty: 0, base: 0, alloc: 0, actual: 0, final: true }
      g.qty += Number(r.produced_qty); g.base += Number(r.base_cost); g.alloc += Number(r.alloc_cost); g.actual += Number(r.actual_cost)
      g.final = g.final && r.is_final
      map.set(r.item_name, g)
    }
    return [...map.values()].sort((a, b) => b.actual - a.actual)
  }, [rep.data])

  return (
    <div>
      <PageTitle title="Κόστος παραγωγής" />
      <div className="card p-3 mb-3 flex flex-wrap gap-2 items-end">
        <div><label className="label">Από</label><input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div><label className="label">Έως</label><input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        <div><label className="label">Προβολή</label>
          <select className="input" value={view} onChange={(e) => setView(e.target.value as 'byItem' | 'byDoc')}>
            <option value="byItem">Ανά είδος</option><option value="byDoc">Ανά παραγωγή</option>
          </select>
        </div>
      </div>
      <p className="text-xs text-stone-500 mb-2">Βασικό = κόστος υλικών τη στιγμή της παραγωγής. Επιμερισμός = διαφορές απογραφής. Πραγματικό = βασικό + επιμερισμός. «Οριστικό» = έχει κλείσει με απογραφή.</p>
      <div className="card overflow-x-auto">
        {rep.loading ? <Spinner /> : (rep.data ?? []).length === 0 ? <Empty /> : view === 'byItem' ? (
          <table className="tbl">
            <thead><tr><th>Είδος</th><th className="num">Ποσότητα</th><th className="num">Βασικό</th><th className="num">Επιμερισμός</th><th className="num">Πραγματικό</th><th className="num">Ανά μονάδα</th><th></th></tr></thead>
            <tbody>
              {byItem.map((g) => (
                <tr key={g.name}>
                  <td>{g.name}</td>
                  <td className="num">{fmtQty(g.qty)}</td>
                  <td className="num">{fmtMoney(g.base)}</td>
                  <td className={'num ' + (g.alloc > 0 ? 'text-red-700' : g.alloc < 0 ? 'text-emerald-700' : '')}>{fmtMoney(g.alloc)}</td>
                  <td className="num">{fmtMoney(g.actual)}</td>
                  <td className="num">{g.qty > 0 ? fmtCost(g.actual / g.qty) : ''}</td>
                  <td>{g.final ? <Badge className="bg-emerald-100 text-emerald-800">Οριστικό</Badge> : <Badge className="bg-amber-100 text-amber-800">Προσωρινό</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table className="tbl">
            <thead><tr><th>Παραστατικό</th><th>Ημ/νία</th><th>Είδος</th><th className="num">Ποσότητα</th><th className="num">Βασικό/μον.</th><th className="num">Πραγματικό/μον.</th><th></th></tr></thead>
            <tbody>
              {(rep.data ?? []).map((r) => (
                <tr key={r.doc_id}>
                  <td><Link className="text-red-700 hover:underline" to={`/docs/production/${r.doc_id}`}>{docCode('production', r.doc_no)}</Link>{r.is_auto && <span className="text-xs text-stone-400 ml-1">(αυτ.)</span>}</td>
                  <td className="whitespace-nowrap">{fmtDate(r.doc_date)}</td>
                  <td>{r.item_name}</td>
                  <td className="num">{fmtQty(r.produced_qty)}</td>
                  <td className="num">{fmtCost(r.base_unit_cost)}</td>
                  <td className="num">{fmtCost(r.actual_unit_cost)}</td>
                  <td>{r.is_final ? <Badge className="bg-emerald-100 text-emerald-800">Οριστικό</Badge> : <Badge className="bg-amber-100 text-amber-800">Προσωρινό</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
