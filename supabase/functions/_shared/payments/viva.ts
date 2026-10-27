import { cents, json } from '../http.ts'
import { need, ProviderError, type PayCtx, type PaymentProvider } from './types.ts'

/**
 * Viva.com Smart Checkout. Κλειδιά (Viva → Settings → API Access):
 *   viva_client_id, viva_client_secret   (Smart Checkout credentials, OAuth2)
 *   viva_merchant_id, viva_api_key       (webhooks και επιστροφές)
 *   viva_source_code                     (κωδικός πηγής πληρωμών, προαιρετικός: Default)
 * Στην πηγή πληρωμών του Viva: Success URL και Failure URL = <site>/pay/viva
 * (το Viva προσθέτει ?t=<transactionId>&s=<orderCode>). Webhook για
 * «Transaction Payment Created» και «Transaction Failed»:
 * <SUPABASE_URL>/functions/v1/payments-webhook?provider=viva&company=<id>
 * Με κάρτα, Apple Pay, Google Pay και IRIS (ανοιχτό για ελληνικά μαγαζιά).
 */

const HOSTS = {
  live: { www: 'https://www.vivapayments.com', api: 'https://api.vivapayments.com', accounts: 'https://accounts.vivapayments.com' },
  demo: { www: 'https://demo.vivapayments.com', api: 'https://demo-api.vivapayments.com', accounts: 'https://demo-accounts.vivapayments.com' },
}

const host = (ctx: PayCtx) => (ctx.live ? HOSTS.live : HOSTS.demo)
const basic = (a: string, b: string) => 'Basic ' + btoa(`${a}:${b}`)

/** ο orderCode είναι 16ψήφιος: διαβάζεται ως κείμενο, όχι ως αριθμός JS */
export function bigField(text: string, field: string): string | null {
  const m = new RegExp(`"${field}"\\s*:\\s*"?(\\d+)"?`, 'i').exec(text)
  return m ? m[1] : null
}

async function token(ctx: PayCtx): Promise<string> {
  const [id, secret] = need(ctx.secrets, 'viva_client_id', 'viva_client_secret')
  const r = await ctx.fetch(`${host(ctx).accounts}/connect/token`, {
    method: 'POST',
    headers: { Authorization: basic(id, secret), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  })
  const text = await r.text()
  if (!r.ok) throw new ProviderError(`Viva: δεν δέχτηκε τα κλειδιά (${r.status}). Έλεγξε client id / secret και demo ή live.`)
  const t = JSON.parse(text).access_token
  if (!t) throw new ProviderError('Viva: χωρίς access token')
  return t
}

async function transaction(id: string, ctx: PayCtx): Promise<{ text: string; status: number }> {
  const r = await ctx.fetch(`${host(ctx).api}/checkout/v2/transactions/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${await token(ctx)}` },
  })
  return { text: await r.text(), status: r.status }
}

