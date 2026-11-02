import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useCompanyId } from '../context/CompanyContext'
import { useMaster } from '../context/MasterData'
import { errMsg, supabase } from '../lib/supabase'
import type { Partner, PartnerPrice } from '../lib/types'
import { fmtDate, fmtMoney, parseAliases, toNum } from '../lib/format'
import { DOC_TYPE_LABEL, docCode } from '../lib/labels'
import { afmValid } from '../lib/fiscal'
import { qrSvg } from '../lib/qr'
import { Confirm, ErrorBox, Field, NumInput, PageTitle, Spinner, useToast, Empty } from '../components/ui'
import { useLoad } from '../lib/useLoad'
import type { DocType } from '../lib/types'

const emptyPartner = (company_id: string): Omit<Partner, 'id'> => ({
  company_id, code: '', name: '', is_customer: true, is_supplier: false, vat_no: null, phone: null, email: null,
  address: null, city: null, notes: null, is_active: true, aliases: [],
})

type Tab = 'info' | 'prices' | 'ledger'

export function PartnerEdit() {
  const { id } = useParams()
  const isNew = !id || id === 'new'
  const companyId = useCompanyId()
  const nav = useNavigate()
  const toast = useToast()
  const { refresh, partners } = useMaster()
  const [p, setP] = useState<Omit<Partner, 'id'> & { id?: string }>(emptyPartner(companyId))
  const [loading, setLoading] = useState(!isNew)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [askDelete, setAskDelete] = useState(false)
  const [tab, setTab] = useState<Tab>('info')
  const [aliasText, setAliasText] = useState('')

  useEffect(() => {
    if (isNew) return
    supabase.from('partner').select('*').eq('id', id).single().then(({ data, error: e }) => {
      if (e) setError(errMsg(e)); else { setP(data as Partner); setAliasText(((data as Partner).aliases ?? []).join(', ')) }
      setLoading(false)
    })
  }, [id, isNew])

  const set = <K extends keyof Partner>(k: K, v: Partner[K]) => setP((s) => ({ ...s, [k]: v }))
  // στοιχεία τιμολόγησης και σύνδεσμος παραγγελιών (0006)
  const has0006 = 'country' in p || partners.some((x) => 'country' in x)
  const country = (p.country ?? 'GR').toUpperCase()
  const vatClean = (v: string | null | undefined) => {
    const t = (v ?? '').trim()
    return country === 'GR' ? t.replace(/\s/g, '').replace(/^EL/i, '') : t
  }
  const afmWarn = has0006 && country === 'GR' && !!p.vat_no?.trim() && !afmValid(vatClean(p.vat_no))

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      const payload = {
        company_id: companyId, code: p.code.trim(), name: p.name.trim(), is_customer: p.is_customer, is_supplier: p.is_supplier,
        vat_no: vatClean(p.vat_no) || null, phone: p.phone?.trim() || null, email: p.email?.trim() || null,
        address: p.address?.trim() || null, city: p.city?.trim() || null, notes: p.notes?.trim() || null, is_active: p.is_active,
        aliases: parseAliases(aliasText),
        ...(has0006 ? {
          tax_office: p.tax_office?.trim() || null, postal_code: p.postal_code?.trim() || null,
          country: /^[A-Z]{2}$/.test(country) ? country : 'GR',
        } : {}),
      }
      if (isNew) {
        const { data, error: er } = await supabase.from('partner').insert(payload).select('id').single()
        if (er) throw er
        await refresh()
        toast.ok('Αποθηκεύτηκε')
        nav(`/partners/${(data as { id: string }).id}`)
      } else {
        const { error: er } = await supabase.from('partner').update(payload).eq('id', p.id!)
        if (er) throw er
        await refresh()
        toast.ok('Αποθηκεύτηκε')
      }
    } catch (err) { setError(errMsg(err)) } finally { setBusy(false) }
  }

  const doDelete = async () => {
    setAskDelete(false)
    const { error: er } = await supabase.from('partner').delete().eq('id', p.id!)
    if (er) { setError('Δεν διαγράφεται γιατί έχει παραστατικά. Μπορείς να τον κάνεις ανενεργό.'); return }
    await refresh()
    toast.ok('Διαγράφηκε')
    nav('/partners')
  }

  if (loading) return <Spinner />

  return (
    <div>
      <PageTitle title={isNew ? 'Νέος συναλλασσόμενος' : p.name}>
        <Link to="/partners" className="btn-secondary">Πίσω</Link>
        {!isNew && <button type="button" className="btn-danger" onClick={() => setAskDelete(true)}>Διαγραφή</button>}
      </PageTitle>
      <ErrorBox text={error} />

      {!isNew && (
        <div className="flex gap-1 mb-3 border-b border-stone-200">
          {([['info', 'Στοιχεία'], ['prices', 'Τιμές'], ['ledger', 'Καρτέλα']] as [Tab, string][]).map(([t, l]) => (
            <button key={t} className={'px-3 py-2 text-sm border-b-2 -mb-px ' + (tab === t ? 'border-red-700 text-red-700 font-medium' : 'border-transparent text-stone-600')} onClick={() => setTab(t)}>{l}</button>
          ))}
        </div>
      )}

      {tab === 'info' && (
        <form onSubmit={submit} className="card p-4 grid gap-3 sm:grid-cols-2 max-w-3xl">
          <div className="sm:col-span-2 flex gap-4 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" checked={p.is_customer} onChange={(e) => set('is_customer', e.target.checked)} /> Πελάτης</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={p.is_supplier} onChange={(e) => set('is_supplier', e.target.checked)} /> Προμηθευτής</label>
          </div>
          <Field label="Κωδικός"><input className="input" required value={p.code} onChange={(e) => set('code', e.target.value)} placeholder={p.is_supplier && !p.is_customer ? 'π.χ. ΠΡ-001' : 'π.χ. ΠΕ-001'} /></Field>
          <Field label="Όνομα"><input className="input" required value={p.name} onChange={(e) => set('name', e.target.value)} autoFocus={isNew} /></Field>
          <Field label="Άλλα ονόματα (πώς τον λέτε)" className="sm:col-span-2">
            <input className="input" value={aliasText} onChange={(e) => setAliasText(e.target.value)} placeholder="χωρισμένα με κόμμα, π.χ. μύλος, μυλωνάς" />
          </Field>
          <Field label="ΑΦΜ">
            <input className="input" value={p.vat_no ?? ''} onChange={(e) => set('vat_no', e.target.value)} />
            {afmWarn && <div className="text-xs text-amber-800 mt-1">Το ΑΦΜ δεν φαίνεται σωστό· τιμολόγιο θέλει σωστό ΑΦΜ.</div>}
          </Field>
          {has0006 && <Field label="ΔΟΥ"><input className="input" value={p.tax_office ?? ''} onChange={(e) => set('tax_office', e.target.value)} /></Field>}
          <Field label="Τηλέφωνο"><input className="input" value={p.phone ?? ''} onChange={(e) => set('phone', e.target.value)} /></Field>
          <Field label="Email"><input className="input" type="email" value={p.email ?? ''} onChange={(e) => set('email', e.target.value)} /></Field>
          <Field label="Πόλη"><input className="input" value={p.city ?? ''} onChange={(e) => set('city', e.target.value)} /></Field>
          <Field label="Διεύθυνση" className="sm:col-span-2"><input className="input" value={p.address ?? ''} onChange={(e) => set('address', e.target.value)} /></Field>
          {has0006 && (
            <>
              <Field label="ΤΚ"><input className="input" maxLength={10} value={p.postal_code ?? ''} onChange={(e) => set('postal_code', e.target.value)} /></Field>
              <Field label="Χώρα (GR, CY, DE...)"><input className="input uppercase" maxLength={2} value={p.country ?? 'GR'} onChange={(e) => set('country', e.target.value.toUpperCase())} /></Field>
            </>
          )}
          <Field label="Σημειώσεις" className="sm:col-span-2"><textarea className="input" rows={2} value={p.notes ?? ''} onChange={(e) => set('notes', e.target.value)} /></Field>
          <label className="text-sm flex items-center gap-2 sm:col-span-2"><input type="checkbox" checked={p.is_active} onChange={(e) => set('is_active', e.target.checked)} /> Ενεργός</label>
          <div className="sm:col-span-2 flex justify-end">
            <button className="btn-primary" disabled={busy || !p.code.trim() || !p.name.trim() || (!p.is_customer && !p.is_supplier)}>Αποθήκευση</button>
          </div>
        </form>
      )}

      {tab === 'info' && has0006 && p.id && p.is_customer && (
        <OrderLinkCard partnerId={p.id} token={p.order_token ?? null} onChange={(t) => set('order_token', t)} />
      )}

      {tab === 'prices' && p.id && <PricesTab partnerId={p.id} />}
      {tab === 'ledger' && p.id && <LedgerTab partnerId={p.id} />}

      <Confirm open={askDelete} title="Διαγραφή" text={`Να διαγραφεί ο/η "${p.name}";`} onYes={doDelete} onNo={() => setAskDelete(false)} danger />
    </div>
  )
}

