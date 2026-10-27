import { cents } from '../http.ts'
import { need, ProviderError, type PaymentProvider } from './types.ts'

/**
 * Stripe Checkout. Κλειδιά:
 *   stripe_secret_key      (sk_test_… για δοκιμές, sk_live_… για αληθινά)
 *   stripe_webhook_secret  (whsec_…, από το webhook endpoint)
 * Webhook: <SUPABASE_URL>/functions/v1/payments-webhook?provider=stripe&company=<id>
 * με τα events checkout.session.completed, checkout.session.async_payment_succeeded,
 * checkout.session.async_payment_failed, checkout.session.expired.
 */

const API = 'https://api.stripe.com/v1'

function form(obj: Record<string, string | number>): string {
  return Object.entries(obj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&')
}

async function call(path: string, key: string, f: typeof fetch, body?: Record<string, string | number>) {
  const r = await f(`${API}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    body: body ? form(body) : undefined,
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new ProviderError(`Stripe: ${j?.error?.message ?? r.status}`)
  return j
}

const enc = new TextEncoder()
const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, '0')).join('')

/** Έλεγχος υπογραφής Stripe-Signature (t=…,v1=…), ανοχή 5 λεπτά */
export async function verifyStripe(payload: string, header: string | null, secret: string, nowMs: number): Promise<boolean> {
  if (!header) return false
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=', 2) as [string, string]))
  const t = Number(parts.t)
  const sigs = header.split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3))
  if (!t || sigs.length === 0 || Math.abs(nowMs / 1000 - t) > 300) return false
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const expected = hex(await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${payload}`)))
  return sigs.some((s) => s.length === expected.length && timingSafeEqual(s, expected))
}

function timingSafeEqual(a: string, b: string): boolean {
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}

type Session = { id: string; url?: string; payment_status?: string; status?: string; payment_intent?: string | null; amount_total?: number }

function stateOf(s: Session) {
  if (s.payment_status === 'paid' || s.payment_status === 'no_payment_required') {
    return { state: 'paid' as const, transactionId: s.payment_intent ?? s.id, amount: (s.amount_total ?? 0) / 100 }
  }
  if (s.status === 'expired') return { state: 'failed' as const, error: 'Stripe: έληξε η πληρωμή' }
  return { state: 'pending' as const }
}

export const stripeProvider: PaymentProvider = {
  name: 'stripe',

  async createSession(o, ctx) {
    const [key] = need(ctx.secrets, 'stripe_secret_key')
    const back = `${ctx.site}/s/${o.slug}/o/${o.token}`
    const s: Session = await call('/checkout/sessions', key, ctx.fetch, {
      mode: 'payment',
      locale: 'el',
      success_url: `${back}?pay=stripe&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${back}?pay=cancel`,
      client_reference_id: o.orderId,
      'metadata[order_id]': o.orderId,
      'payment_intent_data[metadata][order_id]': o.orderId,
      'line_items[0][quantity]': 1,
      'line_items[0][price_data][currency]': 'eur',
      'line_items[0][price_data][unit_amount]': cents(o.total),
      'line_items[0][price_data][product_data][name]': `Παραγγελία #${o.orderNo} · ${o.title}`.slice(0, 250),
      expires_at: Math.floor(ctx.now() / 1000) + 31 * 60,
    })
    if (!s.id || !s.url) throw new ProviderError('Stripe: δεν δημιουργήθηκε η πληρωμή')
    return { ref: s.id, url: s.url }
  },

  async check(ref, _params, ctx) {
    const [key] = need(ctx.secrets, 'stripe_secret_key')
    const s: Session = await call(`/checkout/sessions/${encodeURIComponent(ref)}`, key, ctx.fetch)
    return { ...stateOf(s), raw: s }
  },

  async webhook(req, ctx) {
    const [secret] = need(ctx.secrets, 'stripe_webhook_secret')
    const payload = await req.text()
    if (!(await verifyStripe(payload, req.headers.get('stripe-signature'), secret, ctx.now()))) {
      throw new ProviderError('Stripe: λάθος υπογραφή webhook')
    }
    const ev = JSON.parse(payload) as { type: string; data: { object: Session } }
    const s = ev.data?.object
    if (!s?.id) return { kind: 'ignore' }
    switch (ev.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        const st = stateOf(s)
        return st.state === 'paid' ? { kind: 'paid', ref: s.id, transactionId: st.transactionId, amount: st.amount, raw: ev } : { kind: 'ignore' }
      }
      case 'checkout.session.async_payment_failed':
      case 'checkout.session.expired':
        return { kind: 'failed', ref: s.id, error: ev.type, raw: ev }
      default:
        return { kind: 'ignore' }
    }
  },

  async refund(p, ctx) {
    const [key] = need(ctx.secrets, 'stripe_secret_key')
    if (!p.transactionId) throw new ProviderError('Stripe: χωρίς payment intent για επιστροφή')
    await call('/refunds', key, ctx.fetch, { payment_intent: p.transactionId, amount: cents(p.amount) })
  },
}
