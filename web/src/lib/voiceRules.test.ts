import { describe, expect, it } from 'vitest'
import type { Item } from './types'
import type { Command, EntityRef } from './voice/types'
import { interpret } from './voice/interpret'
import { CTX, ITEMS, PARTNERS } from './voice/testFixtures'
import {
  NIGHT_END_HOUR, addDays, answerTo, beforeQuestion, cardProblem, countedFor, phraseProblem, plural, pluralGuess, pluralOffer,
  removalNote, removalNotes, staleCount, stockLineViews, stockOps, stockResultText, stockTarget, stockTotalsText, suggestName,
  tallySteps, targetOf, visibleIssues,
  type CardEnv, type RunningState, type RunningStocktake,
} from './voiceRules'
import { applyPhrases } from './voice/normalize'
import { NET_MSG, friendlyMessage, tallyMessage } from './errors'

const itemById = new Map<string, Item>(CTX.items.map((i) => [i.id, i]))
const env = (extra: Partial<CardEnv> = {}): CardEnv => ({ itemById, edited: {}, running: null, hasUndo: false, ...extra })
const ref = (it: { id: string; name: string } | null, heard = it?.name ?? '?'): EntityRef => ({ heard, id: it?.id ?? null, candidates: [] })
const problemOf = (text: string, extra: Partial<CardEnv> = {}) => cardProblem(interpret(text, CTX).command, env(extra))
const EMPTY: RunningState = { tally: [], older: [], totals: [], stocktakes: [], movedToday: null }

