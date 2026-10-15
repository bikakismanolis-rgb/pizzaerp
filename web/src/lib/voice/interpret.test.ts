import { describe, expect, it } from 'vitest'
import { interpret, localInterpreter } from './interpret'
import type { Command, CommandKind, EntityRef, InterpretContext, PricedLine, QtyLine } from './types'
import { CTX, ITEMS, PARTNERS, bigContext } from './testFixtures'

const run = (text: string, ctx: InterpretContext = CTX) => interpret(text, ctx)
const cmd = <K extends CommandKind>(text: string, kind: K, ctx: InterpretContext = CTX): Extract<Command, { kind: K }> => {
  const r = run(text, ctx)
  expect(r.command.kind, `«${text}» → ${JSON.stringify(r.command)}`).toBe(kind)
  return r.command as Extract<Command, { kind: K }>
}
/** [id, qty] ανά γραμμή */
const lines = (ls: QtyLine[]) => ls.map((l) => [l.item.id, l.qty])
const priced = (ls: PricedLine[]) => ls.map((l) => [l.item.id, l.qty, l.unitPrice])
const cands = (r: EntityRef) => r.candidates.map((c) => c.id).sort()

const M = ITEMS.margarita.id
const S = ITEMS.special.id
const P = ITEMS.pepperoni.id
const H = ITEMS.hawaii.id
const C = ITEMS.carbonara.id
const FZ = ITEMS.frozen.id
const D250 = ITEMS.dough250.id
const D400 = ITEMS.dough400.id

// ---------------------------------------------------------------------
describe('sale_tally: πωλήσεις λιανικής', () => {
  it('παράδειγμα: efood τρεις μαργαρίτες και δύο σπέσιαλ', () => {
    const c = cmd('efood τρεις μαργαρίτες και δύο σπέσιαλ', 'sale_tally')
    expect(c.channel).toBe('efood')
    expect(c.channelHeard).toBe(true)
    expect(lines(c.lines)).toEqual([[M, 3], [S, 2]])
    expect(c.lines[0].heardQty).toBe('τρεις')
    expect(c.lines[0].item.heard).toBe('μαργαρίτες')
  })
  it('χωρίς κανάλι → προεπιλογή της οθόνης', () => {
    const c = cmd('2 μαργαρίτες', 'sale_tally')
    expect(c.channel).toBe('store')
    expect(c.channelHeard).toBe(false)
    expect(lines(c.lines)).toEqual([[M, 2]])
    expect(cmd('2 μαργαρίτες', 'sale_tally', { ...CTX, defaultChannel: 'wolt' }).channel).toBe('wolt')
  })
  it.each([
    ['efood 3 μαργαρίτες', 'efood'],
    ['e-food 3 μαργαρίτες', 'efood'],
    ['E FOOD 3 margarita', 'efood'],
    ['ιφούντ 3 μαργαρίτες', 'efood'],
    ['ι φουντ 3 μαργαρίτες', 'efood'],
    ['wolt 3 μαργαρίτες', 'wolt'],
    ['βολτ 3 μαργαρίτες', 'wolt'],
    ['box 3 μαργαρίτες', 'box'],
    ['μποξ 3 μαργαρίτες', 'box'],
    ['τηλέφωνο 3 μαργαρίτες', 'phone'],
    ['τηλεφωνικά 3 μαργαρίτες', 'phone'],
    ['3 μαργαρίτες από τηλέφωνο', 'phone'],
    ['μαγαζί 3 μαργαρίτες', 'store'],
    ['κατάστημα 3 μαργαρίτες', 'store'],
    ['σαλόνι 3 μαργαρίτες', 'store'],
    ['από μέσα 3 μαργαρίτες', 'store'],
  ])('κανάλι: %s → %s', (text, ch) => {
    const c = cmd(text, 'sale_tally')
    expect(c.channel).toBe(ch)
    expect(c.channelHeard).toBe(true)
    expect(lines(c.lines)).toEqual([[M, 3]])
  })
  it('ρήμα + κανάλι στο τέλος: πούλησα μια πεπερόνι στο μαγαζί (πίτσα, όχι σαλάμι)', () => {
    const c = cmd('πούλησα μια πεπερόνι στο μαγαζί', 'sale_tally')
    expect(c.channel).toBe('store')
    expect(lines(c.lines)).toEqual([[P, 1]])
  })
  it.each([
    ['wolt μία χαβανέζα', [[H, 1]]],
    ['τηλέφωνο δυο μαργαρίτες', [[M, 2]]],
    ['μαργαρίτα και πεπερόνι', [[M, 1], [P, 1]]],
    ['efood 3 margarita 2 special', [[M, 3], [S, 2]]],
    ['EFOOD ΤΡΕΙΣ ΜΑΡΓΑΡΙΤΕΣ', [[M, 3]]],
    ['εφουντ τρεις μαργαριτες', [[M, 3]]],
    ['pepperoni 2', [[P, 2]]],
    ['δύο pepperoni', [[P, 2]]],
    ['box 4 καρμπονάρες', [[C, 4]]],
    ['μποξ τέσσερις καρμπονάρες', [[C, 4]]],
    ['3 μαργαρίτες 2 σπέσιαλ 1 χαβανέζα efood', [[M, 3], [S, 2], [H, 1]]],
    ['efood δώδεκα μαργαρίτες οκτώ σπέσιαλ πέντε πεπερόνι', [[M, 12], [S, 8], [P, 5]]],
    ['efood μαργαρίτες τρεις σπέσιαλ δύο', [[M, 3], [S, 2]]],
    ['efood 2 μαργαρίτες ακόμα 1 σπέσιαλ', [[M, 2], [S, 1]]],
    ['ε λοιπόν efood ε τρεις μαργαρίτες', [[M, 3]]],
    ['efood 2 σπέσιαλ κατεψυγμένες', [[FZ, 2]]],
    ['efood 2 χαβανεζες και 1 καρμπονάρα', [[H, 2], [C, 1]]],
  ])('%s', (text, expected) => {
    expect(lines(cmd(text, 'sale_tally').lines)).toEqual(expected)
  })
  it('άγνωστο (ή ανενεργό) προϊόν: γραμμή χωρίς id + προειδοποίηση', () => {
    const r = run('efood τρεις μαργαρίτες και δύο καλτσόνε')
    const c = r.command as Extract<Command, { kind: 'sale_tally' }>
    expect(lines(c.lines)).toEqual([[M, 3], [null, 2]])
    expect(c.lines[1].item.heard).toBe('καλτσόνε')
    expect(r.issues.join(' ')).toContain('«καλτσόνε»')
    expect(r.confidence).toBeLessThan(0.5)
  })
  it('"λιγότερη" → αρνητική ποσότητα', () => {
    expect(lines(cmd('efood μία μαργαρίτα λιγότερη', 'sale_tally').lines)).toEqual([[M, -1]])
  })
  it('σκέτο κανάλι → χωρίς γραμμές, χαμηλή βεβαιότητα', () => {
    const r = run('efood')
    expect(r.command.kind).toBe('sale_tally')
    expect(r.confidence).toBeLessThan(0.3)
  })
  it('δύο κανάλια: κρατά το πρώτο με προειδοποίηση', () => {
    const r = run('μια μαργαρίτα efood και δυο σπεσιαλ wolt')
    expect((r.command as Extract<Command, { kind: 'sale_tally' }>).channel).toBe('efood')
    expect(r.issues.length).toBe(1)
  })
})

