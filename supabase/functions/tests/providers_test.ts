import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1'
import { vivaProvider, bigField } from '../_shared/payments/viva.ts'
import { stripeProvider, verifyStripe } from '../_shared/payments/stripe.ts'
import { testProvider } from '../_shared/payments/test.ts'
import { testFiscal } from '../_shared/fiscal/test.ts'
import { mydataVatCategory, type FiscalBegin } from '../_shared/fiscal/types.ts'
import { verifyTurnstile } from '../_shared/captcha.ts'
import { cents } from '../_shared/http.ts'
import type { OrderForPay, PayCtx } from '../_shared/payments/types.ts'
import { fakeFetch, jsonRes } from './helpers.ts'

const order: OrderForPay = {
  orderId: '11111111-1111-1111-1111-111111111111', orderNo: 12, token: '22222222-2222-2222-2222-222222222222',
  total: 20.08, slug: 'pizza-gonia', title: 'Πιτσαρία Η Γωνιά', customerName: 'Γιώργος', phone: '6941234567',
}
const ctx = (f: typeof fetch, secrets: Record<string, string>, live = false): PayCtx =>
  ({ secrets, live, site: 'https://pizza.example', fetch: f, now: () => 1_800_000_000_000 })

const VIVA = { viva_client_id: 'cid', viva_client_secret: 'csec', viva_merchant_id: 'mid', viva_api_key: 'key', viva_source_code: '1234' }

Deno.test('λεπτά του ευρώ χωρίς λάθη στρογγύλευσης', () => {
  assertEquals(cents(20.08), 2008)
  assertEquals(cents(0.1 + 0.2), 30)
  assertEquals(cents(11.865), 1187)
})

Deno.test('Viva: token, παραγγελία, ανακατεύθυνση (demo), 16ψήφιος orderCode χωρίς απώλεια', async () => {
  const { fetch, calls } = fakeFetch([
    ['https://demo-accounts.vivapayments.com/connect/token', () => jsonRes({ access_token: 'AT' })],
    ['https://demo-api.vivapayments.com/checkout/v2/orders', () => new Response('{"orderCode":9876543210987654}', { status: 200 })],
  ])
  const s = await vivaProvider.createSession(order, ctx(fetch, VIVA))
  assertEquals(s.ref, '9876543210987654')
  assertEquals(s.url, 'https://demo.vivapayments.com/web/checkout?ref=9876543210987654')
  assertEquals(calls[0].headers.authorization, 'Basic ' + btoa('cid:csec'))
  assertEquals(calls[0].body, 'grant_type=client_credentials')
  const body = JSON.parse(calls[1].body)
  assertEquals(calls[1].headers.authorization, 'Bearer AT')
  assertEquals(body.amount, 2008)
  assertEquals(body.sourceCode, '1234')
  assertEquals(body.merchantTrns, order.orderId)
  assertEquals(body.customer.requestLang, 'el-GR')
  assertEquals(bigField('{"OrderCode": 1234567890123456789}', 'OrderCode'), '1234567890123456789')
})

Deno.test('Viva: live χρησιμοποιεί τις πραγματικές διευθύνσεις', async () => {
  const { fetch, calls } = fakeFetch([
    ['https://accounts.vivapayments.com/connect/token', () => jsonRes({ access_token: 'AT' })],
    ['https://api.vivapayments.com/checkout/v2/orders', () => jsonRes({ orderCode: 1 })],
  ])
  const s = await vivaProvider.createSession(order, ctx(fetch, VIVA, true))
  assertEquals(s.url, 'https://www.vivapayments.com/web/checkout?ref=1')
  assertEquals(calls.length, 2)
})

Deno.test('Viva: λείπουν κλειδιά → καθαρό μήνυμα', async () => {
  const { fetch } = fakeFetch([])
  await assertRejects(() => vivaProvider.createSession(order, ctx(fetch, {})), Error, 'viva_client_id, viva_client_secret')
})

