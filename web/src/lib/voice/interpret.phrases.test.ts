import { describe, expect, it } from 'vitest'
import { interpret } from './interpret'
import { describe as describeCmd } from './describe'
import type { Command, CommandKind, InterpretContext, VoicePhraseRule } from './types'
import type { Item } from '../types'
import { CTX, ITEMS, PARTNERS, bigContext } from './testFixtures'

/** Δικές τους φράσεις (ctx.phrases) και η εντολή «νέα φράση» */

const withPhrases = (phrases: VoicePhraseRule[], base: InterpretContext = CTX): InterpretContext => ({ ...base, phrases })
const cmdIn = <K extends CommandKind>(ctx: InterpretContext, text: string, kind: K): Extract<Command, { kind: K }> => {
  const r = interpret(text, ctx)
  expect(r.command.kind, `«${text}» → ${JSON.stringify(r.command)}`).toBe(kind)
  return r.command as Extract<Command, { kind: K }>
}
const lines = (c: { lines: { item: { id: string | null }; qty: number }[] }) => c.lines.map((l) => [l.item.id, l.qty])

const M = ITEMS.margarita.id
const FZ = ITEMS.frozen.id
const AST = PARTNERS.asteria.id

const RULES: VoicePhraseRule[] = [
  { phrase: 'οικογενειακή', meaning: 'μεγάλη μαργαρίτα' },
  { phrase: 'ο Γιώργος', meaning: 'Ξενοδοχείο Αστέρια' },
  { phrase: 'χτύπα', meaning: 'πούλησα' },
  { phrase: 'το συνηθισμένο του ξενοδοχείου', meaning: 'πούλησα στο ξενοδοχείο Αστέρια 60 σπέσιαλ κατεψυγμένες' },
]
const PCTX = withPhrases(RULES)

