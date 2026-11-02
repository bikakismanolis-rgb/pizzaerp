import { supabase } from './supabase'
import { friendlyMessage } from './errors'

/**
 * Κλήση Edge Function (supabase/functions). Τα σφάλματα έρχονται ως
 * { error: "μήνυμα για τον χρήστη" }.
 */
export async function callFunction<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, { body })
  if (error) {
    let msg = error.message
    const ctx = (error as { context?: Response }).context
    if (ctx && typeof ctx.json === 'function') {
      try {
        const j = await ctx.json()
        if (j?.error) msg = String(j.error)
      } catch { /* όχι json */ }
    }
    if (/Failed to send a request|FunctionsFetchError|Failed to fetch/i.test(msg)) {
      msg = 'Δεν απαντά ο server των πληρωμών / παραστατικών. Έλεγξε τη σύνδεση ή αν έχουν ανέβει οι Edge Functions.'
    }
    throw new Error(friendlyMessage(msg))
  }
  return data as T
}
