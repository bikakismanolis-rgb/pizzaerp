import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useCompanyId } from '../../context/CompanyContext'
import { useMaster } from '../../context/MasterData'
import { useLoad } from '../../lib/useLoad'
import { supabase } from '../../lib/supabase'
import { fmtMoney, fmtQty } from '../../lib/format'
import { addMonths, allocateOverhead, monthAcc, monthKey, monthLabel, monthShare, type OverheadMethod, type SaleRow } from '../../lib/overhead'
import { ErrorBox, PageTitle, Spinner } from '../../components/ui'

/**
 * Κέρδος του μήνα: πωλήσεις − υλικά − γενικά έξοδα, συνολικά και ανά
 * είδος (και ανά τεμάχιο: «κάθε μαργαρίτα σού αφήνει 2,10 €»).
 * Μόνο ο ιδιοκτήτης (μετρά και τους μισθούς).
 */

const METHOD_KEY = 'pizza-erp.overhead-method'
const readMethod = (): OverheadMethod => { try { return localStorage.getItem(METHOD_KEY) === 'material' ? 'material' : 'units' } catch { return 'units' } }

export function Profit() {
  const companyId = useCompanyId()
  const { itemById } = useMaster()
  const [month, setMonth] = useState(monthKey)
  const [method, setMethod] = useState<OverheadMethod>(readMethod)
  useEffect(() => { try { localStorage.setItem(METHOD_KEY, method) } catch { /* ignore */ } }, [method])

  const rep = useLoad(async () => {
    const { data: owner } = await supabase.rpc('is_owner', { p_company: companyId })
    if (owner === false) return 'denied' as const
    const [sales, oh, boms] = await Promise.all([
      supabase.from('v_sales_by_partner_item').select('item_id, item_name, qty, net, cogs').eq('company_id', companyId).eq('month', month),
      supabase.from('v_overhead_month').select('total').eq('company_id', companyId).eq('month', month).maybeSingle(),
      supabase.from('bom').select('item_id').eq('company_id', companyId),
    ])
    if (sales.error) throw sales.error
    return {
      sales: (sales.data ?? []) as SaleRow[],
      // βάση χωρίς το 0008: χωρίς γενικά έξοδα
      overhead: oh.error ? null : Number((oh.data as { total?: number } | null)?.total ?? 0),
      withRecipe: new Set(((boms.data ?? []) as { item_id: string }[]).map((b) => b.item_id)),
    }
  }, [companyId, month])

  // τρέχων μήνας: μόνο τα έξοδα των ημερών που πέρασαν
  const part = monthShare(month)
  const res = useMemo(() => {
    if (!rep.data || rep.data === 'denied') return null
    // «ίσα ανά τεμάχιο»: μόνο ό,τι έχει συνταγή (όχι αναψυκτικά, extra, μεταφορικά)
    const perUnit = new Set([...rep.data.withRecipe].filter((id) => {
      const it = itemById.get(id)
      return it && it.item_type === 'finished' && !it.is_extra && !it.is_service
    }))
    return allocateOverhead(rep.data.sales, (rep.data.overhead ?? 0) * part.share, method, perUnit)
  }, [rep.data, method, itemById, part.share])

  if (rep.data === 'denied') {
    return <div><PageTitle title="Κέρδος του μήνα" /><div className="card p-4 text-sm">Το κέρδος (με τους μισθούς και τα έξοδα) το βλέπει μόνο ο ιδιοκτήτης.</div></div>
  }

  const noOverhead = !!rep.data && rep.data.overhead === 0
  // «από κάθε 10 €» μόνο όταν έχει νόημα (όχι «σού λείπουν 300 € στα 10»)
  const per10 = res && res.net > 0 && Math.abs(res.profit) <= res.net ? (res.profit / res.net) * 10 : null

  return (
    <div>
      <PageTitle title="Κέρδος του μήνα">
        <Link to="/costs" className="btn-secondary">Γενικά έξοδα</Link>
      </PageTitle>
      <ErrorBox text={rep.error} />

      <div className="card p-3 mb-3 flex flex-wrap items-center gap-2">
        <button className="btn-secondary h-11 w-11 p-0 text-lg" onClick={() => setMonth(addMonths(month, -1))} aria-label="Προηγούμενος μήνας">‹</button>
        <div className="text-lg font-semibold min-w-[11rem] text-center">{monthLabel(month)}</div>
        <button className="btn-secondary h-11 w-11 p-0 text-lg" onClick={() => setMonth(addMonths(month, 1))} aria-label="Επόμενος μήνας" disabled={month >= monthKey()}>›</button>
      </div>

      {rep.loading || !res ? <Spinner /> : (
        <>
          <div className="grid gap-3 grid-cols-2 lg:grid-cols-4 mb-3">
            <Stat label="Πωλήσεις (χωρίς ΦΠΑ)" value={fmtMoney(res.net)} />
            <Stat label="Υλικά" value={`− ${fmtMoney(res.material)}`} />
            <Stat label={part.share < 1 && rep.data?.overhead ? `Γενικά έξοδα (${part.days} από ${part.of} μέρες)` : 'Γενικά έξοδα'} value={`− ${fmtMoney(res.overhead)}`} />
            <Stat label="Καθαρό κέρδος" value={fmtMoney(res.profit)} tone={res.profit >= 0 ? 'good' : 'bad'} />
          </div>
          {part.share < 1 && !!rep.data?.overhead && (
            <p className="text-sm text-stone-600 mb-2">
              Ο μήνας δεν τελείωσε: μετράνε τα {fmtMoney(res.overhead)} από τα {fmtMoney(rep.data.overhead)} των γενικών εξόδων, όσο αναλογεί στις {part.days} μέρες ως σήμερα.
            </p>
          )}
          {res.profit < 0 && per10 === null && res.net > 0 && (
            <p className="text-base mb-3 text-red-700">Ως τώρα τα έξοδα είναι περισσότερα από τις πωλήσεις.</p>
          )}
          {per10 !== null && (
            <p className="text-base mb-3">
              Από κάθε <b>10 €</b> πωλήσεις σού {per10 >= 0 ? 'μένουν' : 'λείπουν'} <b className={per10 >= 0 ? 'text-emerald-800' : 'text-red-700'}>{fmtMoney(Math.abs(per10))}</b>.
            </p>
          )}
          {noOverhead && (
            <div className="rounded-md bg-amber-50 border border-amber-200 text-amber-900 text-sm px-3 py-2 mb-3">
              Δεν έχεις γράψει γενικά έξοδα για τον {monthAcc(month)}: το κέρδος φαίνεται μεγαλύτερο απ' ό,τι είναι.{' '}
              <Link className="underline font-medium" to="/costs">Γράψε τα (ρεύμα, ενοίκιο, μισθοί…)</Link>
            </div>
          )}
          {res.unallocated > 0 && res.rows.length > 0 && (
            <div className="rounded-md bg-amber-50 border border-amber-200 text-amber-900 text-sm px-3 py-2 mb-3">
              {fmtMoney(res.unallocated)} γενικά έξοδα δεν μοιράστηκαν σε είδος (δεν πουλήθηκε κάτι με συνταγή). Μετράνε όμως στο καθαρό κέρδος.
            </div>
          )}

          <div className="card p-3 mb-3 text-sm">
            <div className="font-medium mb-2">Πώς μοιράζονται τα γενικά έξοδα στα είδη:</div>
            <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Μοίρασμα γενικών εξόδων">
              {([
                ['units', 'Ίσα σε κάθε πίτσα', 'Κάθε τεμάχιο με συνταγή παίρνει το ίδιο. Τα αναψυκτικά τίποτα.'],
                ['material', 'Ανάλογα με τα υλικά', 'Όποιο είδος έχει ακριβότερα υλικά, παίρνει περισσότερα.'],
              ] as const).map(([m, title, help]) => (
                <button key={m} type="button" role="radio" aria-checked={method === m}
                  className={'rounded-md border p-3 text-left ' + (method === m ? 'border-red-700 bg-red-50' : 'border-stone-200 bg-white')}
                  onClick={() => setMethod(m)}>
                  <div className="font-semibold">{title}</div>
                  <div className="text-xs text-stone-600">{help}</div>
                </button>
              ))}
            </div>
          </div>

          {res.rows.length === 0 ? (
            <div className="card p-4 text-sm text-stone-600">Καμία καταχωρημένη πώληση τον {monthAcc(month)}.</div>
          ) : (
            <div className="card overflow-x-auto">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Είδος</th><th className="num">Πουλήθηκαν</th><th className="num">Τιμή / τεμ.</th><th className="num">Υλικά / τεμ.</th>
                    <th className="num">Έξοδα / τεμ.</th><th className="num">Κέρδος / τεμ.</th><th className="num">Κέρδος</th>
                  </tr>
                </thead>
                <tbody>
                  {res.rows.map((r) => {
                    const q = r.qty || 1
                    return (
                      <tr key={r.item_id}>
                        <td className="font-medium">{r.name}</td>
                        <td className="num">{fmtQty(r.qty)}</td>
                        <td className="num">{fmtMoney(r.net / q)}</td>
                        <td className="num">{fmtMoney(r.material / q)}</td>
                        <td className="num">{fmtMoney(r.overhead / q)}</td>
                        <td className={'num font-semibold ' + (r.profit < 0 ? 'text-red-700' : 'text-emerald-800')}>{fmtMoney(r.profit / q)}</td>
                        <td className={'num ' + (r.profit < 0 ? 'text-red-700' : '')}>{fmtMoney(r.profit)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-xs text-stone-500 mt-2">
            Πωλήσεις και υλικά από τις καταχωρημένες πωλήσεις του μήνα (οι «Πωλήσεις ημέρας» μετράνε όταν κλείσουν). Υλικά = κόστος τη
            στιγμή της πώλησης· οι διαφορές απογραφής φαίνονται στο «Κόστος παραγωγής». Τιμές χωρίς ΦΠΑ.
          </p>
        </>
      )}
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  return (
    <div className={'card p-3 ' + (tone === 'good' ? 'border-emerald-300 bg-emerald-50' : tone === 'bad' ? 'border-red-300 bg-red-50' : '')}>
      <div className="text-xs text-stone-600">{label}</div>
      <div className={'text-xl font-bold tabular-nums ' + (tone === 'good' ? 'text-emerald-800' : tone === 'bad' ? 'text-red-700' : '')}>{value}</div>
    </div>
  )
}
