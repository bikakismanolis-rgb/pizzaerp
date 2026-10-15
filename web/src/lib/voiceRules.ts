import type { Item } from './types'
import type { Command, CommandKind, EntityRef, QtyLine, TallyChannel } from './voice/types'
import { parseYesNo } from './voice/describe'

/**
 * Κανόνες της κάρτας επιβεβαίωσης του «Πες το» και βοηθητικά των ενεργειών.
 * Καθαρές συναρτήσεις (χωρίς βάση / DOM), ώστε να ελέγχονται με vitest.
 */

// ---------------------------------------------------------------------
// Ανοιχτά πρόχειρα (μετρητής ημέρας, απογραφή σε εξέλιξη)
// ---------------------------------------------------------------------
export interface TallyRow { channel: TallyChannel; date: string; docId: string; docNo: number; qty: number; gross: number }
export interface RunningStocktake { id: string; docNo: number; date: string; count: number }
export interface RunningState {
  /** σημερινές ανοιχτές πωλήσεις ανά κανάλι */
  tally: TallyRow[]
  /** ανοιχτές πωλήσεις προηγούμενων ημερών (δεν έχουν κλείσει ακόμα) */
  older: TallyRow[]
  stocktake: RunningStocktake | null
}

/** YYYY-MM-DD ± ημέρες */
export function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

/**
 * Σε ποια ημερομηνία γράφονται οι μετρήσεις: στην ανοιχτή απογραφή αν είναι
 * σημερινή ή χθεσινή (μέτρημα που περνάει τα μεσάνυχτα), αλλιώς σε σημερινή.
 */
export function stocktakeDate(open: { date: string } | null, today: string): string {
  return open && open.date <= today && open.date >= addDays(today, -1) ? open.date : today
}

/** "1 είδος" / "3 είδη" */
export const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

// ---------------------------------------------------------------------
// Αφαίρεση από τον μετρητή
// ---------------------------------------------------------------------
export interface TallyStep {
  id: string
  /** ό,τι θα σταλεί στο tally_add (0 = τίποτα) */
  delta: number
  /** ό,τι ζητήθηκε */
  asked: number
}

/**
 * Βήματα για τον μετρητή. Οι αφαιρέσεις περιορίζονται σε όσα υπάρχουν: ο
 * server σβήνει τη γραμμή στο 0, άρα η αναίρεση πρέπει να ξέρει πόσα βγήκαν
 * στην πραγματικότητα. lines: ένα ανά είδος (ήδη ενωμένα).
 */
export function tallySteps(lines: { id: string; qty: number }[], current: Map<string, number>): TallyStep[] {
  return lines.filter((l) => l.qty !== 0).map((l) => {
    if (l.qty > 0) return { id: l.id, delta: l.qty, asked: l.qty }
    const have = Math.max(0, current.get(l.id) ?? 0)
    return { id: l.id, delta: have > 0 ? -Math.min(have, -l.qty) : 0, asked: l.qty }
  })
}

// ---------------------------------------------------------------------
// Αναφορές (είδη / συναλλασσόμενοι) μέσα σε μια εντολή
// ---------------------------------------------------------------------
export type RefKind = 'item' | 'partner'
export interface RefSlot { path: string; kind: RefKind; ref: EntityRef }

type WithLines = Extract<Command, { lines: QtyLine[] }>
export const hasLines = (c: Command): c is WithLines => 'lines' in c

export function refSlots(cmd: Command): RefSlot[] {
  const out: RefSlot[] = []
  if ('partner' in cmd) out.push({ path: 'partner', kind: 'partner', ref: cmd.partner })
  if ('item' in cmd) out.push({ path: 'item', kind: 'item', ref: cmd.item })
  if (hasLines(cmd)) cmd.lines.forEach((l, i) => out.push({ path: `lines.${i}.item`, kind: 'item', ref: l.item }))
  return out
}