// ---------------------------------------------------------------------
// Σύνδεσμος παραγγελιών (ξενοδοχεία, καφέ): ο πελάτης παραγγέλνει μόνος του
// ---------------------------------------------------------------------
function OrderLinkCard({ partnerId, token, onChange }: { partnerId: string; token: string | null; onChange: (t: string | null) => void }) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const url = token ? `${window.location.origin}/h/${token}` : null
  const act = async (action: 'get' | 'rotate' | 'off') => {
    setBusy(true)
    const { data, error } = await supabase.rpc('partner_order_link', { p_partner: partnerId, p_action: action })
    setBusy(false)
    if (error) { toast.err(errMsg(error)); return }
    onChange((data as string | null) ?? null)
    if (action === 'rotate') toast.ok('Νέος σύνδεσμος· ο παλιός δεν δουλεύει πια.')
    if (action === 'off') toast.ok('Ο σύνδεσμος σταμάτησε.')
  }
  return (
    <div className="card p-4 mt-4 max-w-3xl">
      <h2 className="font-semibold mb-1">Σύνδεσμος παραγγελιών</h2>
      <p className="text-sm text-stone-600 mb-3">
        Ο πελάτης ανοίγει τον σύνδεσμο από το κινητό, βλέπει τα είδη με τις δικές του τιμές και στέλνει παραγγελία.
        Γίνεται πρόχειρη πώληση χονδρικής· εσύ την ελέγχεις και την καταχωρείς (εμφανίζεται στις Παραγγελίες).
      </p>
      {!url ? (
        <button className="btn-primary" disabled={busy} onClick={() => act('get')}>Φτιάξε σύνδεσμο</button>
      ) : (
        <div className="flex flex-wrap gap-4 items-start">
          <div className="w-28 shrink-0" dangerouslySetInnerHTML={{ __html: qrSvg(url) }} aria-label="QR του συνδέσμου" />
          <div className="flex-1 min-w-[12rem] text-sm">
            <a className="text-red-700 underline break-all" href={url} target="_blank" rel="noreferrer">{url}</a>
            <div className="flex flex-wrap gap-2 mt-2">
              <button className="btn-secondary" onClick={() => { void navigator.clipboard?.writeText(url).then(() => toast.ok('Αντιγράφηκε')) }}>Αντιγραφή</button>
              <a className="btn-secondary" href={`https://wa.me/?text=${encodeURIComponent('Παραγγελίες από εδώ: ' + url)}`} target="_blank" rel="noreferrer">Στείλε με WhatsApp</a>
              <button className="btn-ghost" disabled={busy} onClick={() => act('rotate')}>Νέος σύνδεσμος</button>
              <button className="btn-ghost" disabled={busy} onClick={() => act('off')}>Σταμάτα</button>
            </div>
            <p className="text-xs text-stone-500 mt-2">Όποιος έχει τον σύνδεσμο μπορεί να στείλει παραγγελία· αν τον δώσατε λάθος, πάτα «Νέος σύνδεσμος».</p>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------
// Τιμοκατάλογος πελάτη
// ---------------------------------------------------------------------
function PricesTab({ partnerId }: { partnerId: string }) {
  const companyId = useCompanyId()
  const { items } = useMaster()
  const toast = useToast()
  const [prices, setPrices] = useState<Map<string, string>>(new Map())
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [q, setQ] = useState('')

  useEffect(() => {
    supabase.from('partner_price').select('*').eq('partner_id', partnerId).then(({ data }) => {
      setPrices(new Map(((data ?? []) as PartnerPrice[]).map((r) => [r.item_id, String(r.price)])))
      setLoading(false)
    })
  }, [partnerId])

  const finished = items.filter((i) => i.item_type === 'finished' && i.is_active)
    .filter((i) => !q.trim() || i.name.toLowerCase().includes(q.trim().toLowerCase()))

  const save = async () => {
    setBusy(true)
    try {
      const rows = [...prices.entries()].filter(([, v]) => v !== '' && v !== null).map(([item_id, v]) => ({ company_id: companyId, partner_id: partnerId, item_id, price: toNum(v) }))
      const { error: ed } = await supabase.from('partner_price').delete().eq('partner_id', partnerId)
      if (ed) throw ed
      if (rows.length) {
        const { error: ei } = await supabase.from('partner_price').insert(rows)
        if (ei) throw ei
      }
      toast.ok('Οι τιμές αποθηκεύτηκαν')
    } catch (e) { toast.err(errMsg(e)) } finally { setBusy(false) }
  }

  if (loading) return <Spinner />
  return (
    <div className="card p-4 max-w-3xl">
      <div className="text-sm text-stone-600 mb-3">Ειδικές τιμές για αυτόν τον πελάτη (χωρίς ΦΠΑ). Κενό = ισχύει η γενική τιμή του είδους.</div>
      <input className="input max-w-xs mb-3" placeholder="Αναζήτηση είδους..." value={q} onChange={(e) => setQ(e.target.value)} />
      {finished.length === 0 ? <Empty text="Δεν υπάρχουν έτοιμα προϊόντα." /> : (
        <table className="tbl">
          <thead><tr><th>Προϊόν</th><th className="num w-32">Γενική τιμή</th><th className="num w-36">Τιμή πελάτη</th></tr></thead>
          <tbody>
            {finished.map((i) => (
              <tr key={i.id}>
                <td>{i.name} <span className="text-xs text-stone-500">{i.code}</span></td>
                <td className="num">{fmtMoney(i.sale_price)}</td>
                <td><NumInput value={prices.get(i.id) ?? ''} onChange={(v) => setPrices(new Map(prices).set(i.id, v))} min={0} placeholder="—" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="flex justify-end mt-3"><button className="btn-primary" onClick={save} disabled={busy}>Αποθήκευση τιμών</button></div>
    </div>
  )
}

// ---------------------------------------------------------------------
// Καρτέλα συναλλασσόμενου
// ---------------------------------------------------------------------
interface LedgerRow { id: number; ledger: 'customer' | 'supplier'; move_date: string; debit: number; credit: number; doc_id: string; doc_type: DocType; doc_no: number; ref_no: string | null; running_balance: number }

function LedgerTab({ partnerId }: { partnerId: string }) {
  const [ledger, setLedger] = useState<'customer' | 'supplier'>('customer')
  const rows = useLoad(async () => {
    const { data, error } = await supabase.from('v_partner_ledger').select('*').eq('partner_id', partnerId).eq('ledger', ledger).order('move_date').order('id')
    if (error) throw error
    return data as LedgerRow[]
  }, [partnerId, ledger])
  const last = rows.data && rows.data.length ? rows.data[rows.data.length - 1].running_balance : 0
  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <select className="input max-w-[14rem]" value={ledger} onChange={(e) => setLedger(e.target.value as 'customer' | 'supplier')}>
          <option value="customer">Ως πελάτης (μας χρωστάει)</option>
          <option value="supplier">Ως προμηθευτής (του χρωστάμε)</option>
        </select>
        <div className="text-sm">Υπόλοιπο: <b>{fmtMoney(last)}</b></div>
      </div>
      {rows.loading ? <Spinner /> : !rows.data?.length ? <Empty text="Καμία κίνηση." /> : (
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead><tr><th>Ημ/νία</th><th>Παραστατικό</th><th>Αρ. προμηθευτή</th><th className="num">Χρέωση</th><th className="num">Πίστωση</th><th className="num">Υπόλοιπο</th></tr></thead>
            <tbody>
              {rows.data.map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap">{fmtDate(r.move_date)}</td>
                  <td><Link className="text-red-700 hover:underline" to={`/docs/${r.doc_type}/${r.doc_id}`}>{DOC_TYPE_LABEL[r.doc_type]} {docCode(r.doc_type, r.doc_no)}</Link></td>
                  <td>{r.ref_no}</td>
                  <td className="num">{r.debit ? fmtMoney(r.debit) : ''}</td>
                  <td className="num">{r.credit ? fmtMoney(r.credit) : ''}</td>
                  <td className="num">{fmtMoney(r.running_balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