describe('cardProblem: τιμές «δεν ακούστηκε» δεν περνάνε σιωπηλά', () => {
  it('απογραφή χωρίς ποσότητα: εμποδίζει μέχρι να γραφτεί μέτρηση', () => {
    expect(problemOf('μέτρησα μοτσαρέλα')).toMatch(/Δεν ακούστηκε ποσότητα για «Μοτσαρέλα»/)
    expect(problemOf('μέτρησα μοτσαρέλα και αλεύρι σαράντα επτά κιλά')).toMatch(/Μοτσαρέλα/)
    // ο χρήστης έγραψε 0 στο πεδίο: σκόπιμη μηδενική μέτρηση
    expect(problemOf('μέτρησα μοτσαρέλα', { edited: { 'lines.0.qty': true } })).toBeNull()
  })

  it('απογραφή με ειπωμένο μηδέν: περνάει', () => {
    expect(problemOf('μέτρησα μοτσαρέλα μηδέν')).toBeNull()
    const cmd: Command = { kind: 'stocktake', lines: [{ item: ref(ITEMS.mozz), qty: 0, heardQty: '0 κιλά' }] }
    expect(cardProblem(cmd, env())).toBeNull()
  })

  it('απογραφή: αρνητική ή μη αριθμός εμποδίζει', () => {
    expect(cardProblem({ kind: 'stocktake', lines: [{ item: ref(ITEMS.mozz), qty: -1, heardQty: '1' }] }, env())).toMatch(/Βάλε ποσότητα/)
    expect(cardProblem({ kind: 'stocktake', lines: [{ item: ref(ITEMS.mozz), qty: NaN, heardQty: 'x' }] }, env())).toMatch(/Βάλε ποσότητα/)
  })

  it('τιμή είδους χωρίς ειπωμένη τιμή (0): εμποδίζει μέχρι να γραφτεί', () => {
    expect(problemOf('η μαργαρίτα κάνει')).toMatch(/Δεν ακούστηκε τιμή/)
    expect(problemOf('η μαργαρίτα κάνει', { edited: { netPrice: true } })).toBeNull()
    expect(problemOf('η μαργαρίτα κάνει οκτώ ευρώ')).toBeNull()
  })

  it('τιμή πελάτη 0: εμποδίζει μέχρι να γραφτεί', () => {
    const cmd: Command = { kind: 'partner_price', partner: ref(PARTNERS.asteria), item: ref(ITEMS.special), netPrice: 0 }
    expect(cardProblem(cmd, env())).toMatch(/Δεν ακούστηκε τιμή για «Special»/)
    expect(cardProblem(cmd, env({ edited: { netPrice: true } }))).toBeNull()
    expect(cardProblem({ ...cmd, netPrice: 4.2 }, env())).toBeNull()
  })

  it('αφαίρεση από τον μετρητή («βγάλε μία μαργαρίτα»): επιτρέπεται', () => {
    const cmd = interpret('βγάλε μία μαργαρίτα από το efood', CTX).command
    expect(cmd.kind).toBe('sale_tally')
    expect(cardProblem(cmd, env())).toBeNull()
    // αφαίρεση ακόμα και για είδος χωρίς τιμή
    expect(cardProblem({ kind: 'sale_tally', channel: 'efood', channelHeard: true, lines: [{ item: ref(ITEMS.pepperoni), qty: -1 }] }, env())).toBeNull()
  })

  it('μετρητής: 0 τεμάχια εμποδίζει', () => {
    expect(cardProblem({ kind: 'sale_tally', channel: 'efood', channelHeard: true, lines: [{ item: ref(ITEMS.margarita), qty: 0 }] }, env()))
      .toMatch(/Βάλε ποσότητα για «Μαργαρίτα»/)
  })

  it('μετρητής: προϊόν χωρίς τιμή πώλησης δεν μπαίνει με 0 €', () => {
    const cmd: Command = { kind: 'sale_tally', channel: 'efood', channelHeard: true, lines: [{ item: ref(ITEMS.carbonara), qty: 3 }] }
    expect(cardProblem(cmd, env())).toMatch(/«Καρμπονάρα» δεν έχει τιμή πώλησης/)
    expect(cardProblem({ ...cmd, lines: [{ item: ref(ITEMS.margarita), qty: 3 }] }, env())).toBeNull()
  })

  it('χονδρική: τιμή που δεν ειπώθηκε και είναι 0 (ούτε πελάτη ούτε γενική) εμποδίζει', () => {
    const cmd: Command = { kind: 'sale', partner: ref(PARTNERS.hotelX), lines: [{ item: ref(ITEMS.carbonara), qty: 20, unitPrice: null }] }
    expect(cardProblem(cmd, env({ saleFallback: () => 0 }))).toMatch(/Δεν υπάρχει τιμή για «Καρμπονάρα»/)
    // άγνωστη ακόμα (φορτώνει): δεν εμποδίζει, ξαναελέγχεται στην εκτέλεση
    expect(cardProblem(cmd, env({ saleFallback: () => undefined }))).toBeNull()
    expect(cardProblem(cmd, env({ saleFallback: () => 4.5 }))).toBeNull()
    // ρητή τιμή 0 (δείγμα): περνάει
    expect(cardProblem({ ...cmd, lines: [{ ...cmd.lines[0], unitPrice: 0 }] }, env({ saleFallback: () => 0 }))).toBeNull()
    expect(cardProblem({ ...cmd, lines: [{ ...cmd.lines[0], unitPrice: -1 }] }, env())).toMatch(/Λάθος τιμή/)
  })

  it('αγορά χωρίς τιμή και χωρίς μέσο κόστος εμποδίζει', () => {
    const cmd: Command = { kind: 'purchase', partner: ref(PARTNERS.dairy), refNo: null, lines: [{ item: ref(ITEMS.mozz), qty: 20, unitPrice: null }] }
    expect(cardProblem(cmd, env())).toMatch(/Γράψε τιμή για «Μοτσαρέλα»/)
    expect(cardProblem({ ...cmd, lines: [{ item: ref(ITEMS.flour), qty: 250, unitPrice: null }] }, env())).toBeNull()
    expect(cardProblem({ ...cmd, lines: [{ item: ref(ITEMS.mozz), qty: 20, unitPrice: 7 }] }, env())).toBeNull()
  })

  it('αναφορά χωρίς επιλογή εμποδίζει', () => {
    expect(problemOf('μέτρησα ζυμάρια')).toMatch(/Διάλεξε είδος για «ζυμάρια»/)
  })

  it('κλείσιμο ημέρας: και με ανοιχτές μόνο από προηγούμενες μέρες', () => {
    const row = { channel: 'efood' as const, date: '2026-10-14', docId: 'd1', docNo: 1, qty: 12, gross: 96, items: {} }
    const running: RunningState = { ...EMPTY, older: [row] }
    expect(cardProblem({ kind: 'close_day' }, env({ running }))).toBeNull()
    expect(cardProblem({ kind: 'close_day' }, env({ running: EMPTY }))).toMatch(/Δεν υπάρχουν/)
  })

  it('τέλος απογραφής: και όταν η μόνη ανοιχτή είναι παλιότερη', () => {
    const st: RunningStocktake = { id: 's', docNo: 3, date: '2026-10-14', count: 1, counted: { x: 1 } }
    expect(cardProblem({ kind: 'close_stocktake' }, env({ running: { ...EMPTY, stocktakes: [st] } }))).toBeNull()
    expect(cardProblem({ kind: 'close_stocktake' }, env({ running: EMPTY }))).toMatch(/Δεν υπάρχει απογραφή/)
  })
})

