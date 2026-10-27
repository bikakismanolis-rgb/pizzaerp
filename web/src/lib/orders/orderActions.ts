import { errMsg, supabase } from '../supabase'
import { today } from '../format'
import { clock, type OnlineOrder, type OnlineShop } from '../online'
import type { OrderVoiceCommand } from './orderVoice'
import { listNos, pickOrder, readText } from './orderPick'

/**
 * Ενέργειες στις online παραγγελίες (οθόνη «Παραγγελίες» και «Πες το»).
 * Όλα περνούν από τις functions της βάσης (0005): order_accept κλπ.
 */

export interface OrderResult {
  ok: boolean
  /** για την οθόνη */
  text: string
  /** για ανάγνωση φωναχτά (αν διαφέρει) */
  speech?: string
}

/** Το site της εταιρείας· 'missing' = η βάση δεν έχει το 0005 */
export async function loadShop(companyId: string): Promise<OnlineShop | null | 'missing'> {
  const { data, error } = await supabase.from('online_shop').select('*').eq('company_id', companyId).maybeSingle()
  if (error) {
    if (error.code === 'PGRST205' || error.code === '42P01' || /online_shop/.test(error.message)) return 'missing'
    throw error
  }
  return (data as OnlineShop | null) ?? null
}

/** Ανοιχτές (νέες, σε ετοιμασία) όποτε κι αν ήρθαν, και όλες της ημέρας */
export async function loadOrders(companyId: string, day = today()): Promise<OnlineOrder[]> {
  const { data, error } = await supabase
    .from('online_order')
    .select('*, online_order_line(*)')
    .eq('company_id', companyId)
    .or(`status.in.(new,accepted),order_date.eq.${day}`)
    .order('created_at', { ascending: true })
    .limit(300)
  if (error) throw error
  const rows = (data ?? []) as OnlineOrder[]
  for (const o of rows) o.online_order_line.sort((a, b) => a.line_no - b.line_no)
  return rows
}

// ---------------------------------------------------------------------
// Προεπιλεγμένος χρόνος αποδοχής (ο τελευταίος που διάλεξαν)
// ---------------------------------------------------------------------
const MINUTES_KEY = 'pizza-erp.order-minutes'

export function defaultMinutes(): number {
  try {
    const v = Number(localStorage.getItem(MINUTES_KEY))
    return v >= 5 && v <= 240 ? v : 30
  } catch { return 30 }
}

export function rememberMinutes(m: number): void {
  try { localStorage.setItem(MINUTES_KEY, String(m)) } catch { /* ignore */ }
}

// ---------------------------------------------------------------------
// Κλήσεις
// ---------------------------------------------------------------------
async function call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args)
  if (error) throw new Error(errMsg(error))
  return data as T
}

export async function acceptOrder(o: Pick<OnlineOrder, 'id' | 'order_no'>, minutes: number | null): Promise<OrderResult> {
  const r = await call<{ stock_note: string | null; doc_no: number }>('order_accept', { p_order: o.id, p_minutes: minutes })
  if (minutes) rememberMinutes(minutes)
  const base = `Δεκτή η ${o.order_no}${minutes ? `, σε ${minutes} λεπτά` : ''}.`
  if (r.stock_note) {
    return { ok: true, text: `${base} Η πώληση ΠΩ-${r.doc_no} δεν πέρασε στην αποθήκη: ${r.stock_note}`, speech: `${base} Προσοχή, δεν πέρασε στην αποθήκη.` }
  }
  return { ok: true, text: base }
}

export async function rejectOrder(o: Pick<OnlineOrder, 'id' | 'order_no'>, reason: string | null): Promise<OrderResult> {
  await call('order_reject', { p_order: o.id, p_reason: reason })
  return { ok: true, text: `Απορρίφθηκε η ${o.order_no}.${reason ? ` Λόγος: ${reason}.` : ''}`, speech: `Απορρίφθηκε η ${o.order_no}.` }
}

export async function doneOrder(o: Pick<OnlineOrder, 'id' | 'order_no'>): Promise<OrderResult> {
  await call('order_done', { p_order: o.id })
  return { ok: true, text: `Έφυγε η ${o.order_no}.` }
}

export async function cancelOrder(o: Pick<OnlineOrder, 'id' | 'order_no'>, reason: string | null): Promise<OrderResult> {
  const r = await call<{ note: string | null }>('order_cancel', { p_order: o.id, p_reason: reason })
  if (r.note) return { ok: true, text: `Ακυρώθηκε η ${o.order_no}. ${r.note}`, speech: `Ακυρώθηκε η ${o.order_no}. Η πώληση έμεινε, δες την οθόνη.` }
  return { ok: true, text: `Ακυρώθηκε η ${o.order_no}. Η πώληση σβήστηκε και το απόθεμα γύρισε.`, speech: `Ακυρώθηκε η ${o.order_no}.` }
}

export async function setShopOpen(companyId: string, open: boolean): Promise<OrderResult & { until: string | null }> {
  const until = await call<string | null>('shop_set_open', { p_company: companyId, p_open: open })
  if (open && until) return { ok: true, until, text: `Άνοιξαν οι online παραγγελίες, ως τις ${clock(until)}.` }
  return { ok: true, until: null, text: 'Έκλεισαν οι online παραγγελίες.' }
}

/**
 * Εκτέλεση μιας φωνητικής εντολής. Οι παραγγελίες φορτώνονται τώρα (και
 * από άλλες συσκευές), για να μη γίνει δεκτή κάποια που μόλις απορρίφθηκε.
 */
export async function runOrderVoice(cmd: OrderVoiceCommand, companyId: string): Promise<OrderResult> {
  try {
    switch (cmd.kind) {
      case 'open': return await setShopOpen(companyId, true)
      case 'close': return await setShopOpen(companyId, false)
      case 'stop': return { ok: true, text: '' }
      default: break
    }
    const orders = await loadOrders(companyId)
    switch (cmd.kind) {
      case 'read': {
        const t = readText(orders, cmd.pick)
        return { ok: true, text: t }
      }
      case 'accept': {
        const p = pickOrder(orders, cmd.pick, 'new', 'δεκτή')
        if (!p.order) return { ok: false, text: p.error! }
        return await acceptOrder(p.order, cmd.minutes ?? defaultMinutes())
      }
      case 'reject': {
        const p = pickOrder(orders, cmd.pick, 'new', 'απόρριψε')
        if (!p.order) return { ok: false, text: p.error! }
        return await rejectOrder(p.order, cmd.reason)
      }
      case 'done': {
        if (cmd.all) {
          const cooking = orders.filter((o) => o.status === 'accepted')
          if (cooking.length === 0) return { ok: false, text: 'Δεν υπάρχει παραγγελία σε ετοιμασία.' }
          for (const o of cooking) await doneOrder(o)
          return { ok: true, text: `Έφυγαν ${cooking.length === 1 ? 'η' : 'οι'} ${listNos(cooking)}.` }
        }
        const p = pickOrder(orders, cmd.pick, 'accepted', 'έφυγε')
        if (!p.order) return { ok: false, text: p.error! }
        return await doneOrder(p.order)
      }
    }
  } catch (e) {
    return { ok: false, text: e instanceof Error ? e.message : errMsg(e) }
  }
}