describe('δικές τους φράσεις: αντικατάσταση πριν από την κατανόηση', () => {
  it('συνώνυμο είδους: «οικογενειακή» → «μεγάλη μαργαρίτα»', () => {
    expect(lines(cmdIn(PCTX, 'efood δύο οικογενειακή', 'sale_tally'))).toEqual([[M, 2]])
    // με είδος «Μεγάλη μαργαρίτα» στον κατάλογο: πάει σε αυτό, όχι στη σκέτη Μαργαρίτα
    const big: Item = { ...ITEMS.margarita, id: 'big', code: 'ΠΡ-099', name: 'Μεγάλη μαργαρίτα' }
    const ctx = withPhrases(RULES, { ...CTX, items: [...CTX.items, big] })
    expect(lines(cmdIn(ctx, 'efood δύο οικογενειακή', 'sale_tally'))).toEqual([['big', 2]])
  })
  it('παρατσούκλι πελάτη: «ο Γιώργος» → «Ξενοδοχείο Αστέρια»', () => {
    expect(cmdIn(PCTX, 'ο Γιώργος πλήρωσε 300 ευρώ', 'receipt')).toMatchObject({ partner: { id: AST }, amount: 300 })
    expect(cmdIn(PCTX, 'πόσα μας χρωστάει ο Γιώργος', 'query_balance').partner.id).toBe(AST)
    // χωρίς το άρθρο και με άλλη πτώση (μόνο το τελικό -ς): "στον Γιώργο"
    expect(cmdIn(PCTX, 'πούλησα στον Γιώργο 2 σπέσιαλ κατεψυγμένες', 'sale')).toMatchObject({ partner: { id: AST } })
  })
  it('ρήμα: «χτύπα» → «πούλησα»', () => {
    const r = interpret('χτύπα στο ξενοδοχείο Αστέρια 10 σπέσιαλ κατεψυγμένες', PCTX)
    expect(r.command.kind).toBe('sale')
    expect(r.confidence).toBeGreaterThan(interpret('χτύπα στο ξενοδοχείο Αστέρια 10 σπέσιαλ κατεψυγμένες', CTX).confidence)
    const v = withPhrases([{ phrase: 'ανοίξαμε', meaning: 'φτιάξαμε' }])
    expect(interpret('ανοίξαμε 40 ζυμάρια 250', CTX).command.kind).toBe('unknown')
    expect(cmdIn(v, 'ανοίξαμε 40 ζυμάρια 250', 'production')).toMatchObject({ item: { id: ITEMS.dough250.id }, qty: 40 })
  })
  it('ολόκληρη πρόταση με μία φράση', () => {
    const c = cmdIn(PCTX, 'το συνηθισμένο του ξενοδοχείου', 'sale')
    expect(c.partner.id).toBe(AST)
    expect(c.lines.map((l) => [l.item.id, l.qty])).toEqual([[FZ, 60]])
    // και χωρίς το αρχικό άρθρο
    expect(cmdIn(PCTX, 'συνηθισμένο του ξενοδοχείου', 'sale').partner.id).toBe(AST)
  })
  it('χωρίς τόνους / κεφαλαία, και στους δύο τρόπους', () => {
    for (const t of ['efood ΟΙΚΟΓΕΝΕΙΑΚΗ μία', 'efood οικογενειακη μία', 'efood Οικογενειακή μία']) {
      expect(lines(cmdIn(PCTX, t, 'sale_tally')), t).toEqual([[M, 1]])
    }
    const up = withPhrases([{ phrase: 'ΧΤΥΠΑ', meaning: 'πούλησα' }])
    expect(interpret('χτύπα 2 μαργαρίτες', up).confidence).toBe(interpret('πούλησα 2 μαργαρίτες', CTX).confidence)
  })
  it('μόνο ολόκληρες λέξεις: «ζυμάρι» δεν αγγίζει το «ζυμάρια»', () => {
    const z = withPhrases([{ phrase: 'ζυμάρι', meaning: 'Ζυμάρι 400γρ' }])
    // «ζυμάρια»: μένει αμφίσημο, όπως χωρίς φράση
    expect(cmdIn(z, 'μέτρησα 20 ζυμάρια', 'stocktake').lines[0].item.id).toBeNull()
    expect(cmdIn(z, 'μέτρησα 20 ζυμάρι', 'stocktake').lines[0].item.id).toBe(ITEMS.dough400.id)
    // ο χρήστης έγραψε και τον πληθυντικό
    const zz = withPhrases([{ phrase: 'ζυμάρι', meaning: 'Ζυμάρι 400γρ' }, { phrase: 'ζυμάρια', meaning: 'ζυμάρια 400' }])
    expect(cmdIn(zz, 'μέτρησα 20 ζυμάρια', 'stocktake').lines[0].item.id).toBe(ITEMS.dough400.id)
    // ούτε μέσα σε άλλη λέξη
    const p = withPhrases([{ phrase: 'μαργ', meaning: 'σπέσιαλ' }])
    expect(lines(cmdIn(p, 'efood 2 μαργαρίτες', 'sale_tally'))).toEqual([[M, 2]])
  })
  it('η μεγαλύτερη φράση πρώτα', () => {
    const r = withPhrases([
      { phrase: 'μεγάλη', meaning: 'σπέσιαλ' },
      { phrase: 'μεγάλη μαργαρίτα', meaning: 'καρμπονάρα' },
    ])
    expect(lines(cmdIn(r, 'efood 2 μεγάλη μαργαρίτα', 'sale_tally'))).toEqual([[ITEMS.carbonara.id, 2]])
    expect(lines(cmdIn(r, 'efood 2 μεγάλη', 'sale_tally'))).toEqual([[ITEMS.special.id, 2]])
  })
  it('ένα πέρασμα: ό,τι μπήκε δεν ξαναψάχνεται (χωρίς ατέρμονες αλυσίδες)', () => {
    const chain = withPhrases([
      { phrase: 'χαβα', meaning: 'μαργαρίτα' },
      { phrase: 'μαργαρίτα', meaning: 'πεπερόνι' },
    ])
    expect(lines(cmdIn(chain, 'efood 1 χαβα', 'sale_tally'))).toEqual([[M, 1]])
    const self = withPhrases([{ phrase: 'σπέσιαλ', meaning: 'σπέσιαλ κατεψυγμένη' }])
    expect(lines(cmdIn(self, 'πούλησα στο ξενοδοχείο Αστέρια 3 σπέσιαλ', 'sale'))).toEqual([[FZ, 3]])
  })
  it('σιωπηλά: χωρίς issues, και το text μένει το αρχικό', () => {
    const r = interpret('ο Γιώργος πλήρωσε 300 ευρώ', PCTX)
    expect(r.text).toBe('ο Γιώργος πλήρωσε 300 ευρώ')
    expect(r.issues).toEqual([])
  })
  it('χωρίς φράσεις / λάθος φράσεις: ίδιο αποτέλεσμα, ποτέ εξαίρεση', () => {
    const t = 'efood τρεις μαργαρίτες και δύο σπέσιαλ'
    const base = JSON.stringify(interpret(t, CTX))
    expect(JSON.stringify(interpret(t, withPhrases([])))).toBe(base)
    const bad = [
      { phrase: '', meaning: 'x' }, { phrase: '   ', meaning: 'x' }, { phrase: '«»', meaning: 'x' },
      null, { phrase: 3, meaning: null }, { meaning: 'x' },
    ] as unknown as VoicePhraseRule[]
    expect(JSON.stringify(interpret(t, withPhrases(bad)))).toBe(base)
    expect(interpret(t, { ...CTX, phrases: 'όχι πίνακας' as unknown as VoicePhraseRule[] }).command.kind).toBe('sale_tally')
  })
  it('νέες φράσεις στον ίδιο πίνακα πιάνουν αμέσως (χωρίς παλιά cache)', () => {
    const rules: VoicePhraseRule[] = []
    const ctx = withPhrases(rules)
    expect(interpret('efood 1 χαβα', ctx).command.kind).toBe('sale_tally')
    expect(lines(interpret('efood 1 χαβα', ctx).command as Extract<Command, { kind: 'sale_tally' }>)).toEqual([[null, 1]])
    rules.push({ phrase: 'χαβα', meaning: 'χαβανέζα' })
    expect(lines(cmdIn(ctx, 'efood 1 χαβα', 'sale_tally'))).toEqual([[ITEMS.hawaii.id, 1]])
    rules[0] = { phrase: 'χαβα', meaning: 'καρμπονάρα' }
    expect(lines(cmdIn(ctx, 'efood 1 χαβα', 'sale_tally'))).toEqual([[ITEMS.carbonara.id, 1]])
  })
})