describe('αφαίρεση από τον μετρητή όταν έχουν καταχωρηθεί (π.χ. από μέτρηση απογραφής)', () => {
  const M = ITEMS.margarita.id
  const tallyRow = (items: Record<string, number>) => ({ channel: 'efood' as const, date: '2026-10-15', docId: 'd2', docNo: 2, qty: 0, gross: 0, items })
  const posted = (qty: number) => ({ channel: 'efood' as const, qty, gross: 0, postedQty: qty, postedItems: { [M]: { qty, docs: [1] } } })
  const remove1: Command = { kind: 'sale_tally', channel: 'efood', channelHeard: true, lines: [{ item: ref(ITEMS.margarita), qty: -1 }] }

  it('όλες καταχωρημένες: εμποδίζει και λέει πού διορθώνεται', () => {
    const running: RunningState = { ...EMPTY, totals: [posted(3)] }
    const why = cardProblem(remove1, env({ running }))
    expect(why).toMatch(/^«Μαργαρίτα» στο efood σήμερα: 3 έχουν ήδη καταχωρηθεί \(ΠΩ-1\) και δεν αφαιρούνται από εδώ/)
    expect(why).toMatch(/διόρθωση από το παραστατικό ΠΩ-1/)
    expect(removalNotes(remove1, running, () => 'Μαργαρίτα')).toEqual([why])
  })
  it('καμία ούτε ανοιχτή ούτε καταχωρημένη: εμποδίζει', () => {
    expect(cardProblem(remove1, env({ running: EMPTY }))).toBe('Δεν υπάρχει «Μαργαρίτα» στο efood σήμερα για αφαίρεση.')
  })
  it('υπάρχουν ανοιχτές: περνάει· μερική αφαίρεση = σημείωση', () => {
    const running: RunningState = { ...EMPTY, tally: [tallyRow({ [M]: 1 })], totals: [posted(3)] }
    expect(cardProblem(remove1, env({ running }))).toBeNull()
    expect(removalNotes(remove1, running, () => 'Μαργαρίτα')).toEqual([])
    const remove2: Command = { ...remove1, lines: [{ item: ref(ITEMS.margarita), qty: -2 }] } as Command
    expect(cardProblem(remove2, env({ running }))).toBeNull()
    expect(removalNotes(remove2, running, () => 'Μαργαρίτα')[0]).toMatch(/^«Μαργαρίτα» στο efood: ανοιχτές μόνο 1, βγαίνουν αυτές\. Οι άλλες 3 έχουν ήδη καταχωρηθεί \(ΠΩ-1\)/)
  })
  it('με πρόσθεση στην ίδια φράση: δεν εμποδίζει· άγνωστη κατάσταση (null): δεν εμποδίζει', () => {
    const mixed: Command = { kind: 'sale_tally', channel: 'efood', channelHeard: true, lines: [{ item: ref(ITEMS.margarita), qty: -1 }, { item: ref(ITEMS.special), qty: 1 }] }
    expect(cardProblem(mixed, env({ running: EMPTY }))).toBeNull()
    expect(cardProblem(remove1, env({ running: null }))).toBeNull()
  })
  it('removalNote', () => {
    expect(removalNote('Μαργαρίτα', 'efood', -1, 1, null)).toBeNull()
    expect(removalNote('Μαργαρίτα', 'wolt', -2, 1, null)).toBe('«Μαργαρίτα» στο Wolt: ανοιχτές μόνο 1, βγαίνουν αυτές.')
  })
})

