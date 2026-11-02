import { FiscalError, mydataVatCategory, type FiscalProvider } from './types.ts'

/**
 * Δοκιμαστικός πάροχος: βγάζει «παραστατικό» με ψεύτικο ΜΑΡΚ, χωρίς καμία
 * σύνδεση με την ΑΑΔΕ και χωρίς φορολογική αξία. Για να δοκιμαστεί όλη η
 * ροή (κουμπιά, αρίθμηση, εκτύπωση, σύνδεσμος στον πελάτη) πριν από τον
 * αληθινό πάροχο. Κάνει και τους ελέγχους που θα έκανε ένας πάροχος.
 */
export const testFiscal: FiscalProvider = {
  name: 'test',
  label: 'Δοκιμαστικός (χωρίς αξία)',

  async issue(b, ctx) {
    const d = b.doc
    if (!b.issuer.vat_no) throw new FiscalError('Λείπει ο ΑΦΜ του μαγαζιού (στοιχεία εταιρείας).')
    for (const l of d.lines) mydataVatCategory(l.vat_rate)
    if (d.kind === 'invoice' && !d.customer?.vat_no) throw new FiscalError('Το τιμολόγιο θέλει ΑΦΜ πελάτη.')
    if ((d.kind === 'credit_invoice' || d.kind === 'credit_receipt') && !b.related?.mark) {
      throw new FiscalError('Το πιστωτικό θέλει το ΜΑΡΚ του αρχικού παραστατικού.')
    }
    const sum = d.lines.reduce((s, l) => s + Number(l.gross), 0)
    if (Math.abs(sum - Number(d.total_gross)) > 0.011) throw new FiscalError('Τα σύνολα δεν συμφωνούν με τις γραμμές.')

    const digits = Array.from(crypto.getRandomValues(new Uint8Array(14)), (x) => x % 10).join('')
    const src = `${b.issuer.vat_no}-${d.issue_date}-${d.series}-${d.number}-${d.mydata_type}`
    const uid = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(src))))
      .map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase()
    return {
      mark: '9' + digits,
      uid,
      qr_url: `${ctx.site}/r/${d.public_token}`,
      provider_ref: 'TEST-' + uid.slice(0, 8),
      raw: { test: true, at: new Date(ctx.now()).toISOString() },
    }
  },
}
