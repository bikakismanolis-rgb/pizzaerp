import type { Deps } from '../_shared/env.ts'
import { payCtx, recordFailed, recordPaid, secretsOf } from '../_shared/flow.ts'
import { fail, HttpError, json, UUID_RE } from '../_shared/http.ts'
import { provider } from '../_shared/payments/index.ts'

/**
 * Ειδοποιήσεις των παρόχων (χωρίς login, deploy με --no-verify-jwt):
 *   …/payments-webhook?provider=viva&company=<id>     (GET: επιβεβαίωση διεύθυνσης, POST: events)
 *   …/payments-webhook?provider=stripe&company=<id>   (POST με Stripe-Signature)
 * Η εταιρεία στη διεύθυνση λέει ποια κλειδιά ελέγχουν το μήνυμα· μια
 * πληρωμή άλλης εταιρείας αγνοείται.
 */
export async function handle(req: Request, deps: Deps): Promise<Response> {
  try {
    const u = new URL(req.url)
    const name = u.searchParams.get('provider') ?? ''
    const company = u.searchParams.get('company') ?? ''
    if (!['viva', 'stripe'].includes(name) || !UUID_RE.test(company)) throw new HttpError(400, 'Λάθος διεύθυνση webhook')
    const settings = await deps.rpc<{ pay_live: boolean } | null>('shop_pay_settings', { p_company: company }, 'service')
    if (!settings) throw new HttpError(404, 'Άγνωστη εταιρεία')
    const secrets = await secretsOf(deps, company)
    const ev = await provider(name).webhook(req, payCtx(deps, undefined, secrets, settings.pay_live))

    if (ev.kind === 'reply') return ev.response
    if (ev.kind === 'ignore') return json({ ok: true })
    const look = await deps.rpc<{ company_id: string } | null>('payment_lookup', { p_provider: name, p_ref: ev.ref }, 'service')
    if (!look || look.company_id !== company) return json({ ok: true, ignored: true })
    if (ev.kind === 'paid') await recordPaid(deps, name, ev.ref, ev.transactionId, ev.amount, ev.raw)
    else await recordFailed(deps, name, ev.ref, ev.error, ev.raw)
    return json({ ok: true })
  } catch (e) {
    // σε σφάλμα ο πάροχος ξαναστέλνει αργότερα
    return fail(e)
  }
}