// ---------------------------------------------------------------------
describe('sale: πώληση σε πελάτη', () => {
  it('πούλησα στο ξενοδοχείο Αστέρια εξήντα σπέσιαλ κατεψυγμένες', () => {
    const c = cmd('πούλησα στο ξενοδοχείο Αστέρια εξήντα σπέσιαλ κατεψυγμένες', 'sale')
    expect(c.partner.id).toBe(PARTNERS.asteria.id)
    expect(priced(c.lines)).toEqual([[FZ, 60, null]])
  })
  it('δελτίο στον Χ με τιμή', () => {
    const c = cmd('δελτίο στον Χ 20 σπέσιαλ κατεψυγμένες προς 4,50', 'sale')
    expect(c.partner.id).toBe(PARTNERS.hotelX.id)
    expect(priced(c.lines)).toEqual([[FZ, 20, 4.5]])
  })
  it('δύο γραμμές με τιμές', () => {
    const c = cmd('πούλησα στο ξενοδοχείο Χ 60 σπέσιαλ κατεψυγμένες 4,50 και 20 μαργαρίτες 3 ευρώ', 'sale')
    expect(priced(c.lines)).toEqual([[FZ, 60, 4.5], [M, 20, 3]])
  })
  it('"σπέσιαλ" σε πελάτη χονδρικής: ρωτάει ποιο', () => {
    const c = cmd('πούλησα στο ξενοδοχείο Χ 20 σπέσιαλ', 'sale')
    expect(c.lines[0].item.id).toBeNull()
    expect(cands(c.lines[0].item)).toEqual([S, FZ].sort())
  })
})

// ---------------------------------------------------------------------
describe('purchase: αγορές', () => {
  it('παράδειγμα με σακιά, τιμή ανά κιλό και δεύτερη γραμμή', () => {
    const r = run('αγόρασα από τον μύλο δέκα σακιά αλεύρι 0,62 το κιλό και 2 κιλά μαγιά 3 ευρώ το κιλό')
    const c = r.command as Extract<Command, { kind: 'purchase' }>
    expect(c.kind).toBe('purchase')
    expect(c.partner.id).toBe(PARTNERS.mill.id)
    expect(priced(c.lines)).toEqual([[ITEMS.flour.id, 250, 0.62], [ITEMS.yeast.id, 2, 3]])
    expect(c.lines[0].heardQty).toBe('δέκα σακιά')
    expect(c.refNo).toBeNull()
    expect(r.issues).toEqual([])
    expect(r.confidence).toBeGreaterThan(0.8)
  })
  it('τιμολόγιο με αριθμό', () => {
    const c = cmd('τιμολόγιο 1234 από το τυροκομείο 20 κιλά μοτσαρέλα 7,50 το κιλό', 'purchase')
    expect(c.refNo).toBe('1234')
    expect(c.partner.id).toBe(PARTNERS.dairy.id)
    expect(priced(c.lines)).toEqual([[ITEMS.mozz.id, 20, 7.5]])
  })
  it.each([
    ['ήρθαν 10 σακιά αλεύρι από τον μύλο 15 ευρώ το σακί', [[ITEMS.flour.id, 250, 0.6]]],
    ['πήρα από τον μύλο 10 σακιά αλεύρι σύνολο 155', [[ITEMS.flour.id, 250, 0.62]]],
    ['παρέλαβα από τον μύλο 250 κιλά αλεύρι εξήντα δύο λεπτά το κιλό', [[ITEMS.flour.id, 250, 0.62]]],
    ['αγόρασα από το τυροκομείο 2 κιλά μαγιά τρία και πενήντα το κιλό', [[ITEMS.yeast.id, 2, 3.5]]],
    ['ήρθε ο μύλος με 10 σακιά 15 ευρώ το σακί', [[ITEMS.flour.id, 250, 0.6]]],
    ['παρέλαβα 2 κούτες κουτιά πίτσας', [[ITEMS.box.id, 200, null]]],
    ['αγόρασα 5 κιλά πεπερόνι', [[ITEMS.salami.id, 5, null]]],
    ['αγόρασα 500 γραμμάρια ρίγανη', [[ITEMS.oregano.id, 500, null]]],
    ['αγόρασα 2 κιλά ρίγανη', [[ITEMS.oregano.id, 2000, null]]],
    ['αγόρασα μισό κιλό μαγιά', [[ITEMS.yeast.id, 0.5, null]]],
    ['ήρθαν 20 λίτρα ελαιόλαδο 5 ευρώ το λίτρο', [[ITEMS.oil.id, 20, 5]]],
    ['αγόρασα 10 κιλά μοτσαρέλα 7,91 το κιλό με ΦΠΑ', [[ITEMS.mozz.id, 10, 7]]],
  ])('%s', (text, expected) => {
    expect(priced(cmd(text, 'purchase').lines)).toEqual(expected)
  })
  it('χωρίς τιμή: προειδοποίηση για μέσο κόστος', () => {
    const r = run('ήρθε το τυροκομείο με 30 κιλά μοτσαρέλα')
    expect(r.command.kind).toBe('purchase')
    expect(r.issues).toContain('Δεν ακούστηκε τιμή για «Μοτσαρέλα»· θα μπει το μέσο κόστος.')
  })
  it('χωρίς προμηθευτή: προειδοποίηση', () => {
    const r = run('αγόρασα 5 κιλά μοτσαρέλα')
    expect((r.command as Extract<Command, { kind: 'purchase' }>).partner.id).toBeNull()
    expect(r.issues).toContain('Δεν ακούστηκε προμηθευτής.')
  })
})

