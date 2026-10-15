import { describe, expect, it } from 'vitest'
import { capFirst, keySim, norm, normText, parseDigits, phon, stemKey, titleCase, tokenize } from './normalize'

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
