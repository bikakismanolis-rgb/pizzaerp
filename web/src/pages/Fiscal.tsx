import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useCompany } from '../context/CompanyContext'
import { errMsg, supabase } from '../lib/supabase'
import { fmtDate, fmtMoney, monthStart, round, today } from '../lib/format'
import {
  fiscalCode, FISCAL_KIND_LABEL, FISCAL_PAYMENT_LABEL, FISCAL_PROVIDERS, FISCAL_STATUS_LABEL, fiscalUrl, loadFiscalSettings,
  type FiscalDoc, type FiscalKind, type FiscalSettings,
} from '../lib/fiscal'
import { ErrorBox, Field, PageTitle, Spinner, useToast } from '../components/ui'
import { SecretField, useSecretNames } from '../components/Secrets'

/**
 * Παραστατικά (0006): η λίστα του μήνα (με εξαγωγή για τον λογιστή) και οι
 * ρυθμίσεις (τρόπος έκδοσης, σειρές, στοιχεία εκδότη).
 */

const missingDb = (
  <div className="card p-4 text-sm">Η βάση δεν έχει ακόμα τα παραστατικά. Χρειάζεται το <code>supabase/migrations/0006_pay_fiscal.sql</code> (βλ. README).</div>
)

const sign = (k: FiscalKind) => (k === 'credit_invoice' || k === 'credit_receipt' ? -1 : 1)

const nextMonth = (m: string) => {
  const [y, mo] = m.split('-').map(Number)
  return mo === 12 ? `${y + 1}-01-01` : `${y}-${String(mo + 1).padStart(2, '0')}-01`
}

