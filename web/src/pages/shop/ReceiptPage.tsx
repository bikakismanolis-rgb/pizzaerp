import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { errMsg, supabase } from '../../lib/supabase'
import { fmtDate, fmtMoney, fmtQty } from '../../lib/format'
import { FISCAL_KIND_LABEL, FISCAL_PAYMENT_LABEL, type FiscalPublic } from '../../lib/fiscal'
import { qrSvg } from '../../lib/qr'
import { Centered, UUID_RE } from './shared'

/**
 * Το παραστατικό για τον πελάτη (/r/:token): απόδειξη, τιμολόγιο ή
 * πιστωτικό, όπως εκδόθηκε, με ΜΑΡΚ και QR. Τυπώνεται.
 */
export function ReceiptPage() {
  const { token = '' } = useParams()
  const [doc, setDoc] = useState<FiscalPublic | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!UUID_RE.test(token)) { setDoc(null); return }
    supabase.rpc('fiscal_public', { p_token: token }).then(({ data, error: e }) => {
      if (e) setError(errMsg(e))
      else setDoc((data as FiscalPublic | null) ?? null)
    })
  }, [token])
  useEffect(() => {
    if (doc) document.title = `${FISCAL_KIND_LABEL[doc.kind]} ${doc.series}-${doc.number} · ${doc.issuer.name}`
  }, [doc])

  if (doc === undefined) return <Centered>{error ?? 'Φόρτωση...'}</Centered>
  if (doc === null) return <Centered>Δεν βρέθηκε το παραστατικό.</Centered>

  const iss = doc.issuer
  const c = doc.customer
  const isInvoice = doc.kind === 'invoice' || doc.kind === 'credit_invoice'
  return (
    <div className="min-h-screen bg-stone-100 py-6 px-3 print:bg-white print:p-0">
      <div className="mx-auto max-w-md bg-white shadow-sm rounded-lg p-5 text-sm print:shadow-none print:max-w-none">
        {doc.test && (
          <div className="mb-3 rounded-md border-2 border-amber-500 text-amber-900 text-center font-bold py-1">
            ΔΟΚΙΜΑΣΤΙΚΟ · ΧΩΡΙΣ ΦΟΡΟΛΟΓΙΚΗ ΑΞΙΑ
          </div>
        )}
        <div className="text-center">
          <div className="text-lg font-bold">{iss.name}</div>
          {iss.activity && <div>{iss.activity}</div>}
          {iss.address && <div>{iss.address}{iss.city ? `, ${iss.city}` : ''}{iss.postal_code ? ` ${iss.postal_code}` : ''}</div>}
          <div>{iss.vat_no && <>ΑΦΜ {iss.vat_no}</>}{iss.tax_office && <> · ΔΟΥ {iss.tax_office}</>}</div>
          {iss.phone && <div>Τηλ. {iss.phone}</div>}
        </div>

        <div className="border-t border-dashed border-stone-300 my-3" />
        <div className="flex justify-between font-semibold">
          <span>{FISCAL_KIND_LABEL[doc.kind]}</span>
          <span>{doc.series}-{doc.number}</span>
        </div>
        <div className="flex justify-between text-stone-600">
          <span>{fmtDate(doc.issue_date)}</span>
          <span>{FISCAL_PAYMENT_LABEL[doc.payment_method] ?? doc.payment_method}</span>
        </div>
        {doc.related && (
          <div className="text-stone-600">Αφορά: {doc.related.series}-{doc.related.number}{doc.related.mark ? ` (ΜΑΡΚ ${doc.related.mark})` : ''}</div>
        )}

        {c && (isInvoice || c.vat_no) && (
          <div className="mt-3 rounded-md bg-stone-50 p-2">
            <div className="font-medium">{c.name}</div>
            {c.vat_no && <div>ΑΦΜ {c.vat_no}{c.tax_office ? ` · ΔΟΥ ${c.tax_office}` : ''}</div>}
            {c.address && <div>{c.address}{c.city ? `, ${c.city}` : ''}{c.postal_code ? ` ${c.postal_code}` : ''}</div>}
          </div>
        )}

        <table className="w-full mt-3">
          <thead>
            <tr className="text-left text-stone-500 border-b border-stone-200">
              <th className="py-1 font-normal">Είδος</th>
              <th className="py-1 font-normal text-right">Ποσ.</th>
              <th className="py-1 font-normal text-right">Τιμή</th>
              <th className="py-1 font-normal text-right">Αξία</th>
            </tr>
          </thead>
          <tbody>
            {doc.lines.map((l) => (
              <tr key={l.line_no} className="border-b border-stone-100 align-top">
                <td className="py-1">
                  {l.description}<span className="text-stone-400"> {l.vat_rate}%</span>
                  {Number(l.discount_pct) > 0 && <span className="block text-xs text-emerald-800">έκπτωση {Number(l.discount_pct)}%</span>}
                </td>
                <td className="py-1 text-right tabular-nums">{fmtQty(l.qty)}</td>
                <td className="py-1 text-right tabular-nums">{fmtMoney(l.qty ? l.gross / l.qty : 0)}</td>
                <td className="py-1 text-right tabular-nums">{fmtMoney(l.gross)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="mt-3 grid gap-0.5">
          {doc.vat_breakdown.map((v) => (
            <div key={v.vat_rate} className="flex justify-between text-stone-600">
              <span>ΦΠΑ {v.vat_rate}% σε {fmtMoney(v.net)}</span><span className="tabular-nums">{fmtMoney(v.vat)}</span>
            </div>
          ))}
          <div className="flex justify-between"><span>Καθαρή αξία</span><span className="tabular-nums">{fmtMoney(doc.total_net)}</span></div>
          <div className="flex justify-between"><span>ΦΠΑ</span><span className="tabular-nums">{fmtMoney(doc.total_vat)}</span></div>
          <div className="flex justify-between text-base font-bold"><span>Σύνολο</span><span className="tabular-nums">{fmtMoney(doc.total_gross)}</span></div>
        </div>

        <div className="border-t border-dashed border-stone-300 my-3" />
        {doc.mark && <div className="text-center">ΜΑΡΚ <span className="font-mono">{doc.mark}</span></div>}
        {doc.uid && <div className="text-center text-xs text-stone-500 break-all">UID {doc.uid}</div>}
        {doc.qr_url && (
          <div className="mx-auto mt-2 w-36" aria-label="QR του παραστατικού" dangerouslySetInnerHTML={{ __html: qrSvg(doc.qr_url) }} />
        )}

        <div className="mt-4 flex gap-2 justify-center print:hidden">
          <button className="btn-secondary" onClick={() => window.print()}>Εκτύπωση</button>
          {doc.pdf_url && <a className="btn-secondary" href={doc.pdf_url} target="_blank" rel="noreferrer">PDF</a>}
        </div>
      </div>
    </div>
  )
}