describe('visibleIssues: η επιλογή είδους δεν κρύβει το «δεν ακούστηκε ποσότητα»', () => {
  const issues = ['«ζυμάρια»: εννοείς Ζυμάρι 250γρ ή Ζυμάρι 400γρ;', 'Δεν ακούστηκε ποσότητα για «ζυμάρια».']
  it('κρύβει μόνο την ερώτηση επιλογής', () => {
    expect(visibleIssues(issues, { entity: ['ζυμάρια'], qty: [], price: [], fields: [] })).toEqual(['Δεν ακούστηκε ποσότητα για «ζυμάρια».'])
  })
  it('η ποσότητα κρύβεται όταν τη γράψει ο χρήστης', () => {
    expect(visibleIssues(issues, { entity: ['ζυμάρια'], qty: ['ζυμάρια', 'Ζυμάρι 250γρ'], price: [], fields: [] })).toEqual([])
  })
  it('«Δεν βρέθηκε» κρύβεται με την επιλογή· τιμή γραμμής με την τιμή', () => {
    expect(visibleIssues(['Δεν βρέθηκε «λαζάνια».', 'Δεν ακούστηκε τιμή για «Αλεύρι»· θα μπει το μέσο κόστος.'],
      { entity: ['λαζάνια'], qty: [], price: ['Αλεύρι'], fields: [] })).toEqual([])
    expect(visibleIssues(['Δεν ακούστηκε τιμή.'], { entity: [], qty: [], price: [], fields: ['price'] })).toEqual([])
    expect(visibleIssues(['Δεν ακούστηκε τιμή.'], { entity: [], qty: [], price: [], fields: [] })).toEqual(['Δεν ακούστηκε τιμή.'])
  })
})

describe('answerTo: «ναι» μόνο ως σκέτη απάντηση', () => {
  const kind = (t: string) => interpret(t, CTX).command.kind
  const ans = (t: string) => answerTo(t, kind(t))
  it.each(['ναι', 'Ναι.', 'οκ', 'εντάξει', 'πέρασέ το', 'ναι πέρασέ το', 'σωστό', 'καταχώρησε', 'ναι ναι'])('yes: %s', (t) => {
    expect(ans(t)).toBe('yes')
  })
  it.each(['όχι', 'άκυρο', 'ακύρωσε', 'λάθος', 'άστο', 'ακύρωσε το τελευταίο'])('no: %s', (t) => {
    expect(ans(t)).toBe('no')
  })
  it('νέα εντολή που περιέχει «πέρασε» δεν επιβεβαιώνει την παλιά κάρτα', () => {
    expect(ans('πέρασε δύο σπέσιαλ στο wolt')).toBe('new')
    expect(ans('ναι δύο μαργαρίτες')).toBe('new')
  })
  it('διόρθωση «όχι, …» = ακύρωση + νέα κάρτα', () => {
    expect(ans('όχι, τέσσερις μαργαρίτες')).toBe('fix')
    expect(ans('λάθος, δύο σπέσιαλ')).toBe('fix')
  })
  it('νέα φράση χωρίς ναι/όχι', () => {
    expect(ans('τέσσερις μαργαρίτες')).toBe('new')
  })
  it('«ναι» με κάτι ακόμα που δεν είναι εντολή: όχι επιβεβαίωση', () => {
    expect(['unclear', 'new']).toContain(ans('ναι αλλά πιο μετά'))
  })
})

describe('tallySteps: αφαίρεση μέχρι όσα υπάρχουν', () => {
  it('προσθέσεις ως έχουν, αφαιρέσεις περιορίζονται', () => {
    const cur = new Map([['m', 2], ['s', 5]])
    expect(tallySteps([{ id: 'm', qty: -3 }, { id: 's', qty: -1 }, { id: 'p', qty: 2 }, { id: 'x', qty: -1 }], cur)).toEqual([
      { id: 'm', delta: -2, asked: -3 },
      { id: 's', delta: -1, asked: -1 },
      { id: 'p', delta: 2, asked: 2 },
      { id: 'x', delta: 0, asked: -1 },
    ])
  })
  it('μηδενικές γραμμές αγνοούνται', () => {
    expect(tallySteps([{ id: 'm', qty: 0 }], new Map())).toEqual([])
  })
})

describe('ημερομηνίες', () => {
  it('addDays', () => {
    expect(addDays('2026-10-14', 1)).toBe('2026-10-15')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
  })
})

