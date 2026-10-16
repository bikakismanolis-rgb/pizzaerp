import { describe, expect, it } from 'vitest'
import { interpret } from './interpret'
import type { Command, CommandKind, InterpretContext, QtyLine } from './types'
import { CTX, ITEMS } from './testFixtures'

/** Απογραφή: πρόσθεση ("άλλα") / αντικατάσταση ("σύνολο") ανά γραμμή */

const run = (text: string, ctx: InterpretContext = CTX) => interpret(text, ctx)
const cmd = <K extends CommandKind>(text: string, kind: K): Extract<Command, { kind: K }> => {
  const r = run(text)
  expect(r.command.kind, `«${text}» → ${JSON.stringify(r.command)}`).toBe(kind)
  return r.command as Extract<Command, { kind: K }>
}
/** [id, qty, mode] ανά γραμμή */
const modes = (ls: QtyLine[]) => ls.map((l) => [l.item.id, l.qty, l.mode ?? null])
const stock = (text: string) => modes(cmd(text, 'stocktake').lines)

const F = ITEMS.flour.id
const MZ = ITEMS.mozz.id
const M = ITEMS.margarita.id
const S = ITEMS.special.id

describe('απογραφή: λέξεις πρόσθεσης → mode add', () => {
  it.each([
    ['αλεύρι άλλα 5 κιλά', [[F, 5, 'add']]],
    ['αλεύρι άλλα πέντε κιλά', [[F, 5, 'add']]],
    ['μέτρησα κι άλλα 2 κιλά μοτσαρέλα', [[MZ, 2, 'add']]],
    ['και άλλα 2 κιλά μοτσαρέλα', [[MZ, 2, 'add']]],
    ['στο ψυγείο κι άλλη μοτσαρέλα 3 κιλά', [[MZ, 3, 'add']]],
    ['άλλο ένα σακί αλεύρι', [[F, 25, 'add']]],
    ['άλλες 2 κούτες κουτιά', [[ITEMS.box.id, 200, 'add']]],
    ['ακόμα 2 κιλά μοτσαρέλα', [[MZ, 2, 'add']]],
    ['μοτσαρέλα 2 κιλά ακόμα', [[MZ, 2, 'add']]],
    ['αλεύρι επιπλέον 5 κιλά', [[F, 5, 'add']]],
    ['αλεύρι 5 κιλά επιπλέον', [[F, 5, 'add']]],
    ['αλεύρι συν 5 κιλά', [[F, 5, 'add']]],
    ['πρόσθεσε αλεύρι 5 κιλά', [[F, 5, 'add']]],
    ['βάλε κι άλλα 5 κιλά αλεύρι', [[F, 5, 'add']]],
    ['κι εδώ αλεύρι δύο σακιά', [[F, 50, 'add']]],
    ['και εδώ μοτσαρέλα 4 κιλά', [[MZ, 4, 'add']]],
    ['στην κουζίνα άλλα 3 κιλά αλεύρι', [[F, 3, 'add']]],
  ] as const)('%s', (text, expected) => {
    expect(stock(text)).toEqual(expected)
  })
  it('χωρίς προειδοποίηση και με καλή βεβαιότητα (όχι το παλιό «δεν προσθέτει»)', () => {
    for (const t of ['αλεύρι άλλα 5 κιλά', 'μέτρησα κι άλλα 2 κιλά μοτσαρέλα', 'κι εδώ αλεύρι δύο σακιά']) {
      const r = run(t)
      expect(r.issues, t).toEqual([])
      expect(r.confidence, t).toBeGreaterThanOrEqual(0.8)
    }
  })
  it('η ποσότητα που ακούστηκε δεν περιέχει τη λέξη τρόπου', () => {
    expect(cmd('αλεύρι άλλα 5 κιλά', 'stocktake').lines[0].heardQty).toBe('5 κιλά')
  })
})