// ---------------------------------------------------------------------
describe('production: παραγωγή', () => {
  it('έφτιαξα ογδόντα ζυμάρια → ποιο ζυμάρι;', () => {
    const c = cmd('έφτιαξα ογδόντα ζυμάρια', 'production')
    expect(c.qty).toBe(80)
    expect(c.item.id).toBeNull()
    expect(cands(c.item)).toEqual([D250, D400].sort())
  })
  it.each([
    ['φτιάξαμε 80 ζυμάρια 400', D400, 80],
    ['έφτιαξα 40 τετρακοσάρια', D400, 40],
    ['ζυμώσαμε εκατό ζυμάρια των 250 γραμμαρίων', D250, 100],
    ['παραγωγή 60 σπέσιαλ κατεψυγμένες', FZ, 60],
    ['βγάλαμε 30 special κατεψυγμένες', FZ, 30],
  ])('%s', (text, id, qty) => {
    const c = cmd(text, 'production')
    expect([c.item.id, c.qty]).toEqual([id, qty])
  })
  it('ζύμωσα 80 → υποψήφια τα ζυμάρια', () => {
    const c = cmd('ζύμωσα 80', 'production')
    expect(c.qty).toBe(80)
    expect(cands(c.item)).toEqual([D250, D400].sort())
  })
})

// ---------------------------------------------------------------------
describe('stocktake: απογραφή', () => {
  it('παράδειγμα με τρία είδη, κόμμα και "και"', () => {
    const c = cmd('μέτρησα μοτσαρέλα έξι κιλά, αλεύρι σαράντα επτά κιλά και είκοσι τρία ζυμάρια', 'stocktake')
    expect(lines(c.lines)).toEqual([[ITEMS.mozz.id, 6], [ITEMS.flour.id, 47], [null, 23]])
    expect(cands(c.lines[2].item)).toEqual([D250, D400].sort())
  })
  it.each([
    ['έχουμε 6,5 κιλά μοτσαρέλα', [[ITEMS.mozz.id, 6.5]]],
    ['μέτρησα έξι κόμμα πέντε κιλά μοτσαρέλα', [[ITEMS.mozz.id, 6.5]]],
    ['μέτρησα ενάμισι κιλό μοτσαρέλα', [[ITEMS.mozz.id, 1.5]]],
    ['μέτρησα ένα κιλό και μισό μοτσαρέλα', [[ITEMS.mozz.id, 1.5]]],
    ['έμειναν 23 ζυμάρια 250', [[D250, 23]]],
    ['μέτρησα μισό κιλό ρίγανη', [[ITEMS.oregano.id, 500]]],
    ['απογραφή πεπερόνι 3 κιλά', [[ITEMS.salami.id, 3]]],
    ['μέτρησα 3 σακιά και 2 κούτες', [[ITEMS.flour.id, 75], [ITEMS.box.id, 200]]],
    ['απογραφή: μοτσαρελα 6 αλευρι 47 ζυμαρια 400 20', [[ITEMS.mozz.id, 6], [ITEMS.flour.id, 47], [D400, 20]]],
    ['μέτρησα 14 σπέσιαλ κατεψυγμένες', [[FZ, 14]]],
    ['έχουμε 2 λίτρα ελαιόλαδο και 300 ml νερό', [[ITEMS.oil.id, 2], [ITEMS.water.id, 0.3]]],
  ])('%s', (text, expected) => {
    expect(lines(cmd(text, 'stocktake').lines)).toEqual(expected)
  })
  it('χωρίς ρήμα, πρώτες ύλες με ποσότητες → απογραφή με χαμηλή βεβαιότητα', () => {
    const r = run('μοτσαρέλα 6 κιλά αλεύρι 47 κιλά')
    expect(r.command.kind).toBe('stocktake')
    expect(r.confidence).toBeLessThan(0.6)
  })
  it('χωρίς ποσότητα: προειδοποίηση', () => {
    const r = run('μέτρησα μοτσαρέλα')
    expect(r.issues).toContain('Δεν ακούστηκε ποσότητα για «Μοτσαρέλα».')
    expect(r.confidence).toBeLessThan(0.6)
  })
})

