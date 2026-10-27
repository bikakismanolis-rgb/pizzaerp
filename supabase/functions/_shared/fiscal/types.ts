/**
 * Πάροχος ηλεκτρονικής έκδοσης παραστατικών (αδειοδοτημένος από την ΑΑΔΕ).
 * Κάθε πάροχος υλοποιεί το ίδιο interface. Ο νέος πάροχος = ένα αρχείο
 * δίπλα σε αυτό (π.χ. epsilon.ts) + μία γραμμή στο index.ts· τα κλειδιά του
 * στο integration_secret (fiscal_*). Η βάση δίνει το παραστατικό έτοιμο
 * (fiscal_begin): γραμμές, ΦΠΑ, πελάτη, εκδότη, σειρά και αριθμό.
 */

export interface FiscalLine {
  line_no: number
  code: string
  description: string
  unit: string
  qty: number
  unit_price: number
  discount_pct: number
  vat_rate: number
  net: number
  vat: number
  gross: number
  is_service: boolean
}

export interface FiscalDoc {
  id: string
  company_id: string
  kind: 'receipt' | 'invoice' | 'credit_invoice' | 'credit_receipt'
  /** τύπος myDATA: 11.1 απόδειξη, 1.1 τιμολόγιο, 5.1 πιστωτικό, 11.4 πιστωτικό λιανικής */
  mydata_type: string
  series: string
  number: number
  issue_date: string
  customer: null | {
    name: string; vat_no: string | null; tax_office: string | null; address: string | null; city: string | null
    postal_code: string | null; country: string; email: string | null; phone: string | null
  }
  lines: FiscalLine[]
  vat_breakdown: { vat_rate: number; net: number; vat: number; gross: number }[]
  total_net: number
  total_vat: number
  total_gross: number
  /** cash, card, online, iris, bank, credit */
  payment_method: string
  public_token: string
  /** ΜΑΡΚ, αν έχει ήδη εκδοθεί */
  mark?: string | null
}

export interface FiscalBegin {
  doc: FiscalDoc
  issuer: { name: string; vat_no: string | null; address: string | null; phone: string | null; activity: string | null
            tax_office: string | null; city: string | null; postal_code: string | null }
  settings: { provider: string; live: boolean }
  related: null | { series: string; number: number; mark: string | null; issue_date: string; mydata_type: string }
}

export interface FiscalResult {
  mark: string
  uid?: string
  qr_url?: string
  pdf_url?: string
  provider_ref?: string
  /** αν ο πάροχος δίνει δικό του αριθμό */
  number?: number
  raw?: unknown
}

export interface FiscalCtx {
  secrets: Record<string, string>
  live: boolean
  site: string
  fetch: typeof fetch
  now: () => number
}

export interface FiscalProvider {
  name: string
  /** ελληνικό όνομα για τις ρυθμίσεις */
  label: string
  issue(b: FiscalBegin, ctx: FiscalCtx): Promise<FiscalResult>
}

export class FiscalError extends Error {}

/** Κωδικοί myDATA που χρειάζονται συνήθως οι πάροχοι */
export const MYDATA_PAYMENT: Record<string, number> = {
  bank: 1,    // επαγγελματικός λογαριασμός πληρωμών ημεδαπής
  cash: 3,    // μετρητά
  credit: 5,  // επί πιστώσει
  card: 7,    // POS / e-POS
  online: 7,  // e-POS (Viva / Stripe)
  iris: 8,    // άμεσες πληρωμές IRIS
}

/** Κατηγορία ΦΠΑ myDATA από τον συντελεστή */
export function mydataVatCategory(rate: number): number {
  switch (Number(rate)) {
    case 24: return 1
    case 13: return 2
    case 6: return 3
    case 17: return 4
    case 9: return 5
    case 4: return 6
    case 0: return 7
    default: throw new FiscalError(`Άγνωστος συντελεστής ΦΠΑ για myDATA: ${rate}%`)
  }
}
