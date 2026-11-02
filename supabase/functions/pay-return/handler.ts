import type { Deps } from '../_shared/env.ts'
import { payCtx, recordFailed, recordPaid, secretsOf, type PayContext } from '../_shared/flow.ts'
import { CORS, fail, HttpError, json, readJson } from '../_shared/http.ts'
import { provider } from '../_shared/payments/index.ts'

/**
 * Ο πελάτης γύρισε από τον πάροχο: ρωτάμε τον πάροχο τι έγινε (όχι τον
 * browser) και ενημερώνουμε τη βάση. Το webhook κάνει το ίδιο· όποιο φτάσει
 * πρώτο, το άλλο βρίσκει την πληρωμή ήδη γραμμένη.
 *   POST { provider: 'viva', params: { s, t } }
 *   POST { provider: 'stripe', params: { session_id } }
 *   POST { provider: 'test', params: { ref, result: 'ok' | 'fail' } }
 *   → { token, slug, state }
 */
export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  if (req.method !== 'POST') return json({ error: 'POST' }, 405)
  try {
    const body = await readJson<{ provider?: unknown; params?: Record<string, unknown> }>(req)
    const name = String(body.provider ?? '')
    const params: Record<string, string> = {}
    for (const [k, v] of Object.entries(body.params ?? {})) if (typeof v === 'string' && v.length < 300) params[k] = v
    const ref = name === 'viva' ? params.s : name === 'stripe' ? params.session_id : name === 'test' ? params.ref : undefined
    if (!ref) throw new HttpError(400, 'Λείπουν τα στοιχεία της πληρωμής')
    const prov = provider(name)

    const look = await deps.rpc<{ order_id: string; company_id: string; token: string; slug: string; amount: number } | null>(
      'payment_lookup', { p_provider: name, p_ref: ref }, 'service')
    if (!look) throw new HttpError(404, 'Δεν βρέθηκε η πληρωμή')
    const c = await deps.rpc<PayContext>('payment_context', { p_order: look.order_id, p_token: null }, 'service')
    // δοκιμαστική πληρωμή μόνο όσο το μαγαζί είναι σε δοκιμαστική λειτουργία
    if (name === 'test' && c.shop.pay_provider !== 'test') throw new HttpError(403, 'Οι δοκιμαστικές πληρωμές είναι κλειστές')

    const secrets = name === 'test' ? {} : await secretsOf(deps, look.company_id)
    const r = await prov.check(ref, params, payCtx(deps, req, secrets, c.shop.pay_live), Number(look.amount))
    if (r.state === 'paid') {
      const done = await recordPaid(deps, name, ref, r.transactionId ?? ref, Number(r.amount), r.raw ?? null)
      if (!done?.ok) return json({ token: look.token, slug: look.slug, state: 'failed', error: 'Το ποσό δεν συμφωνεί· μίλα με το μαγαζί.' })
    } else if (r.state === 'failed') {
      await recordFailed(deps, name, ref, r.error, r.raw ?? null)
    }
    return json({ token: look.token, slug: look.slug, state: r.state })
  } catch (e) {
    return fail(e)
  }
}
