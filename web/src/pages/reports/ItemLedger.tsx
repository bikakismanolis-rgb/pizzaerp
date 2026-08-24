import { useParams } from 'react-router-dom'
import { useMaster } from '../../context/MasterData'
import { useLoad } from '../../lib/useLoad'
import { supabase } from '../../lib/supabase'
import { MOVE_TYPE_LABEL, docCode } from '../../lib/labels'
import type { DocType } from '../../lib/types'
import { fmtCost, fmtDate, fmtQty } from '../../lib/format'
import { Empty, PageTitle, Spinner } from '../../components/ui'
import { Link } from 'react-router-dom'
import { ItemPicker } from '../../components/Pickers'
import { useNavigate } from 'react-router-dom'

interface LedgerRow { id: number; item_id: string; move_date: string; move_type: string; qty: number; unit_cost: number; doc_id: string; doc_type: DocType; doc_no: number; partner_name: string | null; is_auto: boolean; running_qty: number }

export function ItemLedger() {
  const { itemId } = useParams()
  const nav = useNavigate()
  const { itemById } = useMaster()
  const item = itemId ? itemById.get(itemId) : null

  const rows = useLoad(async () => {
    if (!itemId) return []
    const { data, error } = await supabase.from('v_item_ledger').select('*').eq('item_id', itemId).order('move_date').order('id')
    if (error) throw error
    return data as LedgerRow[]
  }, [itemId])

  return (
    <div>
      <PageTitle title={item ? `Καρτέλα: ${item.name}` : 'Καρτέλα είδους'} />
      <div className="card p-3 mb-3 max-w-md">
        <label className="label">Είδος</label>
        <ItemPicker value={itemId ?? null} includeInactive onChange={(v) => nav(v ? `/reports/item-ledger/${v}` : '/reports/stock')} />
      </div>
      {!itemId ? <Empty text="Διάλεξε είδος." /> : rows.loading ? <Spinner /> : !rows.data?.length ? <Empty text="Καμία κίνηση." /> : (
        <div className="card overflow-x-auto">
          <table className="tbl">
            <thead><tr><th>Ημ/νία</th><th>Κίνηση</th><th>Παραστατικό</th><th>Συναλλασσόμενος</th><th className="num">Ποσότητα</th><th className="num">Κόστος/μον.</th><th className="num">Υπόλοιπο</th></tr></thead>
            <tbody>
              {rows.data.map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap">{fmtDate(r.move_date)}</td>
                  <td>{MOVE_TYPE_LABEL[r.move_type] ?? r.move_type}</td>
                  <td><Link className="text-red-700 hover:underline" to={`/docs/${r.doc_type}/${r.doc_id}`}>{docCode(r.doc_type, r.doc_no)}</Link>
                    {r.is_auto && <span className="text-xs text-stone-400 ml-1">(αυτ.)</span>}</td>
                  <td>{r.partner_name}</td>
                  <td className={'num ' + (Number(r.qty) < 0 ? 'text-red-700' : 'text-emerald-700')}>{fmtQty(r.qty)}</td>
                  <td className="num">{fmtCost(r.unit_cost)}</td>
                  <td className="num">{fmtQty(r.running_qty)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
