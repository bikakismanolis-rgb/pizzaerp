import { describe, expect, it } from 'vitest'
import type { Item } from './types'
import type { Command, EntityRef } from './voice/types'
import { interpret } from './voice/interpret'
import { CTX, ITEMS, PARTNERS } from './voice/testFixtures'
import {
  addDays, answerTo, cardProblem, plural, stocktakeDate, suggestName, tallySteps, visibleIssues,
  type CardEnv, type RunningState,
} from './voiceRules'
import { NET_MSG, friendlyMessage, tallyMessage } from './errors'

const itemById = new Map<string, Item>(CTX.items.map((i) => [i.id, i]))
const env = (extra: Partial<CardEnv> = {}): CardEnv => ({ itemById, edited: {}, running: null, hasUndo: false, ...extra })
const ref = (it: { id: string; name: string } | null, heard = it?.name ?? '?'): EntityRef => ({ heard, id: it?.id ?? null, candidates: [] })
const problemOf = (text: string, extra: Partial<CardEnv> = {}) => cardProblem(interpret(text, CTX).command, env(extra))

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
    const row = { channel: 'efood' as const, date: '2026-10-14', docId: 'd1', docNo: 1, qty: 12, gross: 96 }
    const running: RunningState = { tally: [], older: [row], stocktake: null }
    expect(cardProblem({ kind: 'close_day' }, env({ running }))).toBeNull()
    expect(cardProblem({ kind: 'close_day' }, env({ running: { tally: [], older: [], stocktake: null } }))).toMatch(/Δεν υπάρχουν/)
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
  it('απογραφή που περνάει τα μεσάνυχτα συνεχίζει στη χθεσινή· παλιότερη όχι', () => {
    expect(stocktakeDate({ date: '2026-10-14' }, '2026-10-15')).toBe('2026-10-14')
    expect(stocktakeDate({ date: '2026-10-15' }, '2026-10-15')).toBe('2026-10-15')
    expect(stocktakeDate({ date: '2026-09-30' }, '2026-10-15')).toBe('2026-10-15')
    expect(stocktakeDate(null, '2026-10-15')).toBe('2026-10-15')
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
    // μετρητής σε κλειδωμένη μέρα: όχι «μεταγενέστερη ημερομηνία»
    const locked = tallyMessage('Κλειδωμένη περίοδος: υπάρχει απογραφή ΑΠ-3 (2026-10-15) που περιλαμβάνει το είδος "Αλεύρι". Χρησιμοποιήστε μεταγενέστερη ημερομηνία.')
    expect(locked).toMatch(/^Κλειδωμένη περίοδος: .*ΑΠ-3 \(15\/10\/2026\).*"Αλεύρι"\. Η μέρα έκλεισε/)
    expect(locked).not.toMatch(/μεταγενέστερη/)
    expect(tallyMessage('Μη έγκυρη ποσότητα')).toBe('Μη έγκυρη ποσότητα')
  })
})
