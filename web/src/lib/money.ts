import { errMsg, supabase } from './supabase'
import { round } from './format'
import { monthShare } from './overhead'

/**
 * Τα λεφτά του μήνα, ίδια παντού (αρχική, «Κέρδος του μήνα», φωνή):
 * καταχωρημένες πωλήσεις − υλικά − γενικά έξοδα ως σήμερα. Οι ανοιχτές
 * πωλήσεις ημέρας φαίνονται χωριστά: μετράνε όταν κλείσει η μέρα (τότε
 * γράφεται και το κόστος των υλικών τους).
 */
export interface MonthNumbers {
  month: string
  /** καταχωρημένες πωλήσεις, χωρίς ΦΠΑ */
  net: number
  /** κόστος υλικών τους */
  cogs: number
  /** ανοιχτές πωλήσεις ημέρας (δεν μετράνε ακόμα) */
  openNet: number
  openQty: number
  /** γενικά έξοδα όλου του μήνα (0 αν δεν γράφτηκαν ή δεν τα βλέπει ο χρήστης) */
  overheadTotal: number
  /** όσα αναλογούν ως σήμερα */
  overhead: number
  days: number
  of: number
  profit: number
}

export async function loadMonthNumbers(companyId: string, today: string): Promise<MonthNumbers> {
  const month = today.slice(0, 7) + '-01'
  const [sales, open, oh] = await Promise.all([
    supabase.from('v_sales_by_partner_item').select('net, cogs').eq('company_id', companyId).eq('month', month),
    supabase.from('doc').select('doc_line(net, qty)').eq('company_id', companyId).eq('doc_type', 'sale')
      .eq('status', 'draft').eq('is_running', true).gte('doc_date', month),
    supabase.from('v_overhead_month').select('total').eq('company_id', companyId).eq('month', month).maybeSingle(),
  ])
  if (sales.error) throw new Error(errMsg(sales.error))
  const rows = (sales.data ?? []) as { net: number; cogs: number | null }[]
  const net = round(rows.reduce((s, r) => s + Number(r.net), 0), 2)
  const cogs = round(rows.reduce((s, r) => s + Number(r.cogs ?? 0), 0), 2)
  let openNet = 0, openQty = 0
  for (const d of (open.data ?? []) as unknown as { doc_line: { net: number; qty: number }[] }[]) {
    for (const l of d.doc_line) { openNet += Number(l.net); openQty += Number(l.qty) }
  }
  const overheadTotal = oh.error ? 0 : Number((oh.data as { total?: number } | null)?.total ?? 0)
  const part = monthShare(month, today)
  const overhead = round(overheadTotal * part.share, 2)
  return {
    month, net, cogs, openNet: round(openNet, 2), openQty, overheadTotal, overhead,
    days: part.days, of: part.of, profit: round(net - cogs - overhead, 2),
  }
}
