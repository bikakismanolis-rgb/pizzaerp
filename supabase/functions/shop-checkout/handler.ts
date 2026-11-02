import { verifyTurnstile } from '../_shared/captcha.ts'
import type { Deps } from '../_shared/env.ts'
import { secretsOf, startPayment, type PayContext } from '../_shared/flow.ts'
import { CORS, fail, HttpError, json, readJson, uuid } from '../_shared/http.ts'

/**
 * Παραγγελία από τη σελίδα του μαγαζιού, όταν χρειάζεται server: CAPTCHA
 * ή online πληρωμή. (Χωρίς αυτά η σελίδα καλεί κατευθείαν το place_order.)
 *   POST { slug, order, captcha? }      → { token, order_no, redirect? }
 *   POST { retry_token }                → { token, order_no, redirect } (ξανά πληρωμή)
 */
export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  if (req.method !== 'POST') return json({ error: 'POST' }, 405)
  try {
    const body = await readJson<{ slug?: unknown; order?: unknown; captcha?: unknown; retry_token?: unknown }>(req)

    if (body.retry_token !== undefined) {
      const c = await deps.rpc<PayContext | null>('payment_context', { p_order: null, p_token: uuid(body.retry_token, 'token') }, 'service')
      if (!c) throw new HttpError(404, 'Δεν βρέθηκε η παραγγελία')
      return json(await startPayment(deps, req, c))
    }

    if (typeof body.slug !== 'string' || !body.order || typeof body.order !== 'object') throw new HttpError(400, 'Μη έγκυρη παραγγελία')
    const order = body.order as Record<string, unknown>
    const info = await deps.rpc<{ company_id: string; captcha_required: boolean; pay_provider: string } | null>(
      'shop_checkout_info', { p_slug: body.slug }, 'service')
    if (!info) throw new HttpError(404, 'Δεν βρέθηκε το κατάστημα')
    const online = order.payment === 'online'
    const secrets = info.captcha_required || online ? await secretsOf(deps, info.company_id) : {}

    if (info.captcha_required) {
      if (!secrets.turnstile_secret) throw new HttpError(500, 'Το μαγαζί δεν έχει βάλει το μυστικό κλειδί του CAPTCHA.')
      const ok = await verifyTurnstile(body.captcha, secrets.turnstile_secret, req.headers.get('cf-connecting-ip') ?? req.headers.get('x-forwarded-for'), deps.fetch)
      if (!ok) throw new HttpError(400, 'Ο έλεγχος «δεν είμαι ρομπότ» δεν πέρασε. Δοκίμασε ξανά.')
    }

    const placed = await deps.rpc<{ token: string; order_no: number; order_id: string }>(
      'place_order', { p_slug: body.slug, p_order: order }, 'service')
    if (!online) return json({ token: placed.token, order_no: placed.order_no })

    const c = await deps.rpc<PayContext>('payment_context', { p_order: placed.order_id, p_token: null }, 'service')
    return json(await startPayment(deps, req, c, secrets))
  } catch (e) {
    return fail(e)
  }
}