export function FiscalList() {
  const { company } = useCompany()
  const [settings, setSettings] = useState<FiscalSettings | null | 'missing' | undefined>(undefined)
  const [month, setMonth] = useState(() => monthStart().slice(0, 7))
  const [kind, setKind] = useState<FiscalKind | ''>('')
  const [docs, setDocs] = useState<FiscalDoc[]>([])
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!company) return
    try {
      const s = await loadFiscalSettings(company.id)
      setSettings(s)
      if (s === 'missing') return
      const from = `${month}-01`
      let q = supabase.from('fiscal_doc').select('*').eq('company_id', company.id)
        .gte('issue_date', from).lt('issue_date', nextMonth(month))
      if (kind) q = q.eq('kind', kind)
      const { data, error: e } = await q.order('issue_date', { ascending: false }).order('created_at', { ascending: false }).limit(1000)
      if (e) throw e
      setDocs((data ?? []) as FiscalDoc[])
      setError(null)
    } catch (e) {
      setError(errMsg(e))
    }
  }, [company, month, kind])
  useEffect(() => { load() }, [load])

  const issued = docs.filter((d) => d.status === 'issued')
  const totals = useMemo(() => {
    const t = { net: 0, vat: 0, gross: 0, count: issued.length }
    for (const d of issued) {
      t.net += sign(d.kind) * Number(d.total_net); t.vat += sign(d.kind) * Number(d.total_vat); t.gross += sign(d.kind) * Number(d.total_gross)
    }
    return { ...t, net: round(t.net), vat: round(t.vat), gross: round(t.gross) }
  }, [issued])
  const pending = docs.filter((d) => d.status !== 'issued')

  const exportCsv = () => {
    const head = ['Ημερομηνία', 'Είδος', 'Τύπος myDATA', 'Σειρά', 'Αριθμός', 'Πελάτης', 'ΑΦΜ', 'Καθαρή αξία', 'ΦΠΑ', 'Σύνολο', 'Πληρωμή', 'ΜΑΡΚ', 'Πάροχος']
    const num = (v: number) => round(Number(v)).toFixed(2).replace('.', ',')
    const rows = issued.slice().reverse().map((d) => [
      fmtDate(d.issue_date), FISCAL_KIND_LABEL[d.kind], d.mydata_type, d.series ?? '', String(d.number ?? ''),
      d.customer?.name ?? '', d.customer?.vat_no ?? '', num(sign(d.kind) * d.total_net), num(sign(d.kind) * d.total_vat),
      num(sign(d.kind) * d.total_gross), FISCAL_PAYMENT_LABEL[d.payment_method] ?? d.payment_method, d.mark ?? '', d.provider,
    ])
    const esc = (c: string) => (/[;"\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)
    const csv = '﻿' + [head, ...rows].map((r) => r.map(esc).join(';')).join('\r\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    a.download = `parastatika-${month}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  if (settings === undefined && !error) return <Spinner />
  if (settings === 'missing') return <div><PageTitle title="Παραστατικά" />{missingDb}</div>

  return (
    <div>
      <PageTitle title="Παραστατικά">
        <Link to="/fiscal/settings" className="btn-secondary">Ρυθμίσεις</Link>
      </PageTitle>
      <ErrorBox text={error} />
      {(!settings || settings.provider === 'none') && (
        <div className="card p-4 mb-4 text-sm">
          Δεν έχει ρυθμιστεί ακόμα πώς βγαίνουν τα παραστατικά. <Link className="underline text-red-700" to="/fiscal/settings">Ρύθμισέ το</Link>.
        </div>
      )}
      {settings && settings.provider === 'test' && (
        <div className="rounded-md bg-amber-50 border border-amber-200 text-amber-900 text-sm px-3 py-2 mb-4">
          Δοκιμαστικός πάροχος: τα παραστατικά εδώ δεν έχουν φορολογική αξία και δεν πάνε στην ΑΑΔΕ.
        </div>
      )}

      <div className="card p-3 mb-4 flex flex-wrap items-end gap-3">
        <Field label="Μήνας"><input className="input" type="month" value={month} max={today().slice(0, 7)} onChange={(e) => e.target.value && setMonth(e.target.value)} /></Field>
        <Field label="Είδος">
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value as FiscalKind | '')}>
            <option value="">Όλα</option>
            {(Object.keys(FISCAL_KIND_LABEL) as FiscalKind[]).map((k) => <option key={k} value={k}>{FISCAL_KIND_LABEL[k]}</option>)}
          </select>
        </Field>
        <div className="flex-1" />
        <button className="btn-secondary" disabled={issued.length === 0} onClick={exportCsv}>Εξαγωγή για τον λογιστή (CSV)</button>
      </div>

      <div className="grid gap-3 sm:grid-cols-4 mb-4">
        <Stat label="Εκδομένα" value={String(totals.count)} />
        <Stat label="Καθαρή αξία" value={fmtMoney(totals.net)} />
        <Stat label="ΦΠΑ" value={fmtMoney(totals.vat)} />
        <Stat label="Σύνολο (μείον πιστωτικά)" value={fmtMoney(totals.gross)} />
      </div>

      {pending.length > 0 && (
        <div className="rounded-md bg-amber-50 border border-amber-200 text-amber-900 text-sm px-3 py-2 mb-4">
          {pending.length} {pending.length === 1 ? 'παραστατικό δεν έχει' : 'παραστατικά δεν έχουν'} εκδοθεί (πρόχειρα ή με σφάλμα). Άνοιξε την πώληση για «Ξανά έκδοση» ή «Σβήσε».
        </div>
      )}

      <div className="card overflow-x-auto">
        <table className="tbl">
          <thead>
            <tr><th>Ημ/νία</th><th>Είδος</th><th>Αριθμός</th><th>Πελάτης</th><th className="num">Σύνολο</th><th>Κατάσταση</th><th>ΜΑΡΚ</th><th /></tr>
          </thead>
          <tbody>
            {docs.length === 0 && <tr><td colSpan={8} className="text-center text-stone-500 py-6">Κανένα παραστατικό αυτόν τον μήνα.</td></tr>}
            {docs.map((d) => (
              <tr key={d.id}>
                <td>{fmtDate(d.issue_date)}</td>
                <td>{FISCAL_KIND_LABEL[d.kind]}</td>
                <td className="font-medium whitespace-nowrap">{fiscalCode(d)}</td>
                <td>{d.customer?.name ?? <span className="text-stone-400">λιανική</span>}</td>
                <td className="num">{fmtMoney(sign(d.kind) * Number(d.total_gross))}</td>
                <td>
                  <span className={'badge ' + (d.status === 'issued' ? 'bg-emerald-100 text-emerald-800' : d.status === 'error' ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-800')}>
                    {FISCAL_STATUS_LABEL[d.status]}
                  </span>
                  {d.error && <div className="text-xs text-red-800 max-w-xs">{d.error}</div>}
                </td>
                <td className="font-mono text-xs">{d.mark ?? ''}</td>
                <td className="text-right whitespace-nowrap">
                  {d.status === 'issued' && <a className="btn-ghost px-2 py-1 text-xs" href={fiscalUrl(d.public_token)} target="_blank" rel="noreferrer">Δες</a>}
                  {d.sale_doc_id && <Link className="btn-ghost px-2 py-1 text-xs" to={`/docs/sale/${d.sale_doc_id}`}>Πώληση</Link>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card p-3">
      <div className="text-xs text-stone-500">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  )
}

// ---------------------------------------------------------------------
// Ρυθμίσεις
// ---------------------------------------------------------------------
interface SForm {
  provider: string; live: boolean; auto_receipt: boolean
  series_receipt: string; series_invoice: string; series_credit: string; series_credit_retail: string
  issuer_activity: string; issuer_tax_office: string; issuer_city: string; issuer_postal_code: string
}

const toSForm = (s: FiscalSettings | null): SForm => ({
  provider: s?.provider ?? 'none', live: !!s?.live, auto_receipt: !!s?.auto_receipt,
  series_receipt: s?.series_receipt ?? 'ΑΛΠ', series_invoice: s?.series_invoice ?? 'ΤΠ',
  series_credit: s?.series_credit ?? 'ΠΤ', series_credit_retail: s?.series_credit_retail ?? 'ΠΛ',
  issuer_activity: s?.issuer_activity ?? '', issuer_tax_office: s?.issuer_tax_office ?? '',
  issuer_city: s?.issuer_city ?? '', issuer_postal_code: s?.issuer_postal_code ?? '',
})

export function FiscalSettingsPage() {
  const { company } = useCompany()
  const toast = useToast()
  const [settings, setSettings] = useState<FiscalSettings | null | 'missing' | undefined>(undefined)
  const [form, setForm] = useState<SForm | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { names, reload } = useSecretNames(company?.id ?? '')

  useEffect(() => {
    if (!company) return
    loadFiscalSettings(company.id).then((s) => {
      setSettings(s)
      if (s !== 'missing') setForm(toSForm(s))
    }).catch((e) => setError(errMsg(e)))
  }, [company])

  const set = <K extends keyof SForm>(k: K, v: SForm[K]) => setForm((f) => (f ? { ...f, [k]: v } : f))

  const save = async (e: FormEvent) => {
    e.preventDefault()
    if (!form || !company) return
    setError(null)
    const series = [form.series_receipt, form.series_invoice, form.series_credit, form.series_credit_retail].map((x) => x.trim())
    if (series.some((x) => x.length < 1 || x.length > 10)) { setError('Κάθε σειρά θέλει από 1 έως 10 χαρακτήρες.'); return }
    if (new Set(series).size !== series.length) { setError('Οι σειρές πρέπει να διαφέρουν μεταξύ τους.'); return }
    const payload = {
      company_id: company.id, provider: form.provider, live: form.live, auto_receipt: form.auto_receipt,
      series_receipt: series[0], series_invoice: series[1], series_credit: series[2], series_credit_retail: series[3],
      issuer_activity: form.issuer_activity.trim() || null, issuer_tax_office: form.issuer_tax_office.trim() || null,
      issuer_city: form.issuer_city.trim() || null, issuer_postal_code: form.issuer_postal_code.trim() || null,
    }
    setBusy(true)
    const { data, error: er } = await supabase.from('fiscal_settings').upsert(payload, { onConflict: 'company_id' }).select('*')
    setBusy(false)
    if (er) { setError(/row-level security/.test(er.message) ? 'Μόνο ο ιδιοκτήτης αλλάζει τις ρυθμίσεις παραστατικών.' : errMsg(er)); return }
    const row = (data ?? [])[0] as FiscalSettings | undefined
    if (!row) { setError('Μόνο ο ιδιοκτήτης αλλάζει τις ρυθμίσεις παραστατικών.'); return }
    setSettings(row)
    setForm(toSForm(row))
    toast.ok('Αποθηκεύτηκε')
  }

  if (settings === undefined && !error) return <Spinner />
  if (settings === 'missing') return <div><PageTitle title="Ρυθμίσεις παραστατικών" />{missingDb}</div>
  if (!form || !company) return <ErrorBox text={error} />

  const known = FISCAL_PROVIDERS.find((p) => p.name === form.provider)
  const real = !['none', 'manual', 'test'].includes(form.provider)

  return (
    <div>
      <PageTitle title="Ρυθμίσεις παραστατικών">
        <Link to="/fiscal" className="btn-secondary">Παραστατικά</Link>
      </PageTitle>
      <ErrorBox text={error} />
      <div className="grid gap-4 lg:grid-cols-2">
        <form onSubmit={save} className="card p-4 grid gap-3 content-start">
          <div>
            <span className="label">Πώς βγαίνουν οι αποδείξεις και τα τιμολόγια</span>
            <div className="grid gap-2">
              {FISCAL_PROVIDERS.map((p) => (
                <label key={p.name} className={'rounded-md border p-2 text-sm flex gap-2 ' + (form.provider === p.name ? 'border-red-700 bg-red-50' : 'border-stone-200')}>
                  <input type="radio" name="fiscal-provider" checked={form.provider === p.name} onChange={() => set('provider', p.name)} />
                  <span><b>{p.label}</b><br /><span className="text-stone-600">{p.help}</span></span>
                </label>
              ))}
              {real && !known && (
                <div className="rounded-md border border-red-700 bg-red-50 p-2 text-sm">Πάροχος: <b>{form.provider}</b></div>
              )}
            </div>
          </div>
          {real && (
            <label className="text-sm flex items-center gap-2">
              <input type="checkbox" checked={form.live} onChange={(e) => set('live', e.target.checked)} /> Πραγματική έκδοση (όχι δοκιμαστικό περιβάλλον του παρόχου)
            </label>
          )}
          {form.provider !== 'none' && form.provider !== 'manual' && (
            <label className="text-sm flex items-center gap-2">
              <input type="checkbox" checked={form.auto_receipt} onChange={(e) => set('auto_receipt', e.target.checked)} />
              Απόδειξη αυτόματα όταν γίνεται δεκτή online παραγγελία
            </label>
          )}

          <div className="grid gap-3 sm:grid-cols-2 border-t border-stone-200 pt-3">
            <Field label="Σειρά αποδείξεων"><input className="input" maxLength={10} value={form.series_receipt} onChange={(e) => set('series_receipt', e.target.value)} /></Field>
            <Field label="Σειρά τιμολογίων"><input className="input" maxLength={10} value={form.series_invoice} onChange={(e) => set('series_invoice', e.target.value)} /></Field>
            <Field label="Σειρά πιστωτικών τιμολογίων"><input className="input" maxLength={10} value={form.series_credit} onChange={(e) => set('series_credit', e.target.value)} /></Field>
            <Field label="Σειρά πιστωτικών λιανικής"><input className="input" maxLength={10} value={form.series_credit_retail} onChange={(e) => set('series_credit_retail', e.target.value)} /></Field>
          </div>
          <p className="text-xs text-stone-500 -mt-1">Οι σειρές και η αρίθμηση πρέπει να είναι αυτές που έχει δηλώσει ο λογιστής. Ο αριθμός μπαίνει τη στιγμή της έκδοσης, χωρίς κενά.</p>

          <div className="grid gap-3 sm:grid-cols-2 border-t border-stone-200 pt-3">
            <div className="sm:col-span-2 text-sm">
              Εκδότης: <b>{company.name}</b>{company.vat_no ? ` · ΑΦΜ ${company.vat_no}` : <span className="text-red-800"> · λείπει το ΑΦΜ της επιχείρησης</span>}
              {company.address ? ` · ${company.address}` : ''}
            </div>
            <Field label="Δραστηριότητα" className="sm:col-span-2"><input className="input" maxLength={120} value={form.issuer_activity} onChange={(e) => set('issuer_activity', e.target.value)} placeholder="π.χ. Παρασκευή και πώληση πίτσας" /></Field>
            <Field label="ΔΟΥ"><input className="input" maxLength={60} value={form.issuer_tax_office} onChange={(e) => set('issuer_tax_office', e.target.value)} /></Field>
            <Field label="Πόλη"><input className="input" maxLength={60} value={form.issuer_city} onChange={(e) => set('issuer_city', e.target.value)} /></Field>
            <Field label="ΤΚ"><input className="input" maxLength={10} value={form.issuer_postal_code} onChange={(e) => set('issuer_postal_code', e.target.value)} /></Field>
          </div>
          <div className="flex justify-end"><button className="btn-primary" disabled={busy}>Αποθήκευση</button></div>
        </form>

        <div className="grid gap-4 content-start">
          <div className="card p-4 text-sm grid gap-2">
            <h2 className="font-semibold">Τι ισχύει (σύντομα)</h2>
            <p>Νόμιμη απόδειξη ή τιμολόγιο βγάζει μόνο <b>πιστοποιημένος πάροχος ηλεκτρονικής τιμολόγησης</b>, η ταμειακή μηχανή (ΦΗΜ) ή το timologio της ΑΑΔΕ. Η εφαρμογή δεν τα αντικαθιστά: συνδέεται με αυτά.</p>
            <p>Μέχρι να ξέρεις ποιον πάροχο έχει ο λογιστής: διάλεξε «Από την ταμειακή, με αριθμό» και γράφε εδώ τον αριθμό κάθε απόδειξης, ή «Δοκιμαστικός» για να δεις όλη τη ροή.</p>
            <p>Όταν μάθεις τον πάροχο (π.χ. αυτόν που χρησιμοποιεί ήδη ο λογιστής), γράφεται η σύνδεσή του (ένα αρχείο στο <code>supabase/functions/_shared/fiscal/</code>) και εμφανίζεται εδώ. Τα κλειδιά του μπαίνουν από κάτω.</p>
            <p className="text-stone-600">Ρώτα τον λογιστή: ποιος πάροχος, ποιες σειρές, ΦΠΑ στα μεταφορικά, και από πότε ισχύει για την επιχείρηση η υποχρεωτική ηλεκτρονική τιμολόγηση.</p>
          </div>
          {real && (
            <div className="card p-4 grid gap-3">
              <h2 className="font-semibold">Κλειδιά του παρόχου</h2>
              <SecretField companyId={company.id} name={`fiscal_${form.provider}_key`} label="API key" saved={names[`fiscal_${form.provider}_key`]} onSaved={reload} />
              <SecretField companyId={company.id} name={`fiscal_${form.provider}_user`} label="Χρήστης / subscription (αν ζητά)" saved={names[`fiscal_${form.provider}_user`]} onSaved={reload} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
