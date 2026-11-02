import type { Deps } from '../_shared/env.ts'
import { secretsOf } from '../_shared/flow.ts'
import { fiscalProvider, type FiscalBegin } from '../_shared/fiscal/index.ts'
import { CORS, fail, HttpError, json, readJson, userJwt, uuid } from '../_shared/http.ts'

/**
 * Έκδοση παραστατικού μέσω του παρόχου. Το πρόχειρο το φτιάχνει η βάση
 * (fiscal_prepare)· εδώ: αριθμός, αποστολή στον πάροχο, ΜΑΡΚ / QR πίσω.
 *   POST { id } (Authorization: ο χρήστης) → { status, mark, number, ... }
 */
export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  if (req.method !== 'POST') return json({ error: 'POST' }, 405)
  try {
    const jwt = userJwt(req)
    const body = await readJson<{ id?: unknown }>(req)
    const id = uuid(body.id, 'id παραστατικού')
    await deps.rpc('fiscal_check', { p_id: id }, { jwt })
    const b = await deps.rpc<FiscalBegin & { already?: boolean }>('fiscal_begin', { p_id: id }, 'service')
    if (b.already) return json({ status: 'issued', mark: b.doc.mark, series: b.doc.series, number: b.doc.number })

    const prov = fiscalProvider(b.settings.provider)
    const done = (ok: boolean, result: Record<string, unknown>) =>
      deps.rpc('fiscal_done', { p_id: id, p_ok: ok, p_result: result }, 'service')
    if (!prov) {
      const error = `Δεν υπάρχει ακόμα σύνδεση με τον πάροχο «${b.settings.provider}».`
      await done(false, { error })
      throw new HttpError(400, error)
    }
    let site = ''
    try { site = deps.site(req) } catch { /* ο πάροχος δίνει δικό του QR */ }
    try {
      const secrets = await secretsOf(deps, b.doc.company_id)
      const res = await prov.issue(b, { secrets, live: b.settings.live, site, fetch: deps.fetch, now: deps.now })
      await done(true, res as unknown as Record<string, unknown>)
      return json({ status: 'issued', series: b.doc.series, number: res.number ?? b.doc.number, mark: res.mark, qr_url: res.qr_url ?? null })
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      await done(false, { error })
      throw new HttpError(502, `Ο πάροχος δεν εξέδωσε το παραστατικό: ${error}`)
    }
  } catch (e) {
    return fail(e)
  }
}