// ---------------------------------------------------------------------
describe('receipt / payment', () => {
  it.each([
    ['το ξενοδοχείο Αστέρια μου έδωσε 300 ευρώ', 'receipt', PARTNERS.asteria.id, 300],
    ['είσπραξη 300 από το ξενοδοχείο Χ', 'receipt', PARTNERS.hotelX.id, 300],
    ['πήρα 200 ευρώ από το ξενοδοχείο Αστέρια', 'receipt', PARTNERS.asteria.id, 200],
    ['το efood μας πλήρωσε 450,50', 'receipt', PARTNERS.efood.id, 450.5],
    ['ο Αστέρια πλήρωσε τριακόσια', 'receipt', PARTNERS.asteria.id, 300],
    ['εισπράξαμε από τον Χ διακόσια πενήντα ευρώ', 'receipt', PARTNERS.hotelX.id, 250],
    ['πλήρωσα τον μύλο 500 ευρώ', 'payment', PARTNERS.mill.id, 500],
    ['έδωσα στο τυροκομείο 200', 'payment', PARTNERS.dairy.id, 200],
    ['πληρωμή μύλου 1.250 ευρώ', 'payment', PARTNERS.mill.id, 1250],
    ['πλήρωσα το τυροκομείο κρήτης χίλια διακόσια πενήντα ευρώ', 'payment', PARTNERS.dairy.id, 1250],
    ['πλήρωσε τον μύλο 100 ευρώ', 'payment', PARTNERS.mill.id, 100],
    ['πλήρωσα στον μύλο 120 ευρώ και 50 λεπτά', 'payment', PARTNERS.mill.id, 120.5],
  ])('%s', (text, kind, partnerId, amount) => {
    const c = run(text).command as Extract<Command, { kind: 'receipt' | 'payment' }>
    expect(c.kind).toBe(kind)
    expect(c.partner.id).toBe(partnerId)
    expect(c.amount).toBe(amount)
  })
  it('αμφίσημος πελάτης → υποψήφιοι', () => {
    const c = cmd('είσπραξη 100 από το ξενοδοχείο', 'receipt')
    expect(c.partner.id).toBeNull()
    expect(cands(c.partner)).toEqual([PARTNERS.asteria.id, PARTNERS.hotelX.id].sort())
  })
  it('χωρίς ποσό: προειδοποίηση', () => {
    const r = run('πλήρωσα τον μύλο')
    expect(r.command.kind).toBe('payment')
    expect(r.issues).toContain('Δεν ακούστηκε ποσό.')
  })
})

// ---------------------------------------------------------------------
describe('new_item: νέο είδος', () => {
  it.each([
    ['νέα πρώτη ύλη μανιτάρια σε κιλά', { itemType: 'raw', name: 'Μανιτάρια', unit: 'kg', makeToOrder: false }],
    ['νέο υλικό θυμάρι σε γραμμάρια', { itemType: 'raw', name: 'Θυμάρι', unit: 'g' }],
    ['νέα πρώτη ύλη σιμιγδάλι έρχεται σε σακί των 25 κιλών', { itemType: 'raw', name: 'Σιμιγδάλι', unit: 'kg', packName: 'σακί', packQty: 25 }],
    ['νέα πρώτη ύλη ντομάτα κονκασέ', { itemType: 'raw', name: 'Ντομάτα κονκασέ', unit: 'kg' }],
    ['νέα πίτσα τόνου 10 ευρώ', { itemType: 'finished', name: 'Τόνου', makeToOrder: true, salePrice: 8.8496, vatRate: 13 }],
    ['νέο προϊόν σπέσιαλ κατεψυγμένη 4,50', { itemType: 'finished', name: 'Σπέσιαλ κατεψυγμένη', makeToOrder: false, salePrice: 4.5 }],
    ['νέο ημιέτοιμο ζυμάρι 300 γραμμάρια', { itemType: 'semi', name: 'Ζυμάρι 300γρ', unit: 'τεμ' }],
    ['νέο ζυμάρι 500 γραμμάρια', { itemType: 'semi', name: 'Ζυμάρι 500γρ', unit: 'τεμ' }],
    ['νέα πίτσα τέσσερα τυριά 11 ευρώ ΦΠΑ 24', { itemType: 'finished', name: '4 τυριά', vatRate: 24, salePrice: 8.871 }],
    ['νέο προϊόν μαργαρίτα κατεψυγμένη 30 εκατοστά 3,80 χωρίς ΦΠΑ', { itemType: 'finished', name: 'Μαργαρίτα κατεψυγμένη 30εκ', makeToOrder: false, salePrice: 3.8 }],
    ['νέα πρώτη ύλη χαρτοπετσέτες σε κούτα των 100 τεμαχίων', { itemType: 'raw', name: 'Χαρτοπετσέτες', packName: 'κούτα', packQty: 100, unit: 'τεμ' }],
    ['νέα πρώτη ύλη τόνος σε κιλά συσκευασία κούτα των 12 κιλών', { itemType: 'raw', name: 'Τόνος', unit: 'kg', packName: 'κούτα', packQty: 12 }],
  ])('%s', (text, expected) => {
    expect(cmd(text, 'new_item')).toMatchObject(expected)
  })
  it('υπάρχει ήδη → προειδοποίηση', () => {
    const r = run('νέα πίτσα καρμπονάρα 10 ευρώ')
    expect(r.command.kind).toBe('new_item')
    expect(r.issues).toContain('Υπάρχει ήδη «Καρμπονάρα».')
  })
})

