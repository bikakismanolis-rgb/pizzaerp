import { Link } from 'react-router-dom'
import { useCompany, useCompanyId } from '../context/CompanyContext'
import { useLoad } from '../lib/useLoad'
import { supabase } from '../lib/supabase'
import type { StockBalance } from '../lib/types'
import { fmtMoney, fmtQty, monthStart, today } from '../lib/format'
import { PageTitle, Spinner } from '../components/ui'

export function Dashboard() {
  const companyId = useCompanyId()
  const { company } = useCompany()

  const data = useLoad(async () => {
    const [stock, sales, below, drafts] = await Promise.all([
      supabase.from('v_stock_balance').select('stock_value').eq('company_id', companyId),
      supabase.from('v_sales_by_partner_item').select('net, gross_profit, month').eq('company_id', companyId).gte('month', monthStart()),
      supabase.from('v_stock_balance').select('*').eq('company_id', companyId).eq('below_min', true),
      supabase.from('doc').select('id', { count: 'exact', head: true }).eq('company_id', companyId).eq('status', 'draft'),
    ])
    const stockValue = (stock.data ?? []).reduce((s, r) => s + Number(r.stock_value), 0)
    const monthSales = (sales.data ?? []).filter((r) => r.month >= monthStart() && r.month <= today())
    const salesNet = monthSales.reduce((s, r) => s + Number(r.net), 0)
    const salesGp = monthSales.reduce((s, r) => s + Number(r.gross_profit), 0)
    return { stockValue, salesNet, salesGp, below: (below.data ?? []) as StockBalance[], draftCount: drafts.count ?? 0 }
  }, [companyId])

  if (data.loading || !data.data) return <Spinner />
  const d = data.data

  const Card = ({ label, value, to }: { label: string; value: string; to?: string }) => (
    <div className="card p-4">
      <div className="text-xs text-stone-500">{label}</div>
      <div className="text-2xl font-semibold mt-1">{value}</div>
      {to && <Link to={to} className="text-xs text-red-700 hover:underline mt-1 inline-block">Προβολή →</Link>}
    </div>
  )

  return (
    <div>
      <PageTitle title={`Αρχική — ${company?.name ?? ''}`} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 mb-4">
        <Card label="Αξία αποθήκης" value={fmtMoney(d.stockValue)} to="/reports/stock" />
        <Card label="Πωλήσεις μήνα (καθ.)" value={fmtMoney(d.salesNet)} to="/reports/sales" />
        <Card label="Μικτό κέρδος μήνα" value={fmtMoney(d.salesGp)} to="/reports/sales" />
        <Card label="Πρόχειρα παραστατικά" value={String(d.draftCount)} />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="card p-4">
          <h2 className="font-semibold mb-2">Γρήγορες ενέργειες</h2>
          <div className="flex flex-wrap gap-2">
            <Link to="/daily-sales" className="btn-primary">Πωλήσεις ημέρας</Link>
            <Link to="/docs/purchase/new" className="btn-secondary">Νέα αγορά</Link>
            <Link to="/docs/production/new" className="btn-secondary">Νέα παραγωγή</Link>
            <Link to="/docs/sale/new" className="btn-secondary">Νέα πώληση χονδρικής</Link>
            <Link to="/docs/stocktake/new" className="btn-secondary">Νέα απογραφή</Link>
          </div>
        </div>

        <div className="card p-4">
          <h2 className="font-semibold mb-2">Κάτω από ελάχιστο απόθεμα</h2>
          {d.below.length === 0 ? <div className="text-sm text-stone-500">Όλα τα είδη είναι πάνω από το ελάχιστο.</div> : (
            <table className="tbl">
              <thead><tr><th>Είδος</th><th className="num">Υπόλοιπο</th><th className="num">Ελάχιστο</th></tr></thead>
              <tbody>
                {d.below.map((b) => (
                  <tr key={b.item_id}>
                    <td><Link to={`/reports/item-ledger/${b.item_id}`} className="text-red-700 hover:underline">{b.name}</Link></td>
                    <td className="num text-red-700">{fmtQty(b.on_hand)} {b.unit}</td>
                    <td className="num">{fmtQty(b.min_stock)} {b.unit}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}