describe('σε ποια απογραφή μπαίνει μια μέτρηση (η μέτρηση μετράει τη στιγμή που λέγεται)', () => {
  const T = '2026-10-15'
  const y = { date: '2026-10-14', n: 'y' }
  const t = { date: T, n: 't' }
  const old = { date: '2026-10-01', n: 'old' }
  const night = { hour: 1, movedToday: false }
  it('σημερινή υπάρχει: πάντα αυτή', () => {
    expect(stockTarget([y, t], T, night)).toEqual({ date: T, doc: t, stale: [y] })
    expect(stockTarget([t], T, { hour: 14, movedToday: true })).toEqual({ date: T, doc: t, stale: [] })
  })
  it('μέτρημα που πέρασε τα μεσάνυχτα, χωρίς τίποτα σημερινό: συνεχίζει η χθεσινή', () => {
    expect(stockTarget([y], T, night)).toEqual({ date: y.date, doc: y, stale: [] })
    expect(stockTarget([y], T, { hour: NIGHT_END_HOUR - 1, movedToday: false }).doc).toBe(y)
  })
  it('χθεσινή που ξεχάστηκε ανοιχτή: νέα σημερινή (μέρα, ή σημερινές κινήσεις, ή άγνωστο)', () => {
    // σημερινή αγορά / πώληση πριν από τη μέτρηση: στη χθεσινή θα έμενε «μετά» και θα μετρούσε δύο φορές
    expect(stockTarget([y], T, { hour: 14, movedToday: false })).toEqual({ date: T, doc: null, stale: [y] })
    expect(stockTarget([y], T, { hour: NIGHT_END_HOUR, movedToday: false }).doc).toBeNull()
    expect(stockTarget([y], T, { hour: 1, movedToday: true })).toEqual({ date: T, doc: null, stale: [y] })
    expect(stockTarget([y], T, { hour: 1, movedToday: null }).doc).toBeNull()
  })
  it('παλιότερη από χθες: ποτέ δεν συνεχίζει', () => {
    expect(stockTarget([old], T, night)).toEqual({ date: T, doc: null, stale: [old] })
    expect(stockTarget([], T, night)).toEqual({ date: T, doc: null, stale: [] })
  })
  it('targetOf / countedFor / staleCount από τα φορτωμένα', () => {
    const F = 'flour'
    const ys: RunningStocktake = { id: 'a', docNo: 3, date: '2026-10-14', count: 1, counted: { [F]: 10 } }
    const run: RunningState = { ...EMPTY, stocktakes: [ys], movedToday: false }
    expect(countedFor(run, T, 1)).toEqual({ [F]: 10 })
    // την επόμενη μέρα το μεσημέρι: «αλεύρι 12» δεν προστίθεται στο χθεσινό 10
    expect(countedFor(run, T, 14)).toEqual({})
    expect(countedFor({ ...run, movedToday: true }, T, 1)).toEqual({})
    expect(countedFor(null, T, 1)).toEqual({})
    expect(targetOf(run, T, 14).stale).toEqual([ys])
    expect(staleCount([ys], F)).toEqual({ date: '2026-10-14', docNo: 3, qty: 10 })
    expect(staleCount([ys], 'other')).toBeNull()
  })
})

describe('κείμενα', () => {
  it('ενικός / πληθυντικός', () => {
    expect(`1 ${plural(1, 'είδος', 'είδη')}`).toBe('1 είδος')
    expect(`3 ${plural(3, 'είδος', 'είδη')}`).toBe('3 είδη')
  })
  it('όνομα νέου είδους από ό,τι ακούστηκε', () => {
    expect(suggestName('μαργαρίτες', 'item')).toBe('Μαργαρίτα')
    expect(suggestName('τρούφες', 'item')).toBe('Τρούφα')
    expect(suggestName('καπριτσιόζες', 'item')).toBe('Καπριτσιόζα')
    expect(suggestName('λαζάνια', 'item')).toBe('Λαζάνια')
    expect(suggestName('καφές', 'item')).toBe('Καφές')
    expect(suggestName('σπέσιαλ κατεψυγμένες', 'item')).toBe('Σπέσιαλ κατεψυγμένες')
    expect(suggestName('γιώργο παπαδάκη', 'partner')).toBe('Γιώργο παπαδάκη')
    expect(suggestName('  ', 'item')).toBe('')
  })
  it('σφάλματα δικτύου στα ελληνικά', () => {
    expect(friendlyMessage('TypeError: Failed to fetch')).toBe(NET_MSG)
    expect(friendlyMessage('NetworkError when attempting to fetch resource.')).toBe(NET_MSG)
    expect(friendlyMessage('Load failed')).toBe(NET_MSG)
    expect(friendlyMessage('Δεν βρέθηκε το είδος')).toBe('Δεν βρέθηκε το είδος')
    expect(friendlyMessage('Κλειδωμένη περίοδος: το είδος "Αλεύρι" μετρήθηκε στην απογραφή σε εξέλιξη ΑΠ-1 (2026-10-16) μετά από αυτή την κίνηση'))
      .toBe('Κλειδωμένη περίοδος: το είδος "Αλεύρι" μετρήθηκε στην απογραφή σε εξέλιξη ΑΠ-1 (16/10/2026) μετά από αυτή την κίνηση')
    // μετρητής σε κλειδωμένη μέρα: όχι «μεταγενέστερη ημερομηνία»
    const locked = tallyMessage('Κλειδωμένη περίοδος: υπάρχει απογραφή ΑΠ-3 (2026-10-15) που περιλαμβάνει το είδος "Αλεύρι". Χρησιμοποιήστε μεταγενέστερη ημερομηνία.')
    expect(locked).toMatch(/^Κλειδωμένη περίοδος: .*ΑΠ-3 \(15\/10\/2026\).*"Αλεύρι"\. Η μέρα είναι πριν από αυτή την απογραφή/)
    expect(locked).not.toMatch(/μεταγενέστερη/)
    expect(tallyMessage('Μη έγκυρη ποσότητα')).toBe('Μη έγκυρη ποσότητα')
  })
})