// ---------------------------------------------------------------------
describe('new_partner: νέος συναλλασσόμενος', () => {
  it.each([
    ['νέος πελάτης ξενοδοχείο Ήλιος τηλέφωνο 2810 123 456', { name: 'Ξενοδοχείο Ήλιος', isCustomer: true, isSupplier: false, phone: '2810123456' }],
    ['νέος προμηθευτής τυροκομείο ζαρού ΑΦΜ 123456789', { name: 'Τυροκομείο Ζαρού', isCustomer: false, isSupplier: true, vatNo: '123456789' }],
    ['νέος πελάτης ταβέρνα ο Νίκος στο Ηράκλειο τηλέφωνο 6912345678', { name: 'Ταβέρνα ο Νίκος', city: 'Ηράκλειο', phone: '6912345678' }],
    ['νέος πελάτης και προμηθευτής Μάρκος', { name: 'Μάρκος', isCustomer: true, isSupplier: true }],
    ['νέος πελάτης pizza house τηλέφωνο 210 1234567', { name: 'Pizza House', phone: '2101234567' }],
    ['νέος πελάτης καφέ Ωραία τηλέφωνο είκοσι οκτώ δέκα εκατόν είκοσι τρία τετρακόσια πενήντα έξι', { name: 'Καφέ Ωραία', phone: '2810123456' }],
  ])('%s', (text, expected) => {
    expect(cmd(text, 'new_partner')).toMatchObject(expected)
  })
})

// ---------------------------------------------------------------------
describe('recipe: συνταγές', () => {
  it('η μαργαρίτα έχει ένα ζυμάρι, ογδόντα γραμμάρια σάλτσα και εκατόν είκοσι γραμμάρια μοτσαρέλα', () => {
    const c = cmd('η μαργαρίτα έχει ένα ζυμάρι, ογδόντα γραμμάρια σάλτσα και εκατόν είκοσι γραμμάρια μοτσαρέλα', 'recipe')
    expect(c.item.id).toBe(M)
    expect(c.outputQty).toBe(1)
    expect(lines(c.lines)).toEqual([[null, 1], [ITEMS.sauce.id, 0.08], [ITEMS.mozz.id, 0.12]])
    expect(cands(c.lines[0].item)).toEqual([D250, D400].sort())
  })
  it('συνταγή ζυμάρι 250 για σαράντα τεμάχια', () => {
    const c = cmd('συνταγή ζυμάρι 250 για σαράντα τεμάχια: έξι κιλά αλεύρι, τέσσερα λίτρα νερό, εκατό γραμμάρια μαγιά', 'recipe')
    expect(c.item.id).toBe(D250)
    expect(c.outputQty).toBe(40)
    expect(lines(c.lines)).toEqual([[ITEMS.flour.id, 6], [ITEMS.water.id, 4], [ITEMS.yeast.id, 0.1]])
  })
  it('συνταγή ημιετοίμου: μόνο πρώτες ύλες', () => {
    const c = cmd('συνταγή ζυμάρι 400 για 20: 5 κιλά αλεύρι και 100 γραμμάρια αλάτι', 'recipe')
    expect(c.item.id).toBe(D400)
    expect(c.outputQty).toBe(20)
    expect(lines(c.lines)).toEqual([[ITEMS.flour.id, 5], [ITEMS.salt.id, 0.1]])
  })
  it.each([
    ['η χαβανέζα θέλει ένα ζυμάρι 250, 100 γρ ζαμπόν και 120 γρ μοτσαρέλα', H, [[D250, 1], [ITEMS.ham.id, 0.1], [ITEMS.mozz.id, 0.12]]],
    ['η πεπερόνι παίρνει 80 γραμμάρια πεπερόνι σαλάμι και 1 κουτί', P, [[ITEMS.salami.id, 0.08], [ITEMS.box.id, 1]]],
    ['η καρμπονάρα χρειάζεται 50 γρ μπέικον και 2 γραμμάρια ρίγανη', C, [[ITEMS.bacon.id, 0.05], [ITEMS.oregano.id, 2]]],
    ['η σπέσιαλ έχει ένα ζυμάρι 250, 120 μοτσαρέλα και 50 ζαμπόν', S, [[D250, 1], [ITEMS.mozz.id, 0.12], [ITEMS.ham.id, 0.05]]],
    ['η μαργαρίτα για 10 πίτσες θέλει 1 κιλό μοτσαρέλα', M, [[ITEMS.mozz.id, 1]]],
  ])('%s', (text, id, expected) => {
    const c = cmd(text, 'recipe')
    expect(c.item.id).toBe(id)
    expect(lines(c.lines)).toEqual(expected)
  })
})

// ---------------------------------------------------------------------
describe('item_price / partner_price', () => {
  it.each([
    ['η μαργαρίτα κάνει οκτώ ευρώ', M, 7.0796, true],
    ['τιμή μαργαρίτας 8,50', M, 7.5221, true],
    ['η μαργαρίτα πουλιέται 8 και 50', M, 7.5221, true],
    ['η μαργαρίτα κοστίζει οκτώ και πενήντα', M, 7.5221, true],
    ['η μαργαρίτα κάνει 7 χωρίς ΦΠΑ', M, 7, false],
    ['η μαργαρίτα κάνει 7 καθαρή', M, 7, false],
    ['η σπέσιαλ κατεψυγμένη κάνει 4,50', FZ, 4.5, false],
    ['η σπέσιαλ κατεψυγμένη κάνει 5,085 με ΦΠΑ', FZ, 4.5, true],
  ])('%s', (text, id, net, gross) => {
    const c = cmd(text, 'item_price')
    expect([c.item.id, c.netPrice, c.heardGross]).toEqual([id, net, gross])
  })
  it.each([
    ['το ξενοδοχείο Αστέρια παίρνει τη σπέσιαλ τέσσερα και είκοσι', PARTNERS.asteria.id, S, 4.2],
    ['τιμή για το ξενοδοχείο Χ σπέσιαλ 4,20', PARTNERS.hotelX.id, S, 4.2],
    ['τιμή για τον Χ σπέσιαλ κατεψυγμένη 3,90', PARTNERS.hotelX.id, FZ, 3.9],
  ])('%s', (text, pid, iid, net) => {
    const c = cmd(text, 'partner_price')
    expect([c.partner.id, c.item.id, c.netPrice]).toEqual([pid, iid, net])
  })
})

