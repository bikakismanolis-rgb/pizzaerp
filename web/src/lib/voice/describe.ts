import type { Item, Partner } from '../types'
import type { EntityRef, InterpretContext, Interpretation, PricedLine, QtyLine } from './types'
import { CHANNEL_LABEL } from '../labels'
import { fmtCost, fmtMoney, fmtQty } from '../format'
import { normText } from './normalize'
import { genericPack, unitWord } from './lexicon'

/**
 * Μία φυσική ελληνική πρόταση για την οθόνη επιβεβαίωσης και την ανάγνωση
 * φωναχτά, π.χ. "Πώληση efood: 3 Μαργαρίτα, 2 Special. Να το περάσω;".
 * Ό,τι δεν βρέθηκε στον κατάλογο εμφανίζεται όπως ακούστηκε, σε «».
 */

const UNKNOWN = 'Δεν κατάλαβα. Πες π.χ. «efood δύο μαργαρίτες».'
const HELP =
  'Πες π.χ. «efood δύο μαργαρίτες», «ήρθαν δέκα σακιά αλεύρι από τον μύλο, 0,62 το κιλό», ' +
  '«μέτρησα μοτσαρέλα έξι κιλά», «έφτιαξα ογδόντα ζυμάρια» ή «πόση μοτσαρέλα έχουμε».'

function findItem(ctx: InterpretContext, id: string | null): Item | null {
  return id ? (ctx?.items ?? []).find((i) => i.id === id) ?? null : null
}

function findPartner(ctx: InterpretContext, id: string | null): Partner | null {
  return id ? (ctx?.partners ?? []).find((p) => p.id === id) ?? null : null
}

/** Όνομα από τον κατάλογο, αλλιώς «όπως ακούστηκε», αλλιώς οι υποψήφιοι */
function refText(ctx: InterpretContext, r: EntityRef | null | undefined, kind: 'item' | 'partner'): string {
  if (!r) return '«?»'
  const e = kind === 'item' ? findItem(ctx, r.id) : findPartner(ctx, r.id)
  if (e) return e.name
  if (r.heard) return `«${r.heard}»`
  const cs = (r.candidates ?? []).slice(0, 3).map((c) => c.name)
  return cs.length ? `(${cs.join(' ή ')})` : '«?»'
}

/** Ποσότητα με μονάδα: μικρά κιλά/λίτρα σε γραμμάρια/ml για να διαβάζονται εύκολα */
function qtyText(qty: number, unit: string | null): string {
  if (!unit || unit === 'τεμ') return fmtQty(qty)
  if (unit === 'kg' && qty > 0 && qty < 1) return `${fmtQty(qty * 1000)} g`
  if (unit === 'L' && qty > 0 && qty < 1) return `${fmtQty(qty * 1000)} ml`
  return `${fmtQty(qty)} ${unit}`
}

function lineText(ctx: InterpretContext, l: QtyLine, abs = false): string {
  const it = findItem(ctx, l.item?.id ?? null)
  const name = refText(ctx, l.item, 'item')
  const q = abs ? Math.abs(Number(l.qty) || 0) : Number(l.qty) || 0
  // 0 χωρίς heardQty = δεν ειπώθηκε ποσότητα (όχι "0 kg")
  if (q === 0 && !l.heardQty?.trim()) return `${name} (δεν ακούστηκε ποσότητα)`
  // άγνωστο είδος: η μονάδα όπως ακούστηκε ("10 σακιά «σιμιγδάλι»")
  if (!it && l.heardQty) {
    const last = normText(l.heardQty).split(' ').pop() ?? ''
    if (unitWord(last) || genericPack(last)) return `${l.heardQty} ${name}`
  }
  return `${qtyText(q, it ? it.unit : null)} ${name}`
}

/** Με τιμή μονάδας και σύνολο γραμμής ("250 kg Αλεύρι προς 0,62 € (σύνολο 155,00 €)") */
function pricedText(ctx: InterpretContext, l: PricedLine): string {
  const base = lineText(ctx, l)
  if (l.unitPrice === null || l.unitPrice === undefined) return base
  const q = Number(l.qty) || 0
  const total = q !== 1 && q > 0 ? ` (σύνολο ${fmtMoney(q * l.unitPrice)})` : ''
  return `${base} προς ${fmtCost(l.unitPrice)}${total}`
}

