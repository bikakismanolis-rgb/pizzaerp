import { describe, expect, it } from 'vitest'
import { applyPhrases, capFirst, keySim, norm, normText, parseDigits, phon, phraseKey, phraseStartsName, stemKey, titleCase, tokenize, words } from './normalize'

describe('norm', () => {
  it('πεζά, χωρίς τόνους, ς→σ', () => {
    expect(norm('Μαργαρίτες')).toBe('μαργαριτεσ')
    expect(norm('ΑΛΕΎΡΙ')).toBe('αλευρι')
    expect(norm('Ϊ ΐ ΰ')).toBe('ι ι υ')
    expect(norm('Café')).toBe('cafe')
  })
})

describe('phon: κοινό κλειδί ελληνικών / λατινικών', () => {
  it.each([
    ['special', 'σπεσιαλ'],
    ['pepperoni', 'πεπερονι'],
    ['margarita', 'μαργαριτα'],
    ['carbonara', 'καρμποναρα'],
    ['mozzarella', 'μοτσαρελα'],
    ['wolt', 'βολτ'],
    ['box', 'μποξ'],
    ['pizza', 'πιτσα'],
  ])('%s ≈ %s', (lat, gr) => {
    expect(phon(norm(lat))).toBe(phon(norm(gr)))
  })
  it('δίψηφα', () => {
    expect(phon('ουζο')).toBe('uzo')
    expect(phon('μπεικον')).toBe('bikon')
    expect(phon('ντοματα')).toBe('domata')
    expect(phon('philadelphia')).toBe('filadelfia')
  })
})

describe('stemKey: κλίσεις', () => {
  it.each([
    ['μαργαριτα', 'μαργαριτεσ'],
    ['μαργαριτα', 'μαργαριτασ'],
    ['ζυμαρι', 'ζυμαρια'],
    ['ζυμαρι', 'ζυμαριων'],
    ['σακι', 'σακια'],
    ['κιλο', 'κιλα'],
    ['αλευρι', 'αλευριου'],
    ['ξενοδοχειο', 'ξενοδοχειου'],
    ['κατεψυγμενη', 'κατεψυγμενεσ'],
    ['πεπερονι', 'pepperoni'],
    ['μυλοσ', 'μυλο'],
    ['μυλοσ', 'μυλου'],
  ])('%s ~ %s', (a, b) => {
    expect(stemKey(a)).toBe(stemKey(b))
  })
})

describe('keySim', () => {
  it('ίδια = 1, άσχετα = 0', () => {
    expect(keySim('margarit', 'margarit')).toBe(1)
    expect(keySim('margarit', 'peperon')).toBe(0)
  })
  it('μικρά λάθη αναγνώρισης περνάνε', () => {
    expect(keySim(stemKey('margherita'), stemKey('μαργαριτα'))).toBeGreaterThanOrEqual(0.8)
    expect(keySim(stemKey('bacon'), stemKey('μπεικον'))).toBeGreaterThanOrEqual(0.7)
  })
  it('πρόθεμα (κομμένη λέξη)', () => {
    expect(keySim('katepsig', 'katepsigmen')).toBeGreaterThan(0.85)
  })
  it('σύνθετες λέξεις (κατάληξη)', () => {
    expect(keySim(stemKey('λαδι'), stemKey('ελαιολαδο'))).toBeGreaterThanOrEqual(0.7)
  })
  it('σύντομες λέξεις μόνο ακριβώς', () => {
    expect(keySim('mag', 'mal')).toBe(0)
  })
  it('κοντή ρίζα ως πρόθεμα μένει κάτω από ταίριασμα ρίζας (κρέμα ≠ κρεμμύδι)', () => {
    expect(keySim(stemKey('κρεμα'), stemKey('κρεμμυδι'))).toBeLessThanOrEqual(0.8)
    expect(keySim(stemKey('ντοματεσ'), stemKey('ντοματινια'))).toBeLessThanOrEqual(0.8)
    expect(keySim(stemKey('ντοματεσ'), stemKey('ντοματα'))).toBe(1)
  })
})

describe('parseDigits', () => {
  it.each([
    ['6,5', 6.5],
    ['0.62', 0.62],
    ['1.000', 1000],
    ['2.500', 2500],
    ['1.250,50', 1250.5],
    ['12.50', 12.5],
    ['300', 300],
    ['1/2', 0.5],
    ['3/4', 0.75],
  ])('%s → %d', (s, v) => {
    expect(parseDigits(s)).toBe(v)
  })
})

