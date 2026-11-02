import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useCompanyId } from '../context/CompanyContext'
import { supabase } from '../lib/supabase'
import { fmtMoney } from '../lib/format'
import {
  discardFiscal, fiscalCode, FISCAL_KIND_LABEL, FISCAL_STATUS_LABEL, fiscalUrl, issueFiscal, loadFiscalSettings, makeFiscal,
  recordManualFiscal, type FiscalDoc, type FiscalKind, type FiscalSettings,
} from '../lib/fiscal'
import { Confirm, useToast } from './ui'

/**
 * Τα παραστατικά μιας πώλησης ή μιας online παραγγελίας: απόδειξη ή
 * τιμολόγιο, πιστωτικό, ξανά έκδοση, αριθμός από την ταμειακή.
 * compact: μία γραμμή (οθόνη Παραγγελίες).
 */
export function FiscalBox({ saleDoc, order, canInvoice = false, compact = false, allowNew = true, onChange }: {
  saleDoc?: string | null; order?: string | null; canInvoice?: boolean; compact?: boolean
  /** false: μόνο όσα υπάρχουν (π.χ. ακυρωμένη παραγγελία, για πιστωτικό) */
  allowNew?: boolean; onChange?: () => void
}) {
  const companyId = useCompanyId()
  const toast = useToast()
  const [settings, setSettings] = useState<FiscalSettings | null | 'missing' | undefined>(undefined)
  const [docs, setDocs] = useState<FiscalDoc[]>([])
  const [busy, setBusy] = useState(false)
  const [credit, setCredit] = useState<FiscalDoc | null>(null)

  const load = useCallback(async () => {
    if (!companyId || (!saleDoc && !order)) return
    try {
      const s = await loadFiscalSettings(companyId)
      setSettings(s)
      if (s === 'missing') return
      let q = supabase.from('fiscal_doc').select('*').eq('company_id', companyId)
      q = saleDoc ? q.eq('sale_doc_id', saleDoc) : q.eq('online_order_id', order!)
      const { data } = await q.order('created_at')
      setDocs((data ?? []) as FiscalDoc[])
    } catch {
      setSettings('missing')
    }
  }, [companyId, saleDoc, order])
  useEffect(() => { load() }, [load])

  const run = async (fn: () => Promise<string | void>) => {
    setBusy(true)
    try {
      const t = await fn()
      if (t) toast.ok(t)
    } catch (e) {
      toast.err(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      await load()
      onChange?.()
    }
  }

  const make = (kind: FiscalKind, src: { saleDoc?: string; order?: string; related?: string }) => run(async () => {
    const d = await makeFiscal(kind, src)
    return d.status === 'issued' ? `Βγήκε: ${FISCAL_KIND_LABEL[d.kind]} ${fiscalCode(d)}` : 'Γράψε τον αριθμό από την ταμειακή.'
  })

  if (settings === undefined || settings === 'missing') return null
  const off = !settings || settings.provider === 'none'
  if (off) {
    if (compact) return null
    return (
      <div className="text-sm text-stone-500">
        Παραστατικά: δεν έχει ρυθμιστεί τρόπος έκδοσης (<Link className="underline" to="/fiscal/settings">Ρυθμίσεις παραστατικών</Link>).
      </div>
    )
  }

  const credited = (d: FiscalDoc) => docs.some((c) => c.related_id === d.id && c.status === 'issued')
  const main = docs.filter((d) => d.kind === 'receipt' || d.kind === 'invoice')
  const active = main.find((d) => !credited(d))
  const src = saleDoc ? { saleDoc } : { order: order! }
  if (!allowNew && docs.length === 0) return null

  return (
    <div className={compact ? 'flex flex-wrap items-center gap-2 text-sm' : 'grid gap-2 text-sm'}>
      {docs.map((d) => (
        <DocRow key={d.id} d={d} compact={compact} busy={busy} credited={credited(d)}
          onIssue={() => run(async () => { await issueFiscal(d.id); return `Βγήκε: ${FISCAL_KIND_LABEL[d.kind]}` })}
          onDiscard={() => run(async () => { await discardFiscal(d.id); return 'Σβήστηκε το πρόχειρο.' })}
          onManual={(n, mark) => run(async () => { await recordManualFiscal(d.id, n, mark, null); return 'Γράφτηκε ο αριθμός.' })}
          onCredit={() => setCredit(d)} />
      ))}
      {!active && allowNew && (
        <div className="flex flex-wrap gap-2">
          <button className={compact ? 'btn-secondary px-3 py-1.5' : 'btn-secondary'} disabled={busy} onClick={() => make('receipt', src)}>
            🧾 {main.length ? 'Νέα απόδειξη' : 'Απόδειξη'}
          </button>
          {canInvoice && <button className="btn-secondary" disabled={busy} onClick={() => make('invoice', src)}>Τιμολόγιο</button>}
        </div>
      )}
      {settings.provider === 'test' && !compact && <div className="text-xs text-amber-800">Δοκιμαστικός πάροχος: τα παραστατικά δεν έχουν φορολογική αξία.</div>}
      <Confirm open={!!credit} title="Πιστωτικό" danger
        text={credit ? `Θα βγει ${credit.kind === 'invoice' ? 'πιστωτικό τιμολόγιο' : 'πιστωτικό λιανικής'} για ολόκληρο το ${fiscalCode(credit)} (${fmtMoney(credit.total_gross)}). Η πώληση στην αποθήκη δεν αλλάζει· αν γύρισαν είδη, κάνε και επιστροφή.` : ''}
        onNo={() => setCredit(null)}
        onYes={() => { const c = credit!; setCredit(null); void make(c.kind === 'invoice' ? 'credit_invoice' : 'credit_receipt', { related: c.id }) }} />
    </div>
  )
}

function DocRow({ d, compact, busy, credited, onIssue, onDiscard, onManual, onCredit }: {
  d: FiscalDoc; compact: boolean; busy: boolean; credited: boolean
  onIssue: () => void; onDiscard: () => void; onManual: (n: number, mark: string | null) => void; onCredit: () => void
}) {
  const [no, setNo] = useState('')
  const [mark, setMark] = useState('')
  const isCredit = d.kind === 'credit_invoice' || d.kind === 'credit_receipt'
  const tone = d.status === 'issued' ? (credited ? 'text-stone-400 line-through' : 'text-emerald-800')
    : d.status === 'error' ? 'text-red-800' : 'text-amber-800'
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const n = Number(no)
    if (!Number.isInteger(n) || n < 1) return
    onManual(n, mark.trim() || null)
  }
  const small = compact ? 'px-2 py-1 text-xs' : ''
  return (
    <div className={compact ? 'flex flex-wrap items-center gap-2' : 'rounded-md border border-stone-200 p-2 flex flex-wrap items-center gap-2'}>
      <span className={'font-medium ' + tone}>
        {FISCAL_KIND_LABEL[d.kind]} {d.status === 'issued' ? fiscalCode(d) : `(${FISCAL_STATUS_LABEL[d.status]})`}
      </span>
      {!compact && d.mark && <span className="text-xs text-stone-500">ΜΑΡΚ {d.mark}</span>}
      {d.status === 'issued' && (
        <a className={'btn-ghost ' + small} href={fiscalUrl(d.public_token)} target="_blank" rel="noreferrer">Δες</a>
      )}
      {d.status === 'issued' && !isCredit && !credited && (
        <button className={'btn-ghost ' + small} disabled={busy} onClick={onCredit}>Πιστωτικό…</button>
      )}
      {(d.status === 'error' || d.status === 'sending' || (d.status === 'draft' && d.provider !== 'manual')) && (
        <button className={'btn-secondary ' + small} disabled={busy} onClick={onIssue}>{d.status === 'draft' ? 'Έκδοση' : 'Ξανά έκδοση'}</button>
      )}
      {(d.status === 'draft' || d.status === 'error') && (
        <button className={'btn-ghost ' + small} disabled={busy} onClick={onDiscard}>Σβήσε</button>
      )}
      {d.status === 'draft' && d.provider === 'manual' && (
        <form onSubmit={submit} className="flex flex-wrap gap-2 w-full">
          <input className="input w-28" inputMode="numeric" placeholder="Αριθμός" aria-label="Αριθμός παραστατικού" value={no} onChange={(e) => setNo(e.target.value.replace(/\D/g, ''))} />
          {!compact && <input className="input w-48" inputMode="numeric" placeholder="ΜΑΡΚ (προαιρετικό)" aria-label="ΜΑΡΚ" value={mark} onChange={(e) => setMark(e.target.value.replace(/\D/g, ''))} />}
          <button className={'btn-primary ' + small} disabled={busy || !no}>Γράψε</button>
        </form>
      )}
      {d.status === 'error' && d.error && <div className="w-full text-xs text-red-800">{d.error}</div>}
    </div>
  )
}
