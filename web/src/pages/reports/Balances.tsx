import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useCompanyId } from '../../context/CompanyContext'
import { useLoad } from '../../lib/useLoad'
import { supabase } from '../../lib/supabase'
import type { PartnerBalance } from '../../lib/types'
import { fmtMoney } from '../../lib/format'
import { Empty, PageTitle, Spinner } from '../../components/ui'

export function Balances() {
  const companyId = useCompanyId()
  const [tab, setTab] = useState<'customer' | 'supplier'>('customer')
  const rep = useLoad(async () => {
    const { data, error } = await supabase.from('v_partner_balance').select('*').eq('company_id', companyId).order('name')
    if (error) throw error
    return data as PartnerBalance[]
  }, [companyId])

  const list = useMemo(() => (rep.data ?? []).filter((r) => tab === 'customer' ? r.is_customer : r.is_supplier), [rep.data, tab])
  const total = list.reduce((s, r) => s + Number(tab === 'customer' ? r.customer_balance : r.supplier_balance), 0)

  return (
    <div>
      <PageTitle title="Υπόλοιπα συναλλασσομένων" />
      <div className="flex gap-1 mb-3 border-b border-stone-200">
        {([['customer', 'Πελάτες (μας χρωστάνε)'], ['supplier', 'Προμηθευτές (τους χρωστάμε)']] as const).map(([t, l]) => (
          <button key={t} className={'px-3 py-2 text-sm border-b-2 -mb-px ' + (tab === t ? 'border-red-700 text-red-700 font-medium' : 'border-transparent text-stone-600')} onClick={() => setTab(t)}>{l}</button>
        ))}
      </div>
      <div className="card overflow-x-auto">
        {rep.loading ? <Spinner /> : list.length === 0 ? <Empty /> : (
          <table className="tbl">
            <thead><tr><th>Κωδικός</th><th>Όνομα</th><th className="num">Υπόλοιπο</th></tr></thead>
            <tbody>
              {list.map((r) => {
                const bal = Number(tab === 'customer' ? r.customer_balance : r.supplier_balance)
                return (
                  <tr key={r.partner_id}>
                    <td className="whitespace-nowrap">{r.code}</td>
                    <td><Link to={`/partners/${r.partner_id}`} className="text-red-700 hover:underline">{r.name}</Link></td>
                    <td className={'num ' + (bal < 0 ? 'text-red-700' : '')}>{fmtMoney(bal)}</td>
                  </tr>
                )
              })}
              <tr className="font-semibold"><td></td><td className="text-right">Σύνολο</td><td className="num">{fmtMoney(total)}</td></tr>
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