describe('tokenize', () => {
  it('κρατά την αρχική μορφή και χωρίζει ψηφία από γράμματα', () => {
    const t = tokenize('Ζυμάρι 400γρ, 6,5 κιλά!')
    expect(t.map((x) => x.raw)).toEqual(['Ζυμάρι', '400', 'γρ', ',', '6,5', 'κιλά', '!'])
    expect(t[1].num).toBe(400)
    expect(t[4].num).toBe(6.5)
    expect(t[3].sep).toBe(true)
  })
  it('συντομογραφίες', () => {
    expect(tokenize('με Φ.Π.Α.').map((x) => x.n)).toContain('φπα')
    expect(tokenize('Μύλος Α.Ε.').map((x) => x.n)).toContain('αε')
    expect(tokenize('φ π α').map((x) => x.n)).toEqual(['φπα'])
  })
  it('e-food → δύο tokens, € → ευρώ, μισόκιλο → μισό κιλό', () => {
    expect(tokenize('e-food').map((x) => x.n)).toEqual(['e', 'food'])
    expect(tokenize('5€').map((x) => x.n)).toEqual(['5', 'ευρω'])
    expect(normText('μισόκιλο μαγιά')).toBe('μισο κιλο μαγια')
  })
  it('δεν σκάει σε περίεργη είσοδο', () => {
    expect(tokenize('')).toEqual([])
    expect(tokenize('🙂🍕 ### \n\t')).toEqual([])
    expect(() => tokenize(undefined as unknown as string)).not.toThrow()
  })
})

describe('κεφαλαία', () => {
  it('capFirst / titleCase', () => {
    expect(capFirst('μοτσαρέλα')).toBe('Μοτσαρέλα')
    expect(titleCase('ταβέρνα ο νίκος')).toBe('Ταβέρνα ο Νίκος')
    expect(titleCase('τυροκομείο κρήτης')).toBe('Τυροκομείο Κρήτης')
  })
})

describe('κολλητά γράμματα και αριθμοί', () => {
  it('"3Ε" σπάει σε δύο tokens αλλά θυμάται ότι ήταν κολλητά', () => {
    const t = tokenize('Coca Cola 3Ε')
    expect(t.map((x) => x.raw)).toEqual(['Coca', 'Cola', '3', 'Ε'])
    expect(t[3].glued).toBe(true)
    expect(t[2].glued).toBeUndefined()
    expect(tokenize('3 Ε')[1].glued).toBeUndefined()
  })
})

describe('words: λέξεις με θέσεις', () => {
  it('γράμματα και ψηφία χωριστά, κανονικοποιημένα', () => {
    expect(words('Δύο «Οικογενειακές», 400γρ!').map((w) => w.n)).toEqual(['δυο', 'οικογενειακεσ', '400', 'γρ'])
    const t = 'efood Μαργαρίτα'
    expect(words(t).map((w) => t.slice(w.from, w.to))).toEqual(['efood', 'Μαργαρίτα'])
  })
})

