import { assert, assertEquals } from 'jsr:@std/assert@1'
import { handle as checkout } from '../shop-checkout/handler.ts'
import { handle as payReturn } from '../pay-return/handler.ts'
import { handle as webhook } from '../payments-webhook/handler.ts'
import { handle as refund } from '../pay-refund/handler.ts'
import { handle as fiscal } from '../fiscal-issue/handler.ts'
import { deps, fakeFetch, fakeRpc, jsonRes, post } from './helpers.ts'

const ORDER = '11111111-1111-1111-1111-111111111111'
const TOKEN = '22222222-2222-2222-2222-222222222222'
const COMPANY = '33333333-3333-3333-3333-333333333333'
const USER_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.sig'

const ctxRow = (over: Record<string, unknown> = {}) => ({
  order_id: ORDER, company_id: COMPANY, order_no: 12, token: TOKEN, total: 20.08, status: 'awaiting_payment',
  pay_status: 'pending', payment: 'online', customer_name: 'Γιώργος', phone: '6941234567',
  shop: { slug: 'pizza-gonia', title: 'Πιτσαρία', pay_provider: 'test', pay_live: false }, ...over,
})

const lineOrder = { name: 'Γιώργος', phone: '6941234567', mode: 'pickup', payment: 'online', lines: [{ item_id: ORDER, qty: 1 }] }

Deno.test('checkout: online → παραγγελία μέσω server, συνεδρία, payment_start, ανακατεύθυνση', async () => {
  const { rpc, calls } = fakeRpc({
    shop_checkout_info: { company_id: COMPANY, captcha_required: false, pay_provider: 'test' },
    service_secrets: {},
    place_order: { token: TOKEN, order_no: 12, order_id: ORDER },
    payment_context: ctxRow(),
    payment_start: 'pay-1',
  })
  const r = await checkout(post({ slug: 'pizza-gonia', order: lineOrder }), deps(rpc, fakeFetch([]).fetch))
  const j = await r.json()
  assertEquals(r.status, 200)
  assertEquals(j.token, TOKEN)
  assert(String(j.redirect).startsWith('https://pizza.example/pay/test?ref=T-'))
  assertEquals(calls.find((c) => c.name === 'place_order')!.as, 'service')
  const st = calls.find((c) => c.name === 'payment_start')!
  assertEquals([st.args.p_provider, st.args.p_amount], ['test', 20.08])
})

Deno.test('checkout: χωρίς online και χωρίς CAPTCHA → μόνο παραγγελία', async () => {
  const { rpc, calls } = fakeRpc({
    shop_checkout_info: { company_id: COMPANY, captcha_required: false, pay_provider: 'none' },
    place_order: { token: TOKEN, order_no: 3, order_id: ORDER },
  })
  const r = await checkout(post({ slug: 's', order: { ...lineOrder, payment: 'cash' } }), deps(rpc, fakeFetch([]).fetch))
  assertEquals(await r.json(), { token: TOKEN, order_no: 3 })
  assertEquals(calls.map((c) => c.name), ['shop_checkout_info', 'place_order'])
})

Deno.test('checkout: CAPTCHA που δεν περνά → καμία παραγγελία', async () => {
  const { rpc, calls } = fakeRpc({
    shop_checkout_info: { company_id: COMPANY, captcha_required: true, pay_provider: 'none' },
    service_secrets: { turnstile_secret: 'ts' },
  })
  const { fetch } = fakeFetch([[/siteverify/, () => jsonRes({ success: false })]])
  const r = await checkout(post({ slug: 's', order: { ...lineOrder, payment: 'cash' }, captcha: 'xxxxxxxxxxxx' }), deps(rpc, fetch))
  assertEquals(r.status, 400)
  assert((await r.json()).error.includes('δεν είμαι ρομπότ'))
  assert(!calls.some((c) => c.name === 'place_order'))
})

Deno.test('checkout: ο πάροχος δεν ξεκίνησε → η παραγγελία δεν μένει να περιμένει', async () => {
  const { rpc, calls } = fakeRpc({
    shop_checkout_info: { company_id: COMPANY, captcha_required: false, pay_provider: 'viva' },
    service_secrets: { viva_client_id: 'a', viva_client_secret: 'b' },
    place_order: { token: TOKEN, order_no: 12, order_id: ORDER },
    payment_context: ctxRow({ shop: { slug: 's', title: 't', pay_provider: 'viva', pay_live: false } }),
    payment_abort: null,
  })
  const { fetch } = fakeFetch([[/connect\/token/, () => new Response('no', { status: 401 })]])
  const r = await checkout(post({ slug: 's', order: lineOrder }), deps(rpc, fetch))
  assertEquals(r.status, 502)
  assert((await r.json()).error.includes('δεν ξεκίνησε'))
  assert(calls.some((c) => c.name === 'payment_abort'))
  assert(!calls.some((c) => c.name === 'payment_start'))
})

