import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMaster } from '../context/MasterData'
import { ITEM_TYPE_BADGE, ITEM_TYPE_LABEL } from '../lib/labels'
import type { ItemType } from '../lib/types'
import { fmtCost, fmtMoney } from '../lib/format'
import { Badge, Empty, PageTitle, Spinner } from '../components/ui'

export function Items() {
  const { items, loading } = useMaster()
  const [q, setQ] = useState('')
  const [type, setType] = useState<ItemType | ''>('')
  const [showInactive, setShowInactive] = useState(false)

  const list = useMemo(() => {
    const s = q.trim().toLowerCase()
    return items
      .filter((i) => showInactive || i.is_active)
      .filter((i) => !type || i.item_type === type)
      .filter((i) => !s || i.name.toLowerCase().includes(s) || i.code.toLowerCase().includes(s) || (i.category ?? '').toLowerCase().includes(s))
  }, [items, q, type, showInactive])

  return (
    <div>
      <PageTitle title="Είδη & συνταγές">
        <Link to="/items/new" className="btn-primary">+ Νέο είδος</Link>
      </PageTitle>

      <div className="card p-3 mb-3 flex flex-wrap gap-2 items-center">
        <input className="input max-w-xs" placeholder="Ψάξε είδος…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input max-w-[12rem]" value={type} onChange={(e) => setType(e.target.value as ItemType | '')}>
          <option value="">Όλοι οι τύποι</option>
          <option value="raw">Πρώτες ύλες</option>
          <option value="semi">Ημιέτοιμα</option>
          <option value="finished">Έτοιμα προϊόντα</option>
        </select>
        <label className="text-sm flex items-center gap-1">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Δείξε και όσα δεν χρησιμοποιούμε
        </label>
      </div>

      <div className="card overflow-x-auto">
        {loading ? <Spinner /> : list.length === 0 ? <Empty text="Δεν υπάρχουν είδη. Ξεκίνα με τις πρώτες ύλες (αλεύρι, τυρί...), μετά τα ζυμάρια, μετά τις πίτσες." /> : (
          <table className="tbl">
            <thead>
              <tr>
                <th className="wide">Κωδικός</th><th>Όνομα</th><th className="wide">Τύπος</th><th className="wide">Μονάδα</th>
                <th className="num">Τιμή</th><th className="num wide">Μέσο κόστος</th><th className="wide">Φτιάχνεται τη στιγμή</th>
              </tr>
            </thead>
            <tbody>
              {list.map((i) => (
                <tr key={i.id} className={i.is_active ? '' : 'opacity-50'}>
                  <td className="whitespace-nowrap wide">{i.code}</td>
                  <td><Link to={`/items/${i.id}`} className="text-red-700 hover:underline font-medium">{i.name}</Link>
                    {i.category && <span className="text-sm text-stone-500 ml-2">{i.category}</span>}</td>
                  <td className="wide"><Badge className={ITEM_TYPE_BADGE[i.item_type]}>{ITEM_TYPE_LABEL[i.item_type]}</Badge></td>
                  <td className="wide">{i.unit}</td>
                  <td className="num whitespace-nowrap">{i.item_type === 'finished' ? fmtMoney(i.sale_price) : ''}</td>
                  <td className="num wide">{fmtCost(i.avg_cost)}</td>
                  <td className="wide">{i.make_to_order ? (i.item_type === 'semi' ? 'Αυτόματα' : 'Ναι') : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