// ---------------------------------------------------------------------
describe('κλεισίματα, αναίρεση, ερωτήσεις, βοήθεια', () => {
  it.each([
    ['κλείσε τη μέρα', 'close_day'],
    ['κλείσε τη βάρδια', 'close_day'],
    ['τέλος βάρδιας', 'close_day'],
    ['κλείσιμο ημέρας', 'close_day'],
    ['κλείσε ταμείο', 'close_day'],
    ['τέλος απογραφής', 'close_stocktake'],
    ['κλείσε την απογραφή', 'close_stocktake'],
    ['καταχώρησε την απογραφή', 'close_stocktake'],
    ['ακύρωσε το τελευταίο', 'undo'],
    ['αναίρεση', 'undo'],
    ['σβήσε το τελευταίο', 'undo'],
    ['λάθος, ακύρωσέ το', 'undo'],
    ['λάθος', 'undo'],
    ['τι πουλήσαμε σήμερα', 'query_today'],
    ['πόσες πίτσες σήμερα', 'query_today'],
    ['πόσα efood σήμερα', 'query_today'],
    ['βοήθεια', 'help'],
    ['τι μπορώ να πω', 'help'],
    ['καλημέρα', 'unknown'],
    ['', 'unknown'],
    ['ναι', 'unknown'],
    ['123', 'unknown'],
  ])('%s → %s', (text, kind) => {
    expect(run(text).command.kind).toBe(kind)
  })
  it('query_stock', () => {
    expect(cmd('πόση μοτσαρέλα έχουμε', 'query_stock').item.id).toBe(ITEMS.mozz.id)
    expect(cmd('πόσο αλεύρι έμεινε', 'query_stock').item.id).toBe(ITEMS.flour.id)
    const z = cmd('πόσα ζυμάρια έχουν μείνει', 'query_stock')
    expect(z.item.id).toBeNull()
    expect(cands(z.item)).toEqual([D250, D400].sort())
  })
  it('query_balance', () => {
    expect(cmd('πόσα μας χρωστάει το ξενοδοχείο Αστέρια', 'query_balance').partner.id).toBe(PARTNERS.asteria.id)
    expect(cmd('τι χρωστάμε στον μύλο', 'query_balance').partner.id).toBe(PARTNERS.mill.id)
    expect(cmd('υπόλοιπο ξενοδοχείο Χ', 'query_balance').partner.id).toBe(PARTNERS.hotelX.id)
  })
  it('unknown έχει βεβαιότητα 0 και κανένα θέμα', () => {
    expect(run('καλημέρα')).toEqual({ text: 'καλημέρα', command: { kind: 'unknown' }, confidence: 0, issues: [] })
  })
})

