import { today } from '../format'
import { linesText, orderSpeech, type OnlineOrder } from '../online'
import type { OrderPick } from './orderVoice'

/**
 * Ποια παραγγελία εννοεί μια φωνητική εντολή, και τι διαβάζεται φωναχτά.
 * Χωρίς κλήσεις στη βάση (για tests).
 */

type PickRow = Pick<OnlineOrder, 'id' | 'order_no' | 'order_date' | 'status' | 'mode' | 'address' | 'payment' | 'notes' | 'total'> & {
  online_order_line: { name: string; qty: number; note: string | null }[]
}

export const listNos = (os: { order_no: number }[]): string => {
  const nos = os.map((o) => String(o.order_no))
  return nos.length <= 1 ? nos.join('') : nos.slice(0, -1).join(', ') + ' και ' + nos[nos.length - 1]
}

export const STATUS_PHRASE: Record<OnlineOrder['status'], string> = {
  awaiting_payment: 'περιμένει ακόμα την πληρωμή',
  expired: 'δεν πληρώθηκε ποτέ',
  new: 'δεν έχει γίνει ακόμα δεκτή',
  accepted: 'έχει ήδη γίνει δεκτή',
  done: 'έχει ήδη φύγει',
  rejected: 'έχει απορριφθεί',
  cancelled: 'έχει ακυρωθεί',
}

/** Η παραγγελία με τον αριθμό της (της ημέρας πρώτα, αλλιώς η πιο πρόσφατη) */
export function byNo<T extends PickRow>(orders: T[], n: number, day = today()): T | undefined {
  const same = orders.filter((o) => o.order_no === n)
  return same.find((o) => o.order_date === day) ?? same[same.length - 1]
}

export function pickOrder<T extends PickRow>(orders: T[], pick: OrderPick, status: 'new' | 'accepted', verb: string, day = today()): { order?: T; error?: string } {
  const cands = orders.filter((o) => o.status === status)
  if (typeof pick === 'number') {
    const o = byNo(orders, pick, day)
    if (!o) return { error: `Δεν βρίσκω παραγγελία ${pick} σήμερα.` }
    if (o.status !== status) return { error: `Η ${pick} ${STATUS_PHRASE[o.status]}.` }
    return { order: o }
  }
  if (cands.length === 0) {
    return { error: status === 'new' ? 'Δεν υπάρχει νέα παραγγελία.' : 'Δεν υπάρχει παραγγελία σε ετοιμασία.' }
  }
  if (pick === 'first') return { order: cands[0] }
  if (pick === 'last') return { order: cands[cands.length - 1] }
  if (cands.length === 1) return { order: cands[0] }
  return { error: `Ποια; ${status === 'new' ? 'Περιμένουν' : 'Ετοιμάζονται'} οι ${listNos(cands)}. Πες «${verb} η ${cands[0].order_no}».` }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** Τι διαβάζει το «διάβασε» */
export function readText(orders: PickRow[], pick: OrderPick, day = today()): string {
  if (typeof pick === 'number') {
    const o = byNo(orders, pick, day)
    if (!o) return `Δεν βρίσκω παραγγελία ${pick} σήμερα.`
    return o.status === 'new' ? orderSpeech(o) : `Η ${o.order_no}: ${linesText(o.online_order_line)}. ${cap(STATUS_PHRASE[o.status])}.`
  }
  const fresh = orders.filter((o) => o.status === 'new')
  const cooking = orders.filter((o) => o.status === 'accepted')
  if (fresh.length === 0) {
    return cooking.length
      ? `Δεν υπάρχουν νέες παραγγελίες. Σε ετοιμασία ${cooking.length === 1 ? 'η' : 'οι'} ${listNos(cooking)}.`
      : 'Δεν υπάρχουν παραγγελίες που περιμένουν.'
  }
  return fresh.map(orderSpeech).join(' ')
}
