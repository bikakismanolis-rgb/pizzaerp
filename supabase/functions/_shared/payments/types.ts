/**
 * Πάροχος online πληρωμών. Κάθε πάροχος (test, viva, stripe) υλοποιεί το
 * ίδιο interface· τα κλειδιά του είναι στο integration_secret της εταιρείας.
 */

export type ProviderName = 'test' | 'viva' | 'stripe'

export interface PayCtx {
  secrets: Record<string, string>
  /** Viva: πραγματικά λεφτά (αλλιώς demo)· Stripe: το καθορίζει το κλειδί */
  live: boolean
  /** https://to-site, για τις επιστροφές του πελάτη */
  site: string
  fetch: typeof fetch
  now: () => number
}

export interface OrderForPay {
  orderId: string
  orderNo: number
  token: string
  /** σε ευρώ, με ΦΠΑ και μεταφορικά */
  total: number
  slug: string
  title: string
  customerName: string
  phone: string
}

export interface PaySession {
  /** αναγνωριστικό στον πάροχο (Viva orderCode, Stripe session id) */
  ref: string
  /** πού πάει ο πελάτης για να πληρώσει */
  url: string
}

export type PayState = 'paid' | 'pending' | 'failed'

export interface PayCheck {
  state: PayState
  transactionId?: string
  /** σε ευρώ, όπως το λέει ο πάροχος */
  amount?: number
  raw?: unknown
  error?: string
}

/** Ό,τι κατάλαβε ο πάροχος από ένα webhook */
export type WebhookEvent =
  | { kind: 'reply'; response: Response }
  | { kind: 'paid'; ref: string; transactionId: string; amount: number; raw?: unknown }
  | { kind: 'failed'; ref: string; error?: string; raw?: unknown }
  | { kind: 'ignore' }

export interface PaymentProvider {
  name: ProviderName
  createSession(o: OrderForPay, ctx: PayCtx): Promise<PaySession>
  /** επιστροφή του πελάτη: τι ισχύει στ' αλήθεια (ρωτώντας τον πάροχο) */
  check(ref: string, params: Record<string, string>, ctx: PayCtx, expected: number): Promise<PayCheck>
  webhook(req: Request, ctx: PayCtx): Promise<WebhookEvent>
  refund(p: { ref: string; transactionId: string | null; amount: number }, ctx: PayCtx): Promise<void>
}

export class ProviderError extends Error {}

export function need(secrets: Record<string, string>, ...names: string[]): string[] {
  const missing = names.filter((n) => !secrets[n])
  if (missing.length) throw new ProviderError(`Λείπουν κλειδιά του παρόχου στις Ρυθμίσεις: ${missing.join(', ')}`)
  return names.map((n) => secrets[n])
}