// ---------------------------------------------------------------------
describe('δύσκολες περιπτώσεις από την πράξη', () => {
  it('ερώτηση με "?" → απόθεμα, όχι απογραφή', () => {
    expect(cmd('έχουμε μοτσαρέλα;', 'query_stock').item.id).toBe(ITEMS.mozz.id)
    expect(cmd('έχουμε μοτσαρέλα?', 'query_stock').item.id).toBe(ITEMS.mozz.id)
  })
  it('ερώτηση τιμής δεν αλλάζει τιμή', () => {
    expect(run('πόσο κάνει η μαργαρίτα').command.kind).toBe('unknown')
  })
  it('πελάτης + είδος + μόνο δεκαδικός → ειδική τιμή', () => {
    const c = cmd('στο ξενοδοχείο Αστέρια η σπέσιαλ κατεψυγμένη 3,90', 'partner_price')
    expect([c.partner.id, c.item.id, c.netPrice]).toEqual([PARTNERS.asteria.id, FZ, 3.9])
  })
  it('πώληση σε πελάτη: δεκαδικός δίπλα σε πίτσες = τιμή, χωρίς ποσότητα = 1', () => {
    expect(priced(cmd('πούλησα στο Αστέρια σπέσιαλ κατεψυγμένες 3,90', 'sale').lines)).toEqual([[FZ, 1, 3.9]])
  })
  it('ίδιο είδος δύο φορές → άθροισμα', () => {
    expect(lines(cmd('efood μια μαργαρίτα και μια μαργαρίτα', 'sale_tally').lines)).toEqual([[M, 2]])
    expect(lines(cmd('μέτρησα 5 κιλά μοτσαρέλα και άλλα 2 κιλά μοτσαρέλα', 'stocktake').lines)).toEqual([[ITEMS.mozz.id, 7]])
  })
  it('τιμή χωρίς "το κιλό": διαλέγει με βάση το μέσο κόστος', () => {
    expect(priced(cmd('πλήρωσα στον μύλο 10 σακιά αλεύρι 155 ευρώ', 'purchase').lines)).toEqual([[ITEMS.flour.id, 250, 0.62]])
    expect(priced(cmd('αγόρασα 10 σακιά αλεύρι 15 ευρώ', 'purchase').lines)).toEqual([[ITEMS.flour.id, 250, 0.6]])
    expect(priced(cmd('αγόρασα από τον μύλο 10 σακιά αλεύρι όλα 155 ευρώ', 'purchase').lines)).toEqual([[ITEMS.flour.id, 250, 0.62]])
  })
  it('άγνωστος προμηθευτής: όπως ακούστηκε, με προειδοποίηση', () => {
    const r = run('αγόρασα από τον Παπαδόπουλο 5 κιλά μοτσαρέλα')
    const c = r.command as Extract<Command, { kind: 'purchase' }>
    expect(c.partner).toEqual({ heard: 'Παπαδόπουλο', id: null, candidates: [] })
    expect(r.issues).toContain('Δεν βρέθηκε «Παπαδόπουλο».')
  })
  it('συναλλασσόμενος εκτός ρόλου: μόνο υποψήφιος, όχι σίγουρος', () => {
    const c = cmd('πούλησα στον μύλο 2 σπέσιαλ', 'sale')
    expect(c.partner.id).toBeNull()
    expect(cands(c.partner)).toEqual([PARTNERS.mill.id])
  })
  it('ελληνικά για λατινικό όνομα συναλλασσόμενου (ιφούντ → efood)', () => {
    expect(cmd('το ιφούντ μας πλήρωσε 300', 'receipt').partner.id).toBe(PARTNERS.efood.id)
  })
  it('ΦΠΑ με λέξεις, 3x, κεφαλαία, σημεία στίξης', () => {
    expect(cmd('νέα πίτσα βίγκαν 9 ευρώ ΦΠΑ είκοσι τέσσερα', 'new_item')).toMatchObject({ vatRate: 24, salePrice: 7.2581 })
    expect(lines(cmd('3x μαργαρίτα efood', 'sale_tally').lines)).toEqual([[M, 3]])
    expect(lines(cmd('Efood: 3 Margherita, 2 Special, 1 Pepperoni.', 'sale_tally').lines)).toEqual([[M, 3], [S, 2], [P, 1]])
  })
  it('λάθη αναγνώρισης: μαργαρίτσες, σπεσιαλ χωρίς τόνο', () => {
    expect(lines(cmd('μαργαρίτσες 2 efood', 'sale_tally').lines)).toEqual([[M, 2]])
    expect(lines(cmd('efood 2 σπεσιαλ', 'sale_tally').lines)).toEqual([[S, 2]])
  })
  it('"τηλεφωνική παραγγελία" = κανάλι, όχι πελάτης', () => {
    const c = cmd('τηλεφωνική παραγγελία 2 μαργαρίτες', 'sale_tally')
    expect([c.channel, lines(c.lines)]).toEqual(['phone', [[M, 2]]])
  })
  it('τιμή ανά συσκευασία στο τέλος ("18 ευρώ η κούτα") δεν γίνεται δεύτερη γραμμή', () => {
    expect(priced(cmd('ήρθαν 5 κούτες κουτιά 18 ευρώ η κούτα', 'purchase').lines)).toEqual([[ITEMS.box.id, 500, 0.18]])
  })
  it('σύνθετη λέξη: "λάδι" → Ελαιόλαδο', () => {
    expect(priced(cmd('πήρα 20 λίτρα λάδι', 'purchase').lines)).toEqual([[ITEMS.oil.id, 20, null]])
  })
  it('πόλη μετά το ΑΦΜ', () => {
    expect(cmd('νέος προμηθευτής Αφοί Παπαδάκη ΑΦΜ 099887766 Χανιά', 'new_partner')).toMatchObject({
      name: 'Αφοί Παπαδάκη', vatNo: '099887766', city: 'Χανιά',
    })
  })
  it('προσθετικές ποσότητες: "2 σακιά και 10 κιλά", "και άλλα 2"', () => {
    expect(lines(cmd('μέτρησα αλεύρι 2 σακιά και 10 κιλά', 'stocktake').lines)).toEqual([[ITEMS.flour.id, 60]])
    expect(lines(cmd('μέτρησα αλεύρι 2 σακιά και 10 κιλά μοτσαρέλα 6 κιλά', 'stocktake').lines)).toEqual([
      [ITEMS.flour.id, 60], [ITEMS.mozz.id, 6],
    ])
    expect(lines(cmd('μέτρησα μοτσαρέλα 5 κιλά και άλλα 2', 'stocktake').lines)).toEqual([[ITEMS.mozz.id, 7]])
    expect(lines(cmd('μέτρησα μοτσαρέλα 2 κιλά και 300 γραμμάρια', 'stocktake').lines)).toEqual([[ITEMS.mozz.id, 2.3]])
    expect(lines(cmd('efood 3 μαργαρίτες και άλλες 2', 'sale_tally').lines)).toEqual([[M, 5]])
    expect(lines(cmd('efood 3 μαργαρίτες και 2 σπέσιαλ', 'sale_tally').lines)).toEqual([[M, 3], [S, 2]])
  })
  it('αριθμοί γραμμένοι μαζί', () => {
    expect(lines(cmd('efood εικοσιπέντε μαργαρίτες', 'sale_tally').lines)).toEqual([[M, 25]])
  })
  it('συνταγή "για τη χαβανέζα" και ονόματα με "με όνομα" / "που λέγεται"', () => {
    const c = cmd('συνταγή για τη χαβανέζα: ένα ζυμάρι 400, 120 γραμμάρια μοτσαρέλα, 80 γραμμάρια ζαμπόν', 'recipe')
    expect(c.item.id).toBe(H)
    expect(lines(c.lines)).toEqual([[D400, 1], [ITEMS.mozz.id, 0.12], [ITEMS.ham.id, 0.08]])
    expect(cmd('νέα πίτσα με όνομα τέσσερις εποχές 12 ευρώ', 'new_item').name).toBe('4 εποχές')
    expect(cmd('νέα πίτσα που λέγεται βεζούβιο 11 ευρώ', 'new_item').name).toBe('Βεζούβιο')
  })
  it('συνταγή χωρίς μονάδες: σωστό ζευγάρωμα ("ζυμάρι 250 80 γρ σάλτσα")', () => {
    const c = cmd('η μαργαρίτα θέλει 1 ζυμάρι 250 80 γρ σάλτσα 100 γρ μοτσαρέλα 1 κουτί', 'recipe')
    expect(lines(c.lines)).toEqual([[D250, 1], [ITEMS.sauce.id, 0.08], [ITEMS.mozz.id, 0.1], [ITEMS.box.id, 1]])
  })
  it('η μονάδα που ακούστηκε ξεκαθαρίζει το είδος', () => {
    expect(lines(cmd('μέτρησα 3 κιλά πεπερόνι', 'stocktake').lines)).toEqual([[ITEMS.salami.id, 3]])
  })
})

