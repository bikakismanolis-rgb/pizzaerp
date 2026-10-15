import { createClient } from '@supabase/supabase-js'
import { friendlyMessage } from './errors'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

if (!url || !key) {
  // Εμφανίζεται μόνο σε λάθος ρύθμιση περιβάλλοντος (.env)
  console.error('Λείπουν τα VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY από το .env')
}

export const supabase = createClient(url ?? '', key ?? '', {
  auth: { persistSession: true, autoRefreshToken: true },
})

/** Μετατρέπει σφάλμα Supabase/JS σε αναγνώσιμο μήνυμα */
export function errMsg(e: unknown): string {
  if (!e) return 'Άγνωστο σφάλμα'
  if (typeof e === 'string') return friendlyMessage(e)
  const anyE = e as { message?: string; details?: string; hint?: string }
  return friendlyMessage(anyE.message ?? anyE.details ?? JSON.stringify(e))
}