describe('applyPhrases: δικές τους φράσεις', () => {
  const R = [
    { phrase: 'οικογενειακή', meaning: 'μεγάλη μαργαρίτα' },
    { phrase: 'ο Γιώργος', meaning: 'Ξενοδοχείο Αστέρια' },
    { phrase: 'Χτύπα', meaning: 'πούλησα' },
    { phrase: 'μεγάλη πίτσα', meaning: 'Special' },
  ]
  it.each([
    ['efood δύο οικογενειακή', 'efood δύο μεγάλη μαργαρίτα'],
    ['efood δύο ΟΙΚΟΓΕΝΕΙΑΚΗ', 'efood δύο μεγάλη μαργαρίτα'],
    ['ο Γιώργος πλήρωσε 300', 'Ξενοδοχείο Αστέρια πλήρωσε 300'],
    ['πόσα χρωστάει ο γιωργος;', 'πόσα χρωστάει Ξενοδοχείο Αστέρια;'],
    // χωρίς άρθρο / μόνο το τελικό -ς αλλάζει
    ['πούλησα στον Γιώργο 2', 'πούλησα στον Ξενοδοχείο Αστέρια 2'],
    ['χτύπα 2 μαργαρίτες', 'πούλησα 2 μαργαρίτες'],
    // μόνο ολόκληρες λέξεις
    ['δύο οικογενειακές', 'δύο οικογενειακές'],
    ['χτυπάμε', 'χτυπάμε'],
    // κόμμα ανάμεσα: όχι η ίδια φράση
    ['μεγάλη, πίτσα', 'μεγάλη, πίτσα'],
    ['μεγάλη - πίτσα', 'Special'],
    ['κολλητά 2οικογενειακή', 'κολλητά 2 μεγάλη μαργαρίτα'],
  ])('%s → %s', (text, out) => {
    expect(applyPhrases(text, R)).toBe(out)
  })
  it('η μεγαλύτερη φράση πρώτα, ένα πέρασμα', () => {
    const r = [
      { phrase: 'α', meaning: 'β' },
      { phrase: 'β', meaning: 'γ' },
      { phrase: 'μεγάλη', meaning: 'Χ' },
      { phrase: 'μεγάλη μαργαρίτα', meaning: 'Υ' },
    ]
    expect(applyPhrases('α β μεγάλη μαργαρίτα μεγάλη', r)).toBe('β γ Υ Χ')
  })
  it('φράσεις με αριθμούς', () => {
    expect(applyPhrases('δύο 30άρια και ένα 30άρι', [{ phrase: '30άρι', meaning: 'Special κατεψυγμένη 30εκ' }]))
      .toBe('δύο 30άρια και ένα Special κατεψυγμένη 30εκ')
    expect(applyPhrases('τιμή 6,5 τώρα', [{ phrase: '6,5', meaning: 'έξι και μισό' }])).toBe('τιμή έξι και μισό τώρα')
  })
  it('χωρίς φράσεις ή με λάθος φράσεις: ίδιο κείμενο', () => {
    expect(applyPhrases('efood 2', [])).toBe('efood 2')
    expect(applyPhrases('efood 2', undefined)).toBe('efood 2')
    expect(applyPhrases('efood 2', [{ phrase: '', meaning: 'x' }, { phrase: '!!', meaning: 'y' }])).toBe('efood 2')
  })
  it('η πρώτη από δύο ίδιες φράσεις κερδίζει (π.χ. με και χωρίς τόνο)', () => {
    expect(applyPhrases('χαβα', [{ phrase: 'χάβα', meaning: 'Α' }, { phrase: 'χαβα', meaning: 'Β' }])).toBe('Α')
  })
  it('phraseKey: όπως συγκρίνει το ταίριασμα', () => {
    expect(phraseKey('Ο Γιώργος')).toBe(phraseKey('ο γιωργο'))
    expect(phraseKey('ζυμάρι')).not.toBe(phraseKey('ζυμάρια'))
    expect(phraseKey('νούμερο ένα')).toBe(phraseKey('Νούμερο 1'))
    expect(phraseKey('νούμερο είκοσι τρία')).toBe('νουμερο 23')
  })
  it('αριθμοί με ψηφία ή με λέξεις είναι ίδιοι, προς τις δύο μεριές', () => {
    const digit = [{ phrase: 'νούμερο 1', meaning: 'Μαργαρίτα' }]
    expect(applyPhrases('efood δύο νούμερο ένα', digit)).toBe('efood δύο Μαργαρίτα')
    expect(applyPhrases('efood δύο νούμερο 1', digit)).toBe('efood δύο Μαργαρίτα')
    const word = [{ phrase: 'νούμερο είκοσι τρία', meaning: 'Χαβανέζα' }]
    expect(applyPhrases('νούμερο 23 και νούμερο είκοσι τρία', word)).toBe('Χαβανέζα και Χαβανέζα')
    // άλλος αριθμός: όχι ("είκοσι τρία" ≠ "είκοσι")
    expect(applyPhrases('νούμερο είκοσι τρία', [{ phrase: 'νούμερο 20', meaning: 'Χ' }])).toBe('νούμερο είκοσι τρία')
  })
  it('φράση με άρθρο: χωρίς το άρθρο μόνο αν αυτό που μένει στέκει μόνο του', () => {
    // "η μία" δεν γίνεται σκέτο "μία" (θα έπιανε κάθε "μία σπέσιαλ")
    expect(applyPhrases('efood μία σπέσιαλ', [{ phrase: 'η μία', meaning: 'μαργαρίτα' }])).toBe('efood μία σπέσιαλ')
    expect(applyPhrases('η μία', [{ phrase: 'η μία', meaning: 'μαργαρίτα' }])).toBe('μαργαρίτα')
    for (const phrase of ['τα δύο', 'το πρώτο', 'τα άλλα', 'οι όλες', 'η πίτσα', 'το όχι']) {
      const w = phrase.split(' ')[1]
      expect(applyPhrases(`efood ${w} σπέσιαλ`, [{ phrase, meaning: 'Χ' }]), phrase).toBe(`efood ${w} σπέσιαλ`)
    }
    // ονόματα και λέξεις με νόημα: ναι
    expect(applyPhrases('στον Γιώργο', [{ phrase: 'ο Γιώργος', meaning: 'Αστέρια' }])).toBe('στον Αστέρια')
    expect(applyPhrases('efood δύο οικογενειακή', [{ phrase: 'η οικογενειακή', meaning: 'Special' }])).toBe('efood δύο Special')
  })
})