// ---------------------------------------------------------------------
describe('βεβαιότητα', () => {
  it('σίγουρη εντολή > αμφίσημη > άγνωστη', () => {
    const sure = run('efood τρεις μαργαρίτες').confidence
    const amb = run('έφτιαξα ογδόντα ζυμάρια').confidence
    const none = run('efood δύο καλτσόνε').confidence
    expect(sure).toBeGreaterThan(0.8)
    expect(amb).toBeLessThan(sure)
    expect(none).toBeLessThan(amb)
  })
})

// ---------------------------------------------------------------------
describe('ανθεκτικότητα', () => {
  const VOCAB = [
    'efood', 'wolt', 'μαργαρίτα', 'σπέσιαλ', 'κιλά', 'σακιά', 'και', 'ευρώ', 'το', 'κιλό', 'από', 'μύλο', 'πήρα',
    'πούλησα', 'μέτρησα', 'νέα', 'πίτσα', 'πελάτης', 'τηλέφωνο', 'ΦΠΑ', '24%', 'μισό', 'κόμμα', 'είκοσι', 'τρία', '0,62',
    '1.000', ',', ':', '?', 'συνταγή', 'για', 'έχει', 'τιμή', 'κάνει', 'πόσο', 'χρωστάει', 'κλείσε', 'λάθος', 'ζυμάρια',
    '400', 'τετρακοσάρια', 'σύνολο', 'όλα', 'προς', 'λεπτά', 'Α.Ε.', 'χι', '€', '%', '-', 'ζύμωσα', 'παραγωγή', 'νέος',
    'αφμ', 'στο', 'Ηράκλειο', 'ξενοδοχείο', 'Αστέρια', 'καλτσόνε', '😀', 'ύλη', 'πρώτη', 'σε', 'γραμμάρια', 'μείον',
  ]
  let seed = 42
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
  it('2000 τυχαίες φράσεις: ποτέ εξαίρεση, πάντα έγκυρο σχήμα', () => {
    const ids = new Set([...CTX.items.map((i) => i.id), ...CTX.partners.map((p) => p.id)])
    for (let k = 0; k < 2000; k++) {
      const len = 1 + Math.floor(rnd() * 14)
      const words = Array.from({ length: len }, () => VOCAB[Math.floor(rnd() * VOCAB.length)])
      const text = words.join(rnd() < 0.2 ? '' : ' ')
      const r = interpret(text, CTX)
      expect(typeof r.command.kind).toBe('string')
      expect(r.confidence).toBeGreaterThanOrEqual(0)
      expect(r.confidence).toBeLessThanOrEqual(1)
      expect(Array.isArray(r.issues)).toBe(true)
      const json = JSON.stringify(r)
      for (const m of json.matchAll(/"id":"([^"]+)"/g)) expect(ids.has(m[1])).toBe(true)
      expect(json).not.toContain('NaN')
      expect(json.includes('null,"candidates"') || !json.includes('"id":undefined')).toBe(true)
    }
  })
  it('περίεργη είσοδος και κατεστραμμένο context', () => {
    expect(() => interpret(undefined as unknown as string, CTX)).not.toThrow()
    expect(() => interpret('efood 2 μαργαρίτες', {} as InterpretContext)).not.toThrow()
    expect(() => interpret('efood 2 μαργαρίτες', null as unknown as InterpretContext)).not.toThrow()
    expect(() => interpret('x'.repeat(10000), CTX)).not.toThrow()
    expect(() => interpret('1'.repeat(400), CTX)).not.toThrow()
    expect(interpret('efood 2 μαργαρίτες', { ...CTX, items: [], partners: [] }).command.kind).toBe('sale_tally')
  })
  it('δεν αλλάζει το context', () => {
    const before = JSON.stringify(CTX)
    run('αγόρασα από τον μύλο δέκα σακιά αλεύρι 0,62 το κιλό')
    run('νέα πίτσα τόνου 10 ευρώ')
    expect(JSON.stringify(CTX)).toBe(before)
  })
  it('localInterpreter υλοποιεί το Interpreter', () => {
    expect(localInterpreter.interpret('2 μαργαρίτες', CTX)).toEqual(interpret('2 μαργαρίτες', CTX))
  })
})

// ---------------------------------------------------------------------
describe('ταχύτητα', () => {
  it('< 5 ms ανά φράση με ~200 είδη', () => {
    const ctx = bigContext()
    expect(ctx.items.length).toBeGreaterThanOrEqual(190)
    const phrases = [
      'efood τρεις μαργαρίτες και δύο σπέσιαλ',
      'αγόρασα από τον μύλο δέκα σακιά αλεύρι 0,62 το κιλό και 2 κιλά μαγιά 3 ευρώ το κιλό',
      'μέτρησα μοτσαρέλα έξι κιλά, αλεύρι σαράντα επτά κιλά και είκοσι τρία ζυμάρια',
      'η μαργαρίτα έχει ένα ζυμάρι, ογδόντα γραμμάρια σάλτσα και εκατόν είκοσι γραμμάρια μοτσαρέλα',
      'πούλησα στο ξενοδοχείο Αστέρια εξήντα σπέσιαλ κατεψυγμένες',
      'μέτρησα τυρί τριμμένο 3 κιλά, μανιτάρια φρέσκο 2 κιλά, ελιές 4 κιλά και πάπρικα γλυκό μισό κιλό',
      'νέος πελάτης ξενοδοχείο Ήλιος τηλέφωνο 2810 123 456',
      'πόση μοτσαρέλα έχουμε',
    ]
    for (const p of phrases) interpret(p, ctx) // ζέσταμα + ευρετήριο
    const reps = 25
    const t0 = performance.now()
    for (let k = 0; k < reps; k++) for (const p of phrases) interpret(p, ctx)
    const avg = (performance.now() - t0) / (reps * phrases.length)
    expect(avg).toBeLessThan(5)
  })
})
