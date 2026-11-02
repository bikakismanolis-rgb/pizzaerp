import type { Deps } from '../_shared/env.ts'
import { processRefunds } from '../_shared/flow.ts'
import { CORS, fail, json, readJson, userJwt, uuid } from '../_shared/http.ts'

/**
 * Επιστροφή χρημάτων για απορριφθείσα / ακυρωμένη παραγγελία που είχε
 * πληρωθεί online (την καλεί η οθόνη Παραγγελίες αμέσως μετά). Ο χρήστης
 * πρέπει να είναι μέλος της εταιρείας (το ελέγχει η βάση).
 *   POST { order_id } (Authorization: ο χρήστης) → { refunded, failed: [...] }
 */
export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  if (req.method !== 'POST') return json({ error: 'POST' }, 405)
  try {
    const jwt = userJwt(req)
    const body = await readJson<{ order_id?: unknown }>(req)
    const order = uuid(body.order_id, 'id παραγγελίας')
    const pending = await deps.rpc<boolean>('order_refund_request', { p_order: order }, { jwt })
    if (!pending) return json({ refunded: 0, failed: [] })
    return json(await processRefunds(deps, order))
  } catch (e) {
    return fail(e)
  }
}