/** Ψηφία για ανάγνωση φωναχτά σε ομάδες ("69 44 12 34 56", "123 456 789") */
function digitGroups(d: string, size: number): string {
  const out: string[] = []
  for (let i = 0; i < d.length; i += size) out.push(d.slice(i, i + size))
  return out.join(' ')
}

function list(parts: string[]): string {
  return parts.length ? parts.join(', ') : '—'
}

/** Ένωση προτάσεων χωρίς διπλή τελεία ("Μύλος Α.Ε.." → "Μύλος Α.Ε.") */
function sentence(s: string, question?: string): string {
  const t = s.trim()
  const end = /[.!;;]$/.test(t) ? t : t + '.'
  return question ? `${end} ${question}` : end
}

/** Τιμή / ποσό 0 που δεν ειπώθηκε (το issue του parser υπάρχει ακόμα) */
const NO_PRICE = 'Δεν ακούστηκε τιμή.'
const NO_AMOUNT = 'Δεν ακούστηκε ποσό.'

function describeInner(interp: Interpretation, ctx: InterpretContext): string {
  const c = interp?.command
  if (!c) return UNKNOWN
  const ASK = 'Να το περάσω;'
  const unheard = (v: number, issue: string) => !v && (interp.issues ?? []).includes(issue)
  switch (c.kind) {
    case 'sale_tally': {
      const ch = CHANNEL_LABEL[c.channel] ?? c.channel
      if (!c.lines.length) return sentence(`Πώληση ${ch}: δεν κατάλαβα ποια προϊόντα`)
      const minus = c.lines.filter((l) => l.qty < 0)
      const plus = c.lines.filter((l) => !(l.qty < 0))
      if (!plus.length) return sentence(`Αφαίρεση από ${ch}: ${list(minus.map((l) => lineText(ctx, l, true)))}`, ASK)
      const body = list(plus.map((l) => lineText(ctx, l)))
      const less = minus.length ? `· αφαίρεση: ${list(minus.map((l) => lineText(ctx, l, true)))}` : ''
      return sentence(`Πώληση ${ch}: ${body}${less}`, ASK)
    }
    case 'sale': {
      const who = c.partner?.id || c.partner?.heard ? ` σε ${refText(ctx, c.partner, 'partner')}` : ' (χωρίς πελάτη)'
      return sentence(`Πώληση${who}: ${list(c.lines.map((l) => pricedText(ctx, l)))}`, ASK)
    }
    case 'purchase': {
      const who = c.partner?.id || c.partner?.heard ? ` από ${refText(ctx, c.partner, 'partner')}` : ' (χωρίς προμηθευτή)'
      const ref = c.refNo ? ` (τιμολόγιο ${c.refNo})` : ''
      return sentence(`Αγορά${who}${ref}: ${list(c.lines.map((l) => pricedText(ctx, l)))}`, ASK)
    }
    case 'production':
      return sentence(`Παραγωγή: ${lineText(ctx, { item: c.item, qty: c.qty })}`, ASK)
    case 'stocktake':
      return sentence(`Απογραφή: ${list(c.lines.map((l) => lineText(ctx, l)))}`, ASK)
    case 'receipt':
      if (unheard(c.amount, NO_AMOUNT)) return sentence(`Είσπραξη από ${refText(ctx, c.partner, 'partner')}: δεν ακούστηκε ποσό`)
      return sentence(`Είσπραξη ${fmtMoney(c.amount)} από ${refText(ctx, c.partner, 'partner')}`, ASK)
    case 'payment':
      if (unheard(c.amount, NO_AMOUNT)) return sentence(`Πληρωμή σε ${refText(ctx, c.partner, 'partner')}: δεν ακούστηκε ποσό`)
      return sentence(`Πληρωμή ${fmtMoney(c.amount)} σε ${refText(ctx, c.partner, 'partner')}`, ASK)
    case 'new_item': {
      const head = c.itemType === 'raw' ? 'Νέα πρώτη ύλη' : c.itemType === 'semi' ? 'Νέο ημιέτοιμο' : 'Νέο προϊόν'
      const parts = [`${head} «${c.name || '?'}» σε ${c.unit}`]
      if (c.packName) parts.push(c.packQty ? `${c.packName} των ${fmtQty(c.packQty)} ${c.unit}` : `σε ${c.packName}`)
      if (c.salePrice !== null && c.salePrice !== undefined) {
        const gross = c.salePrice * (1 + c.vatRate / 100)
        parts.push(`τιμή ${fmtMoney(gross)} με ΦΠΑ (${fmtMoney(c.salePrice)} χωρίς ΦΠΑ)`)
      }
      if (c.vatRate !== 13) parts.push(`ΦΠΑ ${c.vatRate}%`)
      if (c.makeToOrder) parts.push(c.itemType === 'semi' ? 'φτιάχνεται αυτόματα' : 'κατά παραγγελία')
      return sentence(parts.join(', '), c.itemType === 'raw' ? 'Να τη φτιάξω;' : 'Να το φτιάξω;')
    }
    case 'new_partner': {
      const role = c.isCustomer && c.isSupplier ? 'Νέος πελάτης και προμηθευτής' : c.isSupplier ? 'Νέος προμηθευτής' : 'Νέος πελάτης'
      const parts = [`${role} «${c.name || '?'}»`]
      if (c.city) parts.push(c.city)
      if (c.phone) parts.push(`τηλ. ${digitGroups(String(c.phone), 2)}`)
      if (c.vatNo) parts.push(`ΑΦΜ ${digitGroups(String(c.vatNo), 3)}`)
      return sentence(parts.join(', '), 'Να τον φτιάξω;')
    }
    case 'recipe': {
      const it = findItem(ctx, c.item?.id ?? null)
      const out = qtyText(c.outputQty, it?.unit ?? 'τεμ')
      const unitSuffix = !it || it.unit === 'τεμ' ? ' τεμ' : ''
      return sentence(
        `Συνταγή για ${refText(ctx, c.item, 'item')} (για ${out}${unitSuffix}): ${list(c.lines.map((l) => lineText(ctx, l)))}`,
        'Να την περάσω;',
      )
    }
    case 'item_price': {
      const it = findItem(ctx, c.item?.id ?? null)
      const vat = Number(it?.vat_rate ?? 13)
      const name = refText(ctx, c.item, 'item')
      if (unheard(c.netPrice, NO_PRICE)) return sentence(`Τιμή για ${name}: δεν ακούστηκε ποσό`)
      const text = c.heardGross
        ? `Τιμή για ${name}: ${fmtMoney(c.netPrice * (1 + vat / 100))} με ΦΠΑ (${fmtMoney(c.netPrice)} χωρίς ΦΠΑ)`
        : `Τιμή για ${name}: ${fmtMoney(c.netPrice)} χωρίς ΦΠΑ`
      return sentence(text, 'Να την αλλάξω;')
    }
    case 'partner_price':
      if (unheard(c.netPrice, NO_PRICE)) {
        return sentence(`Τιμή για ${refText(ctx, c.partner, 'partner')}: ${refText(ctx, c.item, 'item')}, δεν ακούστηκε ποσό`)
      }
      return sentence(
        `Τιμή για ${refText(ctx, c.partner, 'partner')}: ${refText(ctx, c.item, 'item')} ${fmtMoney(c.netPrice)} χωρίς ΦΠΑ`,
        'Να την περάσω;',
      )
    case 'close_day':
      return 'Κλείσιμο ημέρας: θα καταχωρηθούν οι ανοιχτές πωλήσεις ημέρας. Να προχωρήσω;'
    case 'close_stocktake':
      return 'Τέλος απογραφής: θα καταχωρηθεί η απογραφή σε εξέλιξη. Να προχωρήσω;'
    case 'undo':
      return 'Αναίρεση της τελευταίας καταχώρησης. Να προχωρήσω;'
    case 'query_stock':
      return sentence(`Απόθεμα για ${refText(ctx, c.item, 'item')}`)
    case 'query_balance':
      return sentence(`Υπόλοιπο για ${refText(ctx, c.partner, 'partner')}`)
    case 'query_today':
      return 'Οι σημερινές πωλήσεις.'
    case 'help':
      return HELP
    default:
      return UNKNOWN
  }
}