describe('νέα φράση: «όταν λέω Χ εννοώ Υ»', () => {
  it.each([
    ['όταν λέω οικογενειακή εννοώ μεγάλη μαργαρίτα', 'οικογενειακή', 'μεγάλη μαργαρίτα'],
    ['Όταν λέω «οικογενειακή» θέλω να πω «Μεγάλη Μαργαρίτα».', 'οικογενειακή', 'Μεγάλη Μαργαρίτα'],
    ['όταν λέω "ο Γιώργος" εννοώ "Ξενοδοχείο Αστέρια"', 'ο Γιώργος', 'Ξενοδοχείο Αστέρια'],
    ['όταν λέμε το συνηθισμένο εννοούμε πούλησα στο Αστέρια 60 σπέσιαλ κατεψυγμένες', 'το συνηθισμένο', 'πούλησα στο Αστέρια 60 σπέσιαλ κατεψυγμένες'],
    ['όταν λέω ο Γιώργος να καταλαβαίνεις Ξενοδοχείο Αστέρια.', 'ο Γιώργος', 'Ξενοδοχείο Αστέρια'],
    ['μάθε ότι χτύπα σημαίνει πούλησα', 'χτύπα', 'πούλησα'],
    ['μάθε: σπεσιαλάκι είναι η Special', 'σπεσιαλάκι', 'η Special'],
    ['χτύπα σημαίνει πούλησα', 'χτύπα', 'πούλησα'],
    ['το συνηθισμένο του ξενοδοχείου σημαίνει πούλησα στο ξενοδοχείο Αστέρια 60 σπέσιαλ κατεψυγμένες',
      'το συνηθισμένο του ξενοδοχείου', 'πούλησα στο ξενοδοχείο Αστέρια 60 σπέσιαλ κατεψυγμένες'],
    ['το τυρί είναι η μοτσαρέλα', 'το τυρί', 'η μοτσαρέλα'],
    ['ο Γιώργος είναι το ξενοδοχείο Αστέρια', 'ο Γιώργος', 'το ξενοδοχείο Αστέρια'],
    // «είναι» μέσα σε εισαγωγικά δεν είναι η λέξη σημασίας
    ['όταν λέω «είναι έτοιμη» εννοώ «έφτιαξα»', 'είναι έτοιμη', 'έφτιαξα'],
  ])('%s', (text, phrase, meaning) => {
    const r = interpret(text, CTX)
    expect(r.command).toEqual({ kind: 'new_phrase', phrase, meaning })
    expect(r.confidence).toBeGreaterThanOrEqual(0.8)
    expect(r.text).toBe(text)
  })
  it('η πρόταση διδασκαλίας δεν αλλάζει από φράσεις που υπάρχουν ήδη', () => {
    const r = interpret('όταν λέω οικογενειακή εννοώ καρμπονάρα', PCTX)
    expect(r.command).toEqual({ kind: 'new_phrase', phrase: 'οικογενειακή', meaning: 'καρμπονάρα' })
    expect(r.issues.join(' ')).toContain('Υπάρχει ήδη')
  })
  it('φράση που είναι ήδη όνομα του καταλόγου: προειδοποίηση', () => {
    expect(interpret('όταν λέω σπέσιαλ εννοώ Special κατεψυγμένη 30εκ', CTX).issues.join(' ')).toMatch(/ήδη όνομα/)
    expect(interpret('η Special είναι η Special κατεψυγμένη', CTX).issues.join(' ')).toMatch(/ήδη όνομα/)
  })
  it('μισή πρόταση διδασκαλίας: δείχνει παράδειγμα', () => {
    for (const t of ['όταν λέω οικογενειακή', 'όταν λέω οικογενειακή εννοώ', 'μάθε ότι χτύπα σημαίνει']) {
      const r = interpret(t, CTX)
      expect(r.command.kind, t).toBe('unknown')
      expect(r.issues.join(' '), t).toContain('όταν λέω οικογενειακή εννοώ μεγάλη μαργαρίτα')
    }
  })
  it('ίδια φράση και σημασία: όχι', () => {
    expect(interpret('όταν λέω μαργαρίτα εννοώ Μαργαρίτα', CTX).command.kind).toBe('unknown')
  })
  it('«Χ είναι Υ» μόνο όταν το Υ είναι είδος / συναλλασσόμενος: δεν κλέβει συνηθισμένες προτάσεις', () => {
    expect(interpret('η μαργαρίτα είναι 8 ευρώ', CTX).command.kind).toBe('item_price')
    expect(interpret('το αλεύρι είναι από τον μύλο', CTX).command.kind).not.toBe('new_phrase')
    expect(interpret('ο μύλος είναι ο προμηθευτής μας', CTX).command.kind).not.toBe('new_phrase')
    expect(interpret('η καρμπονάρα είναι η πιο πουλημένη', CTX).command.kind).not.toBe('new_phrase')
    expect(interpret('αυτή είναι η μαργαρίτα', CTX).command.kind).not.toBe('new_phrase')
    expect(interpret('τι είναι η μαργαρίτα', CTX).command.kind).not.toBe('new_phrase')
    expect(interpret('πόσα είναι τα ζυμάρια 250', CTX).command.kind).not.toBe('new_phrase')
    // ίδιο είδος και στις δύο πλευρές: δεν χρειάζεται φράση
    expect(interpret('η χαβανεζούλα είναι η χαβανέζα', CTX).command.kind).not.toBe('new_phrase')
    // μεγάλη σημασία που δεν είναι όνομα: όχι νέα φράση
    expect(interpret('το τυρί είναι μοτσαρέλα 5 κιλά', CTX).command.kind).not.toBe('new_phrase')
  })
  it('«τι σημαίνει …» δεν είναι νέα φράση', () => {
    expect(interpret('τι σημαίνει απογραφή', CTX).command.kind).not.toBe('new_phrase')
  })
  it('συνηθισμένες εντολές με "σημείωσε", "μάθε" μένουν ίδιες', () => {
    expect(interpret('σημείωσε 3 μαργαρίτες', CTX).command.kind).toBe('sale_tally')
    expect(interpret('μάθε πόση μοτσαρέλα έχουμε', CTX).command.kind).toBe('query_stock')
  })
  it('describe: πρόταση για επιβεβαίωση', () => {
    const r = interpret('όταν λέω οικογενειακή εννοώ μεγάλη μαργαρίτα', CTX)
    expect(describeCmd(r, CTX)).toBe('Νέα φράση: όταν λες «οικογενειακή» θα καταλαβαίνω «μεγάλη μαργαρίτα». Να τη θυμάμαι;')
  })
  it('η νέα φράση πιάνει μετά, όπως θα την περάσει η οθόνη', () => {
    const c = interpret('όταν λέω τον Γιωργάκη εννοώ το ξενοδοχείο Αστέρια', CTX).command as Extract<Command, { kind: 'new_phrase' }>
    const ctx = withPhrases([{ phrase: c.phrase, meaning: c.meaning }])
    expect(cmdIn(ctx, 'τι μας χρωστάει ο Γιωργάκης', 'query_balance').partner.id).toBe(AST)
  })
})