export function setRefAt(cmd: Command, path: string, ref: EntityRef): Command {
  const [head, idx] = path.split('.')
  if (head === 'lines' && hasLines(cmd)) {
    return { ...cmd, lines: cmd.lines.map((l, i) => (i === Number(idx) ? { ...l, item: ref } : l)) } as Command
  }
  return { ...cmd, [head]: ref } as Command
}

/** Μετά από αφαίρεση γραμμής i, οι σημαίες των επόμενων γραμμών μετακινούνται */
export function shiftFlags(flags: Record<string, boolean>, removed: number): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const [k, v] of Object.entries(flags)) {
    const m = /^lines\.(\d+)\.(.+)$/.exec(k)
    if (!m) { out[k] = v; continue }
    const i = Number(m[1])
    if (i === removed) continue
    out[i > removed ? `lines.${i - 1}.${m[2]}` : k] = v
  }
  return out
}

// ---------------------------------------------------------------------
// Τι εμποδίζει την εκτέλεση
// ---------------------------------------------------------------------
export interface CardEnv {
  itemById: Map<string, Item>
  /** πεδία που έγραψε ο χρήστης: 'lines.0.qty', 'lines.0.unitPrice', 'qty', 'netPrice', 'amount', 'outputQty' */
  edited: Record<string, boolean>
  running: RunningState | null
  hasUndo: boolean
  /** τιμή (χωρίς ΦΠΑ) που θα πάρει γραμμή χονδρικής χωρίς ειπωμένη τιμή· undefined = δεν είναι γνωστή ακόμα */
  saleFallback?: (itemId: string) => number | undefined
}

const okNum = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n)

/**
 * Σφάλμα που εμποδίζει το «ναι» (null = όλα καλά). Οι τιμές που βάζει ο
 * parser όταν δεν ακούστηκε κάτι (ποσότητα 0, τιμή 0) δεν περνάνε ποτέ
 * σιωπηλά: χρειάζεται αριθμός που ακούστηκε ή που έγραψε ο χρήστης.
 */
