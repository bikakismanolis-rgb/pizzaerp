import { describe, expect, it } from 'vitest'
import { EXAMPLES } from './examples'
import { interpret } from './interpret'
import { describe as describeCmd } from './describe'
import type { Command, CommandKind, InterpretContext, Interpretation, VoicePhraseRule } from './types'
import { CTX, ITEMS, PARTNERS } from './testFixtures'

/**
 * Κάθε παράδειγμα της βοήθειας / του οδηγού περνά από τον interpreter με
 * τον κατάλογο δοκιμών. Στην ενότητα των δικών σας φράσεων, οι φράσεις που
 * μαθαίνει ένα παράδειγμα ισχύουν για τα επόμενα (όπως στην εφαρμογή).
 */

const SECTIONS = [
  'Πωλήσεις ημέρας', 'Πωλήσεις σε πελάτες', 'Αγορές', 'Παραγωγή', 'Απογραφή', 'Εισπράξεις και πληρωμές', 'Νέα είδη',
  'Νέοι πελάτες και προμηθευτές', 'Συνταγές', 'Τιμές', 'Ερωτήσεις', 'Κλείσιμο και αναίρεση', 'Δικές σας λέξεις και φράσεις',
]

/** issues που επιτρέπονται σε παράδειγμα (κατά τα άλλα: καθαρά) */
const ALLOWED_ISSUES: Record<string, RegExp> = {
  'efood τρεις μαργαρίτες, όχι δύο': /^Κράτησα το «δύο»/,
}