describe('απογραφή χώρο-χώρο: πρόσθεση / αντικατάσταση', () => {
  const F = 'flour', M = 'mozz'
  it('χωρίς μέτρηση: πρώτη μέτρηση (ούτε πρόσθεση ούτε αντικατάσταση)', () => {
    expect(stockLineViews([{ id: F, qty: 10 }], {})).toEqual([{ before: null, mode: null, after: 10 }])
    expect(stockLineViews([{ id: F, qty: 10, mode: 'set' }], {})).toEqual([{ before: null, mode: null, after: 10 }])
    expect(stockLineViews([{ id: F, qty: 10, mode: 'add' }], {})).toEqual([{ before: null, mode: null, after: 10 }])
  })
  it('με μέτρηση: χωρίς λέξη = πρόσθεση, «σύνολο» = αντικατάσταση', () => {
    expect(stockLineViews([{ id: F, qty: 5 }], { [F]: 10 })).toEqual([{ before: 10, mode: 'add', after: 15 }])
    expect(stockLineViews([{ id: F, qty: 5, mode: 'add' }], { [F]: 10 })).toEqual([{ before: 10, mode: 'add', after: 15 }])
    expect(stockLineViews([{ id: F, qty: 40, mode: 'set' }], { [F]: 10 })).toEqual([{ before: 10, mode: 'set', after: 40 }])
    // μέτρηση 0 υπάρχει (δεν είναι «χωρίς μέτρηση»)
    expect(stockLineViews([{ id: F, qty: 3 }], { [F]: 0 })).toEqual([{ before: 0, mode: 'add', after: 3 }])
  })
  it('ίδιο είδος δύο φορές στη φράση: η δεύτερη βλέπει την πρώτη', () => {
    const v = stockLineViews([{ id: F, qty: 10 }, { id: M, qty: 2, mode: 'add' }, { id: F, qty: 5, mode: 'add' }], { [M]: 4 })
    expect(v).toEqual([
      { before: null, mode: null, after: 10 },
      { before: 4, mode: 'add', after: 6 },
      { before: 10, mode: 'add', after: 15 },
    ])
  })
  it('γραμμή χωρίς είδος: σκέτη ποσότητα', () => {
    expect(stockLineViews([{ id: null, qty: 7 }], { [F]: 1 })).toEqual([{ before: null, mode: null, after: 7 }])
  })
  it('stockOps: μία κλήση ανά είδος, χωρίς λέξη = p_add', () => {
    expect(stockOps([{ id: F, qty: 10 }])).toEqual([{ id: F, add: true, qty: 10 }])
    expect(stockOps([{ id: F, qty: 10, mode: 'set' }, { id: F, qty: 5, mode: 'add' }])).toEqual([{ id: F, add: false, qty: 15 }])
    expect(stockOps([{ id: F, qty: 5, mode: 'add' }, { id: M, qty: 2 }, { id: F, qty: 3 }])).toEqual([
      { id: F, add: true, qty: 8 }, { id: M, add: true, qty: 2 },
    ])
    expect(stockOps([{ id: F, qty: 5 }, { id: F, qty: 40, mode: 'set' }, { id: F, qty: 2 }])).toEqual([{ id: F, add: false, qty: 42 }])
  })
  it('κείμενα αποτελέσματος', () => {
    expect(stockResultText({ before: 10, mode: 'add', after: 15 }, 'Αλεύρι', 'kg')).toBe('Αλεύρι: 10 + 5 = 15 kg')
    expect(stockResultText({ before: 10, mode: 'set', after: 40 }, 'Αλεύρι', 'kg')).toBe('Αλεύρι: 40 kg (αντί για 10)')
    expect(stockResultText({ before: null, mode: null, after: 6.5 }, 'Μοτσαρέλα', 'kg')).toBe('Μοτσαρέλα: 6,5 kg')
    expect(stockResultText({ before: 20, mode: 'add', after: 23 }, 'Ζυμάρι', 'τεμ')).toBe('Ζυμάρι: 20 + 3 = 23')
    const lines = [{ id: F, qty: 5 }, { id: M, qty: 6 }]
    const views = stockLineViews(lines, { [F]: 10 })
    const label = (id: string) => (id === F ? { name: 'Αλεύρι', unit: 'kg' } : { name: 'Μοτσαρέλα', unit: 'kg' })
    expect(stockTotalsText(lines, views, label)).toBe('Νέο σύνολο: Αλεύρι 15 kg.')
    expect(stockTotalsText(lines, stockLineViews(lines, {}), label)).toBe('')
    // «σύνολο 40»: το σύνολο ακούγεται ήδη
    const set = [{ id: F, qty: 40, mode: 'set' as const }]
    expect(stockTotalsText(set, stockLineViews(set, { [F]: 10 }), label)).toBe('')
  })
  it('η ερώτηση μένει στο τέλος της ανάγνωσης', () => {
    expect(beforeQuestion('Απογραφή: Αλεύρι άλλα 5 kg. Να το περάσω;', 'Νέο σύνολο: Αλεύρι 15 kg.'))
      .toBe('Απογραφή: Αλεύρι άλλα 5 kg. Νέο σύνολο: Αλεύρι 15 kg. Να το περάσω;')
    expect(beforeQuestion('Κάτι.', 'Νέο σύνολο: Χ.')).toBe('Κάτι. Νέο σύνολο: Χ.')
    expect(beforeQuestion('Κάτι. Να το περάσω;', '')).toBe('Κάτι. Να το περάσω;')
  })
  it('μετρήσεις της απογραφής που θα πάρει τη φράση', () => {
    const st = { id: 's', docNo: 1, count: 1, counted: { [F]: 10 } }
    const run = (date: string, movedToday: boolean | null = false): RunningState => ({ ...EMPTY, stocktakes: [{ ...st, date }], movedToday })
    expect(countedFor(run('2026-10-15', null), '2026-10-15', 14)).toEqual({ [F]: 10 })
    expect(countedFor(run('2026-10-14'), '2026-10-15', 0)).toEqual({ [F]: 10 })
    // χθεσινή μέσα στη μέρα / με σημερινές κινήσεις, ή παλιά: η φράση πάει σε νέα σημερινή
    expect(countedFor(run('2026-10-14'), '2026-10-15', 9)).toEqual({})
    expect(countedFor(run('2026-10-14', true), '2026-10-15', 0)).toEqual({})
    expect(countedFor(run('2026-10-01'), '2026-10-15', 0)).toEqual({})
    expect(countedFor(null, '2026-10-15', 0)).toEqual({})
  })
  it('«άλλα τόσα» χωρίς αριθμό: εμποδίζει με το σωστό μήνυμα', () => {
    const cmd: Command = { kind: 'stocktake', lines: [{ item: ref(ITEMS.flour), qty: 0, mode: 'add' }] }
    expect(cardProblem(cmd, env())).toMatch(/πόσο ακόμα για «Αλεύρι»/)
    expect(cardProblem(cmd, env({ edited: { 'lines.0.qty': true } }))).toBeNull()
  })
})