export function cardProblem(cmd: Command, env: CardEnv): string | null {
  for (const s of refSlots(cmd)) {
    if (!s.ref.id) return `Διάλεξε ${s.kind === 'partner' ? 'συναλλασσόμενο' : 'είδος'} για «${s.ref.heard}».`
  }
  const itemOf = (r: EntityRef) => (r.id ? env.itemById.get(r.id) : undefined)
  const nameOf = (r: EntityRef) => itemOf(r)?.name ?? r.heard
  const ed = (k: string) => !!env.edited[k]
  switch (cmd.kind) {
    case 'sale_tally': {
      if (cmd.lines.length === 0) return 'Δεν έμεινε καμία γραμμή.'
      for (const l of cmd.lines) {
        if (!okNum(l.qty) || l.qty === 0) return `Βάλε ποσότητα για «${nameOf(l.item)}».`
        const it = itemOf(l.item)
        // tally_add γράφει την τιμή του είδους και την κρατάει για όλη τη μέρα
        if (l.qty > 0 && it && !(Number(it.sale_price) > 0)) {
          return `Το «${it.name}» δεν έχει τιμή πώλησης (θα γραφόταν 0 €). Βάλε τιμή στα Είδη ή πες «η ${it.name.toLocaleLowerCase('el')} κάνει … ευρώ».`
        }
      }
      return null
    }
    case 'sale': case 'purchase': {
      if (cmd.lines.length === 0) return 'Δεν έμεινε καμία γραμμή.'
      for (const l of cmd.lines) {
        if (!okNum(l.qty) || l.qty <= 0) return `Βάλε ποσότητα για «${nameOf(l.item)}».`
        if (l.unitPrice != null) {
          if (!(okNum(l.unitPrice) && l.unitPrice >= 0)) return `Λάθος τιμή για «${nameOf(l.item)}».`
          continue
        }
        const it = itemOf(l.item)
        if (cmd.kind === 'sale') {
          const fb = it ? env.saleFallback?.(it.id) : undefined
          if (fb !== undefined && !(fb > 0)) return `Δεν υπάρχει τιμή για «${nameOf(l.item)}» (ούτε του πελάτη ούτε γενική). Γράψε τιμή.`
        } else if (it && !(Number(it.avg_cost) > 0)) {
          return `Γράψε τιμή για «${it.name}» (δεν υπάρχει μέσο κόστος).`
        }
      }
      return null
    }
    case 'stocktake': {
      if (cmd.lines.length === 0) return 'Δεν έμεινε καμία γραμμή.'
      for (const [i, l] of cmd.lines.entries()) {
        if (!okNum(l.qty) || l.qty < 0) return `Βάλε ποσότητα για «${nameOf(l.item)}».`
        if (l.qty === 0 && !l.heardQty?.trim() && !ed(`lines.${i}.qty`)) {
          return `Δεν ακούστηκε ποσότητα για «${nameOf(l.item)}». Γράψε τη μέτρηση (0 αν δεν έχει καθόλου).`
        }
      }
      return null
    }
    case 'recipe': {
      if (cmd.lines.length === 0) return 'Δεν έμεινε καμία γραμμή.'
      for (const l of cmd.lines) if (!okNum(l.qty) || l.qty <= 0) return `Βάλε ποσότητα για «${nameOf(l.item)}».`
      return okNum(cmd.outputQty) && cmd.outputQty > 0 ? null : 'Βάλε για πόσα τεμάχια είναι η συνταγή.'
    }
    case 'production': return okNum(cmd.qty) && cmd.qty > 0 ? null : 'Βάλε ποσότητα παραγωγής.'
    case 'receipt': case 'payment': return okNum(cmd.amount) && cmd.amount > 0 ? null : 'Βάλε ποσό.'
    case 'item_price': case 'partner_price':
      if (!(okNum(cmd.netPrice) && cmd.netPrice >= 0)) return 'Βάλε τιμή.'
      return cmd.netPrice === 0 && !ed('netPrice') ? `Δεν ακούστηκε τιμή για «${nameOf(cmd.item)}». Γράψε την τιμή.` : null
    case 'new_item': return cmd.name.trim() ? null : 'Βάλε όνομα.'
    case 'new_partner':
      if (!cmd.name.trim()) return 'Βάλε όνομα.'
      return cmd.isCustomer || cmd.isSupplier ? null : 'Διάλεξε πελάτης ή προμηθευτής.'
    case 'close_day': return env.running && env.running.tally.length + env.running.older.length > 0 ? null : 'Δεν υπάρχουν ανοιχτές πωλήσεις ημέρας.'
    case 'close_stocktake': return env.running?.stocktake ? null : 'Δεν υπάρχει απογραφή σε εξέλιξη.'
    case 'undo': return env.hasUndo ? null : 'Δεν υπάρχει κάτι για αναίρεση.'
    default: return null
  }
}

// ---------------------------------------------------------------------
// Προειδοποιήσεις του parser που ισχύουν ακόμα
// ---------------------------------------------------------------------
export interface Solved {
  /** φράσεις για τις οποίες ο χρήστης διάλεξε είδος/συναλλασσόμενο */
  entity: string[]
  /** ονόματα (ή φράσεις) γραμμών με ποσότητα που έγραψε ο χρήστης */
  qty: string[]
  /** ονόματα (ή φράσεις) γραμμών με τιμή που έγραψε ο χρήστης */
  price: string[]
  /** πεδία χωρίς γραμμή που έγραψε ο χρήστης */
  fields: ('qty' | 'price' | 'amount')[]
}

const UNLABELED: Record<Solved['fields'][number], string> = {
  qty: 'Δεν ακούστηκε ποσότητα.',
  price: 'Δεν ακούστηκε τιμή.',
  amount: 'Δεν ακούστηκε ποσό.',
}

/**
 * Κρύβει μόνο ό,τι έλυσε ο χρήστης: η επιλογή είδους λύνει το «δεν
 * βρέθηκε / εννοείς…», όχι το «δεν ακούστηκε ποσότητα» της ίδιας φράσης.
 */