describe('ταχύτητα με φράσεις: 50 φράσεις, ~200 είδη', () => {
  const big = bigContext()
  const rules: VoicePhraseRule[] = []
  for (let k = 0; k < 46; k++) rules.push({ phrase: `λέξη${k} φράση${k % 7}`, meaning: `μοτσαρέλα ${k % 5} κιλά` })
  rules.push(...RULES)
  const ctx = withPhrases(rules, big)
  it('οι φράσεις δουλεύουν και στον μεγάλο κατάλογο', () => {
    expect(cmdIn(ctx, 'ο Γιώργος πλήρωσε 300 ευρώ', 'receipt').partner.id).toBe(AST)
  })
  it('< 5 ms κατά μέσο όρο ανά φράση', () => {
    const texts = [
      'μέτρησα τυρί φρέσκο 3 κιλά σαλάμι κατεψυγμένο 2 κιλά μανιτάρια σε φέτες 1 κιλό φέτα τριμμένο 4 κιλά',
      'το συνηθισμένο του ξενοδοχείου',
      'χτύπα efood δύο οικογενειακή και τρεις σπέσιαλ',
      'ο Γιώργος πλήρωσε 300 ευρώ',
      'αλεύρι άλλα 5 κιλά και μοτσαρέλα σύνολο 6',
      'όταν λέω καπρίτσιο εννοώ σπέσιαλ',
      'το τυρί είναι η μοτσαρέλα',
    ]
    for (const t of texts) interpret(t, ctx)
    const t0 = performance.now()
    const N = 20
    for (let k = 0; k < N; k++) for (const t of texts) interpret(t, ctx)
    expect((performance.now() - t0) / (N * texts.length)).toBeLessThan(5)
  })
})