describe('δικές τους φράσεις: έλεγχος', () => {
  it('εντάξει', () => {
    expect(phraseProblem('οικογενειακή', 'μεγάλη μαργαρίτα')).toBeNull()
    expect(phraseProblem('  ο Γιώργος ', 'Ξενοδοχείο Αστέρια')).toBeNull()
  })
  it('κενά, ίδια, πολύ μεγάλα, ναι/όχι', () => {
    expect(phraseProblem('', 'x')).toMatch(/Όταν λέω/)
    expect(phraseProblem('x', '  ')).toMatch(/εννοώ/)
    expect(phraseProblem('Μαργαρίτα', 'μαργαριτα')).toMatch(/ίδια/)
    expect(phraseProblem('α'.repeat(201), 'x')).toMatch(/200/)
    expect(phraseProblem('ναι', 'μαργαρίτα')).toMatch(/«ναι» \/ «όχι»/)
    expect(phraseProblem('όχι', 'μαργαρίτα')).toMatch(/«ναι» \/ «όχι»/)
    expect(phraseProblem('«»', 'μαργαρίτα')).toMatch(/λέξη/)
  })
  it('new_phrase στην κάρτα', () => {
    expect(cardProblem({ kind: 'new_phrase', phrase: 'οικογενειακή', meaning: 'μεγάλη μαργαρίτα' }, env())).toBeNull()
    expect(cardProblem({ kind: 'new_phrase', phrase: 'οικογενειακή', meaning: '' }, env())).toMatch(/εννοώ/)
  })
})

