import { tokenize } from './voice/normalize'
import { segment } from './voice/numbers'

/**
 * Γενικά έξοδα (0008) και καθαρό κέρδος ανά είδος. Ό,τι δεν είναι υλικό
 * συνταγής (ρεύμα, αέριο, μισθοί, ενοίκιο…) μπαίνει ανά μήνα και μοιράζεται
 * στα είδη που πουλήθηκαν τον ίδιο μήνα: ίσα ανά τεμάχιο ή ανάλογα με το
 * κόστος υλικών τους. Χωρίς κλήσεις στη βάση (για tests).
 */

export interface OverheadCategory {
  name: string
  hint?: string
  /** ρίζες λέξεων για τη φωνή («ρεύμα 320», «ΔΕΗ 320») */
  words: RegExp
}

export const OVERHEAD_CATEGORIES: OverheadCategory[] = [
  { name: 'Ενοίκιο', words: /^(ενοικ|νοικ)/ },
  { name: 'Μισθοί', hint: 'μαζί με τις εισφορές (ΕΦΚΑ)', words: /^(μισθ|μεροκαματ|εφκα|ενσημ|εισφορ|προσωπικ)/ },
  { name: 'Ρεύμα', hint: 'χωρίς ΦΠΑ', words: /^(ρευμ|δεη|ηλεκτρ)/ },
  { name: 'Αέριο / καύσιμα φούρνου', hint: 'υγραέριο, ξύλα, πετρέλαιο', words: /^(αερι|γκαζ|υγραερ|ξυλ|πετρελ|καυσιμ)/ },
  { name: 'Νερό', words: /^(νερ|δευα|ευδαπ)/ },
  { name: 'Τηλέφωνο / internet', words: /^(τηλεφ|ιντερνετ|internet|κινητ)/ },
  { name: 'Λογιστής', words: /^(λογιστ)/ },
  { name: 'Προμήθειες efood / Wolt', hint: 'ό,τι κρατάνε οι πλατφόρμες', words: /^(προμηθει|efood|ιφουντ|wolt|βολτ|πλατφορμ)/ },
  { name: 'Συσκευασίες & αναλώσιμα', hint: 'όσα δεν είναι στις συνταγές', words: /^(συσκευασ|σακουλ|αναλωσ|χαρτ|καθαριστ)/ },
  { name: 'Βενζίνη μηχανών', words: /^(βενζιν|μηχαν|μοτοσυκλ|παπακ)/ },
  { name: 'Συντήρηση / επισκευές', words: /^(συντηρ|επισκευ|μαστορ|τεχνικ)/ },
]

/** Μήνας «YYYY-MM-01» */
export const monthKey = (d = new Date()): string => {
  const s = d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Athens' })
  return s.slice(0, 7) + '-01'
}

export const addMonths = (m: string, n: number): string => {
  const [y, mo] = m.split('-').map(Number)
  const t = y * 12 + (mo - 1) + n
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}-01`
}

const MONTHS = ['Ιανουάριος', 'Φεβρουάριος', 'Μάρτιος', 'Απρίλιος', 'Μάιος', 'Ιούνιος', 'Ιούλιος', 'Αύγουστος', 'Σεπτέμβριος', 'Οκτώβριος', 'Νοέμβριος', 'Δεκέμβριος']
export const monthLabel = (m: string): string => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`

/** «τον Οκτώβριο» (αιτιατική, χωρίς έτος αν είναι φέτος) */
export const monthAcc = (m: string, now = monthKey()): string => {
  const name = MONTHS[Number(m.slice(5, 7)) - 1].replace(/ος$/, 'ο')
  return m.slice(0, 4) === now.slice(0, 4) ? name : `${name} ${m.slice(0, 4)}`
}

/**
 * Πόσο από τα γενικά έξοδα του μήνα αναλογεί ως σήμερα: ο τρέχων μήνας
 * μετρά τις μέρες που πέρασαν (αλλιώς στις 2 του μήνα όλο το ενοίκιο θα
 * έπεφτε σε δύο μέρες πωλήσεων). Παλιοί μήνες: όλο.
 */