describe('ανθεκτικότητα: λέξεις τρόπου, διδασκαλία και φράσεις', () => {
  const VOCAB = [
    'αλεύρι', 'μοτσαρέλα', 'άλλα', 'άλλη', 'τόσα', 'σύνολο', 'συνολικά', 'όλα', 'μαζί', 'αντί', 'για', 'όχι', 'αλλά', 'κι', 'εδώ',
    'και', 'διόρθωσε', 'διόρθωση', 'ακόμα', 'επιπλέον', 'συν', 'πρόσθεσε', 'τελικά', 'στην', 'αποθήκη', 'ψυγείο', '5', 'σαράντα',
    'κιλά', 'σακιά', 'μέτρησα', 'όταν', 'λέω', 'εννοώ', 'σημαίνει', 'είναι', 'μάθε', 'ότι', 'θέλω', 'να', 'πω', '«', '»', '"',
    'efood', 'μαργαρίτες', 'οικογενειακή', 'Γιώργος', 'ο', 'το', 'χτύπα', ',', '.', 'έχουμε', 'έμειναν', 'η', 'Special',
  ]
  let seed = 4242
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
  it('2000 τυχαίες φράσεις: πάντα έγκυρο σχήμα', () => {
    const ids = new Set([...CTX.items.map((i) => i.id), ...CTX.partners.map((p) => p.id)])
    for (let k = 0; k < 2000; k++) {
      const len = 1 + Math.floor(rnd() * 12)
      const text = Array.from({ length: len }, () => VOCAB[Math.floor(rnd() * VOCAB.length)]).join(' ')
      const r = interpret(text, k % 2 ? PCTX : CTX)
      expect(r.text).toBe(text)
      expect(r.confidence).toBeGreaterThanOrEqual(0)
      expect(r.confidence).toBeLessThanOrEqual(1)
      const json = JSON.stringify(r)
      expect(json).not.toContain('NaN')
      for (const m of json.matchAll(/"id":"([^"]+)"/g)) expect(ids.has(m[1])).toBe(true)
      const c = r.command
      if (c.kind === 'stocktake') for (const l of c.lines) expect([undefined, 'add', 'set']).toContain(l.mode)
      if (c.kind === 'new_phrase') {
        expect(c.phrase.trim()).not.toBe('')
        expect(c.meaning.trim()).not.toBe('')
        expect(c.phrase).toBe(c.phrase.trim())
      }
    }
  })
})

