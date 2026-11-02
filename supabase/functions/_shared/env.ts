import { HttpError } from './http.ts'

/**
 * Ό,τι χρειάζεται μια Edge Function από έξω: τη βάση (RPC), το fetch και
 * τη διεύθυνση του site. Στα tests δίνονται ψεύτικα.
 */

export type RpcAs = 'service' | { jwt: string }
export type Rpc = <T = unknown>(name: string, args: Record<string, unknown>, as: RpcAs) => Promise<T>

export interface Deps {
  rpc: Rpc
  fetch: typeof fetch
  /** https://to-site (χωρίς / στο τέλος) για τις επιστροφές από τον πάροχο */
  site: (req?: Request) => string
  now: () => number
}

function env(name: string): string | undefined {
  try { return Deno.env.get(name) ?? undefined } catch { return undefined }
}

const isJwt = (k: string) => k.startsWith('eyJ')

/** RPC στη βάση μέσω PostgREST: ως server (service_role) ή ως ο χρήστης */
export function makeRpc(fetcher: typeof fetch = fetch): Rpc {
  return async <T>(name: string, args: Record<string, unknown>, as: RpcAs): Promise<T> => {
    const url = env('SUPABASE_URL')
    const service = env('SUPABASE_SERVICE_ROLE_KEY') ?? env('SUPABASE_SECRET_KEY')
    const anon = env('SUPABASE_ANON_KEY') ?? env('SUPABASE_PUBLISHABLE_KEY')
    if (!url || !service || !anon) throw new HttpError(500, 'Λείπουν οι ρυθμίσεις του server (SUPABASE_URL / κλειδιά)')
    const key = as === 'service' ? service : anon
    const headers: Record<string, string> = { apikey: key, 'Content-Type': 'application/json' }
    const bearer = as === 'service' ? (isJwt(service) ? service : null) : as.jwt
    if (bearer) headers.Authorization = `Bearer ${bearer}`
    const r = await fetcher(`${url}/rest/v1/rpc/${name}`, { method: 'POST', headers, body: JSON.stringify(args) })
    const text = await r.text()
    if (!r.ok) {
      let msg = text
      try { msg = JSON.parse(text).message ?? text } catch { /* κείμενο */ }
      // τα σφάλματα της βάσης είναι μηνύματα για τον χρήστη
      throw new HttpError(r.status >= 500 ? 502 : r.status === 401 || r.status === 403 ? 403 : 400, msg)
    }
    return (text ? JSON.parse(text) : null) as T
  }
}

/**
 * Η διεύθυνση του site: SITE_URL αν έχει οριστεί, αλλιώς το Origin του
 * αιτήματος (https ή localhost).
 */
export function siteFrom(req?: Request): string {
  const fixed = env('SITE_URL')
  if (fixed) return fixed.replace(/\/+$/, '')
  const o = req?.headers.get('origin') ?? ''
  if (/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(o)) return o
  throw new HttpError(500, 'Δεν έχει οριστεί το SITE_URL του server')
}

export const defaultDeps = (): Deps => ({ rpc: makeRpc(), fetch, site: siteFrom, now: () => Date.now() })