export function monthShare(m: string, today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Athens' })): { days: number; of: number; share: number } {
  const [y, mo] = m.split('-').map(Number)
  const of = new Date(Date.UTC(y, mo, 0)).getUTCDate()
  if (today.slice(0, 7) !== m.slice(0, 7)) return { days: of, of, share: today < m ? 0 : 1 }
  const days = Number(today.slice(8, 10))
  return { days, of, share: days / of }
}

// ---------------------------------------------------------------------
// Φωνή: «ρεύμα 320», «μισθοί δύο χιλιάδες τετρακόσια», «ΔΕΗ 320,50»
// ---------------------------------------------------------------------
export function parseOverheadVoice(text: string): { category: string; amount: number } | null {
  const toks = tokenize(String(text ?? '').slice(0, 200)).filter((t) => !t.sep)
  if (toks.length === 0) return null
  const segs = segment(toks)
  const nums = segs.flatMap((s) => (s.t === 'n' ? [s.value] : []))
  const words = segs.flatMap((s) => (s.t === 'w' ? [s.tok.n] : []))
  const cat = OVERHEAD_CATEGORIES.find((c) => words.some((w) => c.words.test(w)))
  if (!cat || nums.length !== 1 || !(nums[0] >= 0) || nums[0] >= 10000000) return null
  return { category: cat.name, amount: Math.round(nums[0] * 100) / 100 }
}

// ---------------------------------------------------------------------
// Καθαρό κέρδος ανά είδος
// ---------------------------------------------------------------------
export type OverheadMethod = 'units' | 'material'

export interface SaleRow { item_id: string; item_name: string; qty: number; net: number; cogs: number | null }

export interface ProfitRow {
  item_id: string
  name: string
  qty: number
  net: number
  material: number
  overhead: number
  profit: number
}

export interface ProfitResult {
  rows: ProfitRow[]
  net: number
  material: number
  overhead: number
  /** γενικά έξοδα που δεν βρήκαν πού να μπουν (π.χ. καμία πώληση) */
  unallocated: number
  profit: number
}

const cents = (v: number) => Math.round(v * 100) / 100

/**
 * Μοιράζει τα γενικά έξοδα του μήνα στα είδη που πουλήθηκαν.
 * units: ίσα σε κάθε τεμάχιο των ειδών του perUnit (π.χ. όσα έχουν
 * συνταγή: όχι αναψυκτικά, extra, μεταφορικά). material: ανάλογα με το
 * κόστος υλικών. Τα λεπτά της στρογγυλοποίησης πάνε στο μεγαλύτερο μερίδιο.
 */
export function allocateOverhead(sales: SaleRow[], overhead: number, method: OverheadMethod, perUnit: Set<string>): ProfitResult {
  const by = new Map<string, ProfitRow>()
  for (const s of sales) {
    const r = by.get(s.item_id) ?? { item_id: s.item_id, name: s.item_name, qty: 0, net: 0, material: 0, overhead: 0, profit: 0 }
    r.qty += Number(s.qty)
    r.net += Number(s.net)
    r.material += Number(s.cogs ?? 0)
    by.set(s.item_id, r)
  }
  const rows = [...by.values()]
  const base = (r: ProfitRow) => (method === 'units' ? (perUnit.has(r.item_id) ? Math.max(0, r.qty) : 0) : Math.max(0, r.material))
  const total = rows.reduce((s, r) => s + base(r), 0)
  const oh = cents(Math.max(0, overhead))
  let given = 0
  if (total > 0 && oh > 0) {
    for (const r of rows) { r.overhead = cents((oh * base(r)) / total); given += r.overhead }
    const rest = cents(oh - given)
    if (rest !== 0) {
      const big = rows.reduce((a, b) => (base(b) > base(a) ? b : a))
      big.overhead = cents(big.overhead + rest)
      given = oh
    }
  }
  for (const r of rows) {
    r.net = cents(r.net)
    r.material = cents(r.material)
    r.profit = cents(r.net - r.material - r.overhead)
  }
  rows.sort((a, b) => b.profit - a.profit)
  const net = cents(rows.reduce((s, r) => s + r.net, 0))
  const material = cents(rows.reduce((s, r) => s + r.material, 0))
  const unallocated = cents(oh - given)
  return { rows, net, material, overhead: oh, unallocated, profit: cents(net - material - oh) }
}
