import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMaster } from '../context/MasterData'
import { useCompanyId } from '../context/CompanyContext'
import { useLoad } from '../lib/useLoad'
import { supabase } from '../lib/supabase'
import type { PartnerBalance } from '../lib/types'
import { fmtMoney } from '../lib/format'
import { Badge, Empty, PageTitle, Spinner } from '../components/ui'

export function Partners() {
  const { partners, loading } = useMaster()
  const companyId = useCompanyId()
  const [q, setQ] = useState('')
  const [kind, setKind] = useState<'' | 'customer' | 'supplier'>('')
  const [showInactive, setShowInactive] = useState(false)

  const balances = useLoad(async () => {
    const { data, error } = await supabase.from('v_partner_balance').select('*').eq('company_id', companyId)
    if (error) throw error
    return new Map((data as PartnerBalance[]).map((b) => [b.partner_id, b]))
  }, [companyId])

  const list = useMemo(() => {
    const s = q.trim().toLowerCase()
    return partners
      .filter((p) => showInactive || p.is_active)
      .filter((p) => !kind || (kind === 'customer' ? p.is_customer : p.is_supplier))
      .filter((p) => !s || p.name.toLowerCase().includes(s) || p.code.toLowerCase().includes(s) || (p.city ?? '').toLowerCase().includes(s))
  }, [partners, q, kind, showInactive])

  return (
    <div>
      <PageTitle title="Πελάτες & προμηθευτές">
        <Link to="/partners/new" className="btn-primary">+ Νέος</Link>
      </PageTitle>
      <div className="card p-3 mb-3 flex flex-wrap gap-2 items-center">
        <input className="input max-w-xs" placeholder="Αναζήτηση..." value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input max-w-[12rem]" value={kind} onChange={(e) => setKind(e.target.value as '' | 'customer' | 'supplier')}>
          <option value="">Όλοι</option>
          <option value="customer">Πελάτες</option>
          <option value="supplier">Προμηθευτές</option>
        </select>
        <label className="text-sm flex items-center gap-1">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Ανενεργοί
        </label>
      </div>
      <div className="card overflow-x-auto">
        {loading ? <Spinner /> : list.length === 0 ? <Empty /> : (
          <table className="tbl">
            <thead>
              <tr><th>Κωδικός</th><th>Όνομα</th><th>Τύπος</th><th>Πόλη</th><th>Τηλέφωνο</th>
                <th className="num">Μας χρωστάει</th><th className="num">Του χρωστάμε</th></tr>
            </thead>
            <tbody>
              {list.map((p) => {
                const b = balances.data?.get(p.id)
                return (
                  <tr key={p.id} className={p.is_active ? '' : 'opacity-50'}>
                    <td className="whitespace-nowrap">{p.code}</td>
                    <td><Link to={`/partners/${p.id}`} className="text-red-700 hover:underline font-medium">{p.name}</Link></td>
                    <td className="space-x-1">
                      {p.is_customer && <Badge className="bg-emerald-100 text-emerald-800">Πελάτης</Badge>}
                      {p.is_supplier && <Badge className="bg-amber-100 text-amber-800">Προμηθευτής</Badge>}
                    </td>
                    <td>{p.city}</td>
                    <td>{p.phone}</td>
                    <td className="num">{p.is_customer && b ? fmtMoney(b.customer_balance) : ''}</td>
                    <td className="num">{p.is_supplier && b ? fmtMoney(b.supplier_balance) : ''}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