describe('απογραφή: λέξεις αντικατάστασης → mode set', () => {
  it.each([
    ['αλεύρι σύνολο 40', [[F, 40, 'set']]],
    ['αλεύρι σύνολο σαράντα κιλά', [[F, 40, 'set']]],
    ['αλεύρι 40 κιλά συνολικά', [[F, 40, 'set']]],
    ['συνολικά αλεύρι 40 κιλά', [[F, 40, 'set']]],
    ['αλεύρι όλα μαζί 40 κιλά', [[F, 40, 'set']]],
    ['τελικά αλεύρι 40 κιλά', [[F, 40, 'set']]],
    ['διόρθωσε μοτσαρέλα 6 κιλά', [[MZ, 6, 'set']]],
    ['διόρθωση: μοτσαρέλα 6 κιλά', [[MZ, 6, 'set']]],
    ['αλεύρι διόρθωση 40', [[F, 40, 'set']]],
    ['αλεύρι όχι 30 αλλά 40', [[F, 40, 'set']]],
    ['αλεύρι όχι 30 κιλά αλλά 40 κιλά', [[F, 40, 'set']]],
    ['αλεύρι όχι 3 σακιά αλλά 4', [[F, 100, 'set']]],
    ['αλεύρι 40 κιλά αντί για 30', [[F, 40, 'set']]],
    ['αλεύρι όχι άλλα, σύνολο 40', [[F, 40, 'set']]],
  ] as const)('%s', (text, expected) => {
    expect(stock(text)).toEqual(expected)
  })
  it('"όχι 3 σακιά αλλά 4": φαίνεται η νέα ποσότητα με τη μονάδα', () => {
    expect(cmd('αλεύρι όχι 3 σακιά αλλά 4', 'stocktake').lines[0].heardQty).toBe('4 σακιά')
  })
  it('χωρίς προειδοποίηση για «σύνολο» (δεν είναι σύνολο τιμής)', () => {
    expect(run('αλεύρι σύνολο 40').issues).toEqual([])
    expect(run('αλεύρι 40 κιλά αντί για 30').issues).toEqual([])
  })
})

describe('απογραφή: τρόπος ανά γραμμή', () => {
  it.each([
    ['μοτσαρέλα άλλα 2 κιλά και αλεύρι σύνολο 40', [[MZ, 2, 'add'], [F, 40, 'set']]],
    ['αλεύρι 40 κιλά συνολικά και μοτσαρέλα 6', [[F, 40, 'set'], [MZ, 6, null]]],
    ['μέτρησα μοτσαρέλα 6 κιλά και άλλα 2 κιλά αλεύρι', [[MZ, 6, null], [F, 2, 'add']]],
    ['μοτσαρέλα 2 κιλά και αλεύρι διόρθωση 40', [[MZ, 2, null], [F, 40, 'set']]],
    ['μοτσαρέλα 2 κιλά και αλεύρι όχι 30 αλλά 40', [[MZ, 2, null], [F, 40, 'set']]],
    // γενική λέξη στην αρχή: για όλες τις γραμμές, εκτός αν μια γραμμή λέει άλλο
    ['πρόσθεσε αλεύρι 5 κιλά και μοτσαρέλα 2', [[F, 5, 'add'], [MZ, 2, 'add']]],
    ['κι εδώ αλεύρι 5 κιλά και μοτσαρέλα σύνολο 6', [[F, 5, 'add'], [MZ, 6, 'set']]],
    ['διόρθωσε αλεύρι 40 και μοτσαρέλα 6', [[F, 40, 'set'], [MZ, 6, 'set']]],
  ] as const)('%s', (text, expected) => {
    expect(stock(text)).toEqual(expected)
  })
})

describe('απογραφή: χωρίς λέξη τρόπου → mode undefined (αποφασίζει η οθόνη)', () => {
  it.each([
    ['μέτρησα μοτσαρέλα έξι κιλά, αλεύρι σαράντα επτά κιλά', [[MZ, 6, null], [F, 47, null]]],
    ['Έχουμε ακόμα 2 κιλά μοτσαρέλα', [[MZ, 2, null]]],
    ['έμειναν ακόμα 3 κιλά αλεύρι', [[F, 3, null]]],
    ['στην αποθήκη αλεύρι 10 σακιά', [[F, 250, null]]],
    // "και άλλα" στο τέλος = "και άλλα πράγματα", όχι πρόσθεση
    ['μέτρησα μοτσαρέλα 5 κιλά, αλεύρι 10 κιλά και άλλα', [[MZ, 5, null], [F, 10, null]]],
  ] as const)('%s', (text, expected) => {
    expect(stock(text)).toEqual(expected)
  })
  it('δεν βάζει κλειδί mode όταν δεν ειπώθηκε', () => {
    expect('mode' in cmd('μέτρησα μοτσαρέλα 6 κιλά', 'stocktake').lines[0]).toBe(false)
  })
})