/** Για τα βασικά παραδείγματα: τι ακριβώς πρέπει να βγει */
const M = ITEMS.margarita.id
const S = ITEMS.special.id
const F = ITEMS.flour.id
const MZ = ITEMS.mozz.id
const FZ = ITEMS.frozen.id
const KEY: Record<string, (c: Command) => void> = {
  'efood τρεις μαργαρίτες και δύο σπέσιαλ': (c) => expect(c).toMatchObject({ channel: 'efood', channelHeard: true, lines: [{ item: { id: M }, qty: 3 }, { item: { id: S }, qty: 2 }] }),
  'wolt μία χαβανέζα': (c) => expect(c).toMatchObject({ channel: 'wolt', lines: [{ item: { id: ITEMS.hawaii.id }, qty: 1 }] }),
  'δύο μαργαρίτες': (c) => expect(c).toMatchObject({ channel: CTX.defaultChannel, channelHeard: false, lines: [{ item: { id: M }, qty: 2 }] }),
  'efood βγάλε μία μαργαρίτα': (c) => expect(c).toMatchObject({ channel: 'efood', lines: [{ item: { id: M }, qty: -1 }] }),
  'efood τρεις μαργαρίτες, όχι δύο': (c) => expect(c).toMatchObject({ lines: [{ item: { id: M }, qty: 2 }] }),
  'πούλησα στο ξενοδοχείο Αστέρια εξήντα σπέσιαλ κατεψυγμένες': (c) => expect(c).toMatchObject({ partner: { id: PARTNERS.asteria.id }, lines: [{ item: { id: FZ }, qty: 60 }] }),
  'δελτίο στο ξενοδοχείο Χ είκοσι σπέσιαλ κατεψυγμένες 3,90 η μία': (c) => expect(c).toMatchObject({ partner: { id: PARTNERS.hotelX.id }, lines: [{ item: { id: FZ }, qty: 20, unitPrice: 3.9 }] }),
  'ήρθαν από τον μύλο δέκα σακιά αλεύρι 0,62 το κιλό': (c) => expect(c).toMatchObject({ partner: { id: PARTNERS.mill.id }, lines: [{ item: { id: F }, qty: 250, unitPrice: 0.62 }] }),
  'τιμολόγιο 1234 από το τυροκομείο 20 κιλά μοτσαρέλα 7 ευρώ το κιλό': (c) => expect(c).toMatchObject({ partner: { id: PARTNERS.dairy.id }, refNo: '1234', lines: [{ item: { id: MZ }, qty: 20, unitPrice: 7 }] }),
  'ήρθαν από τον μύλο 10 σακιά αλεύρι, 155 ευρώ όλα': (c) => expect(c).toMatchObject({ partner: { id: PARTNERS.mill.id }, lines: [{ item: { id: F }, qty: 250, unitPrice: 0.62 }] }),
  'φτιάξαμε 80 ζυμάρια 400': (c) => expect(c).toMatchObject({ item: { id: ITEMS.dough400.id }, qty: 80 }),
  'ζύμωσα σαράντα ζυμάρια 250': (c) => expect(c).toMatchObject({ item: { id: ITEMS.dough250.id }, qty: 40 }),
  'μέτρησα μοτσαρέλα έξι κιλά, αλεύρι σαράντα επτά κιλά και είκοσι τρία ζυμάρια 400': (c) =>
    expect(c).toMatchObject({ lines: [{ item: { id: MZ }, qty: 6 }, { item: { id: F }, qty: 47 }, { item: { id: ITEMS.dough400.id }, qty: 23 }] }),
  'στην αποθήκη αλεύρι δέκα σακιά': (c) => expect(stockLines(c)).toEqual([[F, 250, null]]),
  'αλεύρι άλλα πέντε κιλά': (c) => expect(stockLines(c)).toEqual([[F, 5, 'add']]),
  'στο ψυγείο κι άλλη μοτσαρέλα τρία κιλά': (c) => expect(stockLines(c)).toEqual([[MZ, 3, 'add']]),
  'κι εδώ αλεύρι δύο σακιά': (c) => expect(stockLines(c)).toEqual([[F, 50, 'add']]),
  'στον καταψύκτη άλλες δέκα σπέσιαλ κατεψυγμένες': (c) => expect(stockLines(c)).toEqual([[FZ, 10, 'add']]),
  'αλεύρι σύνολο σαράντα κιλά': (c) => expect(stockLines(c)).toEqual([[F, 40, 'set']]),
  'διόρθωσε μοτσαρέλα έξι κιλά': (c) => expect(stockLines(c)).toEqual([[MZ, 6, 'set']]),
  'μοτσαρέλα άλλα δύο κιλά και αλεύρι σύνολο σαράντα': (c) => expect(stockLines(c)).toEqual([[MZ, 2, 'add'], [F, 40, 'set']]),
  'το ξενοδοχείο Αστέρια μου έδωσε 300 ευρώ': (c) => expect(c).toMatchObject({ partner: { id: PARTNERS.asteria.id }, amount: 300 }),
  'πλήρωσα τον μύλο 500 ευρώ': (c) => expect(c).toMatchObject({ partner: { id: PARTNERS.mill.id }, amount: 500 }),
  'νέο υλικό θυμάρι σε γραμμάρια': (c) => expect(c).toMatchObject({ itemType: 'raw', name: 'Θυμάρι', unit: 'g' }),
  'νέα πρώτη ύλη σιμιγδάλι έρχεται σε σακί των 25 κιλών': (c) => expect(c).toMatchObject({ itemType: 'raw', name: 'Σιμιγδάλι', unit: 'kg', packName: 'σακί', packQty: 25 }),
  'νέα πίτσα βεζούβιο 11 ευρώ': (c) => expect(c).toMatchObject({ itemType: 'finished', name: 'Βεζούβιο', makeToOrder: true, salePrice: 9.7345 }),
  'νέος πελάτης ταβέρνα Κύμα τηλέφωνο 6944123456': (c) => expect(c).toMatchObject({ name: 'Ταβέρνα Κύμα', isCustomer: true, phone: '6944123456' }),
  'η μαργαρίτα θέλει ένα ζυμάρι 250, 80 γραμμάρια σάλτσα και 120 γραμμάρια μοτσαρέλα': (c) =>
    expect(c).toMatchObject({ item: { id: M }, outputQty: 1, lines: [{ item: { id: ITEMS.dough250.id }, qty: 1 }, { item: { id: ITEMS.sauce.id }, qty: 0.08 }, { item: { id: MZ }, qty: 0.12 }] }),
  'η μαργαρίτα κάνει οκτώ ευρώ': (c) => expect(c).toMatchObject({ item: { id: M }, netPrice: 7.0796, heardGross: true }),
  'το ξενοδοχείο Αστέρια παίρνει τη σπέσιαλ κατεψυγμένη 3,90': (c) => expect(c).toMatchObject({ partner: { id: PARTNERS.asteria.id }, item: { id: FZ }, netPrice: 3.9 }),
  'πόση μοτσαρέλα έχουμε': (c) => expect(c).toMatchObject({ item: { id: MZ } }),
  'πόσα μας χρωστάει το ξενοδοχείο Αστέρια': (c) => expect(c).toMatchObject({ partner: { id: PARTNERS.asteria.id } }),
  'όταν λέω κλασική εννοώ μαργαρίτα': (c) => expect(c).toEqual({ kind: 'new_phrase', phrase: 'κλασική', meaning: 'μαργαρίτα' }),
  'όταν λέω ο Γιώργος θέλω να πω Ξενοδοχείο Αστέρια': (c) => expect(c).toEqual({ kind: 'new_phrase', phrase: 'ο Γιώργος', meaning: 'Ξενοδοχείο Αστέρια' }),
  'μάθε ότι χτύπα σημαίνει πούλησα': (c) => expect(c).toEqual({ kind: 'new_phrase', phrase: 'χτύπα', meaning: 'πούλησα' }),
  'το τυρί είναι η μοτσαρέλα': (c) => expect(c).toEqual({ kind: 'new_phrase', phrase: 'το τυρί', meaning: 'η μοτσαρέλα' }),
  'efood μία κλασική': (c) => expect(c).toMatchObject({ channel: 'efood', lines: [{ item: { id: M }, qty: 1 }] }),
  'ο Γιώργος πλήρωσε 300 ευρώ': (c) => expect(c).toMatchObject({ partner: { id: PARTNERS.asteria.id }, amount: 300 }),
  'χτύπα δύο μαργαρίτες': (c) => expect(c).toMatchObject({ lines: [{ item: { id: M }, qty: 2 }] }),
  'το συνηθισμένο του ξενοδοχείου': (c) => expect(c).toMatchObject({ partner: { id: PARTNERS.asteria.id }, lines: [{ item: { id: FZ }, qty: 60 }] }),
  'πόσο τυρί έχουμε': (c) => expect(c).toMatchObject({ item: { id: MZ } }),
}

