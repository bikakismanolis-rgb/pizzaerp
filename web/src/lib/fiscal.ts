import { errMsg, supabase } from './supabase'
import { callFunction } from './edge'

/**
 * Παραστατικά (0006): απόδειξη, τιμολόγιο, πιστωτικά. Το πρόχειρο το
 * φτιάχνει η βάση (fiscal_prepare), την έκδοση ο πάροχος μέσω της Edge
 * Function fiscal-issue· με «manual» γράφεται ο αριθμός της ταμειακής.
 */

export type FiscalKind = 'receipt' | 'invoice' | 'credit_invoice' | 'credit_receipt'
export type FiscalStatus = 'draft' | 'sending' | 'issued' | 'error'

export interface FiscalLine {
  line_no: number; code: string; description: string; unit: string; qty: number; unit_price: number
  discount_pct: number; vat_rate: number; net: number; vat: number; gross: number; is_service: boolean
}

export interface FiscalCustomer {
  name: string; vat_no: string | null; tax_office: string | null; address: string | null; city: string | null
  postal_code: string | null; country: string; email?: string | null; phone?: string | null
}

export interface FiscalDoc {
  id: string
  company_id: string
  kind: FiscalKind
  mydata_type: string
  series: string | null
  number: number | null
  issue_date: string
  sale_doc_id: string | null
  online_order_id: string | null
  related_id: string | null
  partner_id: string | null
  customer: FiscalCustomer | null
  lines: FiscalLine[]
  vat_breakdown: { vat_rate: number; net: number; vat: number; gross: number }[]
  total_net: number
  total_vat: number
  total_gross: number
  payment_method: string
  status: FiscalStatus
  provider: string
  mark: string | null
  uid: string | null
  qr_url: string | null
  pdf_url: string | null
  error: string | null
  public_token: string
  created_at: string
  issued_at: string | null
}

export interface FiscalSettings {
  company_id: string
  provider: string
  live: boolean
  auto_receipt: boolean
  series_receipt: string
  series_invoice: string
  series_credit: string
  series_credit_retail: string
  issuer_activity: string | null
  issuer_tax_office: string | null
  issuer_city: string | null
  issuer_postal_code: string | null
}

/** Δημόσια μορφή (fiscal_public): για τη σελίδα /r/:token */
export interface FiscalPublic {
  kind: FiscalKind; mydata_type: string; series: string; number: number; issue_date: string; issued_at: string
  mark: string | null; uid: string | null; qr_url: string | null; pdf_url: string | null; test: boolean
  customer: FiscalCustomer | null; lines: FiscalLine[]; vat_breakdown: FiscalDoc['vat_breakdown']
  total_net: number; total_vat: number; total_gross: number; payment_method: string
  related: { series: string; number: number; mark: string | null } | null
  issuer: { name: string; vat_no: string | null; address: string | null; phone: string | null; activity: string | null
            tax_office: string | null; city: string | null; postal_code: string | null }
}

export const FISCAL_KIND_LABEL: Record<FiscalKind, string> = {
  receipt: 'Απόδειξη λιανικής',
  invoice: 'Τιμολόγιο πώλησης',
  credit_invoice: 'Πιστωτικό τιμολόγιο',
  credit_receipt: 'Πιστωτικό λιανικής',
}

export const FISCAL_STATUS_LABEL: Record<FiscalStatus, string> = {
  draft: 'Πρόχειρο',
  sending: 'Εκδίδεται…',
  issued: 'Εκδόθηκε',
  error: 'Σφάλμα',
}

export const FISCAL_PAYMENT_LABEL: Record<string, string> = {
  cash: 'Μετρητά', card: 'Κάρτα', online: 'Online (κάρτα / IRIS)', iris: 'IRIS', bank: 'Τράπεζα', credit: 'Επί πιστώσει',
}