describe('δικές τους φράσεις: και ο πληθυντικός («efood 2 οικογενειακές»)', () => {
  it('pluralGuess', () => {
    expect(pluralGuess('οικογενειακή')).toBe('οικογενειακές')
    expect(pluralGuess('μεγάλη μαργαρίτα')).toBe('μεγάλες μαργαρίτες')
    expect(pluralGuess('ζυμάρι')).toBe('ζυμάρια')
    expect(pluralGuess('τυρί')).toBe('τυριά')
    expect(pluralGuess('μικρό')).toBe('μικρά')
    expect(pluralGuess('σκέτος')).toBe('σκέτοι')
    expect(pluralGuess('η σκέτη')).toBe('οι σκέτες')
    expect(pluralGuess('Η Σκέτη')).toBe('Οι Σκέτες')
    expect(pluralGuess('ΟΙΚΟΓΕΝΕΙΑΚΗ')).toBe('ΟΙΚΟΓΕΝΕΙΑΚΕΣ')
    // δεν ξέρουμε: λατινικά, αριθμοί, άλλες καταλήξεις, μεγάλες φράσεις, ήδη πληθυντικός
    for (const x of ['special', 'νούμερο 1', 'καφές', 'οικογενειακές', 'ζυμάρια', 'το συνηθισμένο του ξενοδοχείου', '', 'ο']) {
      expect(pluralGuess(x), x).toBeNull()
    }
  })
  it('pluralOffer: μόνο όταν ο πληθυντικός δεν πιάνεται ήδη', () => {
    const rules = [{ phrase: 'οικογενειακή', meaning: 'μαργαρίτα' }]
    const catches = applyPhrases('οικογενειακές', rules) !== 'οικογενειακές'
    // χωρίς κλίσεις στον interpreter: προτείνεται· αν τις πιάνει, όχι
    expect(pluralOffer('οικογενειακή', 'μαργαρίτα', [])).toBe(catches ? null : 'οικογενειακές')
    // υπάρχει ήδη φράση για τον πληθυντικό με την ίδια σημασία
    expect(pluralOffer('οικογενειακή', 'Μαργαρίτα', [{ phrase: 'Οικογενειακές', meaning: 'μαργαρίτα' }])).toBeNull()
    // ...με άλλη σημασία (αλλαγή της φράσης): αλλάζει μαζί
    expect(pluralOffer('οικογενειακή', 'special', [{ phrase: 'οικογενειακή', meaning: 'μαργαρίτα' }, { phrase: 'οικογενειακές', meaning: 'μαργαρίτα' }]))
      .toBe('οικογενειακές')
    // τον πιάνει ήδη άλλη φράση («οι σκέτες» πιάνει και σκέτο «σκέτες»): όχι
    expect(applyPhrases('σκέτες', [{ phrase: 'οι σκέτες', meaning: 'πεπερόνι' }])).toBe('πεπερόνι')
    expect(pluralOffer('σκέτη', 'μαργαρίτα', [{ phrase: 'οι σκέτες', meaning: 'πεπερόνι' }])).toBeNull()
    // άκυρη φράση / χωρίς πρόταση
    expect(pluralOffer('οικογενειακή', '', [])).toBeNull()
    expect(pluralOffer('special', 'μαργαρίτα', [])).toBeNull()
    // ο πληθυντικός είναι ίδιος με τη σημασία
    expect(pluralOffer('μαργαρίτα', 'μαργαρίτες', [])).toBeNull()
  })
  it('με τον πληθυντικό ως φράση, το «efood 2 οικογενειακές» γίνεται Μαργαρίτα', () => {
    const phrases = [{ phrase: 'οικογενειακή', meaning: 'μαργαρίτα' }]
    const pl = pluralOffer('οικογενειακή', 'μαργαρίτα', []) ?? 'οικογενειακές'
    const c = interpret('efood 2 οικογενειακές', { ...CTX, phrases: [...phrases, { phrase: pl, meaning: 'μαργαρίτα' }] }).command
    expect(c.kind).toBe('sale_tally')
    if (c.kind === 'sale_tally') expect(c.lines.map((l) => [l.item.id, l.qty])).toEqual([[ITEMS.margarita.id, 2]])
  })
})