function stockLines(c: Command) {
  return c.kind === 'stocktake' ? c.lines.map((l) => [l.item.id, l.qty, l.mode ?? null]) : null
}

/** Όλα τα παραδείγματα με το ctx που τους αντιστοιχεί */
function runAll(): { section: string; say: string; kind: CommandKind; r: Interpretation; ctx: InterpretContext }[] {
  const out: { section: string; say: string; kind: CommandKind; r: Interpretation; ctx: InterpretContext }[] = []
  for (const s of EXAMPLES) {
    const learned: VoicePhraseRule[] = []
    for (const ex of s.items) {
      const ctx: InterpretContext = { ...CTX, phrases: learned.slice() }
      const r = interpret(ex.say, ctx)
      out.push({ section: s.section, say: ex.say, kind: ex.kind, r, ctx })
      if (r.command.kind === 'new_phrase') learned.push({ phrase: r.command.phrase, meaning: r.command.meaning })
    }
  }
  return out
}

const ALL = runAll()

describe('EXAMPLES: ενότητες του οδηγού', () => {
  it('όλες οι ενότητες, με τη σειρά', () => {
    expect(EXAMPLES.map((s) => s.section)).toEqual(SECTIONS)
  })
  it('κάθε ενότητα έχει παραδείγματα, κάθε παράδειγμα κείμενο και εξήγηση, χωρίς διπλά', () => {
    for (const s of EXAMPLES) {
      expect(s.items.length, s.section).toBeGreaterThan(0)
      for (const ex of s.items) {
        expect(ex.say.trim(), s.section).not.toBe('')
        expect(ex.does.trim(), ex.say).not.toBe('')
      }
    }
    const says = EXAMPLES.flatMap((s) => s.items.map((x) => x.say))
    expect(new Set(says).size).toBe(says.length)
  })
  it('καλύπτει κάθε εντολή (εκτός από την άγνωστη), και πρόσθεση / αντικατάσταση στην απογραφή', () => {
    const kinds = new Set(ALL.map((x) => x.r.command.kind))
    const every: CommandKind[] = [
      'sale_tally', 'sale', 'purchase', 'production', 'stocktake', 'receipt', 'payment', 'new_item', 'new_partner', 'recipe',
      'item_price', 'partner_price', 'new_phrase', 'close_day', 'close_stocktake', 'undo', 'query_stock', 'query_balance',
      'query_today', 'help',
    ]
    for (const k of every) expect(kinds.has(k), k).toBe(true)
    const modes = new Set(ALL.flatMap((x) => (x.r.command.kind === 'stocktake' ? x.r.command.lines.map((l) => l.mode) : [])))
    expect(modes.has('add')).toBe(true)
    expect(modes.has('set')).toBe(true)
  })
  it('τα βασικά παραδείγματα έχουν και αναλυτικό έλεγχο', () => {
    const says = new Set(ALL.map((x) => x.say))
    for (const k of Object.keys(KEY)) expect(says.has(k), k).toBe(true)
  })
})

describe.each(EXAMPLES.map((s) => [s.section]))('%s', (section) => {
  it.each(ALL.filter((x) => x.section === section).map((x) => [x.say, x] as const))('«%s»', (_say, x) => {
    const { r, kind, ctx } = x
    expect(r.command.kind, JSON.stringify(r.command)).toBe(kind)
    expect(r.confidence).toBeGreaterThanOrEqual(0.6)
    const allowed = ALLOWED_ISSUES[x.say]
    expect(r.issues.filter((i) => !allowed?.test(i))).toEqual([])
    // σίγουρα ids: καμία γραμμή / αναφορά χωρίς είδος ή συναλλασσόμενο
    expect(JSON.stringify(r.command)).not.toMatch(/"id":null/)
    expect(describeCmd(r, ctx)).not.toMatch(/^Δεν κατάλαβα/)
    KEY[x.say]?.(r.command)
  })
})