describe('applyPhrases με τον κατάλογο: δεν κόβει μεγαλύτερα ονόματα', () => {
  const named = (name: string, aliases: string[] = [], is_active = true) => ({ name, code: null, aliases, is_active })
  const CAT = {
    items: [named('Ζυμάρι 250γρ'), named('Ζυμάρι 400γρ'), named('Σάλτσα ντομάτας'), named('Τυρί φρέσκο'), named('Ζαμπόν χωριάτικο', [], false)],
    partners: [named('Ξενοδοχείο Αστέρια'), named('Ξενοδοχείο Χ'), named('Γιώργος Παπαδάκης')],
  }
  const R = [
    { phrase: 'ζυμάρι', meaning: 'Ζυμάρι 250γρ' },
    { phrase: 'το ξενοδοχείο', meaning: 'Ξενοδοχείο Αστέρια' },
    { phrase: 'τυρί', meaning: 'μοτσαρέλα' },
    { phrase: 'σάλτσα', meaning: 'Σάλτσα ντομάτας' },
    { phrase: 'ο Γιώργος', meaning: 'Ξενοδοχείο Αστέρια' },
    { phrase: 'ζαμπόν', meaning: 'Ζαμπόν' },
  ]
  it.each([
    // όνομα του καταλόγου που αρχίζει με τη φράση: μένει όπως ειπώθηκε
    ['μέτρησα ζυμάρι 400 20', 'μέτρησα ζυμάρι 400 20'],
    ['φτιάξαμε 80 ζυμάρια 400', 'φτιάξαμε 80 ζυμάρια 400'],
    ['πόσο ζυμάρι τετρακόσια έχουμε', 'πόσο ζυμάρι τετρακόσια έχουμε'],
    ['ζυμάρι 400 γραμμάρια', 'ζυμάρι 400 γραμμάρια'],
    ['πούλησα στο ξενοδοχείο Χ 10 σπέσιαλ', 'πούλησα στο ξενοδοχείο Χ 10 σπέσιαλ'],
    ['το ξενοδοχείο Χ μου έδωσε 100 ευρώ', 'το ξενοδοχείο Χ μου έδωσε 100 ευρώ'],
    ['μέτρησα τυρί φρέσκο 3 κιλά', 'μέτρησα τυρί φρέσκο 3 κιλά'],
    ['80 γραμμάρια σάλτσα ντομάτας', '80 γραμμάρια σάλτσα ντομάτας'],
    ['πλήρωσε ο Γιώργος Παπαδάκης', 'πλήρωσε ο Γιώργος Παπαδάκης'],
    // αλλιώς η φράση αλλάζει κανονικά
    ['μέτρησα ζυμάρι 20', 'μέτρησα Ζυμάρι 250γρ 20'],
    ['το ξενοδοχείο μου έδωσε 100 ευρώ', 'Ξενοδοχείο Αστέρια μου έδωσε 100 ευρώ'],
    ['μέτρησα τυρί 3 κιλά', 'μέτρησα μοτσαρέλα 3 κιλά'],
    ['πλήρωσε ο Γιώργος 300', 'πλήρωσε Ξενοδοχείο Αστέρια 300'],
    // ανενεργό είδος δεν προστατεύεται
    ['ζαμπόν χωριάτικο 2 κιλά', 'Ζαμπόν χωριάτικο 2 κιλά'],
  ])('%s → %s', (text, out) => {
    expect(applyPhrases(text, R, CAT)).toBe(out)
  })
  it('φράση ίδια ή μεγαλύτερη από το όνομα: αλλάζει (ο χρήστης το ζήτησε)', () => {
    expect(applyPhrases('μέτρησα ζυμάρι 400 20', [{ phrase: 'ζυμάρι 400', meaning: 'Ζυμάρι 250γρ' }], CAT)).toBe('μέτρησα Ζυμάρι 250γρ 20')
    expect(applyPhrases('ζυμάρι 400 διπλό', [{ phrase: 'ζυμάρι 400 διπλό', meaning: 'Χ' }], CAT)).toBe('Χ')
  })
  it('χωρίς κατάλογο: όπως πριν', () => {
    expect(applyPhrases('μέτρησα ζυμάρι 400 20', R)).toBe('μέτρησα Ζυμάρι 250γρ 400 20')
    expect(applyPhrases('μέτρησα ζυμάρι 400 20', R, null)).toBe('μέτρησα Ζυμάρι 250γρ 400 20')
    expect(applyPhrases('μέτρησα ζυμάρι 400 20', R, { items: 'x' as unknown as [] })).toBe('μέτρησα Ζυμάρι 250γρ 400 20')
  })
  it('phraseStartsName: η φράση είναι η αρχή μεγαλύτερου ονόματος', () => {
    expect(phraseStartsName('ζυμάρι', CAT)).toBe('Ζυμάρι 250γρ')
    expect(phraseStartsName('Ξενοδοχείο', CAT)).toBe('Ξενοδοχείο Αστέρια')
    expect(phraseStartsName('ζυμάρι 400', CAT)).toBeNull()
    expect(phraseStartsName('οικογενειακή', CAT)).toBeNull()
    expect(phraseStartsName('ζαμπόν', CAT)).toBeNull()
  })
})