export const vivaProvider: PaymentProvider = {
  name: 'viva',

  async createSession(o, ctx) {
    const body = {
      amount: cents(o.total),
      customerTrns: `Παραγγελία #${o.orderNo} · ${o.title}`.slice(0, 2048),
      customer: { fullName: o.customerName, phone: o.phone, countryCode: 'GR', requestLang: 'el-GR' },
      paymentTimeout: 1800,
      sourceCode: ctx.secrets.viva_source_code || 'Default',
      merchantTrns: o.orderId,
      disableCash: true,
      tags: ['pizzaerp'],
    }
    const r = await ctx.fetch(`${host(ctx).api}/checkout/v2/orders`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await token(ctx)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const text = await r.text()
    const code = r.ok ? bigField(text, 'orderCode') : null
    if (!code) throw new ProviderError(`Viva: δεν δημιουργήθηκε η πληρωμή (${r.status}) ${text.slice(0, 200)}`)
    return { ref: code, url: `${host(ctx).www}/web/checkout?ref=${code}` }
  },

  async check(ref, params, ctx) {
    const t = params.t
    if (!t) return { state: 'pending' }
    const { text, status } = await transaction(t, ctx)
    if (status === 404) return { state: 'failed', error: 'Viva: άγνωστη συναλλαγή' }
    if (status >= 400) throw new ProviderError(`Viva: δεν βρέθηκε η συναλλαγή (${status})`)
    const raw = JSON.parse(text)
    if (bigField(text, 'orderCode') !== ref) return { state: 'failed', error: 'Viva: η συναλλαγή είναι άλλης πληρωμής' }
    const st = String(raw.statusId ?? '')
    if (st === 'F') return { state: 'paid', transactionId: t, amount: Number(raw.amount), raw }
    if (st === 'A') return { state: 'pending', raw }
    return { state: 'failed', error: `Viva: κατάσταση ${st}`, raw }
  },

  async webhook(req, ctx) {
    // επιβεβαίωση της διεύθυνσης: το Viva κάνει GET και θέλει πίσω το κλειδί
    if (req.method === 'GET') {
      const [mid, key] = need(ctx.secrets, 'viva_merchant_id', 'viva_api_key')
      const r = await ctx.fetch(`${host(ctx).www}/api/messages/config/token`, { headers: { Authorization: basic(mid, key) } })
      if (!r.ok) throw new ProviderError(`Viva: δεν δόθηκε κλειδί webhook (${r.status}). Έλεγξε merchant id / API key.`)
      return { kind: 'reply', response: json(await r.json()) }
    }
    const text = await req.text()
    let ev: { EventTypeId?: number; EventData?: Record<string, unknown> }
    try { ev = JSON.parse(text) } catch { return { kind: 'ignore' } }
    const data = ev.EventData ?? {}
    const orderCode = bigField(text, 'OrderCode')
    const tx = typeof data.TransactionId === 'string' ? data.TransactionId : null
    if (!orderCode || !tx) return { kind: 'ignore' }
    if (ev.EventTypeId === 1796) {
      // τα webhooks του Viva δεν είναι υπογεγραμμένα: ρωτάμε τον ίδιο τον Viva
      const c = await vivaProvider.check(orderCode, { t: tx }, ctx, 0)
      if (c.state === 'paid') return { kind: 'paid', ref: orderCode, transactionId: tx, amount: c.amount ?? 0, raw: ev }
      if (c.state === 'failed') return { kind: 'failed', ref: orderCode, error: c.error, raw: ev }
      return { kind: 'ignore' }
    }
    if (ev.EventTypeId === 1798) return { kind: 'failed', ref: orderCode, error: 'Viva: η πληρωμή απέτυχε', raw: ev }
    return { kind: 'ignore' }
  },

  async refund(p, ctx) {
    if (!p.transactionId) throw new ProviderError('Viva: χωρίς αριθμό συναλλαγής για επιστροφή')
    const [mid, key] = need(ctx.secrets, 'viva_merchant_id', 'viva_api_key')
    const amount = cents(p.amount)
    // Cancel / refund transaction (επιστροφή ολόκληρου του ποσού)
    const r = await ctx.fetch(`${host(ctx).www}/api/transactions/${encodeURIComponent(p.transactionId)}?amount=${amount}`, {
      method: 'DELETE',
      headers: { Authorization: basic(mid, key) },
    })
    if (r.ok) return
    // νεότερο endpoint (OAuth2)
    const r2 = await ctx.fetch(`${host(ctx).api}/acquiring/v1/transactions/${encodeURIComponent(p.transactionId)}?amount=${amount}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${await token(ctx)}` },
    })
    if (!r2.ok) {
      throw new ProviderError(`Viva: η επιστροφή απέτυχε (${r.status}/${r2.status}). Κάν' την από το Viva (Πωλήσεις → Συναλλαγές) και έλεγξε ότι το API key επιτρέπει επιστροφές.`)
    }
  },
}