describe('φράσεις και μεγαλύτερα ονόματα του καταλόγου', () => {
  const z = withPhrases([
    { phrase: 'ζυμάρι', meaning: 'Ζυμάρι 250γρ' },
    { phrase: 'το ξενοδοχείο', meaning: 'Ξενοδοχείο Αστέρια' },
  ])
  const D250 = ITEMS.dough250.id
  const D400 = ITEMS.dough400.id
  it('«ζυμάρι» δεν κόβει το «ζυμάρι 400»', () => {
    expect(cmdIn(z, 'μέτρησα ζυμάρι 400 20', 'stocktake').lines.map((l) => [l.item.id, l.qty])).toEqual([[D400, 20]])
    expect(cmdIn(z, 'φτιάξαμε 80 ζυμάρι 400', 'production')).toMatchObject({ item: { id: D400 }, qty: 80 })
    expect(cmdIn(z, 'πόσο ζυμάρι 400 έχουμε', 'query_stock').item.id).toBe(D400)
    // σκέτο: η φράση
    expect(cmdIn(z, 'μέτρησα ζυμάρι 20', 'stocktake').lines.map((l) => [l.item.id, l.qty])).toEqual([[D250, 20]])
  })
  it('«το ξενοδοχείο» δεν κόβει το «ξενοδοχείο Χ»', () => {
    const r = interpret('πούλησα στο ξενοδοχείο Χ 10 σπέσιαλ κατεψυγμένες', z)
    expect(r.command).toMatchObject({ kind: 'sale', partner: { id: PARTNERS.hotelX.id }, lines: [{ item: { id: FZ }, qty: 10 }] })
    expect(cmdIn(z, 'το ξενοδοχείο Χ μου έδωσε 100 ευρώ', 'receipt').partner.id).toBe(PARTNERS.hotelX.id)
    expect(cmdIn(z, 'το ξενοδοχείο μου έδωσε 100 ευρώ', 'receipt').partner.id).toBe(AST)
  })
  it('νέα φράση που είναι η αρχή ονόματος: προειδοποίηση', () => {
    const r = interpret('όταν λέω ζυμάρι εννοώ Ζυμάρι 250γρ', CTX)
    expect(r.command).toEqual({ kind: 'new_phrase', phrase: 'ζυμάρι', meaning: 'Ζυμάρι 250γρ' })
    // όχι η ίδια η σημασία: το άλλο ζυμάρι
    expect(r.issues).toEqual(['Το «ζυμάρι» είναι και η αρχή του «Ζυμάρι 400γρ»· εκεί θα κρατάω το όνομα του καταλόγου.'])
    expect(interpret('όταν λέω το ξενοδοχείο εννοώ Ξενοδοχείο Αστέρια', CTX).issues.join(' ')).toMatch(/αρχή του «Ξενοδοχείο/)
    expect(interpret('όταν λέω οικογενειακή εννοώ μεγάλη μαργαρίτα', CTX).issues).toEqual([])
  })
  it('αριθμοί με λέξεις: «νούμερο 1» πιάνει και το «νούμερο ένα»', () => {
    const n = withPhrases([{ phrase: 'νούμερο 1', meaning: 'μαργαρίτα' }])
    expect(lines(cmdIn(n, 'efood δύο νούμερο ένα', 'sale_tally'))).toEqual([[M, 2]])
    expect(lines(cmdIn(n, 'efood δύο νούμερο 1', 'sale_tally'))).toEqual([[M, 2]])
  })
})

