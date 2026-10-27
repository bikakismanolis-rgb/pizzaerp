import { fmtMoney } from './format'

/**
 * Online παραγγελίες (0005, 0006): ό,τι μοιράζονται η σελίδα του πελάτη
 * (/s/:slug, χωρίς login) και η οθόνη «Παραγγελίες» της κουζίνας.
 */

/** awaiting_payment / expired: πληρωμή online που δεν ολοκληρώθηκε (δεν φαίνεται στην κουζίνα) */
export type OrderStatus = 'awaiting_payment' | 'new' | 'accepted' | 'done' | 'rejected' | 'cancelled' | 'expired'
export type OrderMode = 'delivery' | 'pickup'
export type OrderPayment = 'cash' | 'card' | 'online'
export type PayStatus = 'none' | 'pending' | 'failed' | 'paid' | 'refund_pending' | 'refunded' | 'refund_failed'
export type PayProvider = 'none' | 'test' | 'viva' | 'stripe'

/** Ένα είδος του μενού όπως το βλέπει ο πελάτης (τιμή με ΦΠΑ) */
export interface MenuItem {
  id: string
  name: string
  description: string | null
  category: string | null
  price: number
  /** παίρνει extra (πίτσα κατά παραγγελία) */
  extras_ok?: boolean
}

/** Extra πάνω σε πίτσα (τιμή με ΦΠΑ) */
export interface MenuExtra { id: string; name: string; price: number }

/** Απάντηση του shop_menu */
export interface ShopMenu {
  name: string
  phone: string | null
  note: string | null
  open: boolean
  closes_at: string
  delivery: boolean
  pickup: boolean
  delivery_fee: number
  min_order: number
  items: MenuItem[]
  extras?: MenuExtra[]
  pay_cash?: boolean
  pay_card_door?: boolean
  pay_online?: boolean
  pay_test?: boolean
  captcha_site_key?: string | null
}

export interface OrderInputLine { item_id: string; qty: number; note?: string | null; extras?: string[] }

export interface OrderInput {
  name: string
  phone: string
  mode: OrderMode
  address: string | null
  payment: OrderPayment
  notes: string | null
  lines: OrderInputLine[]
}

/** Απάντηση του order_status (σελίδα κατάστασης του πελάτη) */
export interface OrderStatusInfo {
  order_no: number
  order_date: string
  status: OrderStatus
  mode: OrderMode
  payment: OrderPayment
  pay_status?: PayStatus
  pay_test?: boolean
  /** public token της απόδειξης, αν έχει εκδοθεί */
  receipt?: string | null
  paid_at?: string | null
  name: string
  items_total: number
  delivery_fee: number
  total: number
  ready_minutes: number | null
  reason: string | null
  created_at: string
  accepted_at: string | null
  done_at: string | null
  shop: { name: string; phone: string | null; slug: string }
  lines: { name: string; qty: number; price: number; note: string | null; line_no?: number; parent_line?: number | null }[]
}

/** Ρυθμίσεις του site (πίνακας online_shop) */
export interface OnlineShop {
  company_id: string
  slug: string
  title: string
  phone: string | null
  note: string | null
  delivery: boolean
  pickup: boolean
  delivery_fee: number
  min_order: number
  closes_at: string
  open_until: string | null
  compare_fee_pct: number | null
  pay_cash?: boolean
  pay_card_door?: boolean
  pay_provider?: PayProvider
  pay_live?: boolean
  captcha_site_key?: string | null
  delivery_item_id?: string | null
}

export interface OnlineOrderLine {
  id: string
  order_id: string
  line_no: number
  item_id: string
  name: string
  qty: number
  unit_price: number
  note: string | null
  /** extra: ο αριθμός γραμμής της πίτσας που το παίρνει */
  parent_line?: number | null
}

