/**
 * Κοινά για όλες τις Edge Functions: CORS, απαντήσεις JSON, σφάλματα με
 * μήνυμα για τον χρήστη (στα ελληνικά, όπως τα δίνει η βάση).
 */

export const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, stripe-signature',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', ...extra },
  })
}

export function fail(e: unknown): Response {
  if (e instanceof HttpError) return json({ error: e.message }, e.status)
  console.error(e)
  return json({ error: 'Κάτι πήγε στραβά. Δοκίμασε ξανά σε λίγο.' }, 500)
}

/** Σώμα JSON με όριο μεγέθους (οι παραγγελίες είναι μικρές) */
export async function readJson<T = Record<string, unknown>>(req: Request, max = 40_000): Promise<T> {
  const text = await req.text()
  if (text.length > max) throw new HttpError(413, 'Πολύ μεγάλο αίτημα')
  try {
    const v = JSON.parse(text || '{}')
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object')
    return v as T
  } catch {
    throw new HttpError(400, 'Μη έγκυρο αίτημα')
  }
}

/** Το JWT του χρήστη από το Authorization (για κλήσεις στη βάση ως αυτός) */
export function userJwt(req: Request): string {
  const h = req.headers.get('authorization') ?? ''
  const m = /^Bearer\s+(.+)$/i.exec(h)
  if (!m || !m[1].startsWith('eyJ')) throw new HttpError(401, 'Χρειάζεται σύνδεση')
  return m[1]
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function uuid(v: unknown, what = 'id'): string {
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw new HttpError(400, `Μη έγκυρο ${what}`)
  return v
}

/** Ποσό σε λεπτά του ευρώ (ακέραιος), όπως τα θέλουν Viva και Stripe */
export const cents = (eur: number): number => Math.round(Number((Number(eur) * 100).toFixed(4)))