describe('απογραφή: πρόσθεση μέσα στην ίδια φράση (άθροισμα, όχι τρόπος)', () => {
  it.each([
    ['μέτρησα μοτσαρέλα 5 κιλά και άλλα 2', [[MZ, 7, null]]],
    ['αλεύρι 10 κιλά στην αποθήκη και άλλα 5 κιλά στο ψυγείο', [[F, 15, null]]],
    ['αλεύρι 10 κιλά στην αποθήκη και εδώ 5 κιλά', [[F, 15, null]]],
    ['μέτρησα 5 κιλά μοτσαρέλα και άλλα 2 κιλά μοτσαρέλα', [[MZ, 7, null]]],
    ['3 κιλά μοτσαρέλα στο ψυγείο και 2 κιλά στην αποθήκη', [[MZ, 5, null]]],
    // ίδιο είδος με "σύνολο" πιο μετά: μένει η τελευταία μέτρηση
    ['μοτσαρέλα 5 κιλά και μοτσαρέλα σύνολο 8 κιλά', [[MZ, 8, 'set']]],
    // "άλλα" στην αρχή: πρόσθεση σε ό,τι έχει μετρηθεί, μαζί με το άθροισμα της φράσης
    ['αλεύρι άλλα 10 κιλά και άλλα 5 κιλά', [[F, 15, 'add']]],
  ] as const)('%s', (text, expected) => {
    expect(stock(text)).toEqual(expected)
  })
})

describe('απογραφή: «άλλα τόσα» χωρίς αριθμό', () => {
  it.each(['αλεύρι άλλα τόσα', 'άλλα τόσα κιλά αλεύρι', 'και άλλα τόσα αλεύρι'])('%s', (text) => {
    const r = run(text)
    const c = r.command as Extract<Command, { kind: 'stocktake' }>
    expect(c.kind).toBe('stocktake')
    expect(c.lines).toHaveLength(1)
    expect(c.lines[0]).toMatchObject({ item: { id: F }, qty: 0, mode: 'add' })
    expect(c.lines[0].heardQty).toBeUndefined()
    expect(r.issues).toEqual(['Δεν ακούστηκε ποσότητα για «Αλεύρι»· πες τον αριθμό, π.χ. «άλλα πέντε κιλά».'])
  })
})

describe('απογραφή χωρίς ρήμα: οι λέξεις τρόπου τη δείχνουν', () => {
  it.each(['αλεύρι άλλα 5 κιλά', 'αλεύρι σύνολο 40', 'διόρθωσε μοτσαρέλα 6 κιλά', 'αλεύρι άλλα τόσα'])('%s → απογραφή', (text) => {
    expect(run(text).command.kind).toBe('stocktake')
  })
  it('με χώρο ("στην αποθήκη") και ποσότητα: απογραφή, όχι χαμηλή βεβαιότητα', () => {
    const r = run('στην αποθήκη αλεύρι 10 σακιά')
    expect(r.command.kind).toBe('stocktake')
    expect(r.confidence).toBeGreaterThanOrEqual(0.7)
  })
})

describe('πωλήσεις: χωρίς αλλαγή', () => {
  it.each([
    ['άλλες δύο μαργαρίτες', [[M, 2]]],
    ['efood άλλες δύο μαργαρίτες', [[M, 2]]],
    ['efood 3 μαργαρίτες και άλλες 2', [[M, 5]]],
    ['efood 2 μαργαρίτες ακόμα 1 σπέσιαλ', [[M, 2], [S, 1]]],
    ['πρόσθεσε 2 μαργαρίτες στο efood', [[M, 2]]],
    ['efood όχι 3 αλλά 4 μαργαρίτες', [[M, 4]]],
  ] as const)('%s', (text, expected) => {
    const c = cmd(text, 'sale_tally')
    expect(c.lines.map((l) => [l.item.id, l.qty])).toEqual(expected)
    expect(c.lines.every((l) => l.mode === undefined)).toBe(true)
  })
  it('αγορά με "κι άλλα": αγορά, χωρίς mode', () => {
    const c = cmd('ήρθαν κι άλλα 2 σακιά αλεύρι από τον μύλο', 'purchase')
    expect(c.lines.map((l) => [l.item.id, l.qty, l.mode])).toEqual([[F, 50, undefined]])
  })
  it('αγορά με "σύνολο": μένει σύνολο τιμής', () => {
    const c = cmd('πήρα από τον μύλο 10 σακιά αλεύρι σύνολο 155', 'purchase')
    expect(c.lines[0].unitPrice).toBe(0.62)
  })
})