Deno.test('checkout: ξανά πληρωμή με το token του πελάτη', async () => {
  const { rpc } = fakeRpc({ payment_context: ctxRow({ pay_status: 'failed' }), service_secrets: {}, payment_start: 'p' })
  const r = await checkout(post({ retry_token: TOKEN }), deps(rpc, fakeFetch([]).fetch))
  assert((await r.json()).redirect)
  const { rpc: rpc2 } = fakeRpc({ payment_context: ctxRow({ status: 'new', pay_status: 'paid' }) })
  const r2 = await checkout(post({ retry_token: TOKEN }), deps(rpc2, fakeFetch([]).fetch))
  assertEquals(r2.status, 400)
})

Deno.test('επιστροφή πελάτη (test): πληρώθηκε → payment_confirm με το ποσό της βάσης', async () => {
  const { rpc, calls } = fakeRpc({
    payment_lookup: { order_id: ORDER, company_id: COMPANY, token: TOKEN, slug: 'pizza-gonia', amount: 20.08 },
    payment_context: ctxRow(),
    payment_confirm: { ok: true, refund: false, token: TOKEN },
  })
  const r = await payReturn(post({ provider: 'test', params: { ref: 'T-1', result: 'ok' } }), deps(rpc, fakeFetch([]).fetch))
  assertEquals(await r.json(), { token: TOKEN, slug: 'pizza-gonia', state: 'paid' })
  const c = calls.find((x) => x.name === 'payment_confirm')!
  assertEquals([c.args.p_ref, c.args.p_amount], ['T-1', 20.08])
})

Deno.test('επιστροφή πελάτη (test): όχι όταν το μαγαζί έχει αληθινό πάροχο', async () => {
  const { rpc } = fakeRpc({
    payment_lookup: { order_id: ORDER, company_id: COMPANY, token: TOKEN, slug: 's', amount: 20.08 },
    payment_context: ctxRow({ shop: { slug: 's', title: 't', pay_provider: 'viva', pay_live: true } }),
  })
  const r = await payReturn(post({ provider: 'test', params: { ref: 'T-1', result: 'ok' } }), deps(rpc, fakeFetch([]).fetch))
  assertEquals(r.status, 403)
})

Deno.test('επιστροφή πελάτη (test): πληρωμή αφού απορρίφθηκε → επιστροφή χρημάτων αμέσως', async () => {
  const { rpc, calls } = fakeRpc({
    payment_lookup: { order_id: ORDER, company_id: COMPANY, token: TOKEN, slug: 's', amount: 20.08 },
    payment_context: ctxRow(),
    payment_confirm: { ok: true, refund: true },
    refunds_due: [{ payment_id: 'p1', company_id: COMPANY, provider: 'test', provider_ref: 'T-1', transaction_id: 'TX', amount: 20.08 }],
    shop_pay_settings: { pay_live: false },
    service_secrets: {},
    payment_refunded: null,
  })
  await payReturn(post({ provider: 'test', params: { ref: 'T-1', result: 'ok' } }), deps(rpc, fakeFetch([]).fetch))
  const rf = calls.find((c) => c.name === 'payment_refunded')!
  assertEquals([rf.args.p_payment, rf.args.p_ok], ['p1', true])
})

Deno.test('webhook: λάθος διεύθυνση, άλλη εταιρεία αγνοείται', async () => {
  const { rpc } = fakeRpc({})
  assertEquals((await webhook(new Request('https://fn/x?provider=paypal&company=' + COMPANY, { method: 'POST' }), deps(rpc, fakeFetch([]).fetch))).status, 400)
  const ev = JSON.stringify({ EventTypeId: 1798, EventData: { OrderCode: 5, TransactionId: 't' } })
  const { rpc: rpc2, calls } = fakeRpc({
    shop_pay_settings: { pay_live: false },
    service_secrets: {},
    payment_lookup: { company_id: 'other' },
  })
  const r = await webhook(new Request(`https://fn/x?provider=viva&company=${COMPANY}`, { method: 'POST', body: ev }), deps(rpc2, fakeFetch([]).fetch))
  assertEquals((await r.json()).ignored, true)
  assert(!calls.some((c) => c.name === 'payment_failed'))
})

