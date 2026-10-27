import { fmtMoney } from './format'

/**
 * Online παραγγελίες (0005): ό,τι μοιράζονται η σελίδα του πελάτη
 * (/s/:slug, χωρίς login) και η οθόνη «Παραγγελίες» της κουζίνας.
 */

export type OrderStatus = 'new' | 'accepted' | 'done' | 'rejected' | 'cancelled'
export type OrderMode = 'delivery' | 'pickup'
export type OrderPayment = 'cash' | 'card'

/** Ένα είδος του μενού όπως το βλέπει ο πελάτης (τιμή με ΦΠΑ) */
export interface MenuItem {
  id: string
  name: string
  description: string | null
  category: string | null
  price: number
}

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
}

export interface OrderInputLine { item_id: string; qty: number; note?: string | null }

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
  lines: { name: string; qty: number; price: number; note: string | null }[]
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
}

export interface OnlineOrder {
  id: string
  company_id: string
  order_date: string
  order_no: number
  status: OrderStatus
  mode: OrderMode
  payment: OrderPayment
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
  new: 'Νέα',
  accepted: 'Σε ετοιμασία',
  done: 'Έφυγε',
  rejected: 'Απορρίφθηκε',
  cancelled: 'Ακυρώθηκε',
}

export const MODE_LABEL: Record<OrderMode, string> = { delivery: 'Διανομή', pickup: 'Παραλαβή' }

export const PAYMENT_LABEL: Record<OrderPayment, string> = { cash: 'Μετρητά', card: 'Κάρτα' }

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

/** Γραμμές παραγγελίας όπως τις λέει η κουζίνα: «Μαργαρίτα 2 (χωρίς ρίγανη)» */
export function linesText(lines: { name: string; qty: number; note?: string | null }[], sep = ', '): string {
  return lines.map((l) => `${l.name} ${l.qty}${l.note ? ` (${l.note})` : ''}`).join(sep)
}

/** Ό,τι διαβάζεται φωναχτά όταν έρχεται νέα παραγγελία */
export function orderSpeech(o: Pick<OnlineOrder, 'order_no' | 'mode' | 'address' | 'payment' | 'notes' | 'total'> & { online_order_line: { name: string; qty: number; note: string | null }[] }): string {
  const parts = [
    `Νέα παραγγελία ${o.order_no}.`,
    linesText(o.online_order_line) + '.',
    o.mode === 'delivery' ? `Διανομή${o.address ? ', ' + o.address : ''}.` : 'Παραλαβή από το μαγαζί.',
    o.payment === 'card' ? 'Πληρωμή με κάρτα.' : 'Μετρητά.',
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
