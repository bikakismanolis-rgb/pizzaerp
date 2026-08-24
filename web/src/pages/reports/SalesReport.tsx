import { useMemo, useState } from 'react'
import { useCompanyId } from '../../context/CompanyContext'
import { useLoad } from '../../lib/useLoad'
import { supabase } from '../../lib/supabase'
import type { Channel } from '../../lib/types'
import { CHANNEL_LABEL } from '../../lib/labels'
import { fmtMoney, fmtQty, monthStart, today } from '../../lib/format'
import { Empty, PageTitle, Spinner } from '../../components/ui'

interface Row { partner_name: string | null; channel: Channel | null; item_name: string; qty: number; net: number; cogs: number; gross_profit: number; month: string }

export function SalesReport() {
  const companyId = useCompanyId()
  const [from, setFrom] = useState(monthStart())
  const [to, setTo] = useState(today())
  const [groupBy, setGroupBy] = useState<'item' | 'partner' | 'channel'>('item')

  const rep = useLoad(async () => {
    const { data, error } = await supabase.from('v_sales_by_partner_item').select('*').eq('company_id', companyId).gte('month', monthStart(from)).lte('month', to)
    if (error) throw error
    return (data as Row[]).filter((r) => r.month >= monthStart(from) && r.month <= to)
  }, [companyId, from, to])

  const grouped = useMemo(() => {
    const map = new Map<string, { label: string; qty: number; net: number; cogs: number; gp: number }>()
    for (const r of rep.data ?? []) {
      const label = groupBy === 'item' ? r.item_name : groupBy === 'partner' ? (r.partner_name ?? '(λιανική)') : (r.channel ? CHANNEL_LABEL[r.channel] : '—')
      const g = map.get(label) ?? { label, qty: 0, net: 0, cogs: 0, gp: 0 }
      g.qty += Number(r.qty); g.net += Number(r.net); g.cogs += Number(r.cogs); g.gp += Number(r.gross_profit)
      map.set(label, g)
    }
    return [...map.values()].sort((a, b) => b.net - a.net)
  }, [rep.data, groupBy])

  const tot = grouped.reduce((s, g) => ({ net: s.net + g.net, cogs: s.cogs + g.cogs, gp: s.gp + g.gp }), { net: 0, cogs: 0, gp: 0 })

  return (
    <div>
      <PageTitle title="Πωλήσεις ανά πελάτη/είδος" />
      <div className="card p-3 mb-3 flex flex-wrap gap-2 items-end">
        <div><label className="label">Από</label><input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div><label className="label">Έως</label><input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        <div><label className="label">Ομαδοποίηση</label>
          <select className="input" value={groupBy} onChange={(e) => setGroupBy(e.target.value as 'item' | 'partner' | 'channel')}>
            <option value="item">Ανά είδος</option><option value="partner">Ανά πελάτη</option><option value="channel">Ανά κανάλι</option>
          </select>
        </div>
      </div>
      <div className="card overflow-x-auto">
        {rep.loading ? <Spinner /> : grouped.length === 0 ? <Empty /> : (
          <table className="tbl">
            <thead><tr><th>{groupBy === 'item' ? 'Είδος' : groupBy === 'partner' ? 'Πελάτης' : 'Κανάλι'}</th><th className="num">Ποσότητα</th><th className="num">Καθαρές πωλήσεις</th><th className="num">Κόστος</th><th className="num">Μικτό κέρδος</th><th className="num">Περιθώριο</th></tr></thead>
            <tbody>
              {grouped.map((g) => (
                <tr key={g.label}>
                  <td>{g.label}</td>
                  <td className="num">{fmtQty(g.qty)}</td>
                  <td className="num">{fmtMoney(g.net)}</td>
                  <td className="num">{fmtMoney(g.cogs)}</td>
                  <td className={'num ' + (g.gp < 0 ? 'text-red-700' : 'text-emerald-700')}>{fmtMoney(g.gp)}</td>
                  <td className="num">{g.net > 0 ? Math.round((g.gp / g.net) * 100) + '%' : ''}</td>
                </tr>
              ))}
              <tr className="font-semibold"><td>Σύνολο</td><td></td><td className="num">{fmtMoney(tot.net)}</td><td className="num">{fmtMoney(tot.cogs)}</td><td className="num">{fmtMoney(tot.gp)}</td><td className="num">{tot.net > 0 ? Math.round((tot.gp / tot.net) * 100) + '%' : ''}</td></tr>
            </tbody>
          </table>
        )}
      </div>
      <p className="text-xs text-stone-500 mt-2">Το κόστος είναι το κόστος πωληθέντων τη στιγμή της πώλησης (μέσο σταθμικό). Οι διαφορές απογραφής φαίνονται στην αναφορά κόστους παραγωγής.</p>
    </div>
  )
}
