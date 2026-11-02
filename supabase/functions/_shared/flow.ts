import type { Deps } from './env.ts'
import { HttpError } from './http.ts'
import { provider, ProviderError, type PayCtx } from './payments/index.ts'

/**
 * Κοινά βήματα πληρωμών: έναρξη (νέα ή ξανά πληρωμή), επιβεβαίωση από τον
 * πάροχο, επιστροφές. Η βάση κρατά την κατάσταση· εδώ μόνο οι κλήσεις στον
 * πάροχο.
 */

export interface PayContext {
  order_id: string
  company_id: string
  order_no: number
  token: string
  total: number
  status: string
  pay_status: string
  payment: string
  customer_name: string
  phone: string
  shop: { slug: string; title: string; pay_provider: string; pay_live: boolean }
}

export const secretsOf = (deps: Deps, company: string) =>
  deps.rpc<Record<string, string>>('service_secrets', { p_company: company }, 'service')

export function payCtx(deps: Deps, req: Request | undefined, secrets: Record<string, string>, live: boolean): PayCtx {
  let site = ''
  try { site = deps.site(req) } catch { /* τα webhooks δεν χρειάζονται site */ }
  return { secrets, live, site, fetch: deps.fetch, now: deps.now }
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Νέα συνεδρία στον πάροχο για μια παραγγελία που περιμένει πληρωμή */
export async function startPayment(deps: Deps, req: Request, c: PayContext, secrets?: Record<string, string>) {
  if (c.payment !== 'online' || !['awaiting_payment', 'expired'].includes(c.status) || !['pending', 'failed'].includes(c.pay_status)) {
    throw new HttpError(400, `Η παραγγελία #${c.order_no} δεν περιμένει πληρωμή.`)
  }
  const prov = provider(c.shop.pay_provider)
  const s = secrets ?? (await secretsOf(deps, c.company_id))
  let session
  try {
    session = await prov.createSession({
      orderId: c.order_id, orderNo: c.order_no, token: c.token, total: Number(c.total), slug: c.shop.slug,
      title: c.shop.title, customerName: c.customer_name, phone: c.phone,
    }, payCtx(deps, req, s, c.shop.pay_live))
  } catch (e) {
    await deps.rpc('payment_abort', { p_order: c.order_id, p_error: msg(e) }, 'service')
    const why = e instanceof ProviderError ? msg(e) : 'ο πάροχος δεν απάντησε'
    throw new HttpError(502, `Η online πληρωμή δεν ξεκίνησε (${why}). Δοκίμασε ξανά ή διάλεξε άλλο τρόπο πληρωμής.`)
  }
  await deps.rpc('payment_start', { p_order: c.order_id, p_provider: prov.name, p_ref: session.ref, p_amount: Number(c.total) }, 'service')
  return { token: c.token, order_no: c.order_no, redirect: session.url }
}

/** Επιστροφές που περιμένουν για μια παραγγελία: γίνονται τώρα */
export async function processRefunds(deps: Deps, orderId: string) {
  const due = await deps.rpc<{ payment_id: string; company_id: string; provider: string; provider_ref: string; transaction_id: string | null; amount: number }[]>(
    'refunds_due', { p_order: orderId }, 'service')
  const out = { refunded: 0, failed: [] as string[] }
  for (const p of due ?? []) {
    try {
      const settings = await deps.rpc<{ pay_live: boolean } | null>('shop_pay_settings', { p_company: p.company_id }, 'service')
      const secrets = await secretsOf(deps, p.company_id)
      await provider(p.provider).refund({ ref: p.provider_ref, transactionId: p.transaction_id, amount: Number(p.amount) },
        payCtx(deps, undefined, secrets, !!settings?.pay_live))
      await deps.rpc('payment_refunded', { p_payment: p.payment_id, p_ok: true, p_error: null, p_raw: null }, 'service')
      out.refunded++
    } catch (e) {
      await deps.rpc('payment_refunded', { p_payment: p.payment_id, p_ok: false, p_error: msg(e), p_raw: null }, 'service')
      out.failed.push(msg(e))
    }
  }
  return out
}

/** Ο πάροχος είπε «πληρώθηκε» / «απέτυχε»: η βάση ενημερώνεται */
export async function recordPaid(deps: Deps, prov: string, ref: string, tx: string, amount: number, raw: unknown) {
  const r = await deps.rpc<{ ok: boolean; refund?: boolean; order_id?: string; token?: string; reason?: string }>(
    'payment_confirm', { p_provider: prov, p_ref: ref, p_transaction: tx, p_amount: amount, p_raw: raw ?? null }, 'service')
  if (r?.ok && r.refund) {
    const look = await deps.rpc<{ order_id: string } | null>('payment_lookup', { p_provider: prov, p_ref: ref }, 'service')
    if (look) await processRefunds(deps, look.order_id)
  }
  return r
}

export const recordFailed = (deps: Deps, prov: string, ref: string, error: string | undefined, raw: unknown) =>
  deps.rpc('payment_failed', { p_provider: prov, p_ref: ref, p_error: error ?? null, p_raw: raw ?? null }, 'service')