describe('«Χ είναι Υ» / «Χ σημαίνει Υ»: όχι από συνηθισμένες προτάσεις', () => {
  it.each([
    'efood δύο πίτσες η μία είναι μαργαρίτα',
    'η μία είναι μαργαρίτα',
    'τα δύο είναι μαργαρίτες',
    'όλες είναι μαργαρίτες',
    'και οι δύο είναι μαργαρίτες',
    'η πίτσα είναι μαργαρίτα',
    'η τελευταία πίτσα είναι σπέσιαλ',
    'το σακί είναι αλεύρι',
    'αυτό το σακί είναι αλεύρι',
    'το πρώτο είναι η μαργαρίτα',
    'η άλλη είναι η Special',
    'όχι, είναι η μοτσαρέλα',
    'λάθος, είναι η μοτσαρέλα',
    'efood η μία είναι μαργαρίτα',
    'το κιλό είναι μοτσαρέλα',
    'η μία σημαίνει μαργαρίτα',
    'μάθε ότι η μαργαρίτα είναι 8 ευρώ',
  ])('%s', (text) => {
    expect(interpret(text, CTX).command.kind).not.toBe('new_phrase')
  })
  it('"λάθος, είναι η μοτσαρέλα" μένει αναίρεση· "μάθε ότι η μαργαρίτα είναι 8 ευρώ" μένει τιμή', () => {
    expect(interpret('λάθος, είναι η μοτσαρέλα', CTX).command.kind).toBe('undo')
    expect(interpret('μάθε ότι η μαργαρίτα είναι 8 ευρώ', CTX).command.kind).toBe('item_price')
  })
  it('φράσεις που κάποιος πέρασε έτσι (π.χ. από τη σελίδα) δεν χαλάνε άλλες πωλήσεις', () => {
    const bad = withPhrases([
      { phrase: 'η μία', meaning: 'μαργαρίτα' },
      { phrase: 'τα δύο', meaning: 'μαργαρίτες' },
    ])
    expect(lines(cmdIn(bad, 'efood μία σπέσιαλ', 'sale_tally'))).toEqual([[ITEMS.special.id, 1]])
    expect(lines(cmdIn(bad, 'efood δύο σπέσιαλ', 'sale_tally'))).toEqual([[ITEMS.special.id, 2]])
  })
  it('"ναι" / "όχι" ως φράση: όχι (κρατιούνται για την επιβεβαίωση)', () => {
    const r = interpret('όταν λέω όχι εννοώ μοτσαρέλα', CTX)
    expect(r.command.kind).toBe('unknown')
    expect(r.issues.join(' ')).toMatch(/«ναι» \/ «όχι»/)
  })
  it('οι σωστές μορφές δουλεύουν ακόμα', () => {
    expect(interpret('το τυρί είναι η μοτσαρέλα', CTX).command).toEqual({ kind: 'new_phrase', phrase: 'το τυρί', meaning: 'η μοτσαρέλα' })
    expect(interpret('χτύπα σημαίνει πούλησα', CTX).command).toEqual({ kind: 'new_phrase', phrase: 'χτύπα', meaning: 'πούλησα' })
    // ρητή διδασκαλία: ο χρήστης το ζήτησε, ακόμα και με αριθμό
    expect(interpret('όταν λέω νούμερο ένα εννοώ μαργαρίτα', CTX).command).toEqual({ kind: 'new_phrase', phrase: 'νούμερο ένα', meaning: 'μαργαρίτα' })
  })
})