/** Ελληνική πρόταση για επιβεβαίωση (οθόνη + ανάγνωση φωναχτά) */
export function describe(interp: Interpretation, ctx: InterpretContext): string {
  try {
    return describeInner(interp, ctx)
  } catch {
    return UNKNOWN
  }
}

// ---------------------------------------------------------------------
// Ναι / όχι
// ---------------------------------------------------------------------
/**
 * Μόνο φράσεις φτιαγμένες από λέξεις ναι / όχι / γέμισμα. Οτιδήποτε άλλο
 * (αριθμός, είδος, νέα εντολή: "πέρασε 3 μαργαρίτες", "ναι αλλά βάλε τρεις")
 * δίνει null, ώστε να διαβαστεί ως νέα εντολή και να μην επιβεβαιωθεί
 * κατά λάθος η κάρτα που περιμένει.
 */
const YES_WORDS = new Set([
  'ναι', 'ενταξει', 'νταξει', 'οκ', 'οκει', 'ok', 'okay', 'σωστο', 'σωστα', 'σωστοσ', 'σωστη', 'μαλιστα', 'βεβαιωσ',
  'βεβαια', 'yes', 'yeah', 'yep', 'ακριβωσ', 'τελεια', 'προχωρα', 'προχωρησε', 'σιγουρα', 'φυσικα', 'αμε', 'go',
  'περασε', 'περασ', 'καταχωρησε', 'καταχωρισε', 'θελω',
])
/** ρήματα που μετά από άρνηση σημαίνουν όχι ("μην το περάσεις") */
const YES_VERBS = new Set(['περασεισ', 'καταχωρησεισ', 'καταχωρισεισ', 'περασετε', 'γραψεισ'])
const NO_WORDS = new Set([
  'οχι', 'ακυρο', 'ακυρωσε', 'ακυρωση', 'λαθοσ', 'σταματα', 'σταμα', 'no', 'nope', 'αστο', 'ασ', 'αφησε', 'αφησ',
  'περιμενε', 'stop', 'cancel',
])
const NEGATORS = new Set(['δεν', 'δε', 'μη', 'μην', 'καθολου'])
const FILLER = new Set([
  'ε', 'εε', 'εεε', 'εμ', 'ρε', 'λοιπον', 'το', 'τα', 'τη', 'την', 'παρακαλω', 'ευχαριστω', 'μου', 'φιλε', 'μωρε',
  'ειναι', 'ναι', 'λιγο', 'ακομα', 'ακομη', 'πολυ', 'αυτο', 'ετσι', 'please', 'thanks',
])

/** Ναι / όχι / άγνωστο, για φωνητική επιβεβαίωση */
export function parseYesNo(text: string): 'yes' | 'no' | null {
  try {
    const t = normText(String(text ?? ''))
    if (!t) return null
    const words = t.split(' ')
    if (words.length > 6) return null
    let yes = false
    let no = false
    let neg = false
    let negYes = false
    for (const w of words) {
      if (NEGATORS.has(w)) { neg = true; continue }
      if (YES_VERBS.has(w)) { if (neg) negYes = true; else return null; continue }
      if (NO_WORDS.has(w)) { no = true; continue }
      if (YES_WORDS.has(w)) { if (neg) negYes = true; else yes = true; continue }
      if (FILLER.has(w)) continue
      // αριθμός, είδος ή άλλη λέξη: δεν είναι απάντηση
      return null
    }
    if (negYes) no = true
    // σκέτο "μη!" / "μην!"· το σκέτο "δεν" μάλλον κόπηκε
    if (!yes && !no && words.every((w) => w === 'μη' || w === 'μην')) no = true
    if (yes && no) return null
    if (yes) return 'yes'
    if (no) return 'no'
    return null
  } catch {
    return null
  }
}
