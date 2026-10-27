import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useCompanyId } from '../context/CompanyContext'
import { errMsg, supabase } from '../lib/supabase'
import { fmtDate, fmtMoney } from '../lib/format'
import { fmtPhone } from '../lib/online'
import { Confirm, Empty, ErrorBox, PageTitle, Spinner, useToast } from '../components/ui'

/**
 * Οι πελάτες του site (ανά τηλέφωνο): πόσες παραγγελίες, τζίρος, τελευταία.
 * «Σβήσε τα στοιχεία»: όταν το ζητήσει ο πελάτης (GDPR). Η πώληση μένει.
 */

interface Row { phone: string; name: string; address: string | null; orders: number; total: number; first_at: string; last_at: string }

const athensDate = (iso: string) => new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Europe/Athens' })

export function SiteCustomers() {
  const companyId = useCompanyId()
  const toast = useToast()
  const [rows, setRows] = useState<Row[] | null | 'missing'>(null)
  const [error, setError] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [forget, setForget] = useState<Row | null>(null)

  const load = useCallback(async () => {
    if (!companyId) return
    const { data, error: e } = await supabase.from('v_site_customer').select('*').eq('company_id', companyId)
      .order('last_at', { ascending: false }).limit(2000)
    if (e) {
      if (e.code === 'PGRST205' || e.code === '42P01' || /v_site_customer/.test(e.message)) { setRows('missing'); return }
      setError(errMsg(e)); return
    }
    setRows(((data ?? []) as Row[]).map((r) => ({ ...r, orders: Number(r.orders), total: Number(r.total) })))
  }, [companyId])
  useEffect(() => { load() }, [load])

  const shown = useMemo(() => {
    if (!Array.isArray(rows)) return []
    const t = q.trim().toLowerCase()
    const d = t.replace(/\D/g, '')
    return rows.filter((r) => !t || r.name.toLowerCase().includes(t) || (d && r.phone.includes(d)))
  }, [rows, q])

  const doForget = async () => {
    const r = forget
    setForget(null)
    if (!r) return
    const { data, error: e } = await supabase.rpc('customer_forget', { p_company: companyId, p_phone: r.phone })
    if (e) { toast.err(errMsg(e)); return }
    toast.ok(`Σβήστηκαν τα στοιχεία από ${data} ${Number(data) === 1 ? 'παραγγελία' : 'παραγγελίες'}.`)
    load()
  }

  if (rows === null && !error) return <Spinner />
  if (rows === 'missing') {
    return (
      <div>
        <PageTitle title="Πελάτες site" />
        <div className="card p-4 text-sm">Η βάση δεν έχει ακόμα αυτή τη λίστα. Χρειάζεται το <code>supabase/migrations/0006_pay_fiscal.sql</code> (βλ. README).</div>
      </div>
    )
  }

  return (
    <div>
      <PageTitle title="Πελάτες site">
        <Link to="/orders" className="btn-secondary">Παραγγελίες</Link>
      </PageTitle>
      <ErrorBox text={error} />
      <div className="card p-3 mb-3 flex flex-wrap items-center gap-3">
        <input className="input max-w-xs" placeholder="Όνομα ή τηλέφωνο..." value={q} onChange={(e) => setQ(e.target.value)} aria-label="Αναζήτηση πελάτη" />
        <div className="text-sm text-stone-600">{Array.isArray(rows) ? rows.length : 0} πελάτες</div>
      </div>
      {shown.length === 0 ? <Empty text="Κανένας πελάτης ακόμα." /> : (
        <div className="card overflow-x-auto">
          <table className="tbl">
            <thead><tr><th>Όνομα</th><th>Τηλέφωνο</th><th>Διεύθυνση</th><th className="num">Παραγγελίες</th><th className="num">Τζίρος</th><th>Τελευταία</th><th /></tr></thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.phone}>
                  <td className="font-medium">{r.name}</td>
                  <td className="whitespace-nowrap"><a className="text-red-700 underline" href={`tel:${r.phone}`}>{fmtPhone(r.phone)}</a></td>
                  <td className="text-stone-600">{r.address ?? ''}</td>
                  <td className="num">{r.orders}</td>
                  <td className="num">{fmtMoney(r.total)}</td>
                  <td className="whitespace-nowrap">{fmtDate(athensDate(r.last_at))}</td>
                  <td className="text-right"><button className="btn-ghost px-2 py-1 text-xs" onClick={() => setForget(r)}>Σβήσε τα στοιχεία…</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-stone-500 mt-3">
        Τα στοιχεία των πελατών σβήνονται μόνα τους 24 μήνες μετά από κάθε παραγγελία. Οι πωλήσεις μένουν, χωρίς όνομα και τηλέφωνο.
      </p>
      <Confirm open={!!forget} danger title="Διαγραφή στοιχείων πελάτη"
        text={forget ? `Θα σβηστούν όνομα, τηλέφωνο, διεύθυνση και σημειώσεις του «${forget.name}» από όλες τις παραγγελίες του (${forget.orders}). Οι πωλήσεις μένουν. Δεν αναιρείται. Το κάνει μόνο ο ιδιοκτήτης.` : ''}
        onNo={() => setForget(null)} onYes={doForget} />
    </div>
  )
}