describe('με προμηθευτή / τιμή χωρίς ρήμα: αγορά, όχι μέτρηση', () => {
  const MILL = 'p-mill'
  const DAIRY = 'p-dairy'
  it.each([
    ['από τον μύλο άλλα 2 σακιά αλεύρι', MILL, [[F, 50, null]]],
    ['από τον μύλο 10 σακιά αλεύρι σύνολο 155', MILL, [[F, 250, 0.62]]],
    ['από τον μύλο άλλα 2 σακιά αλεύρι 0,62 το κιλό', MILL, [[F, 50, 0.62]]],
    ['μύλος 10 σακιά αλεύρι στην αποθήκη', MILL, [[F, 250, null]]],
    ['τυροκομείο 20 κιλά μοτσαρέλα στο ψυγείο', DAIRY, [[MZ, 20, null]]],
    ['μύλος επιπλέον 2 σακιά αλεύρι', MILL, [[F, 50, null]]],
    ['τυροκομείο ακόμα 5 κιλά μοτσαρέλα', DAIRY, [[MZ, 5, null]]],
    // "σύνολο 10 σακιά" = ποσότητα, όχι τιμή
    ['από τον μύλο σύνολο 10 σακιά αλεύρι', MILL, [[F, 250, null]]],
  ] as const)('%s', (text, partner, expected) => {
    const c = cmd(text, 'purchase')
    expect(c.partner.id).toBe(partner)
    expect(c.lines.map((l) => [l.item.id, l.qty, l.unitPrice])).toEqual(expected)
    expect(c.lines.every((l) => l.mode === undefined)).toBe(true)
  })
  it('τιμή χωρίς προμηθευτή: όχι σίγουρη μέτρηση', () => {
    for (const t of ['αλεύρι άλλα 2 σακιά 0,62 το κιλό', 'στην αποθήκη αλεύρι 10 κιλά 0,62 το κιλό', '10 σακιά αλεύρι σύνολο 155']) {
      expect(run(t).confidence, t).toBeLessThan(0.6)
    }
  })
  it('το "σύνολο" της μέτρησης μένει μέτρηση (και σε άλλη γραμμή)', () => {
    expect(stock('μοτσαρέλα άλλα 2 κιλά και αλεύρι σύνολο 40')).toEqual([[MZ, 2, 'add'], [F, 40, 'set']])
    expect(stock('αλεύρι σύνολο 10 σακιά')).toEqual([[F, 250, 'set']])
    expect(run('μοτσαρέλα άλλα 2 κιλά και αλεύρι σύνολο 40').confidence).toBeGreaterThanOrEqual(0.8)
  })
})

describe('«διόρθωσε» σε πωλήσεις / εισπράξεις: όχι πρόσθεση', () => {
  it.each([
    'διόρθωσε δύο μαργαρίτες',
    'διόρθωσε τις μαργαρίτες σε δύο',
    'διόρθωσε σπέσιαλ 3',
    'διόρθωσε efood 4 μαργαρίτες',
    'efood διόρθωσε 3 μαργαρίτες',
  ])('%s → άγνωστο, με οδηγία', (text) => {
    const r = run(text)
    expect(r.command.kind).toBe('unknown')
    expect(r.issues.join(' ')).toMatch(/Η διόρθωση γίνεται μόνο στην απογραφή.*βγάλε μία μαργαρίτα/)
  })
  it.each(['διόρθωσε το ξενοδοχείο Αστέρια 300 ευρώ', 'διόρθωσε την παραγωγή 80 ζυμάρια 250', 'διόρθωσε από τον μύλο 10 σακιά αλεύρι'])(
    '%s → άγνωστο',
    (text) => {
      const r = run(text)
      expect(r.command.kind).toBe('unknown')
      expect(r.issues.join(' ')).toMatch(/ακύρωσε το τελευταίο/)
    },
  )
  it('στην απογραφή και μέσα στη φράση ("2 μαργαρίτες διόρθωση 3") δουλεύει όπως πριν', () => {
    expect(stock('διόρθωσε μοτσαρέλα 6 κιλά')).toEqual([[MZ, 6, 'set']])
    expect(stock('μέτρησα, διόρθωσε αλεύρι 40')).toEqual([[F, 40, 'set']])
    expect(cmd('efood 2 μαργαρίτες διόρθωση 3', 'sale_tally').lines.map((l) => [l.item.id, l.qty])).toEqual([[M, 3]])
  })
})

