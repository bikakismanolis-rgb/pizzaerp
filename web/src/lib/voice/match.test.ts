import { describe, expect, it } from 'vitest'
import { tokenize } from './normalize'
import { segment } from './numbers'
import { Matcher, confident, getIndex, toRef, type Pool, type Role } from './match'
import { CTX, ITEMS, PARTNERS } from './testFixtures'
import { isStop, unitWord } from './lexicon'

const ALL: Pool = { item: () => 1, partner: () => 1 }
const FIN: Pool = { item: (it) => (it.item_type === 'finished' ? 1 : 0) }

/** Βρίσκει τις οντότητες μιας φράσης (χωρίς λέξεις εντολών) */
function find(text: string, pool: Pool = ALL) {
  const toks = tokenize(text)
  const segs = segment(toks)
  const roles: Role[] = segs.map((s) =>
    s.t === 's' ? 'block' : s.t === 'n' ? 'num' : unitWord(s.tok.n) ? 'unit' : isStop(s.tok.n) ? 'stop' : 'content',
  )
  const m = new Matcher(getIndex(CTX.items, CTX.partners), toks, segs)
  return m.find(roles, pool).map((h) => ({ heard: h.heard, ref: toRef(h.heard, h.ranked) }))
}

describe('ευρετήριο', () => {
  it('αγνοεί ανενεργά και κρατιέται στη μνήμη', () => {
    const idx = getIndex(CTX.items, CTX.partners)
    expect(idx.entries.some((e) => e.id === ITEMS.calzone.id)).toBe(false)
    expect(idx.entries.some((e) => e.id === PARTNERS.old.id)).toBe(false)
    expect(getIndex(CTX.items, CTX.partners)).toBe(idx)
  })
  it('ξαναχτίζεται όταν αλλάξει ο ίδιος πίνακας (νέο alias)', () => {
    const items = [{ ...ITEMS.flour, aliases: [] as string[] }]
    const a = getIndex(items, [])
    items[0] = { ...items[0], aliases: ['σιμιγδάλι'] }
    const b = getIndex(items, [])
    expect(b).not.toBe(a)
    expect(b.entries[0].forms.length).toBe(2)
  })
  it('δεν σκάει με κενά / ελλιπή δεδομένα', () => {
    expect(() => getIndex([], [])).not.toThrow()
    const broken = [{ ...ITEMS.flour, aliases: null as unknown as string[], name: '' }]
    expect(() => getIndex(broken, [])).not.toThrow()
  })
})

describe('αντιστοίχιση φράσεων', () => {
  it('ακριβές όνομα, κλίση, λατινικά', () => {
    expect(find('μαργαρίτες')[0].ref.id).toBe(ITEMS.margarita.id)
    expect(find('margherita')[0].ref.id).toBe(ITEMS.margarita.id)
    expect(find('MOZZARELLA')[0].ref.id).toBe(ITEMS.mozz.id)
    expect(find('μπέικον')[0].ref.id).toBe(ITEMS.bacon.id)
    expect(find('bacon')[0].ref.id).toBe(ITEMS.bacon.id)
  })
  it('alias: "μύλος" → Μύλος Α.Ε., "σπέσιαλ" → Special', () => {
    expect(find('μύλο')[0].ref.id).toBe(PARTNERS.mill.id)
    expect(find('σπέσιαλ', FIN)[0].ref.id).toBe(ITEMS.special.id)
  })
  it('προτιμά τη μεγαλύτερη ακριβή αντιστοίχιση', () => {
    const r = find('σπέσιαλ κατεψυγμένες', FIN)
    expect(r).toHaveLength(1)
    expect(r[0].ref.id).toBe(ITEMS.frozen.id)
    expect(find('ζυμάρια 400')[0].ref.id).toBe(ITEMS.dough400.id)
    expect(find('ζυμάρι 250 γραμμαρίων')[0].ref.id).toBe(ITEMS.dough250.id)
  })
  it('αμφίσημο → id null με υποψηφίους', () => {
    const r = find('ζυμάρια')[0].ref
    expect(r.id).toBeNull()
    expect(r.candidates.map((c) => c.id).sort()).toEqual([ITEMS.dough250.id, ITEMS.dough400.id].sort())
    const h = find('ξενοδοχείο')[0].ref
    expect(h.id).toBeNull()
    expect(h.candidates.length).toBe(2)
  })
  it('δύο οντότητες σε μία φράση', () => {
    const r = find('μαργαρίτα και πεπερόνι', FIN)
    expect(r.map((x) => x.ref.id)).toEqual([ITEMS.margarita.id, ITEMS.pepperoni.id])
  })
  it('όνομα γράμματος ("Χι" → Ξενοδοχείο Χ)', () => {
    expect(find('ξενοδοχείο χι')[0].ref.id).toBe(PARTNERS.hotelX.id)
    expect(find('ξενοδοχείο Χ')[0].ref.id).toBe(PARTNERS.hotelX.id)
  })
  it('κωδικός είδους', () => {
    expect(find('ΠΥ-001')[0]?.ref.id).toBe(ITEMS.flour.id)
  })
  it('η δεξαμενή αλλάζει το αποτέλεσμα (πίτσα vs σαλάμι)', () => {
    expect(find('πεπερόνι', FIN)[0].ref.id).toBe(ITEMS.pepperoni.id)
    expect(find('πεπερόνι', { item: (it) => (it.item_type === 'raw' ? 1 : 0.5) })[0].ref.id).toBe(ITEMS.salami.id)
  })
  it('άγνωστη λέξη δεν γίνεται οντότητα', () => {
    expect(find('καλτσόνε')).toEqual([])
    expect(find('γεια σου')).toEqual([])
  })
})

describe('confident / toRef', () => {
  const e = (id: string) => ({ kind: 'item' as const, id, name: id, forms: [], codeKey: '' })
  it('σίγουρο μόνο με διαφορά από τον δεύτερο', () => {
    expect(confident([{ entry: e('a'), score: 0.9, explained: 1 }, { entry: e('b'), score: 0.85, explained: 1 }])).toBeNull()
    expect(confident([{ entry: e('a'), score: 0.9, explained: 1 }, { entry: e('b'), score: 0.5, explained: 1 }])?.entry.id).toBe('a')
    expect(confident([{ entry: e('a'), score: 0.65, explained: 1 }])?.entry.id).toBe('a')
    expect(confident([{ entry: e('a'), score: 0.4, explained: 1 }])).toBeNull()
  })
  it('ακριβές όνομα μπροστά από άλλη κλίση της ίδιας ρίζας, όχι από μακρύτερο όνομα', () => {
    const exact = { entry: e('a'), score: 1, explained: 1, exact: true, full: true }
    expect(confident([exact, { entry: e('b'), score: 1, explained: 1, exact: false, full: true }])?.entry.id).toBe('a')
    expect(confident([exact, { entry: e('b'), score: 0.95, explained: 1, exact: false, full: false }])).toBeNull()
    expect(confident([{ ...exact, exact: false }, { entry: e('b'), score: 1, explained: 1, exact: false, full: true }])).toBeNull()
  })
  it('έως 5 υποψήφιοι σε φθίνουσα σειρά', () => {
    const ranked = [0.9, 0.88, 0.8, 0.7, 0.6, 0.5, 0.45].map((s, i) => ({ entry: e('x' + i), score: s, explained: 1 }))
    const r = toRef('κάτι', ranked)
    expect(r.id).toBeNull()
    expect(r.candidates).toHaveLength(5)
    expect(r.candidates[0].score).toBeGreaterThanOrEqual(r.candidates[4].score)
  })
})