Deno.test('webhook Viva: GET επιβεβαίωση, POST πληρωμή → payment_confirm', async () => {
  const { rpc, calls } = fakeRpc({
    shop_pay_settings: { pay_live: false },
    service_secrets: { viva_client_id: 'a', viva_client_secret: 'b', viva_merchant_id: 'm', viva_api_key: 'k' },
    payment_lookup: { company_id: COMPANY, order_id: ORDER },
    payment_confirm: { ok: true },
  })
  const { fetch } = fakeFetch([
    [/messages\/config\/token/, () => jsonRes({ Key: 'K1' })],
    [/connect\/token/, () => jsonRes({ access_token: 'AT' })],
    [/transactions\/tx-9/, () => new Response('{"statusId":"F","amount":20.08,"orderCode":9876543210987654}')],
  ])
  const g = await webhook(new Request(`https://fn/x?provider=viva&company=${COMPANY}`), deps(rpc, fetch))
  assertEquals(await g.json(), { Key: 'K1' })
  const body = '{"EventTypeId":1796,"EventData":{"OrderCode":9876543210987654,"TransactionId":"tx-9"}}'
  const p = await webhook(new Request(`https://fn/x?provider=viva&company=${COMPANY}`, { method: 'POST', body }), deps(rpc, fetch))
  assertEquals(p.status, 200)
  const c = calls.find((x) => x.name === 'payment_confirm')!
  assertEquals([c.args.p_ref, c.args.p_transaction, c.args.p_amount], ['9876543210987654', 'tx-9', 20.08])
})

Deno.test('επιστροφή χρημάτων: χρειάζεται χρήστη, ελέγχεται από τη βάση ως αυτός', async () => {
  const { rpc } = fakeRpc({})
  assertEquals((await refund(post({ order_id: ORDER }), deps(rpc, fakeFetch([]).fetch))).status, 401)
  const { rpc: rpc2, calls } = fakeRpc({
    order_refund_request: true,
    refunds_due: [{ payment_id: 'p1', company_id: COMPANY, provider: 'stripe', provider_ref: 'cs', transaction_id: 'pi_1', amount: 20.08 }],
    shop_pay_settings: { pay_live: true },
    service_secrets: { stripe_secret_key: 'sk_live_1' },
    payment_refunded: null,
  })
  const { fetch } = fakeFetch([['https://api.stripe.com/v1/refunds', () => jsonRes({ error: { message: 'charge already refunded' } }, 400)]])
  const r = await refund(post({ order_id: ORDER }, { Authorization: `Bearer ${USER_JWT}` }), deps(rpc2, fetch))
  const j = await r.json()
  assertEquals(j.refunded, 0)
  assert(j.failed[0].includes('already refunded'))
  assertEquals(calls[0].as, { jwt: USER_JWT })
  assertEquals(calls.find((c) => c.name === 'payment_refunded')!.args.p_ok, false)
})

Deno.test('έκδοση παραστατικού: δοκιμαστικός πάροχος → fiscal_done με ΜΑΡΚ', async () => {
  const doc = {
    id: 'f1', company_id: COMPANY, kind: 'receipt', mydata_type: '11.1', series: 'ΑΛΠ', number: 4, issue_date: '2026-10-27',
    customer: null, total_net: 16, total_vat: 2.08, total_gross: 18.08, payment_method: 'cash', public_token: 'pt',
    vat_breakdown: [], lines: [{ line_no: 1, code: 'x', description: 'Μαργαρίτα', unit: 'τεμ', qty: 2, unit_price: 8, discount_pct: 0, vat_rate: 13, net: 16, vat: 2.08, gross: 18.08, is_service: false }],
  }
  const { rpc, calls } = fakeRpc({
    fiscal_check: { id: 'f1', status: 'draft' },
    fiscal_begin: { doc, issuer: { name: 'Π', vat_no: '094014201' }, settings: { provider: 'test', live: false }, related: null },
    service_secrets: {},
    fiscal_done: null,
  })
  const id = '44444444-4444-4444-4444-444444444444'
  const r = await fiscal(post({ id }, { Authorization: `Bearer ${USER_JWT}` }), deps(rpc, fakeFetch([]).fetch))
  const j = await r.json()
  assertEquals([r.status, j.status, j.series, j.number], [200, 'issued', 'ΑΛΠ', 4])
  assert(/^9\d{14}$/.test(j.mark))
  assertEquals(calls[0], { name: 'fiscal_check', args: { p_id: id }, as: { jwt: USER_JWT } })
  assertEquals(calls.find((c) => c.name === 'fiscal_done')!.args.p_ok, true)
})

Deno.test('έκδοση παραστατικού: πάροχος χωρίς σύνδεση → σφάλμα γραμμένο στη βάση', async () => {
  const { rpc, calls } = fakeRpc({
    fiscal_check: { id: 'f1', status: 'draft' },
    fiscal_begin: { doc: { company_id: COMPANY }, issuer: {}, settings: { provider: 'epsilon', live: true }, related: null },
    fiscal_done: null,
  })
  const r = await fiscal(post({ id: '44444444-4444-4444-4444-444444444444' }, { Authorization: `Bearer ${USER_JWT}` }), deps(rpc, fakeFetch([]).fetch))
  assertEquals(r.status, 400)
  assert((await r.json()).error.includes('epsilon'))
  assertEquals(calls.find((c) => c.name === 'fiscal_done')!.args.p_ok, false)
})
