import { errMsg, supabase } from '../supabase'
import { today } from '../format'
import { callFunction } from '../edge'
import { fiscalCode, FISCAL_KIND_LABEL, loadFiscalSettings, makeFiscal, type FiscalDoc } from '../fiscal'
import { clock, type OnlineOrder, type OnlineShop } from '../online'
import type { OrderVoiceCommand } from './orderVoice'
import { byNo, listNos, pickOrder, readText, STATUS_PHRASE } from './orderPick'

/**
 * Ενέργειες στις online παραγγελίες (οθόνη «Παραγγελίες» και «Πες το»).
 * Όλα περνούν από τις functions της βάσης (0005, 0006): order_accept κλπ.
 * Επιστροφές χρημάτων και αποδείξεις από τις Edge Functions.
 */

export interface OrderResult {
  ok: boolean
  /** για την οθόνη */
  text: string
  /** για ανάγνωση φωναχτά (αν διαφέρει) */
  speech?: string
  /** η παραγγελία που έγινε δεκτή (για τύπωμα) */
  acceptedId?: string
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

/** Βγαίνει μόνη της απόδειξη στην αποδοχή; (ρύθμιση, με πάροχο που εκδίδει) */
export async function autoReceiptOn(companyId: string): Promise<boolean> {
  try {
    const s = await loadFiscalSettings(companyId)
    return !!s && s !== 'missing' && s.auto_receipt && s.provider !== 'none' && s.provider !== 'manual'
  } catch { return false }
}

export async function acceptOrder(o: Pick<OnlineOrder, 'id' | 'order_no'>, minutes: number | null, opts: { autoReceipt?: boolean } = {}): Promise<OrderResult> {
  const r = await call<{ stock_note: string | null; doc_no: number }>('order_accept', { p_order: o.id, p_minutes: minutes })
  if (minutes) rememberMinutes(minutes)
  const base = `Δεκτή η ${o.order_no}${minutes ? `, σε ${minutes} λεπτά` : ''}.`
  if (r.stock_note) {
    return { ok: true, acceptedId: o.id, text: `${base} Η πώληση ΠΩ-${r.doc_no} δεν πέρασε στην αποθήκη: ${r.stock_note}`, speech: `${base} Προσοχή, δεν πέρασε στην αποθήκη.` }
  }
  if (opts.autoReceipt) {
    const rc = await receiptOrder(o)
    if (!rc.ok) return { ok: true, acceptedId: o.id, text: `${base} ${rc.text}`, speech: `${base} Η απόδειξη δεν βγήκε.` }
  }
  return { ok: true, acceptedId: o.id, text: base }
}

/** Επιστροφή χρημάτων (online πληρωμή) μετά από απόρριψη / ακύρωση, ή ξανά */
export async function refundOrder(o: Pick<OnlineOrder, 'id' | 'order_no'>): Promise<OrderResult> {
  try {
    const r = await callFunction<{ refunded: number; failed: string[] }>('pay-refund', { order_id: o.id })
    if (r.failed.length) return { ok: false, text: `Η επιστροφή χρημάτων της ${o.order_no} δεν έγινε: ${r.failed[0]}` }
    return { ok: true, text: r.refunded ? 'Τα χρήματα επιστράφηκαν στον πελάτη.' : 'Δεν υπάρχει πληρωμή για επιστροφή.' }
  } catch (e) {
    return { ok: false, text: `Η επιστροφή χρημάτων της ${o.order_no} δεν έγινε: ${e instanceof Error ? e.message : String(e)}` }
  }
}

const withRefund = async (o: Pick<OnlineOrder, 'id' | 'order_no'>, r: OrderResult, refund: boolean | undefined): Promise<OrderResult> => {
  if (!refund) return r
  const f = await refundOrder(o)
  return { ok: f.ok, text: `${r.text} ${f.text}`, speech: `${r.speech ?? r.text} ${f.ok ? 'Τα χρήματα επιστράφηκαν.' : 'Προσοχή, η επιστροφή χρημάτων δεν έγινε.'}` }
}

export async function rejectOrder(o: Pick<OnlineOrder, 'id' | 'order_no'>, reason: string | null): Promise<OrderResult> {
  const r = await call<{ refund?: boolean } | null>('order_reject', { p_order: o.id, p_reason: reason })
  return withRefund(o, { ok: true, text: `Απορρίφθηκε η ${o.order_no}.${reason ? ` Λόγος: ${reason}.` : ''}`, speech: `Απορρίφθηκε η ${o.order_no}.` }, r?.refund)
}

/** Απόδειξη για την παραγγελία (από τον πάροχο· «με το χέρι» μένει πρόχειρη για αριθμό) */
export async function receiptOrder(o: Pick<OnlineOrder, 'id' | 'order_no'>): Promise<OrderResult & { doc?: FiscalDoc }> {
  try {
    // ήδη έχει (και δεν πιστώθηκε): το λέμε, δεν είναι σφάλμα
    const { data: had } = await supabase.from('fiscal_doc').select('*').eq('online_order_id', o.id)
    const docs = (had ?? []) as FiscalDoc[]
    const issued = docs.find((d) => (d.kind === 'receipt' || d.kind === 'invoice') && d.status === 'issued'
      && !docs.some((c) => c.related_id === d.id && c.status === 'issued'))
    if (issued) return { ok: true, doc: issued, text: `Η ${o.order_no} έχει ήδη ${FISCAL_KIND_LABEL[issued.kind].toLowerCase()} ${fiscalCode(issued)}.` }
    const d = await makeFiscal('receipt', { order: o.id })
    if (d.status === 'issued') return { ok: true, doc: d, text: `Βγήκε η απόδειξη ${fiscalCode(d)} για την ${o.order_no}.` }
    return { ok: true, doc: d, text: `Γράψε τον αριθμό της απόδειξης της ${o.order_no} (από την ταμειακή) στην οθόνη Παραγγελίες.` }
  } catch (e) {
    return { ok: false, text: `Η απόδειξη της ${o.order_no} δεν βγήκε: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/** «Έφυγε με τον Νίκο» (0007) */
export async function sendOrder(o: Pick<OnlineOrder, 'id' | 'order_no'>, driver: { driver_id: string; name: string }): Promise<OrderResult> {
  await call('order_send', { p_order: o.id, p_driver: driver.driver_id })
  return { ok: true, text: `Έφυγε η ${o.order_no} · ${driver.name}.` }
}

export async function doneOrder(o: Pick<OnlineOrder, 'id' | 'order_no'>): Promise<OrderResult> {
  await call('order_done', { p_order: o.id })
  return { ok: true, text: `Έφυγε η ${o.order_no}.` }
}

export async function cancelOrder(o: Pick<OnlineOrder, 'id' | 'order_no'>, reason: string | null): Promise<OrderResult> {
  const r = await call<{ note: string | null; refund?: boolean }>('order_cancel', { p_order: o.id, p_reason: reason })
  if (r.note) return withRefund(o, { ok: true, text: `Ακυρώθηκε η ${o.order_no}. ${r.note}`, speech: `Ακυρώθηκε η ${o.order_no}. Η πώληση έμεινε, δες την οθόνη.` }, r.refund)
  return withRefund(o, { ok: true, text: `Ακυρώθηκε η ${o.order_no}. Η πώληση σβήστηκε και το απόθεμα γύρισε.`, speech: `Ακυρώθηκε η ${o.order_no}.` }, r.refund)
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
        return await acceptOrder(p.order, cmd.minutes ?? defaultMinutes(), { autoReceipt: await autoReceiptOn(companyId) })
      }
      case 'reject': {
        const p = pickOrder(orders, cmd.pick, 'new', 'απόρριψε')
        if (!p.order) return { ok: false, text: p.error! }
        return await rejectOrder(p.order, cmd.reason)
      }
      case 'receipt': {
        if (typeof cmd.pick === 'number') {
          const o = byNo(orders, cmd.pick)
          if (!o) return { ok: false, text: `Δεν βρίσκω παραγγελία ${cmd.pick} σήμερα.` }
          if (o.status !== 'accepted' && o.status !== 'done') return { ok: false, text: `Η ${o.order_no} ${STATUS_PHRASE[o.status]}· απόδειξη βγαίνει όταν γίνει δεκτή.` }
          return await receiptOrder(o)
        }
        const p = pickOrder(orders, cmd.pick, 'accepted', 'απόδειξη')
        if (!p.order) return { ok: false, text: p.error!.replace('«απόδειξη η', '«απόδειξη για την') }
        return await receiptOrder(p.order)
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
