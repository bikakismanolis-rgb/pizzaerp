import { useMemo, useState } from 'react'
import { useCompanyId } from '../../context/CompanyContext'
import { useLoad } from '../../lib/useLoad'
import { supabase } from '../../lib/supabase'
import { fmtCost, fmtMoney, fmtQty, monthStart, today } from '../../lib/format'
import { Empty, PageTitle, Spinner } from '../../components/ui'

interface Row { partner_name: string; item_name: string; unit: string; qty: number; net: number; avg_price: number | null; month: string }

export function PurchasesReport() {
  const companyId = useCompanyId()
  const [from, setFrom] = useState(monthStart())
  const [to, setTo] = useState(today())
  const [groupBy, setGroupBy] = useState<'item' | 'partner'>('partner')

  const rep = useLoad(async () => {
    const { data, error } = await supabase.from('v_purchases_by_partner_item').select('*').eq('company_id', companyId)
    if (error) throw error
    return (data as Row[]).filter((r) => r.month >= monthStart(from) && r.month <= to)
  }, [companyId, from, to])

  const grouped = useMemo(() => {
    const map = new Map<string, { label: string; qty: number; net: number; unit: string }>()
    for (const r of rep.data ?? []) {
      const label = groupBy === 'partner' ? r.partner_name : r.item_name
      const g = map.get(label) ?? { label, qty: 0, net: 0, unit: r.unit }
      g.qty += Number(r.qty); g.net += Number(r.net)
      map.set(label, g)
    }
    return [...map.values()].sort((a, b) => b.net - a.net)
  }, [rep.data, groupBy])

  const totNet = grouped.reduce((s, g) => s + g.net, 0)

  return (
    <div>
      <PageTitle title="Αγορές ανά προμηθευτή/είδος" />
      <div className="card p-3 mb-3 flex flex-wrap gap-2 items-end">
        <div><label className="label">Από</label><input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div><label className="label">Έως</label><input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        <div><label className="label">Ομαδοποίηση</label>
          <select className="input" value={groupBy} onChange={(e) => setGroupBy(e.target.value as 'item' | 'partner')}>
            <option value="partner">Ανά προμηθευτή</option><option value="item">Ανά είδος</option>
          </select>
        </div>
      </div>
      <div className="card overflow-x-auto">
        {rep.loading ? <Spinner /> : grouped.length === 0 ? <Empty /> : (
          <table className="tbl">
            <thead><tr><th>{groupBy === 'partner' ? 'Προμηθευτής' : 'Είδος'}</th><th className="num">Ποσότητα</th><th className="num">Καθαρή αξία</th>{groupBy === 'item' && <th className="num">Μέση τιμή</th>}</tr></thead>
            <tbody>
              {grouped.map((g) => (
                <tr key={g.label}>
                  <td>{g.label}</td>
                  <td className="num">{groupBy === 'item' ? fmtQty(g.qty) + ' ' + g.unit : ''}</td>
                  <td className="num">{fmtMoney(g.net)}</td>
                  {groupBy === 'item' && <td className="num">{g.qty > 0 ? fmtCost(g.net / g.qty) : ''}</td>}
                </tr>
              ))}
              <tr className="font-semibold"><td>Σύνολο</td><td></td><td className="num">{fmtMoney(totNet)}</td>{groupBy === 'item' && <td></td>}</tr>
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