Deno.test('Viva: έλεγχος συναλλαγής (F = πληρώθηκε, άλλη πληρωμή = όχι)', async () => {
  const { fetch } = fakeFetch([
    [/connect\/token/, () => jsonRes({ access_token: 'AT' })],
    [/transactions\/tx-ok/, () => new Response('{"statusId":"F","amount":20.08,"orderCode":9876543210987654}')],
    [/transactions\/tx-other/, () => new Response('{"statusId":"F","amount":20.08,"orderCode":1}')],
    [/transactions\/tx-pend/, () => new Response('{"statusId":"A","amount":20.08,"orderCode":9876543210987654}')],
  ])
  const c = ctx(fetch, VIVA)
  assertEquals((await vivaProvider.check('9876543210987654', { t: 'tx-ok' }, c, 20.08)).state, 'paid')
  assertEquals((await vivaProvider.check('9876543210987654', { t: 'tx-ok' }, c, 20.08)).amount, 20.08)
  assertEquals((await vivaProvider.check('9876543210987654', { t: 'tx-other' }, c, 20.08)).state, 'failed')
  assertEquals((await vivaProvider.check('9876543210987654', { t: 'tx-pend' }, c, 20.08)).state, 'pending')
  assertEquals((await vivaProvider.check('9876543210987654', {}, c, 20.08)).state, 'pending')
})

Deno.test('Viva webhook: GET δίνει το κλειδί επιβεβαίωσης, POST 1796 ελέγχεται στον Viva', async () => {
  const { fetch, calls } = fakeFetch([
    ['https://demo.vivapayments.com/api/messages/config/token', () => jsonRes({ Key: 'VERIFY' })],
    [/connect\/token/, () => jsonRes({ access_token: 'AT' })],
    [/transactions\/tx-1/, () => new Response('{"statusId":"F","amount":20.08,"orderCode":9876543210987654}')],
  ])
  const c = ctx(fetch, VIVA)
  const g = await vivaProvider.webhook(new Request('https://x/', { method: 'GET' }), c)
  assert(g.kind === 'reply')
  assertEquals(await g.response.json(), { Key: 'VERIFY' })
  assertEquals(calls[0].headers.authorization, 'Basic ' + btoa('mid:key'))
  const p = await vivaProvider.webhook(new Request('https://x/', {
    method: 'POST', body: '{"EventTypeId":1796,"EventData":{"OrderCode":9876543210987654,"TransactionId":"tx-1","StatusId":"F","Amount":20.08}}',
  }), c)
  assertEquals(p, { kind: 'paid', ref: '9876543210987654', transactionId: 'tx-1', amount: 20.08, raw: p.kind === 'paid' ? p.raw : null })
  const f = await vivaProvider.webhook(new Request('https://x/', {
    method: 'POST', body: '{"EventTypeId":1798,"EventData":{"OrderCode":9876543210987654,"TransactionId":"tx-2"}}',
  }), c)
  assertEquals(f.kind, 'failed')
  const i = await vivaProvider.webhook(new Request('https://x/', { method: 'POST', body: 'όχι json' }), c)
  assertEquals(i.kind, 'ignore')
})

Deno.test('Viva: επιστροφή ολόκληρου του ποσού, και με το νεότερο endpoint αν χρειαστεί', async () => {
  const { fetch, calls } = fakeFetch([
    [/^DELETE https:\/\/demo\.vivapayments\.com\/api\/transactions\/tx-1/, () => new Response('', { status: 404 })],
    [/connect\/token/, () => jsonRes({ access_token: 'AT' })],
    [/^DELETE https:\/\/demo-api\.vivapayments\.com\/acquiring\/v1\/transactions\/tx-1\?amount=2008/, () => jsonRes({ transactionId: 'r1' })],
  ])
  await vivaProvider.refund({ ref: '1', transactionId: 'tx-1', amount: 20.08 }, ctx(fetch, VIVA))
  assert(calls[0].url.endsWith('/api/transactions/tx-1?amount=2008'))
  assertEquals(calls.at(-1)!.headers.authorization, 'Bearer AT')
})