/** Πάροχοι στις ρυθμίσεις. Ο πάροχος της επιχείρησης μπαίνει εδώ όταν γραφτεί η σύνδεση του. */
export const FISCAL_PROVIDERS: { name: string; label: string; help: string }[] = [
  { name: 'none', label: 'Κανένας (χωρίς παραστατικά από εδώ)', help: 'Οι αποδείξεις και τα τιμολόγια βγαίνουν μόνο από την ταμειακή / το πρόγραμμα του λογιστή.' },
  { name: 'manual', label: 'Από την ταμειακή, με αριθμό', help: 'Το παραστατικό βγαίνει από την ταμειακή ή άλλο πρόγραμμα· εδώ γράφεις μόνο τον αριθμό του (και το ΜΑΡΚ αν θέλεις), για να ξέρεις τι κόπηκε.' },
  { name: 'test', label: 'Δοκιμαστικός (χωρίς φορολογική αξία)', help: 'Βγάζει παραστατικά με ψεύτικο ΜΑΡΚ, για να δοκιμάσεις όλη τη ροή. ΔΕΝ πάνε στην ΑΑΔΕ.' },
]

/** Ελληνικό ΑΦΜ: 9 ψηφία με σωστό ψηφίο ελέγχου (όπως ο έλεγχος της βάσης) */
export function afmValid(raw: string | null | undefined): boolean {
  const v = String(raw ?? '').replace(/\s/g, '').replace(/^EL/i, '')
  if (!/^\d{9}$/.test(v) || v === '000000000') return false
  let sum = 0
  for (let i = 0; i < 8; i++) sum += Number(v[i]) * 2 ** (8 - i)
  return (sum % 11) % 10 === Number(v[8])
}

export const fiscalCode = (f: Pick<FiscalDoc, 'series' | 'number'>): string =>
  f.series && f.number ? `${f.series}-${f.number}` : 'χωρίς αριθμό'

export const fiscalUrl = (token: string, origin = typeof window !== 'undefined' ? window.location.origin : ''): string =>
  `${origin}/r/${token}`

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args)
  if (error) throw new Error(errMsg(error))
  return data as T
}

export const loadFiscalSettings = async (companyId: string): Promise<FiscalSettings | null | 'missing'> => {
  const { data, error } = await supabase.from('fiscal_settings').select('*').eq('company_id', companyId).maybeSingle()
  if (error) {
    if (error.code === 'PGRST205' || error.code === '42P01' || /fiscal_settings/.test(error.message)) return 'missing'
    throw new Error(errMsg(error))
  }
  return (data as FiscalSettings | null) ?? null
}

/** Πρόχειρο (ή το υπάρχον πρόχειρο) */
export const prepareFiscal = (kind: FiscalKind, src: { saleDoc?: string; order?: string; related?: string }) =>
  rpc<string>('fiscal_prepare', { p_kind: kind, p_sale_doc: src.saleDoc ?? null, p_order: src.order ?? null, p_related: src.related ?? null })

/** Έκδοση από τον πάροχο (Edge Function) */
export const issueFiscal = (id: string) =>
  callFunction<{ status: string; series: string; number: number; mark: string; qr_url: string | null }>('fiscal-issue', { id })

export const recordManualFiscal = (id: string, number: number, mark: string | null, series: string | null) =>
  rpc<void>('fiscal_record_manual', { p_id: id, p_number: number, p_mark: mark, p_series: series })

export const discardFiscal = (id: string) => rpc<void>('fiscal_discard', { p_id: id })

/**
 * Από την αρχή ως το τέλος: πρόχειρο και, αν ο πάροχος δεν είναι «με το
 * χέρι», έκδοση. Επιστρέφει το παραστατικό όπως είναι μετά.
 */
export async function makeFiscal(kind: FiscalKind, src: { saleDoc?: string; order?: string; related?: string }): Promise<FiscalDoc> {
  const id = await prepareFiscal(kind, src)
  const { data: f } = await supabase.from('fiscal_doc').select('*').eq('id', id).single()
  const doc = f as FiscalDoc
  if (doc.provider !== 'manual' && doc.status !== 'issued') {
    try { await issueFiscal(id) } catch (e) {
      const { data: again } = await supabase.from('fiscal_doc').select('*').eq('id', id).single()
      throw Object.assign(new Error(e instanceof Error ? e.message : String(e)), { doc: again as FiscalDoc })
    }
  }
  const { data: after } = await supabase.from('fiscal_doc').select('*').eq('id', id).single()
  return after as FiscalDoc
}