export interface OnlineOrder {
  id: string
  company_id: string
  order_date: string
  order_no: number
  status: OrderStatus
  mode: OrderMode
  payment: OrderPayment
  pay_status?: PayStatus
  paid_at?: string | null
  customer_name: string
  phone: string
  address: string | null
  notes: string | null
  items_total: number
  delivery_fee: number
  total: number
  ready_minutes: number | null
  reason: string | null
  sale_doc_id: string | null
  stock_note: string | null
  created_at: string
  accepted_at: string | null
  done_at: string | null
  closed_at: string | null
  online_order_line: OnlineOrderLine[]
}

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  awaiting_payment: 'Περιμένει πληρωμή',
  expired: 'Δεν πληρώθηκε',
  new: 'Νέα',
  accepted: 'Σε ετοιμασία',
  done: 'Έφυγε',
  rejected: 'Απορρίφθηκε',
  cancelled: 'Ακυρώθηκε',
}

export const MODE_LABEL: Record<OrderMode, string> = { delivery: 'Διανομή', pickup: 'Παραλαβή' }

export const PAYMENT_LABEL: Record<OrderPayment, string> = { cash: 'Μετρητά', card: 'Κάρτα', online: 'Πληρωμένη online' }

export const PAY_STATUS_LABEL: Record<PayStatus, string> = {
  none: '',
  pending: 'Περιμένει πληρωμή',
  failed: 'Η πληρωμή απέτυχε',
  paid: 'Πληρώθηκε online',
  refund_pending: 'Επιστροφή χρημάτων σε εξέλιξη',
  refunded: 'Έγινε επιστροφή χρημάτων',
  refund_failed: 'Η επιστροφή χρημάτων δεν έγινε',
}

export const PAY_PROVIDER_LABEL: Record<PayProvider, string> = {
  none: 'Χωρίς online πληρωμή',
  test: 'Δοκιμαστική (χωρίς χρήματα)',
  viva: 'Viva.com (κάρτα, Apple/Google Pay, IRIS)',
  stripe: 'Stripe (κάρτα, Apple/Google Pay)',
}

/** Χρόνοι αποδοχής που προτείνει η κουζίνα (λεπτά) */
export const READY_MINUTES = [15, 20, 30, 45, 60]

/** Γρήγοροι λόγοι απόρριψης */
export const REJECT_REASONS = ['Είμαστε γεμάτοι', 'Δεν πάμε σε αυτή την περιοχή', 'Λείπει κάποιο υλικό', 'Κλείνουμε']

/** Το site είναι ανοιχτό; (open_until στο μέλλον) */
export const shopIsOpen = (s: Pick<OnlineShop, 'open_until'> | null | undefined, now = Date.now()): boolean =>
  !!s?.open_until && new Date(s.open_until).getTime() > now

/** "21:30" από ISO χρόνο, σε ώρα Ελλάδας (όπως η ώρα κλεισίματος του μαγαζιού) */
export const clock = (iso: string | Date): string =>
  new Date(iso).toLocaleTimeString('el-GR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/Athens' })

/** Τιμή με ΦΠΑ όπως τη βγάζει η βάση (round(τιμή × (1 + ΦΠΑ/100), 2): 10,50 + 13% = 11,87) */
export const grossPrice = (net: number, vatRate: number): number =>
  Math.round(Number((Number(net) * (100 + Number(vatRate))).toFixed(4))) / 100

/** Γεγονός για τον αριθμό νέων παραγγελιών στο μενού (η οθόνη «Παραγγελίες» το στέλνει αμέσως) */
export const NEW_ORDERS_EVENT = 'pizza-erp:new-orders'

/** Ώρα που θα είναι έτοιμη (αποδοχή + λεπτά), ή null */
export function readyAt(o: { accepted_at: string | null; ready_minutes: number | null }): Date | null {
  if (!o.accepted_at || !o.ready_minutes) return null
  return new Date(new Date(o.accepted_at).getTime() + o.ready_minutes * 60000)
}

/** Λεπτά από τότε (για «πριν από 3'») */
export const minutesSince = (iso: string, now = Date.now()): number =>
  Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60000))