describe('κατεψυγμένα (με απόθεμα) ανά χώρο: μέτρηση, όχι πώληση', () => {
  const FZ = ITEMS.frozen.id
  it.each([
    ['στον καταψύκτη 10 σπέσιαλ κατεψυγμένες', [[FZ, 10, null]]],
    ['στον καταψύκτη άλλες 10 σπέσιαλ κατεψυγμένες', [[FZ, 10, 'add']]],
    ['κι εδώ 10 σπέσιαλ κατεψυγμένες', [[FZ, 10, 'add']]],
    ['σπέσιαλ κατεψυγμένες άλλες 10', [[FZ, 10, 'add']]],
    ['στην βιτρίνα 5 σπέσιαλ κατεψυγμένες', [[FZ, 5, null]]],
    // ο αριθμός μετά από "σύνολο" είναι ποσότητα, όχι το "30" του «30εκ»
    ['σπέσιαλ κατεψυγμένες σύνολο 30', [[FZ, 30, 'set']]],
    ['σπέσιαλ κατεψυγμένες άλλες 30', [[FZ, 30, 'add']]],
  ] as const)('%s', (text, expected) => {
    expect(stock(text)).toEqual(expected)
  })
  it('με πίτσες κατά παραγγελία ή με κανάλι: πωλήσεις', () => {
    expect(cmd('άλλες 2 μαργαρίτες και 3 σπέσιαλ κατεψυγμένες', 'sale_tally').lines.map((l) => l.qty)).toEqual([2, 3])
    expect(cmd('efood άλλες 2 σπέσιαλ κατεψυγμένες', 'sale_tally').lines.map((l) => l.qty)).toEqual([2])
    expect(cmd('10 σπέσιαλ κατεψυγμένες', 'sale_tally').lines.map((l) => l.qty)).toEqual([10])
  })
  it('"σπέσιαλ κατεψυγμένες 30" χωρίς λέξη ποσότητας: αμφίσημο (το 30 είναι και του ονόματος), ρωτάει', () => {
    const r = run('μέτρησα σπέσιαλ κατεψυγμένες 30')
    expect(r.command).toMatchObject({ kind: 'stocktake', lines: [{ item: { id: FZ }, qty: 0 }] })
    expect(r.issues.join(' ')).toMatch(/Δεν ακούστηκε ποσότητα/)
    // "ζυμάρια σύνολο 400": δύο ζυμάρια στον κατάλογο, το 400 είναι το όνομα
    expect(cmd('μέτρησα ζυμάρια σύνολο 400', 'stocktake').lines[0]).toMatchObject({ item: { id: ITEMS.dough400.id }, qty: 0 })
  })
})

describe('«και άλλα τόσα» μετά από ποσότητα: η ίδια ποσότητα ξανά', () => {
  it.each([
    ['αλεύρι 10 κιλά στην αποθήκη και άλλα τόσα στην κουζίνα', [[F, 20, null]]],
    ['μοτσαρέλα 3 κιλά και άλλα τόσα', [[MZ, 6, null]]],
    ['μέτρησα αλεύρι 10 κιλά και άλλα τόσα', [[F, 20, null]]],
    ['αλεύρι 2 σακιά και 10 κιλά και άλλα τόσα', [[F, 120, null]]],
    // "άλλα" στην αρχή: πρόσθεση σε ό,τι μετρήθηκε, με το άθροισμα της φράσης
    ['αλεύρι άλλα 10 κιλά και άλλα τόσα', [[F, 20, 'add']]],
  ] as const)('%s', (text, expected) => {
    expect(stock(text)).toEqual(expected)
    expect(run(text).issues).toEqual([])
  })
  it('σκέτο "τόσα" μετά από ποσότητα: ζητάει τον αριθμό', () => {
    const r = run('μέτρησα μοτσαρέλα 3 κιλά και τόσα')
    expect(r.issues.join(' ')).toMatch(/πες τον αριθμό/)
    expect(r.confidence).toBeLessThan(0.7)
  })
  it('χωρίς ποσότητα πριν: όπως πριν (ζητάει τον αριθμό)', () => {
    expect(run('αλεύρι άλλα τόσα').issues.join(' ')).toMatch(/πες τον αριθμό/)
  })
})

