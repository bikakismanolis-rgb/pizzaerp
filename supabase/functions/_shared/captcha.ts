/**
 * Cloudflare Turnstile («δεν είμαι ρομπότ»). Το site key είναι δημόσιο
 * (online_shop.captcha_site_key), το secret στα κλειδιά: turnstile_secret.
 */
export async function verifyTurnstile(token: unknown, secret: string, ip: string | null, f: typeof fetch): Promise<boolean> {
  if (typeof token !== 'string' || token.length < 10 || token.length > 4000) return false
  const body = new URLSearchParams({ secret, response: token })
  if (ip) body.set('remoteip', ip)
  const r = await f('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body })
  if (!r.ok) return false
  const j = await r.json().catch(() => ({}))
  return j?.success === true
}