/** Τηλέφωνο για εμφάνιση: 6941234567 → 694 123 4567 */
export function fmtPhone(p: string): string {
  if (/^[26]\d{9}$/.test(p)) return `${p.slice(0, 3)} ${p.slice(3, 6)} ${p.slice(6)}`
  return p
}

/** Γρήγορος έλεγχος στον browser (ο τελικός γίνεται στη βάση) */
export function phoneLooksValid(raw: string): boolean {
  const t = raw.trim()
  const d = t.replace(/\D/g, '')
  if (/^(\+|00)/.test(t)) return d.replace(/^00/, '').length >= 8 && d.replace(/^00/, '').length <= 15
  return /^[26]\d{9}$/.test(d)
}

type TextLine = { name: string; qty: number; note?: string | null; line_no?: number; parent_line?: number | null }

/** Γραμμή με τα extras της από κάτω (γραμμές με parent_line) */
export function nestLines<T extends TextLine>(lines: T[]): (T & { extras: T[] })[] {
  const main = lines.filter((l) => l.parent_line == null)
  return main.map((m) => ({ ...m, extras: lines.filter((x) => x.parent_line != null && x.parent_line === m.line_no) }))
}

/** Γραμμές παραγγελίας όπως τις λέει η κουζίνα: «Μαργαρίτα 2 με Extra μοτσαρέλα (χωρίς ρίγανη)» */
export function linesText(lines: TextLine[], sep = ', '): string {
  return nestLines(lines).map((l) => {
    const ex = l.extras.length ? ` με ${l.extras.map((x) => x.name).join(' και ')}` : ''
    return `${l.name} ${l.qty}${ex}${l.note ? ` (${l.note})` : ''}`
  }).join(sep)
}

/** Ό,τι διαβάζεται φωναχτά όταν έρχεται νέα παραγγελία */
export function orderSpeech(o: Pick<OnlineOrder, 'order_no' | 'mode' | 'address' | 'payment' | 'notes' | 'total'> & { online_order_line: TextLine[] }): string {
  const parts = [
    `Νέα παραγγελία ${o.order_no}.`,
    linesText(o.online_order_line) + '.',
    o.mode === 'delivery' ? `Διανομή${o.address ? ', ' + o.address : ''}.` : 'Παραλαβή από το μαγαζί.',
    o.payment === 'online' ? 'Πληρωμένη online.' : o.payment === 'card' ? 'Πληρωμή με κάρτα.' : 'Μετρητά.',
  ]
  if (o.notes) parts.push(`Σημείωση: ${o.notes}.`)
  return parts.join(' ')
}

/** Σύνοψη για φωνή / λίστα: «#12 Γιώργος, 27,12 €» */
export const orderShort = (o: Pick<OnlineOrder, 'order_no' | 'customer_name' | 'total'>): string =>
  `#${o.order_no} ${o.customer_name}, ${fmtMoney(o.total)}`

// ---------------------------------------------------------------------
// Διεύθυνση του site
// ---------------------------------------------------------------------
const GREEK: Record<string, string> = {
  α: 'a', β: 'v', γ: 'g', δ: 'd', ε: 'e', ζ: 'z', η: 'i', θ: 'th', ι: 'i', κ: 'k', λ: 'l', μ: 'm',
  ν: 'n', ξ: 'x', ο: 'o', π: 'p', ρ: 'r', σ: 's', ς: 's', τ: 't', υ: 'y', φ: 'f', χ: 'ch', ψ: 'ps', ω: 'o',
}

/** «Πιτσαρία Η Γωνιά» → «pitsaria-i-gonia» (πρόταση για τη διεύθυνση του site) */
export function slugify(text: string): string {
  const plain = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  const latin = Array.from(plain).map((ch) => GREEK[ch] ?? ch).join('')
  return latin.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '')
}

export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

export const slugValid = (s: string): boolean => SLUG_RE.test(s) && s.length >= 3 && s.length <= 40

/** Η δημόσια διεύθυνση της σελίδας του μαγαζιού */
export const shopUrl = (slug: string, origin = typeof window !== 'undefined' ? window.location.origin : ''): string =>
  `${origin}/s/${slug}`