describe('νέα φράση: κι άλλοι τρόποι να το πεις', () => {
  it.each([
    ['όταν σου λέω οικογενειακή εννοώ μεγάλη μαργαρίτα', 'οικογενειακή', 'μεγάλη μαργαρίτα'],
    ['όταν θα λέω οικογενειακή εννοώ μεγάλη μαργαρίτα', 'οικογενειακή', 'μεγάλη μαργαρίτα'],
    ['όταν θα σου λέω οικογενειακή θέλω να πω μεγάλη μαργαρίτα', 'οικογενειακή', 'μεγάλη μαργαρίτα'],
    ['όποτε λέω οικογενειακή εννοώ μεγάλη μαργαρίτα', 'οικογενειακή', 'μεγάλη μαργαρίτα'],
    ['κάθε φορά που λέω οικογενειακή εννοώ μεγάλη μαργαρίτα', 'οικογενειακή', 'μεγάλη μαργαρίτα'],
    ['αν πω οικογενειακή εννοώ μεγάλη μαργαρίτα', 'οικογενειακή', 'μεγάλη μαργαρίτα'],
    ['εγώ λέω οικογενειακή και εννοώ μεγάλη μαργαρίτα', 'οικογενειακή', 'μεγάλη μαργαρίτα'],
    ['οικογενειακή θα πει μεγάλη μαργαρίτα', 'οικογενειακή', 'μεγάλη μαργαρίτα'],
    ['η οικογενειακή είναι μεγάλη μαργαρίτα', 'η οικογενειακή', 'μεγάλη μαργαρίτα'],
    // εισαγωγές πριν από τη φράση
    ['μάθε τη λέξη οικογενειακή, σημαίνει μεγάλη μαργαρίτα', 'οικογενειακή', 'μεγάλη μαργαρίτα'],
    ['μάθε καινούργια λέξη: οικογενειακή σημαίνει μεγάλη μαργαρίτα', 'οικογενειακή', 'μεγάλη μαργαρίτα'],
    ['νέα λέξη οικογενειακή σημαίνει μεγάλη μαργαρίτα', 'οικογενειακή', 'μεγάλη μαργαρίτα'],
    ['νέα φράση: το συνηθισμένο, σημαίνει πούλησα στο Αστέρια 60 σπέσιαλ κατεψυγμένες', 'το συνηθισμένο', 'πούλησα στο Αστέρια 60 σπέσιαλ κατεψυγμένες'],
    ['αυτό που λέμε τυρί είναι η μοτσαρέλα', 'τυρί', 'η μοτσαρέλα'],
    ['το «χτύπα» σημαίνει «πούλησα»', 'χτύπα', 'πούλησα'],
    ['μάθε ότι το "χτύπα" σημαίνει "πούλησα"', 'χτύπα', 'πούλησα'],
    ['όταν λέει ο πελάτης οικογενειακή εννοεί μεγάλη μαργαρίτα', 'οικογενειακή', 'μεγάλη μαργαρίτα'],
  ])('%s', (text, phrase, meaning) => {
    const r = interpret(text, CTX)
    expect(r.command).toEqual({ kind: 'new_phrase', phrase, meaning })
    expect(r.confidence).toBeGreaterThanOrEqual(0.8)
  })
  it('ρήμα "λέω" και πιο μετά "εννοώ": ποτέ πώληση', () => {
    for (const t of ['όταν σου λέω οικογενειακή εννοώ', 'λέω μαργαρίτα και εννοώ', 'όταν σας λέμε μαργαρίτα εννοούμε']) {
      expect(['new_phrase', 'unknown'], t).toContain(interpret(t, CTX).command.kind)
    }
  })
  it('"αν πω" / "αυτό που λέμε" χωρίς σημασία: όχι διδασκαλία ούτε παράδειγμα', () => {
    expect(interpret('αν πω ναι πέρασέ το', CTX).issues.join(' ')).not.toContain('όταν λέω οικογενειακή')
    expect(interpret('αυτό που λέω είναι ότι θέλουμε αλεύρι', CTX).command.kind).not.toBe('new_phrase')
    // τρίτο πρόσωπο χωρίς σημασία ("όταν θα πει ο μύλος την τιμή"): όχι παράδειγμα διδασκαλίας
    expect(interpret('όταν θα πει ο μύλος την τιμή γράψε τη', CTX).issues.join(' ')).not.toContain('όταν λέω οικογενειακή')
  })
})