export function visibleIssues(issues: string[], solved: Solved): string[] {
  const has = (i: string, label: string) => !!label && i.includes(`«${label}»`)
  return issues.filter((i) => {
    if (solved.entity.some((h) => has(i, h) && (i.startsWith(`Δεν βρέθηκε «${h}»`) || i.startsWith(`«${h}»: εννοείς`)))) return false
    if (solved.qty.some((l) => has(i, l) && /ποσότητα|μετέτρεψα|πέρασα|πήρα το/.test(i))) return false
    if (solved.price.some((l) => has(i, l) && /τιμή/.test(i))) return false
    if (solved.fields.some((f) => i === UNLABELED[f])) return false
    return true
  })
}

// ---------------------------------------------------------------------
// Απάντηση όσο περιμένει κάρτα επιβεβαίωσης
// ---------------------------------------------------------------------
const normWords = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ς/g, 'σ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean)

// λέξεις που συνοδεύουν ένα «ναι» χωρίς να αλλάζουν το νόημα
const YES_FILLER = new Set([
  'το', 'τα', 'τον', 'την', 'ολα', 'ολο', 'τωρα', 'παρακαλω', 'ρε', 'ε', 'λοιπον', 'και', 'πολυ', 'μια', 'χαρα',
  'φιλε', 'ετσι', 'αυτο', 'ειναι', 'σου', 'μου', 'please',
])

/**
 * yes: σκέτη επιβεβαίωση ("ναι", "οκ πέρασέ το").
 * no: σκέτη άρνηση ("όχι", "άκυρο").
 * fix: άρνηση + νέα εντολή ("όχι, τέσσερις μαργαρίτες"): ακύρωση και νέα κάρτα.
 * new: νέα εντολή (ακόμα κι αν περιέχει "πέρασε": "πέρασε δύο σπέσιαλ").
 * unclear: "ναι" με κάτι ακόμα που δεν καταλαβαίνουμε ("ναι αλλά δύο"): ρωτάμε ξανά.
 * kind: τι κατάλαβε ο interpreter από όλη τη φράση.
 */
export type Answer = 'yes' | 'no' | 'fix' | 'new' | 'unclear'
export function answerTo(text: string, kind: CommandKind): Answer {
  const words = normWords(text)
  const yn = parseYesNo(text)
  if (yn === 'yes') {
    if (kind !== 'unknown') return 'new'
    return words.every((w) => YES_FILLER.has(w) || parseYesNo(w) === 'yes') ? 'yes' : 'unclear'
  }
  // άρνηση, ή φράση που αρχίζει με άρνηση ("όχι, τέσσερις μαργαρίτες")
  const lead = words.length > 1 && parseYesNo(words[0]) === 'no'
  // "ακύρωσε (το τελευταίο)" όσο περιμένει κάρτα = ακύρωση της κάρτας, όχι αναίρεση
  if (yn === 'no' || lead) return kind === 'unknown' || kind === 'undo' ? 'no' : 'fix'
  return 'new'
}

// ---------------------------------------------------------------------
// Νέο είδος από ό,τι ακούστηκε
// ---------------------------------------------------------------------
/**
 * Πρόταση ονόματος: κεφαλαίο πρώτο γράμμα· μία λέξη είδους σε άτονο -ες
 * γίνεται ενικός σε -α ("μαργαρίτες" → "Μαργαρίτα", "τρούφες" → "Τρούφα").
 */
export function suggestName(heard: string, kind: RefKind): string {
  let t = heard.trim().replace(/\s+/g, ' ')
  if (!t) return ''
  if (kind === 'item' && !t.includes(' ') && /[α-ωάέήίόύώϊϋΐΰ]{3,}ες$/i.test(t)) t = t.slice(0, -2) + 'α'
  return t[0].toLocaleUpperCase('el') + t.slice(1)
}