describe('«αλλά» (σύνδεσμος) και άρνηση: όχι πρόσθεση', () => {
  it('"αλλά" με τόνο στο τέλος δεν είναι "άλλα"', () => {
    expect(stock('μέτρησα μοτσαρέλα 6 κιλά αλλά αλεύρι 10')).toEqual([[MZ, 6, null], [F, 10, null]])
    expect(stock('μέτρησα μοτσαρέλα 6 κιλά άλλα αλεύρι 10')).toEqual([[MZ, 6, null], [F, 10, 'add']])
    // "όχι 30 αλλά 40" μένει αντικατάσταση
    expect(stock('αλεύρι όχι 30 αλλά 40')).toEqual([[F, 40, 'set']])
  })
  it('"δεν έχει άλλο": όχι πρόσθεση', () => {
    expect(stock('δεν έχει άλλο αλεύρι μόνο 5 κιλά')).toEqual([[F, 5, null]])
    expect(stock('μέτρησα, δεν υπάρχει άλλη μοτσαρέλα, μόνο 2 κιλά')).toEqual([[MZ, 2, null]])
  })
})

describe('πάγκος: χώρος στην απογραφή, κανάλι στις πωλήσεις', () => {
  it.each([
    ['στον πάγκο μοτσαρέλα άλλα 2 κιλά', [[MZ, 2, 'add']]],
    ['κάτω από τον πάγκο άλλο ένα σακί αλεύρι', [[F, 25, 'add']]],
    ['στον πάγκο μοτσαρέλα 2 κιλά', [[MZ, 2, null]]],
  ] as const)('%s', (text, expected) => {
    expect(stock(text)).toEqual(expected)
  })
  it('με πίτσες: κανάλι μαγαζί', () => {
    expect(cmd('πάγκος δύο μαργαρίτες', 'sale_tally')).toMatchObject({ channel: 'store', channelHeard: true, lines: [{ item: { id: M }, qty: 2 }] })
  })
  it.each(['και στην κουζίνα άλλα 5', 'άλλα δύο σακιά', 'στον πάγκο άλλα 3 κιλά'])('χωρίς είδος: «%s» → ζητάει το είδος', (text) => {
    const r = run(text)
    expect(r.command.kind).toBe('unknown')
    expect(r.issues).toEqual(['Πες και το είδος, π.χ. «αλεύρι άλλα 5 κιλά» ή «efood άλλες δύο μαργαρίτες».'])
  })
})

describe('βγάζω είδος από την απογραφή: όχι αναίρεση της τελευταίας ενέργειας', () => {
  it.each(['σβήσε το αλεύρι από την απογραφή', 'βγάλε το αλεύρι από την απογραφή', 'ακύρωσε τη μοτσαρέλα στην απογραφή', 'ακύρωσε την απογραφή'])('«%s» → εξήγηση', (text) => {
    const r = run(text)
    expect(r.command.kind).toBe('unknown')
    expect(r.issues[0]).toMatch(/^Η απογραφή σε εξέλιξη διορθώνεται από τη σελίδα της .*«Βγάλε».*«ακύρωσε το τελευταίο»/)
  })
  it.each([
    ['σβήσε το τελευταίο', 'undo'],
    ['ακύρωσε το τελευταίο', 'undo'],
    ['λάθος, ακύρωσέ το', 'undo'],
    ['κλείσε την απογραφή', 'close_stocktake'],
    ['efood βγάλε μία μαργαρίτα', 'sale_tally'],
  ] as const)('«%s» όπως πριν', (text, kind) => {
    expect(run(text).command.kind).toBe(kind)
  })
})