Deno.test('Stripe: Checkout Session με ένα ποσό, επιστροφή στη σελίδα της παραγγελίας', async () => {
  const { fetch, calls } = fakeFetch([
    ['https://api.stripe.com/v1/checkout/sessions', () => jsonRes({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' })],
  ])
  const s = await stripeProvider.createSession(order, ctx(fetch, { stripe_secret_key: 'sk_test_1' }))
  assertEquals(s, { ref: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' })
  const q = new URLSearchParams(calls[0].body)
  assertEquals(calls[0].headers.authorization, 'Bearer sk_test_1')
  assertEquals(q.get('line_items[0][price_data][unit_amount]'), '2008')
  assertEquals(q.get('line_items[0][price_data][currency]'), 'eur')
  assertEquals(q.get('success_url'), `https://pizza.example/s/pizza-gonia/o/${order.token}?pay=stripe&session_id={CHECKOUT_SESSION_ID}`)
  assertEquals(q.get('metadata[order_id]'), order.orderId)
  assertEquals(Number(q.get('expires_at')), 1_800_000_000 + 31 * 60)
})

async function stripeSig(payload: string, secret: string, t: number) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${payload}`))
  return `t=${t},v1=${Array.from(new Uint8Array(sig)).map((x) => x.toString(16).padStart(2, '0')).join('')}`
}

Deno.test('Stripe: υπογραφή webhook (σωστή, λάθος, παλιά)', async () => {
  const p = '{"a":1}'
  const now = 1_800_000_000_000
  assert(await verifyStripe(p, await stripeSig(p, 'whsec_1', now / 1000), 'whsec_1', now))
  assert(!(await verifyStripe(p, await stripeSig(p, 'whsec_2', now / 1000), 'whsec_1', now)))
  assert(!(await verifyStripe(p, await stripeSig(p, 'whsec_1', now / 1000 - 600), 'whsec_1', now)))
  assert(!(await verifyStripe(p, null, 'whsec_1', now)))
})

Deno.test('Stripe webhook: completed → πληρώθηκε, expired → απέτυχε, λάθος υπογραφή → σφάλμα', async () => {
  const { fetch } = fakeFetch([])
  const c = ctx(fetch, { stripe_secret_key: 'sk_test_1', stripe_webhook_secret: 'whsec_1' })
  const ev = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_1', payment_status: 'paid', payment_intent: 'pi_1', amount_total: 2008 } } })
  const r = await stripeProvider.webhook(new Request('https://x', { method: 'POST', body: ev, headers: { 'stripe-signature': await stripeSig(ev, 'whsec_1', 1_800_000_000) } }), c)
  assertEquals(r.kind === 'paid' && [r.ref, r.transactionId, r.amount], ['cs_1', 'pi_1', 20.08])
  const ex = JSON.stringify({ type: 'checkout.session.expired', data: { object: { id: 'cs_2', status: 'expired' } } })
  const r2 = await stripeProvider.webhook(new Request('https://x', { method: 'POST', body: ex, headers: { 'stripe-signature': await stripeSig(ex, 'whsec_1', 1_800_000_000) } }), c)
  assertEquals(r2.kind, 'failed')
  await assertRejects(() => stripeProvider.webhook(new Request('https://x', { method: 'POST', body: ev, headers: { 'stripe-signature': 't=1,v1=00' } }), c), Error, 'υπογραφή')
})

Deno.test('Stripe: έλεγχος επιστροφής πελάτη και επιστροφή χρημάτων', async () => {
  const { fetch, calls } = fakeFetch([
    ['https://api.stripe.com/v1/checkout/sessions/cs_1', () => jsonRes({ id: 'cs_1', payment_status: 'paid', payment_intent: 'pi_1', amount_total: 2008 })],
    ['https://api.stripe.com/v1/refunds', () => jsonRes({ id: 're_1' })],
  ])
  const c = ctx(fetch, { stripe_secret_key: 'sk_test_1' })
  const r = await stripeProvider.check('cs_1', {}, c, 20.08)
  assertEquals([r.state, r.transactionId, r.amount], ['paid', 'pi_1', 20.08])
  await stripeProvider.refund({ ref: 'cs_1', transactionId: 'pi_1', amount: 20.08 }, c)
  assertEquals(new URLSearchParams(calls[1].body).get('payment_intent'), 'pi_1')
})

Deno.test('δοκιμαστική πληρωμή', async () => {
  const { fetch } = fakeFetch([])
  const s = await testProvider.createSession(order, ctx(fetch, {}))
  assert(s.ref.startsWith('T-'))
  assert(s.url.startsWith('https://pizza.example/pay/test?'))
  assertEquals((await testProvider.check(s.ref, { result: 'ok' }, ctx(fetch, {}), 20.08)).amount, 20.08)
  assertEquals((await testProvider.check(s.ref, { result: 'fail' }, ctx(fetch, {}), 20.08)).state, 'failed')
})

Deno.test('CAPTCHA (Turnstile)', async () => {
  const { fetch, calls } = fakeFetch([['https://challenges.cloudflare.com/turnstile/v0/siteverify', (c) =>
    jsonRes({ success: new URLSearchParams(c.body).get('response') === 'token-good-123' })]])
  assert(await verifyTurnstile('token-good-123', 's', '1.2.3.4', fetch))
  assert(!(await verifyTurnstile('token-bad-1234', 's', null, fetch)))
  assert(!(await verifyTurnstile(undefined, 's', null, fetch)))
  assertEquals(new URLSearchParams(calls[0].body).get('remoteip'), '1.2.3.4')
})

const begin = (over: Partial<FiscalBegin['doc']> = {}): FiscalBegin => ({
  doc: {
    id: 'f1', company_id: 'c1', kind: 'receipt', mydata_type: '11.1', series: 'ΑΛΠ', number: 7, issue_date: '2026-10-27',
    customer: null, total_net: 17.77, total_vat: 2.31, total_gross: 20.08, payment_method: 'online', public_token: 'pt-1',
    lines: [{ line_no: 1, code: 'ΠΡ-001', description: 'Μαργαρίτα', unit: 'τεμ', qty: 2, unit_price: 8, discount_pct: 0, vat_rate: 13, net: 16, vat: 2.08, gross: 18.08, is_service: false },
            { line_no: 2, code: 'ΥΠ-ΜΕΤ', description: 'Μεταφορικά', unit: 'τεμ', qty: 1, unit_price: 1.6129, discount_pct: 0, vat_rate: 24, net: 1.61, vat: 0.39, gross: 2.0, is_service: true }],
    vat_breakdown: [], ...over,
  },
  issuer: { name: 'Πιτσαρία', vat_no: '094014201', address: null, phone: null, activity: null, tax_office: null, city: null, postal_code: null },
  settings: { provider: 'test', live: false },
  related: null,
})

Deno.test('δοκιμαστικός πάροχος παραστατικών: ΜΑΡΚ, QR στη σελίδα της απόδειξης, έλεγχοι', async () => {
  const { fetch } = fakeFetch([])
  const fc = { secrets: {}, live: false, site: 'https://pizza.example', fetch, now: () => 0 }
  const r = await testFiscal.issue(begin(), fc)
  assert(/^9\d{14}$/.test(r.mark))
  assertEquals(r.qr_url, 'https://pizza.example/r/pt-1')
  await assertRejects(() => testFiscal.issue(begin({ kind: 'invoice', mydata_type: '1.1' }), fc), Error, 'ΑΦΜ πελάτη')
  await assertRejects(() => testFiscal.issue(begin({ total_gross: 25 }), fc), Error, 'σύνολα')
  await assertRejects(() => testFiscal.issue({ ...begin({ kind: 'credit_receipt', mydata_type: '11.4' }), related: null }, fc), Error, 'ΜΑΡΚ')
  assertEquals([24, 13, 6, 0].map(mydataVatCategory), [1, 2, 3, 7])
})
