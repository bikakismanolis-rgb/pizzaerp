import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useCompanyId } from '../../context/CompanyContext'
import { useLoad } from '../../lib/useLoad'
import { supabase } from '../../lib/supabase'
import type { ItemType, StockBalance } from '../../lib/types'
import { ITEM_TYPE_BADGE, ITEM_TYPE_LABEL } from '../../lib/labels'
import { fmtCost, fmtMoney, fmtQty } from '../../lib/format'
import { Badge, Empty, PageTitle, Spinner } from '../../components/ui'

export function StockReport() {
  const companyId = useCompanyId()
  const [type, setType] = useState<ItemType | ''>('')
  const [onlyBelow, setOnlyBelow] = useState(false)
  const rep = useLoad(async () => {
    const { data, error } = await supabase.from('v_stock_balance').select('*').eq('company_id', companyId).order('code')
    if (error) throw error
    return data as StockBalance[]
  }, [companyId])

  const list = useMemo(() => (rep.data ?? [])
    .filter((r) => r.is_active || r.on_hand !== 0)
    .filter((r) => !type || r.item_type === type)
    .filter((r) => !onlyBelow || r.below_min), [rep.data, type, onlyBelow])

  const totalValue = list.reduce((s, r) => s + Number(r.stock_value), 0)

  return (
    <div>
      <PageTitle title="Υπόλοιπα αποθήκης" />
      <div className="card p-3 mb-3 flex flex-wrap gap-2 items-center">
        <select className="input max-w-[12rem]" value={type} onChange={(e) => setType(e.target.value as ItemType | '')}>
          <option value="">Όλοι οι τύποι</option><option value="raw">Πρώτες ύλες</option><option value="semi">Ημιέτοιμα</option><option value="finished">Έτοιμα</option>
        </select>
        <label className="text-sm flex items-center gap-1"><input type="checkbox" checked={onlyBelow} onChange={(e) => setOnlyBelow(e.target.checked)} /> Μόνο κάτω από ελάχιστο</label>
        <div className="ml-auto text-sm">Συνολική αξία: <b>{fmtMoney(totalValue)}</b></div>
      </div>
      <div className="card overflow-x-auto">
        {rep.loading ? <Spinner /> : list.length === 0 ? <Empty /> : (
          <table className="tbl">
            <thead><tr><th>Κωδικός</th><th>Είδος</th><th>Τύπος</th><th>Μον.</th><th className="num">Υπόλοιπο</th><th className="num">Μέσο κόστος</th><th className="num">Αξία</th></tr></thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.item_id} className={r.below_min ? 'bg-red-50' : ''}>
                  <td className="whitespace-nowrap">{r.code}</td>
                  <td><Link to={`/reports/item-ledger/${r.item_id}`} className="text-red-700 hover:underline">{r.name}</Link>
                    {r.below_min && <span className="text-xs text-red-700 ml-2">κάτω από ελάχιστο</span>}</td>
                  <td><Badge className={ITEM_TYPE_BADGE[r.item_type]}>{ITEM_TYPE_LABEL[r.item_type]}</Badge></td>
                  <td>{r.unit}</td>
                  <td className={'num ' + (Number(r.on_hand) < 0 ? 'text-red-700' : '')}>{fmtQty(r.on_hand)}</td>
                  <td className="num">{fmtCost(r.avg_cost)}</td>
                  <td className="num">{fmtMoney(r.stock_value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
