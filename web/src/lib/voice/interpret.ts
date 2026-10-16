import type { Item, ItemType, Partner } from '../types'
import type {
  Command, EntityRef, InterpretContext, Interpretation, Interpreter, PricedLine, QtyLine, TallyChannel,
} from './types'
import { applyPhrases, capFirst, norm, phraseKey, phraseStartsName, titleCase, tokenize, words, type Tok, type Word } from './normalize'
import { parseYesNo } from './describe'
import { segment, type NumSeg, type Seg } from './numbers'
import {
  AFM_WORDS, CENTS, CITIES, CITY_PREP, CORRECTION, EACH, LETTER_NAMES, LOCATION, MINUS_POST, MINUS_PRE, MONEY, MORE,
  NET_WORDS, PER_ART, PHONE_WORDS, PLUS_WORDS, PRICE_PREP, REF_WORDS, ROOMS, SO_MANY, STOCK_WORDS, TOTAL, UNIT_SHORT, VAT,
  channelAt, convertUnit, cueOf, genericPack, isItemPack, isMeasureUnit, isModifier, isStop, unitWord,
  type Cue, type MeasureUnit,
} from './lexicon'
import { Matcher, confident, emptyRef, getIndex, toRef, type Hit, type Index, type Pool, type Role, type Scored } from './match'
import { fmtCost, fmtMoney } from '../format'

/**
 * Τοπικός interpreter (χωρίς API): κείμενο → εντολή.
 * Στρώσεις: tokens + κανονικοποίηση → αριθμοί → διορθώσεις ("λάθος, 3") →
 * λέξεις εντολής / κανάλια → απόφαση εντολής → φράσεις-οντότητες (είδη,
 * συναλλασσόμενοι) → ζευγάρωμα ποσοτήτων / τιμών / μονάδων → Command.
 * Δεν πετάει ποτέ εξαίρεση.
 */

// ---------------------------------------------------------------------
// Δεξαμενές υποψηφίων ανά εντολή (βάρος 0 = εκτός)
// ---------------------------------------------------------------------
const isFin = (it: Item) => it.item_type === 'finished'
const POOL = {
  saleTally: { item: (it: Item) => (isFin(it) ? (it.make_to_order ? 1 : 0.9) : 0) } as Pool,
  sale: {
    item: (it: Item) => (isFin(it) ? (it.make_to_order ? 0.8 : 1) : it.item_type === 'semi' ? 0.6 : 0.5),
    partner: (p: Partner) => (p.is_customer ? 1 : 0.55),
  } as Pool,
  purchase: {
    item: (it: Item) => (it.item_type === 'raw' ? 1 : isFin(it) && it.make_to_order ? 0.5 : 0.7),
    partner: (p: Partner) => (p.is_supplier ? 1 : 0.55),
  } as Pool,
  production: { item: (it: Item) => (it.item_type === 'semi' ? 1 : isFin(it) ? (it.make_to_order ? 0.85 : 1) : 0) } as Pool,
  stock: { item: (it: Item) => (isFin(it) && it.make_to_order ? 0.6 : 1) } as Pool,
  recipeProduct: { item: (it: Item) => (it.item_type === 'raw' ? 0 : 1) } as Pool,
  compOfFinished: { item: (it: Item) => (isFin(it) ? 0 : 1) } as Pool,
  compOfSemi: { item: (it: Item) => (it.item_type === 'raw' ? 1 : 0) } as Pool,
  itemPrice: { item: (it: Item) => (isFin(it) ? 1 : 0.7) } as Pool,
  partnerPrice: {
    item: (it: Item) => (isFin(it) ? (it.make_to_order ? 0.95 : 1) : 0.6),
    partner: (p: Partner) => (p.is_customer ? 1 : 0.55),
  } as Pool,
  customers: { partner: (p: Partner) => (p.is_customer ? 1 : 0.55) } as Pool,
  suppliers: { partner: (p: Partner) => (p.is_supplier ? 1 : 0.55) } as Pool,
  partners: { partner: () => 1 } as Pool,
  items: { item: () => 1 } as Pool,
  all: { item: () => 1, partner: () => 1 } as Pool,
}

const round = (v: number, d = 4) => Math.round(v * Math.pow(10, d)) / Math.pow(10, d)

type Per = { k: 'unit'; unit: MeasureUnit } | { k: 'pack'; n: string } | { k: 'each' }

/** Αριθμός της πρότασης με ό,τι τον συνοδεύει */
interface NumInfo {
  i: number
  /** πρώτο τμήμα μετά τον αριθμό και τα συνοδευτικά του */
  end: number
  value: number
  unit: MeasureUnit | null
  pack: string | null
  /** τμήμα που τελειώνει η ποσότητα (για heardQty) */
  qtyEnd: number
  money: boolean
  per: Per | null
  total: boolean
  prep: boolean
  kaiNext: boolean
  words: boolean
  half: boolean
  size: boolean
  pct: boolean
  /** αφαιρείται από τη γραμμή ("3 μαργαρίτες μείον 1") */
  neg?: boolean
}

interface Ent {
  from: number
  to: number
  hit: Hit
  unknown: boolean
  /** σκέτος προσδιορισμός δίπλα σε λέξη που δεν βρέθηκε: όχι σίγουρο id */
  weak?: boolean
}

interface Line {
  ent: Ent
  qty: NumInfo | null
  /** επιπλέον ποσότητες που προστίθενται ("2 σακιά και 10 κιλά") */
  more?: NumInfo[]
  price: NumInfo | null
}

/** Απογραφή: λέξη τρόπου στη φράση ("άλλα", "σύνολο", "άλλα τόσα") */
interface ModeMark {
  /** τμήματα [i, i + len) */
  i: number
  len: number
  /** null: μόνο "τόσα" (λείπει ο αριθμός) */
  mode: 'add' | 'set' | null
  lead: boolean
  trail: boolean
  /** στην αρχή της φράσης ισχύει για όλες τις γραμμές */
  all: boolean
  /** "άλλα τόσα": δεν ειπώθηκε αριθμός */
  soMany: boolean
}

const ARTICLES = new Set(['το', 'τον', 'τη', 'την', 'του', 'τησ'])
const NEGATION = new Set(['δεν', 'δε', 'ουτε', 'μη', 'μην', 'χωρισ'])
/** "πάγκος": κανάλι μαγαζί στις πωλήσεις, χώρος στην απογραφή */
const COUNTER = new Set(['παγκο', 'παγκοσ', 'παγκου'])
const NET_ADJ = new Set(['καθαρη', 'καθαρα', 'καθαρο', 'καθαρησ', 'καθαρων'])
const TIME_PREV = new Set(['στισ', 'ωρα', 'ωρεσ'])
/** "τραπέζι 5", "παραγγελία 1234": αριθμός-ετικέτα */
const LABEL_PREV = new Set(['τραπεζι', 'τραπεζιου', 'τραπεζια', 'παραγγελια', 'παραγγελιασ', 'νουμερο', 'αριθμοσ', 'αριθμο', 'κωδικοσ', 'κωδικο', 'no', 'νο'])
const CLITIC = new Set(['το', 'τα', 'τη', 'την', 'τον', 'του', 'τουσ', 'τισ', 'μου', 'μασ', 'σου', 'σασ'])
const SELL_PRESENT = new Set(['πουλαμε', 'πουλαω', 'πουλαει', 'πουλανε', 'πουλαμαι'])
const TRADE: Cue[] = ['buy', 'sell', 'take1', 'take3', 'invoice', 'note', 'order', 'ordered', 'brought', 'produce', 'did', 'knead', 'count', 'pay', 'receive']
/** καταλήξεις ρημάτων: λέξη που δεν βρέθηκε και μοιάζει με ρήμα → δεν μαντεύουμε εντολή */
const KNOWN_VERBS = new Set(['δινουμε', 'δινω', 'δινουν', 'δινουνε', 'πουλαμε', 'πουλαω', 'πουλανε'])
const VERB_END = /(αμε|ατε|ανε|ουμε|ουνε|ετε|ησα|ησε|ησαν|ηκε|ηκαν|ασα|ασε|ασαν|αξα|αξε|αξαν|ιξα|ιξε|ιξαν|ψα|ψε|ψαν|ωσα|ωσε|ωσαν|εσα|εσε|εσαν|θηκε|θηκαν|ουσε|ουσαν)$/

// ---------------------------------------------------------------------
// Ανάλυση πρότασης
// ---------------------------------------------------------------------
class Analysis {
  toks: Tok[]
  segs: Seg[]
  cue: (Cue | null)[]
  chan: (TallyChannel | null)[]
  m: Matcher
  idx: Index
  items: Item[]
  partners: Partner[]
  issues: string[] = []
  /** τμήματα που "καταναλώθηκαν" από πεδία (αρ. τιμολογίου, ΦΠΑ, διορθώσεις ...) */
  used = new Set<number>()
  gross: boolean | null = null
  vatRate: number | null = null
  /** αριθμοί που δεν μπήκαν πουθενά */
  loose = 0
  /** ανώτατη βεβαιότητα (π.χ. όταν μαντέψαμε αν η τιμή είναι σύνολο) */
  cap = 1
  /** απογραφή: "στο ψυγείο", "στην αποθήκη" είναι γέμισμα */
  locStop = false
  /** αριθμοί που άλλαξαν από διόρθωση: πώς να φαίνονται */
  relabel = new Map<number, string>()
  /** απογραφή: λέξεις πρόσθεσης / αντικατάστασης */
  modes: ModeMark[] = []
  /** "όχι 30 αλλά 40": θέση του "αλλά" (αντικατάσταση) */
  private notButAt = new Set<number>()
  /** τμήματα που διαβάζονται ως γέμισμα (λέξεις τρόπου, μόνο στην απογραφή) */
  filler = new Set<number>()

  constructor(public text: string, public ctx: InterpretContext) {
    this.items = Array.isArray(ctx?.items) ? ctx.items : []
    this.partners = Array.isArray(ctx?.partners) ? ctx.partners : []
    this.toks = tokenize(text)
    this.segs = segment(this.toks)
    this.cue = this.segs.map((s) => (s.t === 'w' ? cueOf(s.tok.n) : null))
    this.chan = this.segs.map(() => null)
    for (let i = 0; i < this.segs.length; i++) {
      const s = this.segs[i]
      if (s.t !== 'w') continue
      const c = channelAt(this.toks, s.from)
      if (!c) continue
      this.chan[i] = c.ch
      if (c.len === 2 && this.segs[i + 1]?.t === 'w') { this.chan[i + 1] = c.ch; i++ }
    }
    this.idx = getIndex(this.items, this.partners)
    this.m = new Matcher(this.idx, this.toks, this.segs)
    this.notBut()
    this.applyCorrections()
    this.uncueNames()
    this.findModes()
  }

  w(i: number): string | null {
    const s = this.segs[i]
    return s && s.t === 'w' ? s.tok.n : null
  }

  num(i: number): NumSeg | null {
    const s = this.segs[i]
    return s && s.t === 'n' ? s : null
  }

  has(...cs: Cue[]): boolean {
    return this.cue.some((c) => c !== null && cs.includes(c))
  }

  at(c: Cue): number {
    return this.cue.indexOf(c)
  }

  heard(from: number, to: number): string {
    return this.m.heard(from, to)
  }

  hasChannel(): boolean {
    return this.chan.some(Boolean)
  }

  /** Το μόνο "κανάλι" της φράσης είναι ο πάγκος; */
  counterOnly(): boolean {
    let any = false
    for (let i = 0; i < this.segs.length; i++) {
      if (!this.chan[i]) continue
      if (!COUNTER.has(this.w(i) ?? '')) return false
      any = true
    }
    return any
  }

  /** Ο πάγκος ως χώρος φύλαξης, όχι κανάλι */
  counterAsRoom() {
    this.segs.forEach((_s, i) => { if (this.chan[i] && COUNTER.has(this.w(i) ?? '')) this.chan[i] = null })
  }

  /** Μόνο γενικοί προσδιορισμοί ("κατεψυγμένα", "φρέσκο") στο [from, to) */
  onlyModifiers(from: number, to: number): boolean {
    let any = false
    for (let i = from; i < to; i++) {
      const n = this.w(i)
      if (n === null) return false
      if (isStop(n)) continue
      if (!isModifier(n)) return false
      any = true
    }
    return any
  }

  /** Λέξεις "περιεχομένου": όχι γέμισμα, όχι λέξεις εντολών */
  contentCount(): number {
    let n = 0
    this.segs.forEach((s, i) => {
      if (this.used.has(i)) return
      if (s.t === 'n') n++
      else if (s.t === 'w' && !isStop(s.tok.n) && !this.cue[i]) n++
    })
    return n
  }

  /** Απλή λέξη (όχι γέμισμα, εντολή, κανάλι, μονάδα, χρήματα) */
  isPlainWord(i: number): boolean {
    const n = this.w(i)
    if (!n || isStop(n) || this.filler.has(i) || this.cue[i] || this.chan[i] || this.unitAt(i)) return false
    return !MONEY.has(n) && !CENTS.has(n) && !VAT.has(n)
  }

  contentBetween(p: number, q: number): boolean {
    for (let i = p; i < q; i++) if (this.isPlainWord(i)) return true
    return false
  }

  roles(reserveChannels: boolean, extraBlock?: Set<number>): Role[] {
    return this.segs.map((s, i) => {
      if (this.used.has(i) || extraBlock?.has(i)) return 'block'
      if (s.t === 's') return 'block'
      if (s.t === 'n') return s.pct ? 'block' : 'num'
      const n = s.tok.n
      if (this.filler.has(i)) return 'stop'
      if (reserveChannels && this.chan[i]) return 'block'
      const c = this.cue[i]
      if (c && c !== 'pizza') return 'block'
      if (unitWord(n)) return 'unit'
      if (this.packSlot(i)) return 'unit'
      if (MONEY.has(n) || CENTS.has(n) || VAT.has(n) || TOTAL.has(n) || PRICE_PREP.has(n) || n === 'ανα' || n === '%') return 'block'
      if (REF_WORDS.has(n) || PHONE_WORDS.has(n) || AFM_WORDS.has(n)) return 'block'
      if (isStop(n) || (this.locStop && LOCATION.has(n))) return 'stop'
      return 'content'
    })
  }

  /** Φράση μόνο από "πίτσα/πίτσες": δεν είναι είδος (δεν πρέπει να γίνει "Κουτί πίτσας") */
  private onlyPizza(h: Hit): boolean {
    for (let i = h.from; i < h.to; i++) {
      const s = this.segs[i]
      if (s.t === 'n') return false
      if (s.t === 'w' && !isStop(s.tok.n) && this.cue[i] !== 'pizza') return false
    }
    return true
  }

  /** Εντοπισμός οντοτήτων + λέξεων που δεν βρέθηκαν */
  scan(pool: Pool, reserveChannels: boolean, lo = 0, hi = this.segs.length, extraBlock?: Set<number>) {
    const roles = this.roles(reserveChannels, extraBlock)
    const hits = this.m.find(roles, pool, lo, hi).filter((h) => !this.onlyPizza(h))
    // λέξεις συσκευασίας / μονάδας αμέσως μετά από αριθμό δεν είναι "άγνωστα είδη"
    const r2 = roles.slice()
    this.segs.forEach((_s, i) => { if (this.packSlot(i)) r2[i] = 'block' })
    const unknown = this.m.unknownRuns(r2, hits, pool, lo, hi)
    return { hits, unknown, roles }
  }

  /** Λέξη συσκευασίας σε θέση μονάδας: "10 σακιά", "15 ευρώ το σακί" */
  packSlot(i: number): boolean {
    const n = this.w(i)
    if (!n || !(genericPack(n) || this.isAnyPack(n))) return false
    const p = this.segs[i - 1]
    if (p?.t === 'n') return true
    // "18 ευρώ η κούτα", "0,62 το σακί"
    if (p?.t !== 'w' || !PER_ART.has(p.tok.n)) return false
    return !!this.num(i - 2) || (MONEY.has(this.w(i - 2) ?? '') && !!this.num(i - 3))
  }

  isAnyPack(n: string): boolean {
    return this.idx.packs.has(n)
  }

  /**
   * "αλεύρι όχι 30 αλλά 40": μένει το 40 (στην απογραφή: αντικατάσταση).
   * Χωρίς μονάδα στο 40 κρατά τη μονάδα του 30 ("όχι 3 σακιά αλλά 4").
   */
  private notBut() {
    const n = this.segs.length
    const isW = (j: number, stopAt?: string) => {
      const w = this.w(j)
      return w !== null && isStop(w) && w !== stopAt
    }
    for (let c = 0; c < n; c++) {
      if (this.w(c) !== 'οχι' || this.used.has(c)) continue
      let j = c + 1
      while (j < n && isW(j, 'αλλα')) j++
      const X = this.num(j)
      if (!X || X.pct || X.size) continue
      let k = j + 1
      const xUnit = !!this.unitAt(k)
      if (xUnit) k++
      while (k < n && this.segs[k].t === 's') k++
      if (this.w(k) !== 'αλλα') continue
      let q = k + 1
      while (q < n && (this.segs[q].t === 's' || isW(q))) q++
      const Y = this.num(q)
      if (!Y || Y.pct || Y.size) continue
      this.used.add(c)
      if (xUnit && !this.unitAt(q + 1)) {
        // η νέα τιμή στη θέση της παλιάς (κρατά τη μονάδα)
        X.value = Y.value
        X.digits = Y.digits
        X.words = Y.words
        if (Y.half) X.half = true
        else delete X.half
        this.relabel.set(j, this.heard(q, q + 1))
        this.used.add(q)
      } else {
        this.used.add(j)
        if (xUnit) this.used.add(j + 1)
      }
      this.notButAt.add(k)
      this.modes.push({ i: c, len: 1, mode: 'set', lead: true, trail: false, all: false, soMany: false })
      c = k
    }
  }

  /** "μοτσαρέλα 2 κιλά και αλεύρι διόρθωση 40": η διόρθωση πάει στο νέο είδος, όχι στο 2 */
  private newItemBetween(p: number, c: number): boolean {
    for (let t = p + 1; t < c - 1; t++) {
      const w = this.w(t)
      if ((w === 'και' || w === 'κι' || this.segs[t].t === 's') && this.isPlainWord(t + 1)) return true
    }
    return false
  }

  /**
   * "2 μαργαρίτες, λάθος, 3": η νέα ποσότητα αντικαθιστά την προηγούμενη·
   * "2 μαργαρίτες λάθος 3 μαργαρίτες": ξαναλέει όλη τη γραμμή.
   */
  private applyCorrections() {
    const n = this.segs.length
    for (let c = 0; c < n; c++) {
      const cw = this.w(c)
      if (!cw || !CORRECTION.has(cw) || this.used.has(c)) continue
      let j = c + 1
      while (j < n && (this.segs[j].t === 's' || (this.w(j) !== null && isStop(this.w(j) as string) && !CORRECTION.has(this.w(j) as string)))) j++
      const M = this.num(j)
      if (!M || M.pct || M.size || this.used.has(j)) continue
      let p = c - 1
      let steps = 0
      while (p >= 0 && !this.num(p) && steps < 5) { p--; steps++ }
      const N = p >= 0 ? this.num(p) : null
      if (!N || N.pct || this.used.has(p) || this.newItemBetween(p, c)) continue
      let q = j + 1
      const mUnit = !!this.unitAt(q)
      if (mUnit) q++
      const nx = this.segs[q]
      const restated = !!nx && nx.t === 'w' && !isStop(nx.tok.n) && !this.cue[q] && !this.chan[q] && !MONEY.has(nx.tok.n) && !CENTS.has(nx.tok.n)
      if (restated) {
        for (let k = p; k <= c; k++) if (k === c || (!this.cue[k] && !this.chan[k])) this.used.add(k)
      } else if (mUnit) {
        // "5 κιλά μοτσαρέλα, συγγνώμη, 6 κιλά": μένει η νέα με τη μονάδα της
        this.used.add(p)
        if (this.unitAt(p + 1)) this.used.add(p + 1)
        this.used.add(c)
      } else {
        // η νέα τιμή μπαίνει στη θέση της παλιάς (κρατά μονάδα και σειρά)
        N.value = M.value
        N.digits = M.digits
        N.words = M.words
        this.relabel.set(p, this.heard(j, j + 1))
        if (M.half) N.half = true
        else delete N.half
        this.used.add(c)
        this.used.add(j)
      }
      if (cw === 'οχι') this.issues.push(`Κράτησα το «${this.heard(j, j + 1)}» αντί για το προηγούμενο.`)
      this.cue[c] = null
    }
  }

  /** Ονόματα του καταλόγου με λέξεις εντολών ("Μετρό", "Νέα Ζωή"): εκεί δεν είναι εντολές */
  private uncueNames() {
    const cand: number[] = []
    this.segs.forEach((s, i) => {
      if (s.t === 'w' && this.cue[i] && this.cue[i] !== 'pizza' && !this.used.has(i) && s.tok.key && this.idx.vocab.has(s.tok.key)) cand.push(i)
    })
    if (!cand.length) return
    const roles = this.segs.map((s, i): Role => {
      if (this.used.has(i) || s.t === 's') return 'block'
      if (s.t === 'n') return s.pct ? 'block' : 'num'
      const n = s.tok.n
      if (this.cue[i] && this.cue[i] !== 'pizza' && !cand.includes(i)) return 'block'
      if (unitWord(n)) return 'unit'
      if (isStop(n) && !cand.includes(i)) return 'stop'
      return 'content'
    })
    for (const h of this.m.find(roles, POOL.all, 0, this.segs.length, 0.85)) {
      const top = h.ranked[0]
      if (!top || top.score < 0.9) continue
      for (const i of cand) {
        if (i < h.from || i >= h.to) continue
        const n = this.w(i)
        if (top.entry.forms.some((f) => f.toks.some((t) => t.n === n))) this.cue[i] = null
      }
    }
  }

  /**
   * Απογραφή: λέξεις τρόπου ("άλλα 5", "κι εδώ", "σύνολο 40", "40 αντί για
   * 30", "όλα μαζί", "διόρθωσε", "άλλα τόσα"). Μόνο σημειώνονται εδώ· η
   * απογραφή τις κάνει γέμισμα και τις δένει με γραμμές (stockModes).
   */
  private findModes() {
    const n = this.segs.length
    for (let i = 0; i < n; i++) {
      if (this.used.has(i) || this.notButAt.has(i)) continue
      const w = this.w(i)
      if (!w) continue
      const nx = this.used.has(i + 1) ? null : this.w(i + 1)
      const at = i
      const mark = (mode: 'add' | 'set' | null, len: number, lead: boolean, trail: boolean, all: boolean, soMany = false) => {
        this.modes.push({ i: at, len, mode, lead, trail, all, soMany })
        i += len - 1
      }
      // "όχι άλλα, σύνολο 40"
      if (w === 'οχι' && nx && STOCK_WORDS.get(nx)?.mode === 'add') { mark('set', 2, true, true, false); continue }
      // "κι εδώ αλεύρι 5 κιλά": άλλος χώρος
      if ((w === 'και' || w === 'κι') && nx === 'εδω') { mark('add', 2, true, false, true); continue }
      if ((w === 'ολα' || w === 'ολο' || w === 'ολεσ' || w === 'ολουσ') && nx === 'μαζι') { mark('set', 2, true, true, true); continue }
      if (SO_MANY.has(w)) { mark(null, 1, true, true, false, true); continue }
      const sw = STOCK_WORDS.get(w)
      if (!sw) continue
      // "έχουμε ακόμα 2 κιλά": ακόμα = ακόμη υπάρχουν, όχι πρόσθεση
      if ((w === 'ακομα' || w === 'ακομη') && (this.cue[i - 1] === 'have' || this.cue[i - 1] === 'remain')) continue
      if (sw.mode === 'add') {
        // "αλλά" (τόνος στο τέλος) = σύνδεσμος, όχι "άλλα"· χωρίς τόνους δεν ξεχωρίζει
        if (w === 'αλλα' && /^αλλά$/i.test((this.segs[i] as { tok: Tok }).tok.raw.normalize('NFC'))) continue
        // "δεν έχει άλλο αλεύρι": άρνηση, όχι πρόσθεση
        if (NEGATION.has(this.w(i - 1) ?? '') || NEGATION.has(this.w(i - 2) ?? '')) continue
      }
      if (sw.mode === 'add' && nx && SO_MANY.has(nx)) { mark('add', 2, true, true, false, true); continue }
      if (w === 'αντι') {
        // "40 κιλά αντί για 30": το 30 ήταν η παλιά μέτρηση
        let j = i + 1
        while (['για', 'του', 'τησ', 'τα', 'το', 'των', 'τουσ', 'τισ'].includes(this.w(j) ?? '')) j++
        if (this.num(j) && !this.used.has(j)) {
          this.used.add(j)
          if (this.unitAt(j + 1)) this.used.add(j + 1)
        }
        mark('set', j - i, true, true, false)
        continue
      }
      mark(sw.mode, 1, sw.lead, sw.trail, sw.all)
    }
  }

  /** Απογραφή: οι λέξεις τρόπου γίνονται γέμισμα */
  stockFiller() {
    for (const m of this.modes) for (let i = m.i; i < m.i + m.len; i++) this.filler.add(i)
    for (const k of this.notButAt) this.filler.add(k)
  }

  /**
   * "με ΦΠΑ", "χωρίς (το) ΦΠΑ", "ΦΠΑ μέσα", "8 ευρώ καθαρά", "ΦΠΑ 24", "24%".
   * rate: πότε ένας αριθμός μετά το ΦΠΑ είναι συντελεστής ('always' για νέο
   * είδος / αγορά, 'strict' όταν ο αριθμός μπορεί να είναι η τιμή).
   */
  markVat(rate: 'always' | 'strict' = 'always') {
    const numCount = this.segs.filter((s) => s.t === 'n').length
    this.segs.forEach((s, i) => {
      const n = this.w(i)
      if (n && VAT.has(n)) {
        this.used.add(i)
        let k = i - 1
        if (ARTICLES.has(this.w(k) ?? '')) k--
        const p = this.w(k)
        if (p === 'με' || p === 'συμπεριλαμβανομενου' || p === 'μαζι') {
          this.gross = true
          for (let q = k; q < i; q++) this.used.add(q)
          if (p === 'με' && this.w(k - 1) === 'μαζι') this.used.add(k - 1)
        } else if (p && ['χωρισ', 'συν', 'πλεον', 'προ', 'εκτοσ', 'ανευ'].includes(p)) {
          this.gross = false
          for (let q = k; q < i; q++) this.used.add(q)
        }
        const nx = this.w(i + 1)
        if (nx === 'μεσα' || nx === 'συμπεριλαμβανεται' || nx === 'περιλαμβανεται') { this.gross = true; this.used.add(i + 1) }
        let r = i + 1
        if (this.w(r) === 'με' || this.w(r) === 'στο' || this.w(r) === 'στα') r++
        const x = this.num(r)
        if (x && this.isRate(x, r, rate === 'always', numCount > 1)) {
          this.vatRate = x.value
          for (let q = i + 1; q <= r; q++) this.used.add(q)
        }
      } else if (n && NET_ADJ.has(n) && (this.num(i - 1) || this.num(i + 1) || (MONEY.has(this.w(i - 1) ?? '') && this.num(i - 2)))) {
        this.gross = false
        this.used.add(i)
      } else if (s.t === 'n' && s.pct && [6, 13, 24].includes(s.value)) {
        this.vatRate = s.value
        this.used.add(i)
      }
    })
  }

  /** Αριθμός μετά το ΦΠΑ: συντελεστής ή τιμή / ποσότητα; ("με ΦΠΑ 8 ευρώ", "χωρίς ΦΠΑ 20 κιλά") */
  private isRate(x: NumSeg, r: number, always: boolean, others: boolean): boolean {
    if (x.pct) return x.value >= 0 && x.value <= 30
    if (!Number.isInteger(x.value) || x.value > 30) return false
    const nx = this.w(r + 1)
    if (nx && (MONEY.has(nx) || CENTS.has(nx) || unitWord(nx) || genericPack(nx) || this.isAnyPack(nx))) return false
    if ([0, 6, 13, 24].includes(x.value)) return always || others
    return others
  }

  /** Είναι το τμήμα j μονάδα ή συσκευασία; */
  unitAt(j: number): { unit: MeasureUnit | null; pack: string | null } | null {
    const n = this.w(j)
    if (!n) return null
    const u = unitWord(n)
    if (u && isMeasureUnit(u)) return { unit: u, pack: null }
    if (genericPack(n) || this.isAnyPack(n)) return { unit: null, pack: n }
    return null
  }

  /** Ακολουθεί είδος του καταλόγου (ή μονάδα); ("τιμολόγιο 20 μοτσαρέλες") */
  itemFollows(j: number): boolean {
    const s = this.segs[j]
    if (!s || s.t !== 'w') return false
    if (this.unitAt(j)) return true
    if (isStop(s.tok.n) || this.cue[j] || this.chan[j]) return false
    const top = this.m.rank(j, j + 1, this.roles(true), POOL.items)[0]
    return !!top && top.score >= 0.7
  }

  /** "το κιλό", "ανά σακί", "τη μία", "έκαστο" */
  perAt(j: number): { per: Per; len: number } | null {
    const n = this.w(j)
    if (!n) return null
    const asPer = (k: number): Per | null => {
      const u = this.unitAt(k)
      if (u?.unit) return { k: 'unit', unit: u.unit }
      if (u?.pack) return { k: 'pack', n: u.pack }
      const x = this.w(k)
      if (x && EACH.has(x)) return { k: 'each' }
      const nn = this.num(k)
      if (nn && nn.value === 1 && nn.words) return { k: 'each' }
      return null
    }
    if (PER_ART.has(n)) {
      const p = asPer(j + 1)
      if (p) return { per: p, len: 2 }
    }
    if (EACH.has(n) && n !== 'ενα' && n !== 'μια' && n !== 'μιαν') return { per: { k: 'each' }, len: 1 }
    return null
  }

  /** Όλοι οι αριθμοί εκτός οντοτήτων / καταναλωμένων, με τα συνοδευτικά τους */
  numbers(skip: Set<number>): NumInfo[] {
    const out: NumInfo[] = []
    const eaten = new Set<number>()
    for (let i = 0; i < this.segs.length; i++) {
      const s = this.segs[i]
      if (s.t !== 'n' || skip.has(i) || this.used.has(i) || eaten.has(i)) continue
      const info: NumInfo = {
        i, end: i + 1, value: s.value, unit: null, pack: null, qtyEnd: i + 1, money: false, per: null, total: false,
        prep: false, kaiNext: false, words: s.words, half: !!s.half, size: !!s.size, pct: !!s.pct,
      }
      let j = i + 1
      const u = skip.has(j) || this.used.has(j) ? null : this.unitAt(j)
      if (u) { info.unit = u.unit; info.pack = u.pack; j++; info.qtyEnd = j }
      // "ένα κιλό και μισό"
      if (u && this.w(j) === 'και' && this.num(j + 1)?.half) { info.value += 0.5; eaten.add(j + 1); j += 2; info.qtyEnd = j }
      const mw = this.w(j)
      if (mw && MONEY.has(mw)) {
        info.money = true
        j++
        // "4 ευρώ και 50 (λεπτά)"
        const c = this.num(j + 1)
        if (this.w(j) === 'και' && c && c.value < 100 && Number.isInteger(c.value) && !this.unitAt(j + 2)) {
          info.value = round(info.value + c.value / 100)
          eaten.add(j + 1)
          j += 2
          if (this.w(j) && CENTS.has(this.w(j) as string)) j++
        }
      } else if (mw && CENTS.has(mw)) {
        info.money = true
        info.value = round(info.value / 100)
        j++
      }
      const p = this.perAt(j)
      if (p) { info.per = p.per; j += p.len }
      const tw = this.w(j)
      if (tw && TOTAL.has(tw) && !info.unit && !info.pack && !this.filler.has(j)) { info.total = true; j++; if (this.w(j) === 'μαζι') j++ }
      const prev = this.filler.has(i - 1) ? null : this.w(i - 1)
      const prev2 = this.w(i - 2)
      // "σύνολο 155" = τιμή όλης της γραμμής· "σύνολο 10 σακιά" = ποσότητα
      if (prev && !info.unit && !info.pack && (TOTAL.has(prev) || (prev === 'μαζι' && prev2 && TOTAL.has(prev2)))) info.total = true
      if (prev && (PRICE_PREP.has(prev) || this.cue[i - 1] === 'price' || this.cue[i - 1] === 'priceVerb')) info.prep = true
      info.end = j
      info.kaiNext = this.w(j) === 'και' && !!this.num(j + 1)
      out.push(info)
    }
    return out
  }

  /** "τέσσερα και πενήντα" = 4,50 όταν μιλάμε για τιμή */
  mergeCents(nums: NumInfo[], always: boolean): NumInfo[] {
    const out: NumInfo[] = []
    for (let k = 0; k < nums.length; k++) {
      const x = nums[k]
      const y = nums[k + 1]
      if (
        y && x.kaiNext && y.i === x.end + 1 && Number.isInteger(x.value) && Number.isInteger(y.value) &&
        y.value >= 1 && y.value <= 99 && !x.unit && !x.pack && !y.unit && !y.pack && !x.per && !x.money &&
        (always || y.money || y.per || y.total || x.prep || x.total)
      ) {
        out.push({ ...y, i: x.i, value: round(x.value + y.value / 100), prep: x.prep || y.prep, total: x.total || y.total, words: true })
        k++
      } else out.push(x)
    }
    return out
  }

  /** Υπάρχει διαχωριστικό ("," "και") ανάμεσα στα τμήματα [a, b); */
  sepBetween(a: number, b: number): boolean {
    for (let i = a; i < b; i++) {
      const s = this.segs[i]
      if (s.t === 's') return true
      if (s.t === 'w' && (s.tok.n === 'και' || s.tok.n === 'κι' || s.tok.n === 'επισησ' || s.tok.n === 'ακομα')) return true
    }
    return false
  }

  /** Τμήματα που ανήκουν σε οντότητες */
  covered(hits: Hit[]): Set<number> {
    const s = new Set<number>()
    for (const h of hits) for (let i = h.from; i < h.to; i++) s.add(i)
    return s
  }

  heardQty(x: NumInfo): string {
    const r = this.relabel.get(x.i)
    if (r === undefined) return this.heard(x.i, x.qtyEnd)
    return x.qtyEnd > x.i + 1 ? `${r} ${this.heard(x.i + 1, x.qtyEnd)}` : r
  }

  /** Αριθμός που περίσσεψε: προειδοποίηση (εκτός από άρθρα "ένα/μία" και ώρες) */
  lost(x: NumInfo) {
    if (isArticle(x) || isTime(this, x)) return
    this.loose++
    this.issues.push(`Δεν κατάλαβα τι είναι το «${this.heard(x.i, Math.max(x.qtyEnd, x.end))}».`)
  }
}

// ---------------------------------------------------------------------
// Ζευγάρωμα ποσοτήτων / τιμών με είδη
// ---------------------------------------------------------------------
const isPriceNum = (x: NumInfo) => x.money || !!x.per || x.total || x.prep
/** "ένα", "μία" χωρίς μονάδα: μπορεί να είναι απλώς άρθρο */
const isArticle = (x: NumInfo) => x.words && x.value === 1 && !x.unit && !x.pack && !x.money && !x.per && !x.total
/** "στις 10", "τραπέζι 5": όχι ποσότητα ούτε τιμή */
const isTime = (a: Analysis, x: NumInfo) => !x.unit && !x.pack && !x.money && (TIME_PREV.has(a.w(x.i - 1) ?? '') || LABEL_PREV.has(a.w(x.i - 1) ?? ''))

/** Είδη που έχουν αυτή τη συσκευασία ("10 σακιά" χωρίς είδος → αλεύρι) */
function packRanked(a: Analysis, pack: string, pool: Pool): Scored[] {
  const out: Scored[] = []
  for (const e of a.idx.entries) {
    if (!e.item || !isItemPack(pack, e.item)) continue
    const w = pool.item ? pool.item(e.item) : 0
    if (w > 0) out.push({ entry: e, score: 0.8 * w, explained: 1 })
  }
  return out.sort((x, y) => y.score - x.score)
}

/** Ταιριάζει η μονάδα / συσκευασία του αριθμού στο είδος (στους κύριους υποψηφίους του); */
function fitScore(e: Ent, x: NumInfo): number {
  if (!x.unit && !x.pack) return 0
  const r = e.hit.ranked
  const top = r[0]?.score ?? 0
  const its = r.filter((s) => s.entry.item && s.score >= top * 0.6).slice(0, 6).map((s) => s.entry.item as Item)
  if (!its.length) return 0
  const ok = its.some((it) => (x.unit ? convertUnit(1, x.unit, it.unit) !== null : isItemPack(x.pack as string, it)))
  return ok ? 1 : -6
}

/** Λέξεις ανάμεσα σε δύο ποσότητες της ίδιας γραμμής: "και", "και άλλα", "μείον", "στο ψυγείο και" */
function glueWords(a: Analysis, p: number, q: number, ent: Ent | null): { more: boolean; sub: boolean } | null {
  let more = false
  let sub = false
  for (let i = p; i < q; i++) {
    if (ent && i >= ent.from && i < ent.to) continue
    const s = a.segs[i]
    if (s.t !== 'w') return null
    const n = s.tok.n
    if (MORE.has(n) || LOCATION.has(n)) more = true
    else if (MINUS_PRE.has(n)) sub = true
    else if (!(n === 'και' || n === 'κι' || isStop(n))) return null
  }
  return { more, sub }
}

/** x προστίθεται (ή αφαιρείται) στην ποσότητα prev της ίδιας γραμμής; */
function glueFwd(a: Analysis, prev: NumInfo, x: NumInfo, ent: Ent): { sub: boolean } | null {
  if (x.i < prev.end) return null
  const g = glueWords(a, prev.end, x.i, ent)
  if (!g) return null
  const explicit = g.more || g.sub || a.w(x.end) === 'ακομα' || a.w(x.end) === 'επιπλεον'
  if (!x.unit && !x.pack) return explicit ? { sub: g.sub } : null
  if (fitScore(ent, x) < 0) return null
  if (!prev.unit && !prev.pack && !explicit) return null
  if (!explicit && ((x.unit && x.unit === prev.unit) || (x.pack && x.pack === prev.pack))) return null
  return { sub: g.sub }
}

/** "3 κιλά και 200 γραμμάρια μοτσαρέλα": η x ενώνεται με την επόμενη ποσότητα */
function glueBack(a: Analysis, x: NumInfo, next: NumInfo, ent: Ent): boolean {
  if (x.end >= next.i) return false
  for (let i = x.end; i < next.i; i++) { const n = a.w(i); if (n !== 'και' && n !== 'κι') return false }
  if (!(x.unit || x.pack) || !(next.unit || next.pack)) return false
  if ((x.unit && x.unit === next.unit) || (x.pack && x.pack === next.pack)) return false
  return fitScore(ent, x) >= 0 && fitScore(ent, next) >= 0
}

/**
 * Ποσότητες σε είδη: δυναμικός προγραμματισμός πάνω στα είδη. Κάθε είδος
 * παίρνει τον αριθμό ακριβώς πριν ("3 μαργαρίτες") ή ακριβώς μετά
 * ("μοτσαρέλα 6 κιλά") ή κανέναν. Κερδίζει η επιλογή που δίνει ποσότητα σε
 * περισσότερα είδη, με ταιριαστές μονάδες, συνεπή κατεύθυνση και χωρίς
 * αριθμούς που περισσεύουν. Επιστρέφει τους αριθμούς που μπήκαν.
 */
function assignQty(a: Analysis, ents: Ent[], lines: Line[], qn: NumInfo[], priced: boolean): Set<NumInfo> {
  const k = ents.length
  const gaps: NumInfo[][] = Array.from({ length: k + 1 }, () => [])
  for (const x of qn) {
    let g = 0
    while (g < k && ents[g].to <= x.i) g++
    gaps[g].push(x)
  }
  const preOf = (g: number) => gaps[g][gaps[g].length - 1] ?? null
  const postOf = (g: number) => gaps[g + 1][0] ?? null
  const assignScore = (g: number, c: number): number => {
    if (c === 0) return 0
    const e = ents[g]
    const x = c === 1 ? preOf(g) : postOf(g)
    if (!x) return -Infinity
    let v = 10 + fitScore(e, x)
    if (c === 1) {
      v += 0.1
      if (a.sepBetween(x.end, e.from)) v -= 3
      if (a.contentBetween(x.end, e.from)) v -= 2
    } else {
      if (a.sepBetween(e.to, x.i)) v -= 3
      if (a.contentBetween(e.to, x.i)) v -= 2
      if (isArticle(x) && a.isPlainWord(x.end)) v -= 3
    }
    return v
  }
  /** αριθμοί του κενού g που κολλάνε σε γειτονική ποσότητα */
  const gapGlue = (g: number, cPrev: number, cCur: number, usedIdx: Set<number>): Set<number> => {
    const L = gaps[g]
    const glued = new Set<number>()
    if (g > 0 && cPrev) {
      let last: NumInfo | null = cPrev === 2 ? L[0] : preOf(g - 1)
      let j = cPrev === 2 ? 1 : 0
      while (last && j < L.length && !usedIdx.has(j) && glueFwd(a, last, L[j], ents[g - 1])) { glued.add(j); last = L[j]; j++ }
    }
    if (g < k && cCur === 1) {
      let next = L[L.length - 1]
      let j = L.length - 2
      while (j >= 0 && !usedIdx.has(j) && !glued.has(j) && glueBack(a, L[j], next, ents[g])) { glued.add(j); next = L[j]; j-- }
    }
    return glued
  }
  const gapCost = (g: number, cPrev: number, cCur: number): number => {
    const L = gaps[g]
    if (!L.length) return 0
    const usedIdx = new Set<number>()
    if (g > 0 && cPrev === 2) usedIdx.add(0)
    if (g < k && cCur === 1) {
      if (usedIdx.has(L.length - 1)) return -Infinity
      usedIdx.add(L.length - 1)
    }
    const glued = gapGlue(g, cPrev, cCur, usedIdx)
    let cost = 0
    L.forEach((x, j) => {
      if (usedIdx.has(j)) return
      if (glued.has(j)) cost -= 0.3
      else cost -= isArticle(x) || isTime(a, x) ? 0.5 : priced && g > 0 ? 1 : 4
    })
    return cost
  }
  const switchCost = (g: number, cPrev: number, cCur: number): number => {
    if (!cPrev || !cCur || cPrev === cCur) return 0
    if (cPrev === 2 && cCur === 1) {
      const L = gaps[g]
      return a.sepBetween(L[0].end, L[L.length - 1].i) ? -0.2 : -1
    }
    return -1.5
  }
  const NEG = -1e9
  let f = [0, NEG, NEG]
  const back: number[][] = []
  for (let g = 0; g < k; g++) {
    const nf = [NEG, NEG, NEG]
    const bk = [0, 0, 0]
    for (let c = 0; c < 3; c++) {
      const as = assignScore(g, c)
      if (as === -Infinity) continue
      for (let cp = 0; cp < 3; cp++) {
        if (f[cp] <= NEG / 2) continue
        const gc = gapCost(g, g === 0 ? 0 : cp, c)
        if (gc === -Infinity) continue
        const v = f[cp] + as + gc + (g > 0 ? switchCost(g, cp, c) : 0)
        if (v > nf[c]) { nf[c] = v; bk[c] = cp }
      }
    }
    f = nf
    back.push(bk)
  }
  let bc = 0
  let best = NEG
  for (let c = 0; c < 3; c++) {
    if (f[c] <= NEG / 2) continue
    const v = f[c] + gapCost(k, c, 0)
    if (v > best) { best = v; bc = c }
  }
  const choice = new Array<number>(k).fill(0)
  for (let g = k - 1; g >= 0; g--) { choice[g] = bc; bc = back[g][bc] }

  const used = new Set<NumInfo>()
  choice.forEach((c, g) => {
    const x = c === 1 ? preOf(g) : c === 2 ? postOf(g) : null
    if (x) { lines[g].qty = x; used.add(x) }
  })
  // κόλλημα πρόσθετων ποσοτήτων με τους ίδιους κανόνες
  for (let g = 0; g <= k; g++) {
    const L = gaps[g]
    if (!L.length) continue
    const cPrev = g > 0 ? choice[g - 1] : 0
    const cCur = g < k ? choice[g] : 0
    if (g > 0 && cPrev) {
      const line = lines[g - 1]
      let last = cPrev === 2 ? L[0] : (preOf(g - 1) as NumInfo)
      let j = cPrev === 2 ? 1 : 0
      while (j < L.length && !used.has(L[j])) {
        const gl = glueFwd(a, last, L[j], ents[g - 1])
        if (!gl) break
        const x = L[j]
        const add: NumInfo = x.unit || x.pack ? { ...x } : { ...x, unit: last.unit, pack: last.pack }
        if (gl.sub) add.neg = true
        line.more = [...(line.more ?? []), add]
        used.add(x)
        last = x
        j++
      }
    }
    if (g < k && cCur === 1) {
      const line = lines[g]
      const prim = line.qty as NumInfo
      const before: NumInfo[] = []
      let next = prim
      let j = L.length - 2
      while (j >= 0 && !used.has(L[j]) && glueBack(a, L[j], next, ents[g])) { before.unshift(L[j]); used.add(L[j]); next = L[j]; j-- }
      if (before.length) {
        line.qty = before[0]
        line.more = [...before.slice(1), prim, ...(line.more ?? [])]
      }
    }
  }
  return used
}

/** Είδη με αυτόν τον αριθμό στο όνομα, από την ίδια "οικογένεια" με τις άλλες γραμμές ("12 των 400") */
function sizeFamily(a: Analysis, v: number, lines: Line[], pool: Pool): Scored[] {
  const keysOf = (e: Scored['entry']) => new Set(e.forms.flatMap((f) => f.toks.filter((t) => t.k === 'w').map((t) => t.key)))
  const fams = lines.map((l) => l.ent.hit.ranked[0]?.entry).filter(Boolean).map((e) => keysOf(e as Scored['entry']))
  const out: Scored[] = []
  for (const ei of a.idx.nums.get(v) ?? []) {
    const e = a.idx.entries[ei]
    if (!e.item || !pool.item || pool.item(e.item) <= 0) continue
    const ks = keysOf(e)
    if (fams.some((f) => [...ks].some((x) => f.has(x)))) out.push({ entry: e, score: 0.9, explained: 1 })
  }
  return out
}

/** Αριθμός που μοιάζει με τιμή σε εντολή χωρίς τιμές ("18 ευρώ", "κάνουν 16", "12,50") */
const priceish = (x: NumInfo, tally: boolean) =>
  x.money || !!x.per || x.prep || x.total || (tally && !Number.isInteger(x.value) && !x.unit && !x.pack)

function pairLines(a: Analysis, known: Ent[], unknown: Ent[], nums: NumInfo[], priced: boolean, pool: Pool, tally = false): Line[] {
  const ents = known.slice().sort((x, y) => x.from - y.from)
  const lines: Line[] = ents.map((e) => ({ ent: e, qty: null, price: null }))
  // "60 σπέσιαλ κατεψυγμένες 3,90": δεκαδικός χωρίς μονάδα δίπλα σε είδος σε τεμάχια = τιμή
  const unitOfNear = (x: NumInfo) => {
    let near: Ent | undefined
    for (const e of ents) if (e.to <= x.i) near = e
    near = near ?? ents.find((e) => e.from >= x.end)
    return near?.hit.ranked[0]?.entry.item?.unit ?? null
  }
  const looksPrice = (x: NumInfo) =>
    isPriceNum(x) || (!Number.isInteger(x.value) && !x.unit && !x.pack && !x.half && unitOfNear(x) === 'τεμ')
  const qn = nums.filter((x) => !x.size && !x.pct && !(priced && looksPrice(x)) && !(!priced && priceish(x, tally)))
  const pn = priced ? nums.filter((x) => !x.size && !x.pct && looksPrice(x)) : []
  const used = lines.length ? assignQty(a, ents, lines, qn, priced) : new Set<NumInfo>()
  const left = qn.filter((x) => !used.has(x))
  // "25 ζυμάρια των 250 και 12 των 400": δεύτερη γραμμή μόνο με το μέγεθος
  const extra: Line[] = []
  for (const x of left.slice()) {
    if (x.unit || x.pack || !left.includes(x)) continue
    let j = x.end
    while (['των', 'του', 'τησ', 'τα', 'τισ', 'τουσ', 'απο'].includes(a.w(j) ?? '')) j++
    if (j === x.end) continue
    const y = left.find((n) => n.i === j && !n.unit && !n.pack && n !== x)
    if (!y) continue
    const fam = sizeFamily(a, y.value, lines, pool)
    if (!fam.length) continue
    const hit: Hit = { from: x.end, to: y.end, heard: a.heard(x.end, y.end), ranked: fam }
    extra.push({ ent: { from: x.end, to: y.end, hit, unknown: false }, qty: x, price: null })
    left.splice(left.indexOf(x), 1)
    left.splice(left.indexOf(y), 1)
  }
  // περισσευούμενοι αριθμοί: σε λέξεις που δεν βρέθηκαν ("δύο καλτσόνε")
  let rest: NumInfo[] = []
  const free = unknown.slice()
  const between = (p: number, q: number) => {
    for (let i = p; i < q; i++) {
      const s = a.segs[i]
      if (s.t === 's') return false
      if (s.t === 'w' && !isStop(s.tok.n) && !unitWord(s.tok.n) && !a.unitAt(i)) return false
      if (s.t === 'n') return false
    }
    return true
  }
  for (const x of left.sort((p, q) => p.i - q.i)) {
    let ui = free.findIndex((u) => u.from >= x.end && between(x.end, u.from))
    if (ui < 0) ui = free.findIndex((u) => u.to <= x.i && between(u.to, x.i))
    if (ui >= 0 && !(isArticle(x) && free[ui].to <= x.i && a.isPlainWord(x.end))) {
      extra.push({ ent: free[ui], qty: x, price: null })
      free.splice(ui, 1)
    } else if (x.pack && packRanked(a, x.pack, pool).length) {
      const hit: Hit = { from: x.i, to: x.qtyEnd, heard: a.heard(x.qtyEnd - 1, x.qtyEnd), ranked: packRanked(a, x.pack, pool), unknown: true }
      extra.push({ ent: { from: x.i, to: x.qtyEnd, hit, unknown: true }, qty: x, price: null })
    } else rest.push(x)
  }
  const all = lines.concat(extra).sort((p, q) => p.ent.from - q.ent.from)
  if (priced && all.length) {
    // αριθμός χωρίς "ευρώ" μετά από γραμμή με ποσότητα = τιμή ("10 κιλά μοτσαρέλα 7")·
    // πριν από τα είδη ή "ένα/μία" ή "στις 10" δεν είναι τιμή
    const asPrice = rest.filter((x) => !isArticle(x) && !isTime(a, x) && all.some((l) => l.qty && l.ent.to <= x.i && l.qty.i < x.i))
    rest = rest.filter((x) => !asPrice.includes(x))
    const prices = pn.concat(a.mergeCents(asPrice.sort((p, q) => p.i - q.i), true)).sort((p, q) => p.i - q.i)
    const lastEnd = Math.max(...all.map((l) => Math.max(l.ent.to, l.qty?.end ?? 0)))
    for (const p of prices) {
      // "σύνολο 400" στο τέλος πολλών γραμμών: για όλο το τιμολόγιο, δεν μοιράζεται
      if (p.total && all.length > 1 && p.i >= lastEnd && all.every((l) => !l.price)) {
        a.issues.push(`Το σύνολο ${fmtMoney(p.value)} είναι για όλο το τιμολόγιο; Δεν το μοίρασα στα είδη.`)
        a.cap = Math.min(a.cap, 0.7)
        continue
      }
      // τιμές: στο είδος αριστερά (που δεν έχει τιμή), αλλιώς δεξιά
      let target: Line | null = null
      for (const l of all) if (l.ent.to <= p.i && !l.price) target = l
      if (!target) target = all.find((l) => l.ent.from >= p.end && !l.price) ?? null
      if (target) target.price = p
      else a.lost(p)
    }
  }
  if (all.length) for (const x of rest) a.lost(x)
  // τιμή σε εντολή χωρίς τιμές: ο μετρητής το λέει μόνος του, οι άλλες ως αριθμό που περισσεύει
  if (!priced && !tally && all.length) for (const x of nums) if (!x.size && !x.pct && priceish(x, false)) a.lost(x)
  return all
}

/** Ποσότητα γραμμής (με τις επιπλέον ποσότητες) στη μονάδα του είδους */
function lineQty(a: Analysis, l: Line, item: Item | null, label: string): number | null {
  const q = qtyFor(a, l.qty, item, label)
  if (q === null || !l.more?.length) return q
  return round(l.more.reduce((s, x) => s + (x.neg ? -1 : 1) * (qtyFor(a, x, item, label) ?? 0), q), 6)
}

function lineHeardQty(a: Analysis, l: Line): string | undefined {
  if (!l.qty) return undefined
  let s = a.heardQty(l.qty)
  for (const x of l.more ?? []) s += (x.neg ? ' μείον ' : ' και ') + a.heardQty(x)
  return s
}

/** Ποσότητα στη μονάδα του είδους */
function qtyFor(a: Analysis, x: NumInfo | null, item: Item | null, label: string): number | null {
  if (!x) return null
  let v = x.value
  if (x.unit && item) {
    const c = convertUnit(v, x.unit, item.unit)
    if (c === null) a.issues.push(`Το «${label}» μετριέται σε ${item.unit}· δεν μετέτρεψα τα «${a.heardQty(x)}».`)
    else v = c
  } else if (x.pack && item) {
    const pq = Number(item.pack_qty)
    if (isItemPack(x.pack, item) && pq > 0) v = round(v * pq, 6)
    else a.issues.push(`Δεν ξέρω πόσο έχει το «${x.pack}» για «${label}»· πέρασα ${v}.`)
  }
  return round(v, 6)
}

const UNIT_LABEL: Record<string, string> = { kg: 'κιλό', g: 'γραμμάριο', L: 'λίτρο', ml: 'ml', τεμ: 'τεμάχιο' }

/**
 * Τιμή χωρίς "το κιλό" / "σύνολο": ανά μονάδα, ανά συσκευασία ή σύνολο γραμμής;
 * Με μέσο κόστος (αγορά) ή τιμή πώλησης (πώληση): το πιο κοντινό. Χωρίς
 * αναφορά: κανόνας + προειδοποίηση που λέει πώς διαβάστηκε.
 */
function guessPrice(a: Analysis, l: Line, item: Item, qty: number, v: number, ref: Item | null, kind: 'cost' | 'sale'): number {
  const x = l.qty
  const pq = Number(item.pack_qty)
  const inPacks = !!x?.pack && pq > 0 && isItemPack(x.pack, item)
  const iu: MeasureUnit = isMeasureUnit(item.unit) ? item.unit : 'τεμ'
  let perNat: number
  let nNat: number
  let natLabel: string
  if (inPacks) {
    perNat = v / pq
    nNat = qty / pq
    natLabel = item.pack_name ?? 'συσκευασία'
  } else {
    let u: MeasureUnit = x?.unit ?? iu
    if (u === 'g') u = 'kg'
    if (u === 'ml') u = 'L'
    if (convertUnit(1, u, iu) === null) u = iu
    const f = convertUnit(1, iu, u) ?? 1
    perNat = v * f
    nNat = qty * f
    natLabel = UNIT_LABEL[u] ?? u
  }
  const total = v / qty
  const opts = [perNat, total]
  if (inPacks || perNat !== v) opts.push(v)
  const refV = ref ? Number(kind === 'sale' ? ref.sale_price : ref.avg_cost) : 0
  const label = item.name
  if (refV > 0) {
    const dist = (y: number) => Math.abs(Math.log(y / refV))
    const best = opts.reduce((b, y) => (y > 0 && dist(y) < dist(b) ? y : b), opts[0])
    if (dist(best) > Math.log(3)) {
      a.issues.push(`Η τιμή για «${label}» (${fmtCost(best)} ανά ${UNIT_LABEL[iu] ?? iu}) είναι μακριά από τη συνηθισμένη (${fmtCost(refV)}).`)
      a.cap = Math.min(a.cap, 0.8)
    }
    return best
  }
  // "προς 7,20": τιμή μονάδας
  if (x?.prep || l.price?.prep || Math.abs(nNat - 1) < 1e-9) return perNat
  let pick: number
  if (nNat < 1) pick = total
  else if (inPacks && v < 5) pick = v
  else if (Number.isInteger(v) && (v >= 3 * nNat || v * nNat > 1000)) pick = total
  else pick = perNat
  const unitTxt = UNIT_LABEL[iu] ?? iu
  if (pick === total) {
    a.issues.push(`Για «${label}» πήρα τα ${fmtMoney(v)} ως σύνολο (${fmtCost(total)} ανά ${unitTxt}).`)
    a.cap = Math.min(a.cap, 0.85)
  } else if (Number.isInteger(v) && v >= nNat) {
    // "2 κιλά μαγιά 3 ευρώ": θα μπορούσε να είναι και σύνολο
    a.issues.push(`Για «${label}» πήρα τα ${fmtCost(v)} ανά ${pick === v && pick !== perNat ? unitTxt : natLabel}· αν είναι σύνολο, διόρθωσέ το.`)
    a.cap = Math.min(a.cap, 0.9)
  }
  return pick
}

/** Τιμή ανά μονάδα είδους, χωρίς ΦΠΑ */
function priceFor(a: Analysis, l: Line, item: Item | null, qty: number | null, ref: Item | null, kind: 'cost' | 'sale'): number | null {
  const p = l.price
  if (!p) return null
  let v = p.value
  if (p.total) {
    if (!qty) return null
    v = v / qty
  } else if (p.per?.k === 'unit' && item) {
    const f = convertUnit(1, isMeasureUnit(item.unit) ? item.unit : 'τεμ', p.per.unit)
    if (f !== null) v = v * f
  } else if (p.per?.k === 'pack' && item) {
    const pq = Number(item.pack_qty)
    if (pq > 0) v = v / pq
  } else if (!p.per && item && qty) {
    v = guessPrice(a, l, item, qty, v, ref, kind)
  }
  if (a.gross && item) v = v / (1 + Number(item.vat_rate ?? 0) / 100)
  return round(v)
}

// ---------------------------------------------------------------------
// Βοηθητικά για EntityRef
// ---------------------------------------------------------------------
const onlyKind = (r: Scored[], k: 'item' | 'partner') => r.filter((s) => s.entry.kind === k)
const topKind = (h: Hit) => h.ranked[0]?.entry.kind ?? null

function itemRef(h: Hit): EntityRef {
  return toRef(h.heard, onlyKind(h.ranked, 'item'))
}

function partnerRef(h: Hit): EntityRef {
  return toRef(h.heard, onlyKind(h.ranked, 'partner'))
}

function itemById(a: Analysis, id: string | null): Item | null {
  return id ? a.items.find((i) => i.id === id) ?? null : null
}

/** Είδη των υποψηφίων μιας αναφοράς */
function candItems(a: Analysis, r: EntityRef): Item[] {
  return r.candidates.map((c) => itemById(a, c.id)).filter((x): x is Item => !!x)
}

/**
 * Είδος για τη μετατροπή μονάδων όταν δεν ξέρουμε ακόμα ποιο είναι: όλοι οι
 * υποψήφιοι έχουν την ίδια μονάδα (και την ίδια συσκευασία). Αλλιώς null.
 */
function unitItem(a: Analysis, r: EntityRef, l: Line): Item | null {
  const xs = [l.qty, ...(l.more ?? [])].filter((x): x is NumInfo => !!x)
  if (!xs.some((x) => x.unit || x.pack)) return null
  const cs = candItems(a, r)
  if (!cs.length || !cs.every((c) => c.unit === cs[0].unit)) return null
  for (const x of xs) {
    if (x.pack && !cs.every((c) => isItemPack(x.pack as string, c) && Number(c.pack_qty) === Number(cs[0].pack_qty))) return null
  }
  return cs[0]
}

/** Αναφορά χωρίς είδος με μονάδα που ίσως θέλει μετατροπή: προειδοποίηση */
function unitIssue(a: Analysis, r: EntityRef, l: Line, item: Item | null) {
  if (item || r.id || !l.qty || !(l.qty.unit || l.qty.pack)) return
  a.issues.push(`«${r.heard || '?'}»: έλεγξε την ποσότητα όταν διαλέξεις είδος (ακούστηκε «${lineHeardQty(a, l)}»).`)
}

/** Προειδοποίηση για αναφορά χωρίς σίγουρο id */
function refIssue(a: Analysis, r: EntityRef, what: string) {
  if (r.id) return
  if (!r.heard) {
    if (r.candidates.length > 1) a.issues.push(`Ποιο από: ${r.candidates.slice(0, 3).map((c) => c.name).join(' ή ')};`)
    else a.issues.push(`Δεν ακούστηκε ${what}.`)
    return
  }
  if (!r.candidates.length) a.issues.push(`Δεν βρέθηκε «${r.heard}».`)
  else if (r.candidates.length === 1) a.issues.push(`«${r.heard}»: εννοείς ${r.candidates[0].name};`)
  else a.issues.push(`«${r.heard}»: εννοείς ${r.candidates.slice(0, 3).map((c) => c.name).join(' ή ')};`)
}

function refConf(r: EntityRef): number {
  if (r.id) return 1
  return r.candidates.length ? 0.5 : 0.3
}

function hitsToEnts(hits: Hit[], unknown = false): Ent[] {
  return hits.map((h) => ({ from: h.from, to: h.to, hit: h, unknown }))
}

/** Συναλλασσόμενος: από τις φράσεις, ή από λέξεις που δεν βρέθηκαν */
function pickPartner(a: Analysis, hits: Hit[], unknown: Hit[], usedUnknown: Set<Hit>, what: string): EntityRef {
  const ph = hits.filter((h) => topKind(h) === 'partner')
  if (ph.length) {
    const best = ph.slice().sort((x, y) => (y.ranked[0]?.score ?? 0) - (x.ranked[0]?.score ?? 0))[0]
    const r = partnerRef(best)
    refIssue(a, r, what)
    return r
  }
  const u = unknown.find((h) => !usedUnknown.has(h))
  if (u) {
    const r = toRef(u.heard, onlyKind(u.ranked, 'partner'))
    refIssue(a, r, what)
    return r
  }
  a.issues.push(`Δεν ακούστηκε ${what}.`)
  return emptyRef()
}

// ---------------------------------------------------------------------
// Απόφαση εντολής
// ---------------------------------------------------------------------
type Kind = Command['kind']

interface Decision {
  kind: Kind
  conf: number
  /** εξήγηση για τον χρήστη (π.χ. γιατί δεν καταλάβαμε) */
  issue?: string
}

const unknownBecause = (issue: string): Decision => ({ kind: 'unknown', conf: 0, issue })

/** "θα έρθουν", "να παραγγείλουμε", "για αύριο": κάτι που δεν έγινε ακόμα */
function future(a: Analysis): boolean {
  const T = new Set<Cue>(TRADE)
  for (let i = 0; i < a.segs.length; i++) {
    const w = a.w(i)
    if (w !== 'θα' && w !== 'να') continue
    let j = i + 1
    while (CLITIC.has(a.w(j) ?? '')) j++
    const c = a.cue[j]
    if (c && T.has(c)) return true
  }
  const later = a.segs.some((_s, i) => a.w(i) === 'αυριο' || a.w(i) === 'μεθαυριο')
  const today = a.segs.some((_s, i) => a.w(i) === 'σημερα')
  return later && !today && a.cue.some((c) => !!c && (T.has(c) || c === 'recipeVerb' || c === 'want'))
}

/** Λέξη που δεν βρέθηκε και μοιάζει με ρήμα ("χάλασαν", "κερνάμε") */
function unknownVerb(a: Analysis, unknown: Hit[]): string | null {
  for (const h of unknown) {
    for (let i = h.from; i < h.to; i++) {
      const w = a.w(i)
      if (w && w.length >= 4 && !a.cue[i] && !KNOWN_VERBS.has(w) && VERB_END.test(w)) return (a.segs[i] as { tok: Tok }).tok.raw
    }
  }
  return null
}

/** Πρώτο ρήμα συνταγής ("έχει", "θέλει", "θέλω" ...) */
function recipeVerbAt(a: Analysis): number {
  for (let i = 0; i < a.segs.length; i++) if (a.cue[i] === 'recipeVerb' || a.cue[i] === 'want') return i
  return -1
}

function decideKind(a: Analysis): Decision {
  const has = (...c: Cue[]) => a.has(...c)
  if (a.contentCount() === 0 && !a.cue.some(Boolean) && !a.hasChannel()) return { kind: 'unknown', conf: 0 }
  const txt = a.toks.filter((t) => !t.sep).map((t) => t.n).join(' ')
  if (has('help') || /(^| )τι (μπορω|λεω|να πω|ξερεισ|κανω|κανουμε)( |$)/.test(txt) || /πωσ (δουλευ|λειτουργ)/.test(txt)) return { kind: 'help', conf: 0.95 }
  const nums = a.segs.some((s, i) => s.t === 'n' && !a.used.has(i))
  if (/(^| )(γυρνα|γυρισε|γυρνα) πισω( |$)/.test(txt) && !nums) return { kind: 'undo', conf: 0.85 }
  // κλεισίματα
  if (has('close')) {
    const day = has('dayNoun', 'today') || (has('sell') && !nums)
    const di = a.cue.findIndex((c) => c === 'dayNoun' || c === 'today')
    const si = a.at('stocktakeNoun')
    if (si >= 0 && day) {
      const dayFirst = di >= 0 && di < si
      return {
        kind: dayFirst ? 'close_day' : 'close_stocktake',
        conf: 0.7,
        issue: `Ένα κλείσιμο τη φορά· μετά πες «${dayFirst ? 'κλείσε την απογραφή' : 'κλείσε τη μέρα'}».`,
      }
    }
    if (si >= 0) return { kind: 'close_stocktake', conf: 0.95 }
    if (day) return { kind: 'close_day', conf: 0.95 }
    if (!nums && a.contentCount() <= 1 && /^(κλεισ|τελοσ)/.test(txt)) {
      if (a.hasChannel()) return unknownBecause('Το κλείσιμο ημέρας γίνεται για όλα τα κανάλια μαζί· πες «κλείσε τη μέρα».')
      return unknownBecause('Πες «κλείσε τη μέρα» ή «κλείσε την απογραφή».')
    }
  }
  // αναίρεση (πριν από το "νέο": "ακύρωσε τη νέα πίτσα")
  const ui = a.at('undo')
  const ni = a.at('new')
  if (ui >= 0 && (ni < 0 || ui < ni)) {
    if (/τελευται/.test(txt)) return { kind: 'undo', conf: 0.95 }
    // "ακύρωσε μία μαργαρίτα (από το efood)": αφαίρεση από τον μετρητή, όχι αναίρεση
    const sc = a.scan(POOL.saleTally, true)
    const numAfter = a.segs.some((s, i) => s.t === 'n' && i > ui && !a.used.has(i))
    if (sc.hits.some((h) => h.from > ui) || (sc.hits.length && numAfter)) return { kind: 'sale_tally', conf: 0.75 }
    if (nums) return unknownBecause('Για αναίρεση πες «ακύρωσε το τελευταίο».')
    return { kind: 'undo', conf: 0.85 }
  }
  if (has('wrong') && a.contentCount() <= 1) return { kind: 'undo', conf: 0.7 }
  // νέο είδος / συναλλασσόμενος: "νέο" στην αρχή ή πριν από λέξη τύπου
  if (ni >= 0 && newIsCommand(a, ni) && !has('order', 'sell', 'buy', 'take1', 'produce', 'count')) {
    if (has('customerWord', 'supplierWord')) return { kind: 'new_partner', conf: 0.9 }
    return { kind: 'new_item', conf: has('typeRaw', 'typeSemi', 'typeFinished', 'pizza') || /νε(α|εσ) πρωτ(η|εσ) υλ/.test(txt) ? 0.9 : 0.7 }
  }
  // πράγματα που δεν είναι καταχωρήσεις
  if (has('waste')) return unknownBecause('Φύρα, κεράσματα και φαγητό προσωπικού δεν περνιούνται από εδώ.')
  if (has('ret')) return unknownBecause('Οι επιστροφές δεν περνιούνται από εδώ.')
  if (!a.has('question') && future(a)) return unknownBecause('Αυτό δεν έχει γίνει ακόμα· πες το όταν γίνει.')
  if (has('ordered') && !a.hasChannel()) return unknownBecause('Οι παραγγελίες δεν περνιούνται· πες το όταν έρθουν ή όταν παραδοθούν.')

  // προκαταρκτικός εντοπισμός οντοτήτων
  let pre = a.scan(POOL.all, true)
  // "στον πάγκο μοτσαρέλα άλλα 2 κιλά": ο πάγκος είναι χώρος (όχι το κανάλι
  // «μαγαζί») όταν δεν ακούστηκε έτοιμο είδος
  if (a.counterOnly() && !pre.hits.some((h) => topKind(h) === 'item' && isFin(h.ranked[0].entry.item as Item))) {
    a.counterAsRoom()
    pre = a.scan(POOL.all, true)
  }
  const ph = pre.hits.filter((h) => topKind(h) === 'partner' && (h.ranked[0]?.score ?? 0) >= 0.6)
  const ih = pre.hits.filter((h) => topKind(h) === 'item')
  const partner = ph[0]?.ranked[0]?.entry.partner ?? null
  const itemsOf = ih.map((h) => h.ranked[0].entry.item as Item)
  const moneyNum = a.segs.some((s, i) => s.t === 'n' && !a.used.has(i) && (MONEY.has(a.w(i + 1) ?? '') || CENTS.has(a.w(i + 1) ?? '')))
  const isCustomer = !!partner?.is_customer
  const isSupplier = !!partner?.is_supplier
  const cov = a.covered(pre.hits)
  const free = a.segs.map((s, i) => s.t === 'n' && !a.used.has(i) && !cov.has(i) && !s.pct && !s.size)
  const freeNums = free.some(Boolean)
  // ποσότητα: με μονάδα / συσκευασία ή ακριβώς πριν από είδος ("2 σπέσιαλ")
  const qtyNum = free.some((f, i) => {
    if (!f || MONEY.has(a.w(i + 1) ?? '') || CENTS.has(a.w(i + 1) ?? '')) return false
    if (a.unitAt(i + 1)) return true
    let j = i + 1
    while (j < a.segs.length && a.w(j) && isStop(a.w(j) as string) && a.w(j) !== 'για') j++
    return ih.some((h) => h.from === j)
  })
  const allFin = itemsOf.length > 0 && itemsOf.every(isFin)
  /** πίτσες κατά παραγγελία: δεν έχουν απόθεμα, άρα πωλήσεις */
  const mtoHeard = itemsOf.some((it) => isFin(it) && it.make_to_order)
  const sellPresent = a.toks.some((t) => SELL_PRESENT.has(t.n))

  // ερωτήσεις
  // "πόσο κάνει η μαργαρίτα;", "πόσο πουλάμε τη μαργαρίτα": ερώτηση τιμής (δεν αλλάζει τιμή)
  if (has('question') && (has('priceVerb', 'price') || sellPresent) && !has('owe1', 'owe3', 'today')) return { kind: 'unknown', conf: 0 }
  const asked = has('question') || a.toks.some((t) => t.raw === '?' || t.raw === ';' || t.raw === ';')
  if ((asked && has('sell')) || has('turnover') || /(^| )πωσ παμε( |$)/.test(txt)) {
    if (!qtyNum) return { kind: 'query_today', conf: 0.85 }
  }
  if (has('today') && !nums && !ih.length && !ph.length) return { kind: 'query_today', conf: 0.8 }
  if (has('runOut') && ih.length) return { kind: 'query_stock', conf: 0.8 }
  if (asked && !freeNums && has('have', 'remain', 'stockNoun') && ih.length) return { kind: 'query_stock', conf: 0.85 }
  // "έχουμε μοτσαρέλα" (χωρίς ποσότητα· η αναγνώριση φωνής δεν βάζει ερωτηματικό)
  if (!freeNums && has('have', 'remain') && ih.length && !has('count', 'stocktakeNoun')) return { kind: 'query_stock', conf: 0.6 }
  if (has('question', 'owe1', 'owe3') || (has('balance', 'stockNoun') && !nums)) {
    if (has('owe1', 'owe3') || (has('balance') && ph.length)) return { kind: 'query_balance', conf: 0.9 }
    if (has('today') && !ih.length) return { kind: 'query_today', conf: 0.9 }
    if (has('sell') && !ih.length) return { kind: 'query_today', conf: 0.8 }
    if (has('today') && ih.length) return { kind: 'query_today', conf: 0.7 }
    if (ih.length) return { kind: 'query_stock', conf: 0.9 }
    if (ph.length) return { kind: 'query_balance', conf: 0.75 }
    if (asked && a.hasChannel()) return { kind: 'query_today', conf: 0.7 }
    if (has('stockNoun', 'remain', 'have')) return { kind: 'query_stock', conf: 0.5 }
    if (has('question') && has('pizza')) return { kind: 'query_today', conf: 0.6 }
  }
  // συνταγή
  const noQty = 'Πες και τις ποσότητες, π.χ. «η μαργαρίτα θέλει ένα ζυμάρι 250 και 120 γραμμάρια μοτσαρέλα».'
  if (has('recipe')) return freeNums ? { kind: 'recipe', conf: 0.9 } : unknownBecause(noQty)
  const rv = recipeVerbAt(a)
  if (rv >= 0) {
    const before = pre.hits.filter((h) => h.to <= rv)
    const after = ih.filter((h) => h.from > rv)
    // υποκείμενο: το πρώτο έτοιμο/ημιέτοιμο ή ο πρώτος συναλλασσόμενος πριν από το ρήμα
    const subj = before.find((h) => topKind(h) === 'partner' || h.ranked[0].entry.item?.item_type !== 'raw')
    if (a.cue[rv] === 'want') {
      // "για 20 ζυμάρια θέλω 3 κιλά αλεύρι": συνταγή· "θέλω 10 σακιά": ανάγκη
      let j = subj ? subj.from - 1 : -1
      while (j >= 0 && (a.num(j) || (a.w(j) && isStop(a.w(j) as string) && a.w(j) !== 'για'))) j--
      if (subj && topKind(subj) === 'item' && after.length && a.w(j) === 'για') return freeNums ? { kind: 'recipe', conf: 0.8 } : unknownBecause(noQty)
      if (a.w(rv + 1) !== 'να' && (ih.length || freeNums)) return unknownBecause('Ανάγκες και παραγγελίες δεν περνιούνται· πες το όταν έρθουν.')
    } else {
      if (subj && topKind(subj) === 'item' && after.length) return freeNums ? { kind: 'recipe', conf: 0.85 } : unknownBecause(noQty)
      if (subj && topKind(subj) === 'partner' && after.length) {
        const afterNum = a.segs.some((s, i) => s.t === 'n' && i > after[0].from)
        const beforeNum = a.segs.some((s, i) => s.t === 'n' && i > rv && i < after[0].from)
        if (afterNum && !beforeNum) return { kind: 'partner_price', conf: 0.8 }
        if (beforeNum) return { kind: 'sale', conf: 0.65 }
      }
    }
  }
  // τιμές
  const trade = has(...TRADE)
  if (has('relPrice') && !trade && ih.length && (has('price', 'priceVerb') || moneyNum || nums)) {
    return unknownBecause('Πες την καινούργια τιμή, π.χ. «η μαργαρίτα κάνει 9 ευρώ».')
  }
  // "2 μαργαρίτες κάνουν 16", "2 μαργαρίτες 18 ευρώ": ποσότητα πριν από το είδος → πώληση, όχι αλλαγή τιμής
  const first = ih[0]
  const qtyBefore = !!first && a.segs.some((s, i) => s.t === 'n' && !a.used.has(i) && i < first.from && !MONEY.has(a.w(i + 1) ?? ''))
  if (has('price', 'priceVerb') && !trade) {
    if (!ph.length && qtyBefore) return { kind: 'sale_tally', conf: 0.6 }
    if (a.hasChannel()) return { kind: ph.length ? 'partner_price' : 'item_price', conf: 0.6, issue: 'Η τιμή είναι μία για όλα τα κανάλια.' }
    return { kind: ph.length ? 'partner_price' : 'item_price', conf: 0.9 }
  }
  // χρήματα
  if (has('receive')) return { kind: 'receipt', conf: 0.9 }
  if (has('pay')) {
    // "δώσαμε 3 μαργαρίτες στο μαγαζί", "έδωσα στο Αστέρια 20 κατεψυγμένες"
    if (allFin && !moneyNum && (a.hasChannel() || (isCustomer && !isSupplier))) return { kind: a.hasChannel() ? 'sale_tally' : 'sale', conf: 0.6 }
    // "πλήρωσα 10 σακιά αλεύρι 155 ευρώ": αγορά τοις μετρητοίς· "πλήρωσα τον μύλο 150 ευρώ για το αλεύρι": πληρωμή
    if (ih.length && qtyNum) return { kind: 'purchase', conf: 0.6 }
    return { kind: 'payment', conf: 0.9 }
  }
  if (has('paid3', 'gave3')) {
    // "το Αστέρια πληρώνει τη σπέσιαλ 4 ευρώ": ειδική τιμή
    if (ih.length === 1 && !qtyNum && (moneyNum || freeNums) && isCustomer && /(^| )(πληρωνει|πληρωνουν|δινει)( |$)/.test(txt)) {
      return { kind: 'partner_price', conf: 0.6 }
    }
    if (ih.length && !moneyNum && has('gave3') && isCustomer) return { kind: 'sale', conf: 0.6 }
    if (isSupplier && !isCustomer) return { kind: 'payment', conf: 0.85 }
    return { kind: 'receipt', conf: ph.length ? 0.9 : 0.75 }
  }
  if ((has('take1') || has('brought')) && moneyNum && !qtyNum && (isCustomer || !ih.length) && !(isSupplier && !isCustomer)) {
    // "πήρα 300 ευρώ από το Αστέρια (για τις κατεψυγμένες)"
    return { kind: 'receipt', conf: ph.length ? 0.85 : 0.7 }
  }
  if ((has('take1') || has('brought')) && !ih.length && (moneyNum || (nums && isCustomer))) {
    if (isSupplier && !isCustomer && has('brought')) return { kind: 'purchase', conf: 0.5 }
    return { kind: 'receipt', conf: ph.length ? 0.85 : 0.7 }
  }
  // συναλλαγές
  // "ήρθε μια παραγγελία από το efood με 2 μαργαρίτες": πώληση λιανικής
  if (has('order') && !isSupplier && (a.hasChannel() || (allFin && itemsOf.every((it) => it.make_to_order)))) {
    return { kind: 'sale_tally', conf: a.hasChannel() ? 0.85 : 0.6 }
  }
  if (has('ordered')) return { kind: 'sale_tally', conf: 0.6 }
  if (has('buy')) return { kind: 'purchase', conf: 0.9 }
  if (has('take1', 'brought') && nums && !moneyNum && !ih.length && !isCustomer) return { kind: 'purchase', conf: 0.55 }
  if (has('take1', 'brought') && ih.length) return { kind: 'purchase', conf: isCustomer && !isSupplier ? 0.6 : 0.85 }
  if (has('invoice', 'note', 'order')) {
    if (a.hasChannel() && !ph.length) return { kind: 'sale_tally', conf: 0.85 }
    if (isCustomer && !isSupplier) return { kind: 'sale', conf: 0.85 }
    if (isSupplier) return { kind: 'purchase', conf: 0.85 }
    if (allFin) return { kind: 'sale', conf: 0.6 }
    return { kind: 'purchase', conf: has('invoice') ? 0.7 : 0.55 }
  }
  if (has('sell', 'take3')) {
    // "στο ξενοδοχείο Χ πουλάμε την κατεψυγμένη 3,90": ειδική τιμή πελάτη
    if (sellPresent && isCustomer && ih.length === 1 && !qtyNum && freeNums) return { kind: 'partner_price', conf: 0.7 }
    if (ph.length && !a.hasChannel()) return { kind: 'sale', conf: isCustomer ? 0.9 : 0.6 }
    if (has('take3') && !a.hasChannel()) {
      // "ένας πελάτης πήρε 2 μαργαρίτες": λιανική
      if (!ph.length && allFin && itemsOf.every((it) => it.make_to_order)) return { kind: 'sale_tally', conf: 0.6 }
      return { kind: 'sale', conf: 0.6 }
    }
    if (!a.hasChannel() && allFin && itemsOf.every((it) => !it.make_to_order)) return { kind: 'sale', conf: 0.6 }
    return { kind: 'sale_tally', conf: 0.9 }
  }
  if (has('produce', 'knead')) return { kind: 'production', conf: 0.9 }
  // "κάναμε 50 ζυμάρια"· "efood κάναμε 30 μαργαρίτες" = πωλήσεις
  if (has('did')) return a.hasChannel() ? { kind: 'sale_tally', conf: 0.7 } : { kind: 'production', conf: 0.75 }
  if (has('count', 'stocktakeNoun', 'remain', 'have')) return { kind: 'stocktake', conf: has('count', 'stocktakeNoun') ? 0.9 : 0.75 }
  // μέτρηση χωρίς ρήμα: όχι με πίτσες κατά παραγγελία (πωλήσεις), όχι με
  // προμηθευτή / πελάτη ("από τον μύλο άλλα 2 σακιά" = αγορά), όχι με τιμή
  const countable = ih.length > 0 && !mtoHeard && !ph.length && !priceShaped(a, moneyNum, ih) && !a.hasChannel()
  // "αλεύρι άλλα 5 κιλά", "μοτσαρέλα σύνολο 6", "διόρθωσε αλεύρι 40", "στον καταψύκτη άλλες 10 κατεψυγμένες"
  if (countable && (a.modes.some((m) => m.mode || m.soMany) || has('fix'))) return { kind: 'stocktake', conf: 0.8 }
  // "στην αποθήκη αλεύρι 10 σακιά": μέτρηση ανά χώρο
  if (countable && nums && a.toks.some((t) => ROOMS.has(t.n))) return { kind: 'stocktake', conf: 0.7 }
  if (a.hasChannel()) return { kind: 'sale_tally', conf: 0.85 }
  // χωρίς ρήμα: από τα είδη (εκτός αν ακούστηκε ρήμα που δεν ξέρουμε: "χάλασαν", "κερνάμε")
  const verb = unknownVerb(a, pre.unknown)
  if (verb) return unknownBecause(`Δεν κατάλαβα το «${verb}».`)
  if (ph.length && ih.length) {
    // "στο Αστέρια η σπέσιαλ 3,90": μόνο τιμή, καμία ποσότητα → ειδική τιμή πελάτη
    const nn = a.segs.filter((s, i): s is NumSeg => s.t === 'n' && !a.used.has(i))
    if (isCustomer && ih.length === 1 && nn.length === 1 && (!Number.isInteger(nn[0].value) || moneyNum)) {
      return { kind: 'partner_price', conf: 0.55 }
    }
    return { kind: isSupplier && !isCustomer ? 'purchase' : 'sale', conf: 0.55 }
  }
  if (ph.length && nums) {
    // "θα φέρει ο μύλος 10 σακιά": ποσότητα (μονάδα / συσκευασία) χωρίς είδος, όχι ποσό
    if (qtyNum && !moneyNum) return unknownBecause('Ποσότητα χωρίς είδος: πες π.χ. «ήρθαν δέκα σακιά αλεύρι» ή, για χρήματα, «πλήρωσα 300 ευρώ».')
    return { kind: isSupplier && !isCustomer ? 'payment' : 'receipt', conf: 0.45 }
  }
  if (ih.length) {
    if (allFin && ih.length === 1 && moneyNum && !qtyBefore) return { kind: 'item_price', conf: 0.55 }
    if (allFin) return { kind: 'sale_tally', conf: nums ? 0.75 : 0.6 }
    if (nums) return { kind: 'stocktake', conf: 0.45 }
  }
  if (has('stockNoun')) return { kind: 'query_stock', conf: 0.5 }
  // "και στην κουζίνα άλλα 5", "άλλα δύο σακιά": λείπει το είδος
  if (!ih.length && (nums || a.modes.some((m) => m.soMany)) && (a.modes.some((m) => m.mode || m.soMany) || a.toks.some((t) => ROOMS.has(t.n)))) {
    return unknownBecause('Πες και το είδος, π.χ. «αλεύρι άλλα 5 κιλά» ή «efood άλλες δύο μαργαρίτες».')
  }
  return { kind: 'unknown', conf: 0 }
}

/** Εντολές όπου το "διόρθωσε" θα πρόσθετε αντί να αντικαθιστά */
const FIX_ADDS = new Set<Kind>(['sale_tally', 'sale', 'purchase', 'production', 'receipt', 'payment'])

function decide(a: Analysis): Decision {
  const d = decideKind(a)
  // "διόρθωσε δύο μαργαρίτες": ο χρήστης θέλει "να γίνουν 2", όχι +2.
  // Αντικατάσταση υπάρχει μόνο στην απογραφή (και στις τιμές / συνταγές).
  if (a.has('fix') && FIX_ADDS.has(d.kind)) {
    return unknownBecause(
      d.kind === 'sale_tally'
        ? 'Η διόρθωση γίνεται μόνο στην απογραφή· στις πωλήσεις πες τι αλλάζει, π.χ. «efood βγάλε μία μαργαρίτα».'
        : 'Η διόρθωση γίνεται μόνο στην απογραφή· αλλιώς πες «ακύρωσε το τελευταίο» και ξαναπές το σωστά.',
    )
  }
  return d
}

/**
 * Αριθμός σε σχήμα τιμής: "ευρώ", "0,62 το κιλό", ή "σύνολο 155" για είδος
 * που έχει ήδη ποσότητα με μονάδα ("10 σακιά αλεύρι σύνολο 155"· όχι το
 * "αλεύρι σύνολο 40" ή το "σύνολο 260 κιλά", που είναι μέτρηση)
 */
function priceShaped(a: Analysis, moneyNum: boolean, ih: Hit[]): boolean {
  if (moneyNum) return true
  const qtyFor = (h: Hit, end: number) =>
    a.segs.some((x, j) => {
      if (x.t !== 'n' || a.used.has(j) || !a.unitAt(j + 1)) return false
      if (j >= h.to && j < end) return true
      // "10 σακιά (το) αλεύρι": ποσότητα ακριβώς πριν από το είδος
      return j + 2 <= h.from && a.segs.slice(j + 2, h.from).every((y) => y.t === 'w' && isStop(y.tok.n) && y.tok.n !== 'και' && y.tok.n !== 'κι')
    })
  return a.segs.some((s, i) => {
    if (s.t !== 'n' || a.used.has(i) || s.pct || s.size) return false
    // "0,62 το κιλό" (όχι "ένα κομμάτι": μονάδα, όχι "ανά")
    if (!a.unitAt(i + 1) && a.perAt(i + 1)) return true
    let p = i - 1
    if (a.w(p) === 'μαζι') p--
    if (!TOTAL.has(a.w(p) ?? '') || a.unitAt(i + 1)) return false
    const last = ih.filter((h) => h.to <= p).pop()
    return !!last && qtyFor(last, p)
  })
}

/** "νέο" ως εντολή: στην αρχή της φράσης ή πριν από λέξη τύπου ("Νέα Ζωή" δεν είναι εντολή) */
function newIsCommand(a: Analysis, ni: number): boolean {
  let atStart = true
  for (let i = 0; i < ni; i++) {
    const s = a.segs[i]
    if (s.t === 's') continue
    const w = a.w(i)
    if (!w || !(isStop(w) || a.cue[i] === 'want')) { atStart = false; break }
  }
  if (atStart) return true
  let j = ni + 1
  while (a.w(j) && isStop(a.w(j) as string)) j++
  const c = a.cue[j]
  return c === 'typeRaw' || c === 'typeSemi' || c === 'typeFinished' || c === 'typeGeneric' || c === 'pizza' ||
    c === 'customerWord' || c === 'supplierWord' || a.w(j) === 'πρωτη' || a.w(j) === 'πρωτεσ'
}

// ---------------------------------------------------------------------
// Κατασκευή εντολών
// ---------------------------------------------------------------------
interface Built {
  command: Command
  conf: number
}

function refNo(a: Analysis): string | null {
  for (let i = 0; i < a.segs.length; i++) {
    const n = a.w(i)
    if (!n || !REF_WORDS.has(n)) continue
    let j = i + 1
    let explicit = false
    if (['αριθμοσ', 'αριθμο', 'νουμερο', 'αρ', 'νο', 'no'].includes(a.w(j) ?? '')) { j++; explicit = true }
    // σειρά με γράμματα: "ΑΒ 1234", "άλφα βήτα 1234"
    let prefix = ''
    const pIdx: number[] = []
    for (let k = j; k < j + 3; k++) {
      const s = a.segs[k]
      if (!s || s.t !== 'w') break
      const letter = LETTER_NAMES[s.tok.n] ?? (/^\p{Lu}{1,3}$/u.test(s.tok.raw) && !isStop(s.tok.n) && !a.cue[k] && !a.chan[k] ? s.tok.raw : null)
      if (!letter) break
      prefix += letter.toUpperCase()
      pIdx.push(k)
    }
    if (prefix && a.num(j + pIdx.length)) j += pIdx.length
    else { prefix = ''; pIdx.length = 0 }
    const parts: string[] = []
    const idx: number[] = []
    while (a.num(j) && !(a.num(j) as NumSeg).half) {
      const x = a.num(j) as NumSeg
      if (a.unitAt(j + 1) || MONEY.has(a.w(j + 1) ?? '') || CENTS.has(a.w(j + 1) ?? '')) break
      // ποσότητα, όχι αριθμός: "δελτίο είκοσι σπέσιαλ", "τιμολόγιο 20 μοτσαρέλες"
      if (!explicit && !prefix && !parts.length && ((x.words && x.value < 10) || a.itemFollows(j + 1))) break
      parts.push(x.words ? String(x.value) : x.digits)
      idx.push(j)
      j++
    }
    if (parts.length) {
      for (const k of [...pIdx, ...idx]) a.used.add(k)
      return prefix + parts.join('')
    }
  }
  return null
}

/** Γραμμές με ποσότητες (και τιμές) για τα είδη μιας περιοχής */
function buildLines(a: Analysis, pool: Pool, priced: boolean, lo = 0, hi = a.segs.length, reserveChannels = true, tally = false) {
  const sc = a.scan(pool, reserveChannels, lo, hi)
  const itemHits = sc.hits.filter((h) => topKind(h) === 'item')
  const partnerHits = sc.hits.filter((h) => topKind(h) === 'partner')
  const cov = a.covered(sc.hits)
  let nums = a.numbers(cov).filter((x) => x.i >= lo && x.i < hi)
  if (priced) nums = a.mergeCents(nums, false)
  const lines = pairLines(a, hitsToEnts(itemHits), hitsToEnts(sc.unknown, true), nums, priced, pool, tally)
  sizeAsQty(a, lines, sc.roles, pool)
  const usedUnknown = new Set<Hit>(lines.filter((l) => l.ent.unknown).map((l) => l.ent.hit))
  // "λαζάνια κατεψυγμένα": ο προσδιορισμός μόνος του δεν φτάνει όταν δίπλα του
  // υπάρχει λέξη που δεν βρέθηκε → ρωτάμε, με όλη τη φράση όπως ακούστηκε
  for (const l of lines) {
    if (l.ent.unknown || !a.onlyModifiers(l.ent.from, l.ent.to)) continue
    const u = sc.unknown.find((h) => !usedUnknown.has(h) && (h.to === l.ent.from || h.from === l.ent.to))
    if (!u) continue
    usedUnknown.add(u)
    const heard = a.heard(Math.min(u.from, l.ent.from), Math.max(u.to, l.ent.to))
    l.ent = { ...l.ent, weak: true, hit: { ...l.ent.hit, heard } }
  }
  return { lines, partnerHits, sc, usedUnknown, nums }
}

/**
 * "σπέσιαλ κατεψυγμένες σύνολο 30" (είδος «Special κατεψυγμένη 30εκ»): ο
 * αριθμός στο τέλος μπήκε στο όνομα, αλλά πριν από αυτόν ειπώθηκε λέξη
 * ποσότητας ("σύνολο", "άλλες", "ακόμα") και το όνομα βγαίνει σίγουρο και
 * χωρίς αυτόν → είναι η ποσότητα. Χωρίς τέτοια λέξη μένει αμφίσημο (ρωτάμε).
 */
function sizeAsQty(a: Analysis, lines: Line[], roles: Role[], pool: Pool) {
  for (const l of lines) {
    if (l.qty || l.ent.unknown) continue
    const h = l.ent.hit
    const ni = h.to - 1
    const x = a.num(ni)
    if (!x || x.pct || x.size || ni <= h.from) continue
    let end = ni
    let cue = false
    while (end > h.from && roles[end - 1] === 'stop') {
      const w = a.w(end - 1) ?? ''
      if (STOCK_WORDS.has(w) || MORE.has(w) || TOTAL.has(w)) cue = true
      end--
    }
    if (!cue || end <= h.from) continue
    const before = confident(h.ranked)
    const ranked = a.m.rank(h.from, end, roles, pool)
    const now = confident(ranked)
    if (!before || !now || now.entry.id !== before.entry.id) continue
    const q = a.numbers(new Set()).find((n) => n.i === ni)
    if (!q || q.money || q.per) continue
    l.ent = { ...l.ent, to: end, hit: { ...h, to: end, heard: a.heard(h.from, end), ranked } }
    l.qty = q
  }
}

/** Η μονάδα που ακούστηκε βοηθά: "3 κιλά πεπερόνι" → το σαλάμι (kg), όχι η πίτσα (τεμ) */
function lineRef(l: Line): EntityRef {
  let ranked = onlyKind(l.ent.hit.ranked, 'item')
  const u = l.qty?.unit
  const pk = l.qty?.pack
  if ((u || pk) && ranked.length > 1) {
    ranked = ranked
      .map((s) => {
        const it = s.entry.item as Item
        const fits = u ? convertUnit(1, u, it.unit) !== null : isItemPack(pk as string, it)
        return fits ? s : { ...s, score: s.score * 0.75 }
      })
      .sort((x, y) => y.score - x.score)
  }
  const r = toRef(l.ent.hit.heard, ranked)
  return l.ent.weak ? { ...r, id: null } : r
}

type Missing = 'one' | 'issue' | ((item: Item | null, ref: EntityRef) => number | null)

function qtyLines(a: Analysis, lines: Line[], missing: Missing, noQtyIssue?: (k: number, label: string) => string | null): { out: QtyLine[]; conf: number } {
  const out: QtyLine[] = []
  let conf = 1
  for (const [k, l] of lines.entries()) {
    const ref = lineRef(l)
    refIssue(a, ref, 'είδος')
    conf = Math.min(conf, refConf(ref))
    const item = itemById(a, ref.id)
    const conv = item ?? unitItem(a, ref, l)
    unitIssue(a, ref, l, conv)
    const label = item?.name ?? ref.heard
    let qty = lineQty(a, l, conv, label)
    if (qty === null) {
      const d = typeof missing === 'function' ? missing(item, ref) : missing === 'one' ? 1 : null
      if (d !== null) qty = d
      else {
        a.issues.push(noQtyIssue?.(k, label) ?? `Δεν ακούστηκε ποσότητα για «${label}».`)
        qty = 0
        conf = Math.min(conf, 0.5)
      }
    }
    const line: QtyLine = { item: ref, qty }
    const hq = lineHeardQty(a, l)
    if (hq) line.heardQty = hq
    out.push(line)
  }
  return { out, conf }
}

/** Ίδιο είδος δύο φορές ("μια μαργαρίτα και μια μαργαρίτα") → μία γραμμή με άθροισμα */
function mergeSame(lines: QtyLine[]): QtyLine[] {
  const out: QtyLine[] = []
  for (const l of lines) {
    const prev = l.item.id ? out.find((x) => x.item.id === l.item.id) : undefined
    if (!prev) { out.push(l); continue }
    prev.qty = round(prev.qty + l.qty, 6)
    if (prev.heardQty || l.heardQty) prev.heardQty = [prev.heardQty ?? '1', l.heardQty ?? '1'].join(' + ')
  }
  return out
}

const lineStart = (l: Line) => Math.min(l.ent.from, l.qty?.i ?? Infinity, ...(l.more ?? []).map((x) => x.i))
const lineEnd = (l: Line) => Math.max(l.ent.to, l.qty?.end ?? 0, ...(l.more ?? []).map((x) => x.end))

/**
 * Πρόσημο ανά γραμμή του μετρητή: "βγάλε μία μαργαρίτα (και μία σπέσιαλ)"
 * αφαιρεί ό,τι ακολουθεί μέχρι το "βάλε"· "μία μαργαρίτα λιγότερη" μόνο αυτή·
 * "με λιγότερο τυρί" τίποτα.
 */
function tallySigns(a: Analysis, lines: Line[]): number[] {
  const order = lines.map((_l, k) => k).sort((x, y) => lineStart(lines[x]) - lineStart(lines[y]))
  const starts = new Set(lines.flatMap((l) => [l.ent.from, l.qty?.i ?? -1]))
  const signs = lines.map(() => 1)
  let prevPrefix = false
  let prevEnd = -1
  for (const k of order) {
    const l = lines[k]
    const start = lineStart(l)
    const end = lineEnd(l)
    let neg = false
    let prefix = false
    let j = start - 1
    while (j >= 0 && (a.chan[j] || (a.segs[j].t === 'w' && isStop(a.w(j) as string) && a.w(j) !== 'και' && a.w(j) !== 'κι' && !PLUS_WORDS.has(a.w(j) as string)))) j--
    const pw = a.w(j)
    if (pw && (MINUS_PRE.has(pw) || a.cue[j] === 'undo')) { neg = true; prefix = true }
    // "μία λιγότερη σπέσιαλ": ανάμεσα στην ποσότητα και το είδος
    for (let i = start; i < end && !neg; i++) {
      if (i >= l.ent.from && i < l.ent.to) continue
      if (MINUS_POST.has(a.w(i) ?? '')) neg = true
    }
    if (!neg) {
      let q = end
      while (q < a.segs.length && (a.chan[q] || (a.segs[q].t === 'w' && isStop(a.w(q) as string) && a.w(q) !== 'με' && a.w(q) !== 'και' && a.w(q) !== 'κι'))) q++
      const nw = a.w(q)
      if (nw && MINUS_POST.has(nw)) {
        const an = a.w(q + 1)
        const after = a.segs[q + 1]
        if (!after || after.t !== 'w' || an === 'και' || an === 'κι' || a.chan[q + 1] || starts.has(q + 1) || !a.isPlainWord(q + 1)) neg = true
      }
    }
    if (!neg && prevPrefix) {
      let stop = false
      for (let i = prevEnd; i < start; i++) {
        const w = a.w(i)
        if ((w && (PLUS_WORDS.has(w) || MINUS_POST.has(w))) || a.segs[i]?.t === 'n') stop = true
      }
      if (!stop) { neg = true; prefix = true }
    }
    signs[k] = neg ? -1 : 1
    prevPrefix = neg && prefix
    prevEnd = end
  }
  return signs
}

function buildSaleTally(a: Analysis): Built {
  const ci = a.chan.findIndex(Boolean)
  const chans = new Set(a.chan.filter(Boolean))
  const channel = (ci >= 0 ? a.chan[ci] : null) ?? a.ctx?.defaultChannel ?? 'store'
  if (chans.size > 1) a.issues.push(`Άκουσα ${chans.size} κανάλια· κράτησα το πρώτο.`)
  const { lines, nums } = buildLines(a, POOL.saleTally, false, 0, a.segs.length, true, true)
  const q = qtyLines(a, lines, 'one')
  const signs = tallySigns(a, lines)
  q.out.forEach((l, k) => { if (signs[k] < 0) l.qty = -Math.abs(l.qty) })
  const out = mergeSame(q.out)
  const money = nums.find((x) => !x.size && !x.pct && priceish(x, true))
  if (money && out.length) a.issues.push(`Αγνόησα το «${a.heard(money.i, money.end)}»· οι πωλήσεις ημέρας παίρνουν την τιμή του είδους.`)
  if (!out.length) a.issues.push('Δεν κατάλαβα ποια προϊόντα.')
  return {
    command: { kind: 'sale_tally', channel: channel as TallyChannel, channelHeard: ci >= 0, lines: out },
    conf: out.length ? q.conf : 0.2,
  }
}

function pricedLines(a: Analysis, lines: Line[], missingPriceIssue: boolean, missingQty: 'one' | 'issue', kind: 'cost' | 'sale'): { out: PricedLine[]; conf: number } {
  const out: PricedLine[] = []
  let conf = 1
  for (const l of lines) {
    const ref = lineRef(l)
    refIssue(a, ref, 'είδος')
    conf = Math.min(conf, refConf(ref))
    const item = itemById(a, ref.id)
    const conv = item ?? unitItem(a, ref, l)
    unitIssue(a, ref, l, conv)
    const label = item?.name ?? ref.heard
    let qty = lineQty(a, l, conv, label)
    if (qty === null && missingQty === 'one') {
      qty = 1
      conf = Math.min(conf, 0.85)
    } else if (qty === null) {
      a.issues.push(`Δεν ακούστηκε ποσότητα για «${label}».`)
      qty = 0
      conf = Math.min(conf, 0.5)
    }
    const unitPrice = priceFor(a, l, conv, qty, item, kind)
    if (unitPrice === null && missingPriceIssue) {
      a.issues.push(`Δεν ακούστηκε τιμή για «${label}»· θα μπει το μέσο κόστος.`)
      conf = Math.min(conf, 0.9)
    }
    const line: PricedLine = { item: ref, qty, unitPrice }
    const hq = lineHeardQty(a, l)
    if (hq) line.heardQty = hq
    out.push(line)
  }
  return { out, conf }
}

function buildSale(a: Analysis): Built {
  a.markVat()
  // "δελτίο 55 στον Χ ...": ο αριθμός δελτίου δεν είναι ποσότητα (η πώληση δεν τον κρατά)
  refNo(a)
  const { lines, partnerHits, sc, usedUnknown } = buildLines(a, POOL.sale, true)
  const partner = pickPartner(a, partnerHits, sc.unknown, usedUnknown, 'πελάτης')
  const { out, conf } = pricedLines(a, lines, false, 'one', 'sale')
  if (!out.length) a.issues.push('Δεν κατάλαβα ποια προϊόντα.')
  return { command: { kind: 'sale', partner, lines: out }, conf: Math.min(conf, refConf(partner)) * (out.length ? 1 : 0.3) }
}

function buildPurchase(a: Analysis): Built {
  a.markVat()
  const ref = refNo(a)
  const { lines, partnerHits, sc, usedUnknown } = buildLines(a, POOL.purchase, true)
  const partner = pickPartner(a, partnerHits, sc.unknown, usedUnknown, 'προμηθευτής')
  const { out, conf } = pricedLines(a, lines, true, 'issue', 'cost')
  if (!out.length) a.issues.push('Δεν κατάλαβα ποια είδη.')
  return {
    command: { kind: 'purchase', partner, lines: out, refNo: ref },
    conf: Math.min(conf, refConf(partner) + 0.2) * (out.length ? 1 : 0.3),
  }
}

function buildProduction(a: Analysis): Built {
  const { lines } = buildLines(a, POOL.production, false)
  const known = lines.filter((l) => !l.ent.unknown)
  const main = known[0] ?? lines[0]
  if (!main) {
    // "ζύμωσα 80": ζυμάρια (δεν το λέμε «ζύμωσα», για να μη γίνει ψευδώνυμο)
    const kneadIdx = a.at('knead')
    const doughs = a.items.filter((i) => i.is_active && i.item_type === 'semi' && /^ζυμαρ/.test(norm(i.name)))
    const x = a.numbers(new Set()).find((n) => !n.money)
    let item: EntityRef = emptyRef()
    if (kneadIdx >= 0 && doughs.length) {
      item = {
        heard: '',
        id: doughs.length === 1 ? doughs[0].id : null,
        candidates: doughs.slice(0, 5).map((d) => ({ id: d.id, name: d.name, score: 0.6 })),
      }
    }
    refIssue(a, item, 'τι φτιάχτηκε')
    const qty = x ? x.value : 0
    if (!x) a.issues.push('Δεν ακούστηκε ποσότητα.')
    return { command: { kind: 'production', item, qty }, conf: (item.id ? 0.8 : 0.4) * (x ? 1 : 0.5) }
  }
  if (known.length > 1) a.issues.push(`Μία παραγωγή τη φορά: κράτησα «${known[0].ent.hit.heard}».`)
  const { out, conf } = qtyLines(a, [main], 'issue')
  return { command: { kind: 'production', item: out[0].item, qty: out[0].qty }, conf }
}

type StockMode = 'add' | 'set' | undefined

/**
 * Απογραφή: τρόπος ανά γραμμή. Η λέξη δένεται με την ποσότητα / το είδος
 * που ακολουθεί ("άλλα 5 κιλά", "κι άλλη μοτσαρέλα") ή, όσες μπαίνουν και
 * μετά, με αυτό που προηγείται ("40 κιλά συνολικά"). Στην αρχή της φράσης
 * οι γενικές ("πρόσθεσε", "κι εδώ", "διόρθωσε") ισχύουν για όλες τις γραμμές.
 * "5 κιλά και άλλα 2" μέσα στη φράση είναι άθροισμα, όχι τρόπος.
 * Αν μια γραμμή ακούσει και τα δύο, κερδίζει η αντικατάσταση.
 */
function stockModes(a: Analysis, lines: Line[]): { mode: StockMode[]; soMany: boolean[] } {
  const own: StockMode[] = lines.map(() => undefined)
  const soMany = lines.map(() => false)
  if (!lines.length) return { mode: own, soMany }
  const n = a.segs.length
  const first = Math.min(...lines.map(lineStart))
  const quiet = (j: number) => {
    const w = a.w(j)
    return a.used.has(j) || a.filler.has(j) || (w !== null && (isStop(w) || LOCATION.has(w) || !!unitWord(w)))
  }
  const inSpan = (l: Line, j: number) =>
    (j >= l.ent.from && j < l.ent.to) || [l.qty, ...(l.more ?? [])].some((x) => !!x && j >= x.i && j < x.end)
  const merge = (cur: StockMode, m: 'add' | 'set'): StockMode => (cur === 'set' || m === 'set' ? 'set' : 'add')
  let all: StockMode
  for (const m of a.modes) {
    // "40 κιλά συνολικά και μοτσαρέλα 6": μετά από "και" αρχίζει άλλη γραμμή
    let nx = m.i + m.len
    while (nx < n && quiet(nx) && a.w(nx) !== 'και' && a.w(nx) !== 'κι') nx++
    if (m.mode === 'add' && lines.some((l) => l.more?.some((x) => x.i === nx))) continue
    let k = m.lead ? lines.findIndex((l) => l.qty?.i === nx || (nx >= l.ent.from && nx < l.ent.to)) : -1
    let back = false
    if (k < 0 && m.trail) {
      let pv = m.i - 1
      while (pv >= 0 && quiet(pv)) pv--
      k = pv >= 0 ? lines.findIndex((l) => inSpan(l, pv)) : -1
      back = k >= 0
    }
    if (k >= 0 && m.soMany) {
      const l = lines[k]
      if (back && l.qty && l.qty.i < m.i) {
        if (m.mode === 'add') {
          // "αλεύρι 10 κιλά στην αποθήκη και άλλα τόσα στην κουζίνα": η ίδια
          // ποσότητα ακόμα μία φορά (άθροισμα μέσα στη φράση, όχι τρόπος)
          const xs = [l.qty, ...(l.more ?? [])]
          l.more = [...(l.more ?? []), ...xs.map((x) => ({ ...x }))]
          continue
        }
        a.issues.push('Δεν κατάλαβα το «τόσα»· πες τον αριθμό, π.χ. «άλλα πέντε κιλά».')
        a.cap = Math.min(a.cap, 0.6)
      } else soMany[k] = true
    }
    if (!m.mode) continue
    if (m.all && m.i < first) all = merge(all, m.mode)
    else if (k >= 0) own[k] = merge(own[k], m.mode)
  }
  return { mode: own.map((x) => x ?? all), soMany }
}

/** Απογραφή: ίδιο είδος δύο φορές στη φράση → άθροισμα· με "σύνολο" → η τελευταία μέτρηση */
function mergeStock(lines: QtyLine[]): QtyLine[] {
  const out: QtyLine[] = []
  for (const l of lines) {
    const prev = l.item.id ? out.find((x) => x.item.id === l.item.id) : undefined
    if (!prev) { out.push(l); continue }
    if (l.mode === 'set') {
      prev.qty = l.qty
      prev.mode = 'set'
      if (l.heardQty) prev.heardQty = l.heardQty
      else delete prev.heardQty
      continue
    }
    prev.qty = round(prev.qty + l.qty, 6)
    if (prev.heardQty || l.heardQty) prev.heardQty = [prev.heardQty ?? '0', l.heardQty ?? '0'].join(' + ')
  }
  return out
}

function buildStocktake(a: Analysis): Built {
  a.locStop = true
  a.stockFiller()
  const { lines } = buildLines(a, POOL.stock, false)
  const sm = stockModes(a, lines)
  // "αλεύρι άλλα τόσα": λείπει ο αριθμός
  const q = qtyLines(a, lines, 'issue', (k, label) =>
    sm.soMany[k] ? `Δεν ακούστηκε ποσότητα για «${label}»· πες τον αριθμό, π.χ. «άλλα πέντε κιλά».` : null)
  q.out.forEach((l, k) => { const m = sm.mode[k]; if (m) l.mode = m })
  const out = mergeStock(q.out)
  if (!out.length) a.issues.push('Δεν κατάλαβα ποια είδη μετρήθηκαν.')
  return { command: { kind: 'stocktake', lines: out }, conf: out.length ? q.conf : 0.2 }
}

function amountOf(a: Analysis, skip: Set<number>): number | null {
  // "10 σακιά", "5 κιλά": ποσότητα, όχι ποσό
  const nums = a.mergeCents(a.numbers(skip), true).filter((x) => !x.pct && !x.size && !x.unit && !x.pack)
  const money = nums.filter((x) => x.money)
  const pick = money[0] ?? nums.slice().sort((p, q) => q.value - p.value)[0]
  return pick ? round(pick.value, 2) : null
}

function buildMoney(a: Analysis, kind: 'receipt' | 'payment'): Built {
  // "πλήρωσα το τιμολόγιο 4521": αριθμός τιμολογίου, όχι ποσό
  refNo(a)
  const sc = a.scan(kind === 'receipt' ? POOL.customers : POOL.suppliers, false)
  const partner = pickPartner(a, sc.hits, sc.unknown, new Set(), kind === 'receipt' ? 'πελάτης' : 'προμηθευτής')
  const amount = amountOf(a, a.covered(sc.hits))
  if (amount === null) a.issues.push('Δεν ακούστηκε ποσό.')
  return {
    command: { kind, partner, amount: amount ?? 0 },
    conf: refConf(partner) * (amount === null ? 0.4 : 1),
  }
}

function priceValue(a: Analysis, skip: Set<number>): number | null {
  const nums = a.mergeCents(a.numbers(skip), true).filter((x) => !x.pct && !x.size)
  const pick = nums.find((x) => x.money || x.prep) ?? nums[nums.length - 1]
  return pick ? pick.value : null
}

/** Δεύτερο είδος με τιμή στην ίδια φράση: δεν χάνεται σιωπηλά */
function onePriceIssue(a: Analysis, hits: Hit[], kept: Hit) {
  const others = hits.filter((h) => h !== kept && topKind(h) === 'item')
  if (others.length) a.issues.push(`Μία τιμή τη φορά: κράτησα «${kept.heard}»· πες ξεχωριστά για «${others[0].heard}».`)
}

function buildItemPrice(a: Analysis): Built {
  a.markVat('strict')
  const sc = a.scan(POOL.itemPrice, true)
  const h = sc.hits.find((x) => topKind(x) === 'item')
  const item = h ? itemRef(h) : sc.unknown[0] ? toRef(sc.unknown[0].heard, onlyKind(sc.unknown[0].ranked, 'item')) : emptyRef()
  refIssue(a, item, 'είδος')
  if (h) onePriceIssue(a, sc.hits, h)
  // μόνο οι αριθμοί μέχρι το επόμενο είδος
  const next = h ? sc.hits.find((x) => x.from >= h.to && topKind(x) === 'item') : undefined
  const skip = a.covered(sc.hits)
  if (next) for (let i = next.from; i < a.segs.length; i++) skip.add(i)
  const price = priceValue(a, skip)
  const it = itemById(a, item.id)
  // χωρίς σίγουρο είδος: ό,τι ισχύει για όλους τους υποψηφίους
  const cs = it ? [it] : candItems(a, item)
  let heardGross = cs.length > 0 && cs.every((x) => isFin(x) && x.make_to_order)
  if (a.gross !== null) heardGross = a.gross
  if (price === null) a.issues.push('Δεν ακούστηκε τιμή.')
  // άγνωστο είδος: ο ΦΠΑ δεν κρίνεται, να το δει όταν διαλέξει είδος
  const mixed = cs.length > 0 && !cs.every((x) => (isFin(x) && x.make_to_order) === heardGross)
  if (!it && price !== null && a.gross === null && (!cs.length || mixed)) {
    a.issues.push(`Δεν ξέρω αν τα ${fmtMoney(price)} είναι με ή χωρίς ΦΠΑ· έλεγξέ το όταν διαλέξεις είδος.`)
  }
  const vat = Number((it ?? cs[0])?.vat_rate ?? 13)
  const netPrice = price === null ? 0 : heardGross ? round(price / (1 + vat / 100)) : round(price)
  return {
    command: { kind: 'item_price', item, netPrice, heardGross },
    conf: refConf(item) * (price === null ? 0.3 : 1),
  }
}

function buildPartnerPrice(a: Analysis): Built {
  a.markVat('strict')
  const sc = a.scan(POOL.partnerPrice, false)
  const partner = pickPartner(a, sc.hits, [], new Set(), 'πελάτης')
  const h = sc.hits.find((x) => topKind(x) === 'item')
  const item = h ? itemRef(h) : sc.unknown[0] ? toRef(sc.unknown[0].heard, onlyKind(sc.unknown[0].ranked, 'item')) : emptyRef()
  refIssue(a, item, 'είδος')
  if (h) onePriceIssue(a, sc.hits, h)
  const price = priceValue(a, a.covered(sc.hits))
  if (price === null) a.issues.push('Δεν ακούστηκε τιμή.')
  const it = itemById(a, item.id)
  const netPrice = price === null ? 0 : a.gross ? round(price / (1 + Number(it?.vat_rate ?? 13) / 100)) : round(price)
  return {
    command: { kind: 'partner_price', partner, item, netPrice },
    conf: Math.min(refConf(partner), refConf(item)) * (price === null ? 0.3 : 1),
  }
}

function buildRecipe(a: Analysis): Built {
  const r = a.at('recipe')
  const v = recipeVerbAt(a)
  const n = a.segs.length
  // περιοχή προϊόντος
  let pLo = 0
  let pHi = n
  if (r >= 0) {
    pLo = r + 1
    pHi = n
    for (let i = pLo; i < n; i++) {
      const s = a.segs[i]
      // "για 40": ποσότητα παρτίδας· "συνταγή για τη χαβανέζα": απλή πρόθεση
      const forQty = a.w(i) === 'για' && (!!a.num(i + 1) || (!!a.w(i + 1) && isStop(a.w(i + 1) as string) && !!a.num(i + 2)))
      if ((s.t === 's' && i > pLo) || forQty || a.cue[i] === 'recipeVerb' || a.cue[i] === 'want' || (s.t === 'n' && a.unitAt(i + 1))) { pHi = i; break }
    }
  } else if (v >= 0) pHi = v
  const ps = a.scan(POOL.recipeProduct, true, pLo, pHi)
  const ph = ps.hits.filter((h) => topKind(h) === 'item')
  // προϊόν: το πρώτο έτοιμο, αλλιώς το πρώτο ημιέτοιμο ("συνταγή μαργαρίτας 1 ζυμάρι 250 80 γρ σάλτσα")
  const prodHit = ph.find((h) => h.ranked[0]?.entry.item?.item_type === 'finished') ?? ph[0] ?? null
  const product = prodHit ? itemRef(prodHit) : ps.unknown[0] ? toRef(ps.unknown[0].heard, onlyKind(ps.unknown[0].ranked, 'item')) : emptyRef()
  refIssue(a, product, 'σε ποιο είδος')
  const prodItem = itemById(a, product.id)
  // ποσότητα παρτίδας: "για 40 (τεμάχια)", "για 10 κιλά", "βγάζει 40", "παρτίδα 40"
  let outputQty = 1
  const block = new Set<number>()
  for (let i = 0; i < n; i++) {
    const wd = a.w(i)
    if (wd === 'για' || wd === 'βγαζει' || wd === 'βγαζουν' || wd === 'παρτιδα' || wd === 'αναλογια') {
      let j = i + 1
      if (a.w(j) === 'των' || a.w(j) === 'τα' || a.w(j) === 'τουσ' || a.w(j) === 'τισ') j++
      const x = a.num(j)
      const xu = a.unitAt(j + 1)
      if (!x || x.size) continue
      let val: number | null = null
      if (!xu || xu.unit === 'τεμ') val = x.value
      else if (xu.unit && prodItem && prodItem.unit !== 'τεμ') val = convertUnit(x.value, xu.unit, prodItem.unit)
      if (val === null) continue
      outputQty = val
      block.add(j)
      // "για 40 τεμάχια / ζυμάρια / πίτσες", "για 10 κιλά"
      const nx = a.w(j + 1)
      const nxKey = (a.segs[j + 1] as { tok?: Tok })?.tok?.key ?? ''
      const sameAsProduct = !!prodItem && tokenize(prodItem.name).some((t) => t.key && t.key === nxKey)
      if (nx && (xu || sameAsProduct || /^(ζυμαρ|πιτσ|τεμαχ|κομματ|μεριδ|μπαλ)/.test(nx))) block.add(j + 1)
      break
    }
  }
  if (prodHit) for (let i = prodHit.from; i < prodHit.to; i++) block.add(i)
  const cLo = r >= 0 ? (prodHit ? prodHit.to : pHi) : v >= 0 ? v + 1 : 0
  const pool = prodItem?.item_type === 'semi' ? POOL.compOfSemi : POOL.compOfFinished
  const cs = a.scan(pool, true, cLo, n, block)
  const itemHits = cs.hits.filter((h) => topKind(h) === 'item')
  const cov = a.covered(cs.hits)
  for (const b of block) cov.add(b)
  const nums = a.numbers(cov).filter((x) => x.i >= cLo)
  const lines = pairLines(a, hitsToEnts(itemHits), hitsToEnts(cs.unknown, true), nums, false, pool)
  // "ζυμάρι 400" χωρίς αριθμό σε συνταγή μίας πίτσας: 1 τεμάχιο
  const oneIfCount = (it: Item | null, ref: EntityRef): number | null => {
    const us = it ? [it.unit] : candItems(a, ref).map((c) => c.unit)
    return outputQty === 1 && us.length > 0 && us.every((u) => u === 'τεμ') ? 1 : null
  }
  const { out, conf } = qtyLines(a, lines, oneIfCount)
  // "120 μοτσαρέλα" σε συνταγή μίας πίτσας: εννοεί γραμμάρια, όχι κιλά
  out.forEach((l, k) => {
    const x = lines[k]?.qty
    const it = itemById(a, l.item.id)
    if (!x || x.unit || x.pack || !it || (it.unit !== 'kg' && it.unit !== 'L')) return
    if (l.qty / Math.max(outputQty, 1) >= 5) {
      l.qty = round(l.qty / 1000, 6)
      a.issues.push(`«${it.name}»: πήρα το ${x.value} ως ${it.unit === 'kg' ? 'γραμμάρια' : 'ml'}.`)
    }
  })
  if (!out.length) a.issues.push('Δεν ακούστηκαν υλικά.')
  return {
    command: { kind: 'recipe', item: product, outputQty, lines: out },
    conf: Math.min(conf, refConf(product)) * (out.length ? 1 : 0.3),
  }
}

// ---------------------------------------------------------------------
// Νέο είδος
// ---------------------------------------------------------------------
/** λέξεις που δεν τελειώνουν ποτέ ένα όνομα */
const TRAIL = new Set(['και', 'κι', 'με', 'απο', 'στο', 'στη', 'στην', 'στον', 'στα', 'σε', 'το', 'τα', 'τη', 'την', 'τον', 'του', 'τησ', 'των', 'ο', 'η', 'οι', 'για', 'ε', 'εε', 'λοιπον', 'ενα', 'μια'])
const NAME_END = new Set(['σε', 'ερχεται', 'ερχονται', 'μοναδα', 'τιμη', 'κατα', 'με', 'χωρισ', 'των', 'συσκευασια', 'αυτοματα', 'ανα', 'πουλιεται', 'κανει', 'κοστιζει'])

/** Κλειδί ονόματος για "υπάρχει ήδη" (ίδια ρίζα / φωνητικά, π.χ. "σπέσιαλ" = "Special") */
const nameKey = (s: string) => tokenize(String(s ?? '')).filter((t) => !t.sep).map((t) => (t.num !== undefined ? String(t.num) : t.key)).join(' ')

function buildNewItem(a: Analysis): Built {
  a.markVat()
  const n = a.segs.length
  const ni = a.at('new')
  let i = ni + 1
  let type: ItemType | null = null
  let mto: boolean | null = null
  // τύπος
  for (let k = 0; k < 3 && i < n; k++) {
    const wd = a.w(i)
    if (!wd) break
    if ((wd === 'πρωτη' || wd === 'πρωτεσ') && /^υλ/.test(a.w(i + 1) ?? '')) { type = 'raw'; i += 2; break }
    const c = a.cue[i]
    if (c === 'typeRaw') { type = 'raw'; i++; break }
    if (c === 'typeSemi') { type = 'semi'; i++; break }
    if (c === 'pizza') { type = 'finished'; mto = true; i++; break }
    if (c === 'typeFinished') { type = 'finished'; i++; if (a.cue[i] === 'pizza') { mto = true; i++ } break }
    if (c === 'typeGeneric') { i++; break }
    if (/^ζυμαρ/.test(wd)) { type = 'semi'; break }
    if (isStop(wd)) { i++; continue }
    break
  }
  // δηλωμένη μονάδα ("σε τεμάχια"): τότε το "330ml" είναι μέρος του ονόματος
  let declared: string | null = null
  for (let k = i; k < n; k++) if (a.w(k) === 'σε' && a.w(k + 1) && unitWord(a.w(k + 1) as string)) { declared = unitWord(a.w(k + 1) as string); break }
  // όνομα ("με όνομα", "που λέγεται" = γέμισμα)
  const parts: string[] = []
  let j = i
  while (j < n && ['με', 'ονομα', 'ονοματι', 'που', 'λεγεται', 'λεγομενη', 'λεγομενο', 'τη', 'το', 'την', 'λενε'].includes(a.w(j) ?? '')) j++
  const isPriceHere = (x: NumSeg, k: number) =>
    MONEY.has(a.w(k + 1) ?? '') || CENTS.has(a.w(k + 1) ?? '') || (type !== 'semi' && type !== 'raw' && !Number.isInteger(x.value))
  while (j < n) {
    const s = a.segs[j]
    if (s.t === 's' || a.used.has(j)) break
    if (s.t === 'n') {
      const u = a.w(j + 1) ? unitWord(a.w(j + 1) as string) : null
      if (isPriceHere(s, j) || s.pct) break
      if ((type !== 'raw' || declared === 'τεμ') && (u === 'g' || u === 'εκ' || u === 'ml' || u === 'kg' || u === 'L')) {
        parts.push(`${s.value}${UNIT_SHORT[u] === 'κιλά' ? 'kg' : UNIT_SHORT[u] === 'λίτρα' ? 'L' : UNIT_SHORT[u]}`)
        j += 2
        continue
      }
      if (s.size) { parts.push(String(s.value)); j++; continue }
      if (type === 'semi' && parts.length) { parts.push(String(s.value)); j++; continue }
      // "τέσσερα τυριά" → "4 τυριά"
      const nw = a.w(j + 1)
      if (Number.isInteger(s.value) && nw && !NAME_END.has(nw) && !MONEY.has(nw) && !VAT.has(nw) && !unitWord(nw) &&
        !genericPack(nw) && !isStop(nw) && !a.cue[j + 1]) { parts.push(String(s.value)); j++; continue }
      break
    }
    const wd = s.tok.n
    if (NAME_END.has(wd) || MONEY.has(wd) || VAT.has(wd) || PHONE_WORDS.has(wd)) break
    if (type === 'raw' && (unitWord(wd) || genericPack(wd))) break
    if (!parts.length && isStop(wd)) { j++; continue }
    if (s.tok.glued && parts.length) parts[parts.length - 1] += s.tok.raw
    else parts.push(s.tok.raw)
    j++
  }
  while (parts.length && TRAIL.has(norm(parts[parts.length - 1]))) parts.pop()
  const name = capFirst(parts.join(' ').trim())
  // μονάδα / συσκευασία
  let unit: string | null = null
  let packName: string | null = null
  let packQty: number | null = null
  for (let k = j; k < n; k++) {
    const wd = a.w(k)
    if (!wd) continue
    const u = unitWord(wd)
    const prevNum = a.num(k - 1)
    if (u && isMeasureUnit(u) && !prevNum && !unit) { unit = u; continue }
    const pk = genericPack(wd)
    // "συσκευασία κούτα των 12": η "συσκευασία" είναι απλώς γέμισμα
    if (pk === 'συσκευασία' && genericPack(a.w(k + 1) ?? '')) continue
    if (pk && !packName) {
      packName = pk
      let q = k + 1
      while (a.w(q) && ['των', 'με', 'απο', 'του', 'τησ', 'που', 'εχει', 'χωραει', 'περιεχει'].includes(a.w(q) as string)) q++
      const x = a.num(q)
      if (x) {
        const pu = a.w(q + 1) ? unitWord(a.w(q + 1) as string) : null
        packQty = x.value
        if (pu && isMeasureUnit(pu)) {
          const target: string = unit ?? (type === 'raw' || !type ? (pu === 'g' || pu === 'kg' ? 'kg' : pu === 'ml' || pu === 'L' ? 'L' : 'τεμ') : 'τεμ')
          if (!unit) unit = target
          const c = convertUnit(x.value, pu, target)
          if (c !== null) packQty = c
        }
      }
    }
  }
  // τιμή
  let price: number | null = null
  if (type !== 'raw') {
    const nums = a.mergeCents(a.numbers(new Set()), true).filter((x) => x.i >= j && !x.pct && !x.size && !x.unit && !x.pack)
    const p = nums.find((x) => x.money || x.prep) ?? nums.find((x) => !a.w(x.end) || !genericPack(a.w(x.end) as string))
    if (p && !(packName && packQty === p.value)) price = p.value
  }
  const txt = a.toks.map((t) => t.n).join(' ')
  if (!type) {
    if (unit && unit !== 'τεμ') type = 'raw'
    else if (packName) type = 'raw'
    else if (price !== null) type = 'finished'
    else { type = 'raw'; a.issues.push('Δεν είπες τι είδος είναι· το πέρασα ως πρώτη ύλη.') }
  }
  if (!unit) unit = type === 'raw' ? 'kg' : 'τεμ'
  // χονδρική / κατεψυγμένα: τιμή χωρίς ΦΠΑ· λιανική: με ΦΠΑ
  const retail = !/κατεψυγμεν|χονδρικ|συσκευασμεν/.test(norm(name) + ' ' + txt)
  if (/κατα παραγγελια|αυτοματα/.test(txt)) mto = true
  if (type === 'finished' && mto === null) {
    // κατά παραγγελία μόνο για "νέα πίτσα" (αλλιώς θα ήθελε συνταγή για να κλείσει η μέρα)
    mto = false
    if (retail) a.issues.push('Δεν θα είναι «κατά παραγγελία»· αν είναι πίτσα με συνταγή, πες «νέα πίτσα …».')
  }
  if (mto === null) mto = false
  const vatRate = a.vatRate !== null && [0, 6, 13, 24].includes(a.vatRate) ? a.vatRate : 13
  if (a.vatRate !== null && vatRate !== a.vatRate) a.issues.push(`Ο ΦΠΑ ${a.vatRate}% δεν υπάρχει· έβαλα 13%.`)
  let salePrice: number | null = null
  if (price !== null) {
    const gross = a.gross ?? (type === 'finished' && retail)
    salePrice = gross ? round(price / (1 + vatRate / 100)) : round(price)
  }
  if (!name) a.issues.push('Δεν ακούστηκε όνομα.')
  if (packName && packQty === null) a.issues.push(`Δεν ακούστηκε πόσο έχει το ${packName}.`)
  const key = name ? nameKey(name) : ''
  const exists = key ? a.items.find((it) => [it.name, ...(it.aliases ?? [])].some((x) => nameKey(x) === key)) : null
  if (exists) a.issues.push(`Υπάρχει ήδη «${exists.name}».`)
  return {
    command: {
      kind: 'new_item', itemType: type, name, unit, vatRate, salePrice, makeToOrder: !!mto,
      packName, packQty,
    },
    conf: name ? (exists ? 0.5 : 1) : 0.2,
  }
}

// ---------------------------------------------------------------------
// Νέος συναλλασσόμενος
// ---------------------------------------------------------------------
function digitsFrom(a: Analysis, j: number): { digits: string; end: number } {
  let d = ''
  let k = j
  while (k < a.segs.length) {
    const x = a.num(k)
    if (x) { d += x.words && !Number.isInteger(x.value) ? '' : x.words ? String(x.value) : x.digits; k++; continue }
    if (a.w(k) === 'και' && a.num(k + 1) && d) { k++; continue }
    break
  }
  return { digits: d, end: k }
}

function buildNewPartner(a: Analysis): Built {
  const n = a.segs.length
  let isCustomer = false
  let isSupplier = false
  a.cue.forEach((c) => { if (c === 'customerWord') isCustomer = true; if (c === 'supplierWord') isSupplier = true })
  // αρχή ονόματος: μετά την τελευταία λέξη τύπου στην αρχή
  let i = a.at('new') + 1
  while (i < n && (a.cue[i] === 'customerWord' || a.cue[i] === 'supplierWord' || a.w(i) === 'και' || (a.w(i) && isStop(a.w(i) as string)))) i++
  let phone: string | null = null
  let vatNo: string | null = null
  let city: string | null = null
  const nameParts: string[] = []
  let j = i
  let mode: 'name' | 'city' = 'name'
  const cityParts: string[] = []
  while (j < n) {
    const s = a.segs[j]
    const wd = a.w(j)
    if (s.t === 's') { j++; if (mode === 'city') mode = 'name'; continue }
    if (wd && PHONE_WORDS.has(wd)) {
      const r = digitsFrom(a, j + 1)
      if (r.digits) phone = r.digits
      j = r.end
      // λέξεις μετά από τηλέφωνο / ΑΦΜ: συνήθως η πόλη
      mode = nameParts.length && !cityParts.length ? 'city' : 'name'
      continue
    }
    if (wd && AFM_WORDS.has(wd)) {
      const r = digitsFrom(a, j + 1)
      if (r.digits) vatNo = r.digits
      j = r.end
      mode = nameParts.length && !cityParts.length ? 'city' : 'name'
      continue
    }
    if (s.t === 'n') {
      const r = digitsFrom(a, j)
      if (r.digits.length >= 9) {
        if (r.digits.length === 9 && !vatNo) vatNo = r.digits
        else if (!phone) phone = r.digits
        j = r.end
        continue
      }
      if (mode === 'name' && nameParts.length) nameParts.push(r.digits)
      j = r.end
      continue
    }
    if (wd && (CITY_PREP.has(wd) || wd === 'πολη' || wd === 'περιοχη') && nameParts.length) {
      mode = 'city'
      j++
      continue
    }
    if (wd && (a.cue[j] === 'customerWord' || a.cue[j] === 'supplierWord')) { j++; continue }
    const tok = (s as { tok: Tok }).tok
    const target = mode === 'city' ? cityParts : nameParts
    // "Coca Cola 3Ε": κολλητά γράμματα μένουν κολλητά
    if (tok.glued && target.length) target[target.length - 1] += tok.raw
    else if (mode === 'city') cityParts.push(tok.raw)
    else if (!(nameParts.length === 0 && wd && isStop(wd))) nameParts.push(tok.raw)
    j++
  }
  while (nameParts.length && TRAIL.has(norm(nameParts[nameParts.length - 1]))) nameParts.pop()
  // "ξενοδοχείο Κνωσός Ηράκλειο": γνωστή πόλη στο τέλος του ονόματος
  if (!cityParts.length && nameParts.length >= 2 && CITIES.has(norm(nameParts[nameParts.length - 1]))) {
    cityParts.push(nameParts.pop() as string)
  }
  if (cityParts.length) city = titleCase(cityParts.join(' '))
  const name = titleCase(nameParts.join(' '))
  if (!isCustomer && !isSupplier) isCustomer = true
  if (!name) a.issues.push('Δεν ακούστηκε όνομα.')
  if (phone && phone.length !== 10) a.issues.push(`Το τηλέφωνο έχει ${phone.length} ψηφία.`)
  if (vatNo && vatNo.length !== 9) a.issues.push(`Το ΑΦΜ έχει ${vatNo.length} ψηφία.`)
  const key = name ? nameKey(name) : ''
  const exists = key ? a.partners.find((p) => [p.name, ...(p.aliases ?? [])].some((x) => nameKey(x) === key)) : null
  if (exists) a.issues.push(`Υπάρχει ήδη «${exists.name}».`)
  return {
    command: { kind: 'new_partner', name, isCustomer, isSupplier, phone, vatNo, city },
    conf: name ? (exists ? 0.5 : 1) : 0.2,
  }
}

// ---------------------------------------------------------------------
// Ερωτήσεις
// ---------------------------------------------------------------------
function buildQueryStock(a: Analysis): Built {
  const sc = a.scan(POOL.stock, true)
  const h = sc.hits.find((x) => topKind(x) === 'item')
  const item = h ? itemRef(h) : sc.unknown[0] ? toRef(sc.unknown[0].heard, onlyKind(sc.unknown[0].ranked, 'item')) : emptyRef()
  refIssue(a, item, 'είδος')
  return { command: { kind: 'query_stock', item }, conf: refConf(item) }
}

function buildQueryBalance(a: Analysis): Built {
  const pool: Pool = a.has('owe1') ? POOL.suppliers : a.has('owe3') ? POOL.customers : POOL.partners
  const sc = a.scan(pool, false)
  const partner = pickPartner(a, sc.hits, sc.unknown, new Set(), 'συναλλασσόμενος')
  return { command: { kind: 'query_balance', partner }, conf: refConf(partner) }
}

// ---------------------------------------------------------------------
// Νέα φράση: "όταν λέω οικογενειακή εννοώ μεγάλη μαργαρίτα"
// ---------------------------------------------------------------------
const SAY = new Set(['λεω', 'λεμε', 'λεσ', 'λεει', 'λενε', 'πω', 'πουμε', 'πεισ', 'πει', 'πουν', 'πουνε', 'ακουσ', 'ακουσεισ', 'ακουω'])
const TEACH = new Set(['μαθε', 'μαθετε', 'θυμησου', 'θυμηθειτε'])
const MEAN1 = new Set(['εννοω', 'εννοουμε', 'εννοει', 'εννοουν', 'εννοεισ', 'εννοειτε', 'σημαινει', 'σημαινουν', 'ειναι', 'καταλαβαινε', 'καταλαβε', 'καταλαβαινεισ', 'καταλαβαινετε'])
/** "εννοώ": σίγουρη σημασία (όχι το "είναι", όχι το "θα πει", που είναι και μέλλοντας) */
const MEAN_STRONG = new Set(['εννοω', 'εννοουμε', 'εννοει', 'εννοουν', 'εννοεισ', 'εννοειτε'])
const QUESTION = new Set(['τι', 'ποιο', 'ποια', 'ποιοσ', 'ποιον', 'ποιεσ', 'ποσο', 'ποση', 'ποσα', 'πωσ', 'γιατι', 'που'])
const SAY3 = new Set(['λεει', 'λενε', 'πει', 'πουν', 'πουνε'])
/** "όταν (σου) λέω", "όποτε λέμε", "αν πω", "κάθε φορά που λέω" */
const WHEN = new Set(['οταν', 'οποτε', 'αν', 'εαν'])
/** ανάμεσα στο "όταν" και στο "λέω" ("όταν σου λέω", "όταν θα λέμε") */
const SAY_FILL = new Set(['σου', 'σασ', 'μου', 'μασ', 'θα', 'το', 'να', 'εγω', 'εμεισ', 'εσυ', 'εσεισ', 'κανεισ', 'καποιοσ'])
/** εισαγωγή πριν από τη φράση: "τη λέξη Χ", "νέα λέξη: Χ" */
const WORD_NOUN = new Set(['λεξη', 'λεξεισ', 'φραση', 'φρασεισ', 'εκφραση'])
/**
 * Στο "Χ είναι / σημαίνει Υ" (χωρίς "όταν λέω" / "μάθε"): λέξεις που δείχνουν
 * συνηθισμένη πρόταση, όχι νέα φράση ("η μία είναι μαργαρίτα", "όλες είναι
 * μαργαρίτες", "το πρώτο είναι η μαργαρίτα", "όχι, είναι η μοτσαρέλα")
 */
const NOT_PHRASE = new Set([
  'ολα', 'ολεσ', 'ολοι', 'ολο', 'ολη', 'ολουσ', 'αυτο', 'αυτη', 'αυτα', 'αυτοσ', 'αυτεσ', 'αυτοι', 'αυτον', 'αυτην', 'εκεινο',
  'εκεινη', 'εκεινα', 'εκεινοσ', 'αλλο', 'αλλη', 'αλλα', 'αλλεσ', 'αλλοι', 'αλλοσ', 'πρωτο', 'πρωτη', 'πρωτα', 'πρωτεσ', 'πρωτοσ',
  'δευτερο', 'δευτερη', 'δευτερα', 'τριτο', 'τριτη', 'τεταρτο', 'τεταρτη', 'επομενο', 'επομενη', 'επομενα', 'τελευταιο',
  'τελευταια', 'τελευταιεσ', 'τελευταιοσ', 'προηγουμενο', 'προηγουμενη', 'ιδιο', 'ιδια', 'ιδιεσ', 'καθε', 'καθενα', 'καθεμια',
  'μερικα', 'μερικεσ', 'μερικοι', 'κανενα', 'καμια', 'τιποτα', 'εδω', 'εκει', 'τωρα', 'σημερα', 'δεν', 'δε', 'μη', 'μην',
])
/** σημασία μετά από αυτά: "σημαίνει από τον μύλο" δεν είναι όνομα */
const NOT_NAME_START = new Set(['απο', 'σε', 'στο', 'στη', 'στην', 'στον', 'στα', 'στουσ', 'στισ', 'για', 'με', 'του', 'τησ', 'των', 'πιο', 'πολυ', 'λιγο', 'ενα', 'μια', 'ενασ'])
const EDGE_JUNK = /^[\s«»"“”'’`:,.;!?·\-–—]+|[\s«»"“”'’`:,.;!?·\-–—]+$/g
const TEACH_EXAMPLE = 'Πες π.χ. «όταν λέω οικογενειακή εννοώ μεγάλη μαργαρίτα».'

/** Μήκος της λέξης / φράσης σημασίας στο i ("εννοώ", "θέλω να πω", "θα πει", "να καταλαβαίνεις"), αλλιώς 0 */
function meanLen(ws: Word[], i: number, onlyIs = false): number {
  const w = ws[i]?.n
  if (!w) return 0
  if (onlyIs) return w === 'ειναι' ? 1 : 0
  if (MEAN1.has(w)) return 1
  if ((w === 'θελω' || w === 'θελουμε' || w === 'θελει') && ws[i + 1]?.n === 'να' && ['πω', 'πουμε', 'πει'].includes(ws[i + 2]?.n ?? '')) return 3
  if (w === 'θα' && ws[i + 1]?.n === 'πει') return 2
  if ((w === 'να' || w === 'θα') && ['καταλαβαινεισ', 'καταλαβαινετε', 'καταλαβεισ', 'γραφεισ', 'βαζεισ'].includes(ws[i + 1]?.n ?? '')) return 2
  return 0
}

/** "θα πει", "θέλει να πει": σημασία χωρίς "όταν λέω" (όπως το "σημαίνει") */
function mightMean(ws: Word[], i: number): number {
  const w = ws[i]?.n
  if (w === 'θα' && ws[i + 1]?.n === 'πει') return 2
  if (w === 'θελει' && ws[i + 1]?.n === 'να' && ws[i + 2]?.n === 'πει') return 3
  return 0
}

/**
 * Το κείμενο είναι ακριβώς ένα είδος / συναλλασσόμενος του καταλόγου (με
 * σίγουρο id); Επιτρέπονται γύρω του γενικοί προσδιορισμοί ("μεγάλη μαργαρίτα").
 */
function resolvesWhole(text: string, ctx: InterpretContext): string | null {
  const a = new Analysis(text, ctx)
  const sc = a.scan(POOL.all, false)
  if (sc.hits.length !== 1 || !sc.unknown.every((h) => a.onlyModifiers(h.from, h.to))) return null
  const cov = a.covered(sc.hits)
  if (a.segs.some((s, i) => !cov.has(i) && (s.t === 'n' || (s.t === 'w' && !isStop(s.tok.n) && !isModifier(s.tok.n))))) return null
  return toRef(sc.hits[0].heard, sc.hits[0].ranked).id
}

/** Η φράση Χ μοιάζει με κομμάτι συνηθισμένης πρότασης; (αριθμοί, κανάλια, "όχι", "όλες", "η πίτσα", "το σακί" ...) */
function ordinaryWords(phrase: string, cmd: boolean): boolean {
  const toks = tokenize(phrase)
  if (segment(toks).some((s) => s.t === 'n')) return true
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    if (t.sep) continue
    const n = t.n
    if (channelAt(toks, i) || CORRECTION.has(n) || NOT_PHRASE.has(n) || parseYesNo(n) !== null) return true
    if (unitWord(n) || genericPack(n)) return true
    const c = cueOf(n)
    if (c === 'pizza' || c === 'question' || (cmd && c && !c.startsWith('type'))) return true
  }
  return false
}

/** Μόνο τιμή / αριθμός ("8 ευρώ", "4,50 με ΦΠΑ"): όχι σημασία φράσης */
function onlyPrice(meaning: string): boolean {
  const segs = segment(tokenize(meaning))
  if (!segs.some((s) => s.t === 'n')) return false
  return segs.every((s) => s.t !== 'w' || isStop(s.tok.n) || MONEY.has(s.tok.n) || CENTS.has(s.tok.n) || VAT.has(s.tok.n) || NET_WORDS.has(s.tok.n))
}

/**
 * Πού αρχίζει η φράση μετά από "όταν λέω" / "μάθε": χωρίς "ότι", "τη λέξη",
 * "νέα φράση", "αυτό που λέμε"
 */
function skipLeadIn(ws: Word[], xs: number, end: number): number {
  let j = xs
  for (let guard = 0; guard < 4 && j < end; guard++) {
    const w = ws[j].n
    const nx = ws[j + 1]?.n ?? ''
    if (w === 'οτι' || w === 'πωσ') { j++; continue }
    if (['τη', 'την', 'μια', 'μιαν', 'νεα', 'νεεσ', 'καινουργια', 'καινουρια', 'αλλη'].includes(w) && WORD_NOUN.has(nx)) { j += 2; continue }
    if (WORD_NOUN.has(w)) { j++; continue }
    if ((w === 'αυτο' || w === 'αυτα') && nx === 'που' && SAY.has(ws[j + 2]?.n ?? '')) { j += 3; continue }
    // "όταν λέει ο πελάτης Χ": το υποκείμενο δεν είναι μέρος της φράσης
    if ((w === 'ο' || w === 'οι') && ['πελατησ', 'πελατεσ', 'κοσμοσ', 'σεφ', 'μαγειρασ', 'ταμιασ'].includes(nx)) { j += 2; continue }
    if (w === 'καποιοσ' || w === 'κανεισ' || w === 'ολοι') { j++; continue }
    break
  }
  return j
}

/** "όταν (σου) λέω", "όποτε λέμε", "αν πω", "κάθε φορά που λέω": θέση μετά το ρήμα, και αν είναι αδύναμο ("αν") */
function whenSay(ws: Word[], free: (k: number) => boolean): { xs: number; weak: boolean } | null {
  for (let k = 0; k < ws.length; k++) {
    if (!free(k)) continue
    let j = -1
    let weak = false
    if (WHEN.has(ws[k].n)) { j = k + 1; weak = ws[k].n === 'αν' || ws[k].n === 'εαν' }
    else if (ws[k].n === 'καθε' && ws[k + 1]?.n === 'φορα' && ws[k + 2]?.n === 'που') j = k + 3
    else if (k <= 1 && (ws[k].n === 'αυτο' || ws[k].n === 'αυτα') && ws[k + 1]?.n === 'που') { j = k + 2; weak = true }
    if (j < 0) continue
    let f = 0
    while (f < 2 && SAY_FILL.has(ws[j]?.n ?? '')) { j++; f++ }
    // "όταν θα πει ο μύλος την τιμή": τρίτο πρόσωπο, μόνο με λέξη σημασίας
    if (SAY.has(ws[j]?.n ?? '') && free(j)) return { xs: j + 1, weak: weak || SAY3.has(ws[j].n) }
  }
  return null
}

/**
 * "όταν (σου) λέω Χ εννοώ / θέλω να πω / να καταλαβαίνεις Υ", "μάθε ότι Χ
 * σημαίνει Υ", "Χ σημαίνει / θα πει Υ", "το Χ είναι το Υ" (τα δύο τελευταία
 * μόνο όταν το Υ είναι είδος ή συναλλασσόμενος του καταλόγου και το Χ δεν
 * μοιάζει με κομμάτι συνηθισμένης πρότασης, για να μην κλέβει προτάσεις).
 * Η φράση και η σημασία μένουν όπως ειπώθηκαν (χωρίς κανονικοποίηση).
 */
function teach(text: string, ctx: InterpretContext): Omit<Interpretation, 'text'> | null {
  const ws = words(text)
  if (ws.length < 3) return null
  const quotes = [...text.matchAll(/«[^»]*»|“[^”]*”|"[^"]*"/g)].map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length])
  const free = (k: number) => !quotes.some(([a, b]) => ws[k].from > a && ws[k].to < b)
  const findMean = (from: number, onlyIs: boolean): number => {
    for (let k = from; k < ws.length; k++) if (free(k) && meanLen(ws, k, onlyIs)) return k
    return -1
  }
  const example = { command: { kind: 'unknown' } as Command, confidence: 0, issues: [TEACH_EXAMPLE] }
  // ρητή διδασκαλία: "όταν λέω …", "μάθε (ότι) …", "νέα λέξη …"
  const when = whenSay(ws, free)
  const ti = ws.findIndex((w, k) => k <= 2 && TEACH.has(w.n) && free(k))
  const ni = ws.findIndex((w, k) => k <= 1 && ['νεα', 'καινουργια', 'καινουρια'].includes(w.n) && WORD_NOUN.has(ws[k + 1]?.n ?? '') && free(k))
  let xs = when ? when.xs : ti >= 0 ? ti + 1 : ni >= 0 ? ni + 2 : -1
  let weak = !!when?.weak || (!when && ti < 0 && ni >= 0)
  // δίχτυ ασφαλείας: "λέω Χ και εννοώ Υ" (ρήμα "λέω" και πιο μετά "εννοώ" / "θέλω να πω"): ποτέ πώληση
  if (xs < 0) {
    const si = ws.findIndex((w, k) => SAY.has(w.n) && free(k))
    if (si >= 0 && ws.some((w, k) => k > si + 1 && free(k) && (MEAN_STRONG.has(w.n) || (w.n.startsWith('θελ') && meanLen(ws, k) === 3)))) {
      xs = si + 1
      weak = false
    }
  }
  const explicit = xs >= 0
  /** μισή / άδεια διδασκαλία: παράδειγμα μόνο όταν ήταν σίγουρα διδασκαλία */
  const fail = () => (explicit && !weak ? example : null)
  let onlyIs = false
  let conf = 0.95
  let mi: number
  if (explicit) {
    mi = findMean(xs + 1, false)
    // "μάθε πόση μοτσαρέλα έχουμε": όχι διδασκαλία
    if (mi < 0) return when && !weak ? example : null
    // "αυτό που λέμε τυρί είναι η μοτσαρέλα", "αν πω Χ είναι Υ": με "είναι" μόνο γνωστό Υ
    if (weak && ws[mi].n === 'ειναι') onlyIs = true
  } else {
    // "Χ σημαίνει Υ"· "Χ θα πει / είναι Υ" μόνο με γνωστό Υ
    xs = 0
    mi = ws.findIndex((w, k) => k > 0 && (w.n === 'σημαινει' || w.n === 'σημαινουν') && free(k))
    conf = 0.9
    if (mi < 0) {
      mi = ws.findIndex((_w, k) => k > 0 && free(k) && mightMean(ws, k) > 0)
      if (mi < 0) mi = findMean(1, true)
      if (mi < 0) return null
      onlyIs = true
      conf = 0.8
    }
    const xw = ws.slice(0, mi).map((w) => w.n)
    if (xw.length > (onlyIs ? 6 : 8) || QUESTION.has(xw[0]) || xw.every((w) => isStop(w) || QUESTION.has(w))) return null
  }
  const mlen = onlyIs && mightMean(ws, mi) ? mightMean(ws, mi) : meanLen(ws, mi, onlyIs)
  let ys = mi + mlen
  if (ws[ys]?.n === 'οτι' || ws[ys]?.n === 'πωσ') ys++
  if (ys >= ws.length) return fail()
  xs = skipLeadIn(ws, xs, mi)
  if (xs >= mi) return fail()
  let phrase = text.slice(ws[xs].from, ws[mi].from)
  // "νέα λέξη: οικογενειακή" → μετά την άνω κάτω τελεία· "το «χτύπα»" → μέσα στα εισαγωγικά
  const q = /«([^»]*)»|“([^”]*)”|"([^"]*)"/.exec(phrase)
  const inQ = q ? (q[1] ?? q[2] ?? q[3] ?? '').trim() : ''
  if (inQ) phrase = inQ
  else if (phrase.includes(':')) phrase = phrase.slice(phrase.lastIndexOf(':') + 1)
  phrase = phrase.replace(EDGE_JUNK, '').replace(/\s+(και|κι)$/i, '').replace(EDGE_JUNK, '')
  const meaning = text.slice(ws[ys].from).replace(EDGE_JUNK, '')
  if (!phrase || !meaning) return fail()
  const pKey = phraseKey(phrase)
  const mKey = phraseKey(meaning)
  if (!pKey) return fail()
  // "μάθε ότι η μαργαρίτα είναι 8 ευρώ": τιμή, όχι φράση
  if (ws[mi].n === 'ειναι' && onlyPrice(meaning)) return null
  if (!explicit) {
    // "Χ είναι Υ" / "Χ σημαίνει Υ": όχι κομμάτια συνηθισμένων προτάσεων
    if (ordinaryWords(phrase, onlyIs)) return null
  }
  if (onlyIs) {
    // "το τυρί είναι η μοτσαρέλα": η σημασία πρέπει να είναι όνομα του καταλόγου
    if (NOT_NAME_START.has(ws[ys].n) || pKey === mKey) return null
    const id = resolvesWhole(meaning, ctx)
    if (!id || resolvesWhole(phrase, ctx) === id) return null
  }
  if (pKey === mKey) return { command: { kind: 'unknown' }, confidence: 0, issues: ['Η φράση και η σημασία της είναι ίδιες.'] }
  if (parseYesNo(phrase) !== null) {
    return { command: { kind: 'unknown' }, confidence: 0, issues: [`Το «${phrase}» το κρατάμε για το «ναι» / «όχι»· διάλεξε άλλη λέξη.`] }
  }
  const issues: string[] = []
  if (phrase.length > 200 || meaning.length > 200) {
    issues.push('Πολύ μεγάλη φράση: έως 200 γράμματα.')
    conf = Math.min(conf, 0.4)
  }
  const old = (Array.isArray(ctx?.phrases) ? ctx.phrases : []).find((r) => r && phraseKey(String(r.phrase ?? '')) === pKey)
  if (old) issues.push(`Υπάρχει ήδη: «${old.phrase}» σημαίνει «${old.meaning}»· θα αλλάξει.`)
  // "η Special" πιάνει και σκέτο "Special"
  const bare = pKey.replace(/^(ο|η|το|οι|τα|τον|την|τη|του|τησ|των|τισ) (?=\S)/, '')
  const named = [...(ctx?.items ?? []), ...(ctx?.partners ?? [])]
    .find((e) => e?.is_active && [e.name, ...(e.aliases ?? [])].some((x) => { const k = phraseKey(String(x ?? '')); return k === pKey || k === bare }))
  if (named) issues.push(`Το «${phrase}» είναι ήδη όνομα στον κατάλογο (${named.name})· η φράση θα μετράει πρώτη.`)
  else {
    // "ζυμάρι" → «Ζυμάρι 400γρ»: στο "ζυμάρι 400" μένει το όνομα του καταλόγου
    const longer = phraseStartsName(phrase, ctx, meaning) ?? (bare !== pKey ? phraseStartsName(bare, ctx, meaning) : null)
    if (longer) issues.push(`Το «${phrase}» είναι και η αρχή του «${longer}»· εκεί θα κρατάω το όνομα του καταλόγου.`)
  }
  return { command: { kind: 'new_phrase', phrase, meaning }, confidence: conf, issues }
}

// ---------------------------------------------------------------------
function run(text: string, ctx: InterpretContext): Interpretation {
  const a = new Analysis(text, ctx)
  const d = decide(a)
  let b: Built
  switch (d.kind) {
    case 'sale_tally': b = buildSaleTally(a); break
    case 'sale': b = buildSale(a); break
    case 'purchase': b = buildPurchase(a); break
    case 'production': b = buildProduction(a); break
    case 'stocktake': b = buildStocktake(a); break
    case 'receipt': b = buildMoney(a, 'receipt'); break
    case 'payment': b = buildMoney(a, 'payment'); break
    case 'new_item': b = buildNewItem(a); break
    case 'new_partner': b = buildNewPartner(a); break
    case 'recipe': b = buildRecipe(a); break
    case 'item_price': b = buildItemPrice(a); break
    case 'partner_price': b = buildPartnerPrice(a); break
    case 'query_stock': b = buildQueryStock(a); break
    case 'query_balance': b = buildQueryBalance(a); break
    case 'close_day': case 'close_stocktake': case 'undo': case 'query_today': case 'help':
      b = { command: { kind: d.kind }, conf: 1 }
      break
    default:
      return { text, command: { kind: 'unknown' }, confidence: 0, issues: d.issue ? [d.issue] : [] }
  }
  if (d.issue) a.issues.unshift(d.issue)
  const issues = Array.from(new Set(a.issues))
  const conf = d.conf * b.conf * a.cap * (a.loose ? 0.7 : 1)
  const confidence = Math.max(0.05, Math.min(1, Math.round(conf * 100) / 100))
  return { text, command: b.command, confidence, issues }
}

/**
 * Κείμενο → εντολή. Πρώτα οι δικές τους φράσεις (ctx.phrases), σιωπηλά·
 * το Interpretation.text μένει το αρχικό. Η "νέα φράση" ("όταν λέω Χ εννοώ
 * Υ") διαβάζεται πριν από τις φράσεις, για να μην αλλάξει η ίδια.
 * Δεν πετάει ποτέ: σε σφάλμα επιστρέφει 'unknown'.
 */
export function interpret(text: string, ctx: InterpretContext): Interpretation {
  const t = typeof text === 'string' ? text : String(text ?? '')
  try {
    const src = t.slice(0, 500)
    const taught = teach(src, ctx)
    if (taught) return { ...taught, text: t }
    return { ...run(applyPhrases(src, ctx?.phrases, ctx).slice(0, 1000), ctx), text: t }
  } catch {
    return { text: t, command: { kind: 'unknown' }, confidence: 0, issues: [] }
  }
}

/**
 * Προετοιμασία ευρετηρίου του καταλόγου (π.χ. όταν ανοίγει η οθόνη), ώστε η
 * πρώτη φράση να μην πληρώνει το χτίσιμό του. Δεν πετάει ποτέ.
 */
export function warmUp(ctx: InterpretContext): void {
  try {
    getIndex(Array.isArray(ctx?.items) ? ctx.items : [], Array.isArray(ctx?.partners) ? ctx.partners : [])
    interpret('efood 2 μαργαρίτες', ctx)
  } catch {
    // τίποτα
  }
}

/**
 * Ποσότητα από ό,τι ακούστηκε ("500 γραμμάρια", "2 σακιά και 10 κιλά",
 * "3 μείον 1") στη μονάδα ενός είδους. Για την οθόνη: όταν ο χρήστης
 * διαλέγει είδος σε γραμμή που δεν είχε σίγουρο id, η ποσότητα πρέπει να
 * ξαναμετατραπεί. null αν δεν βγαίνει (π.χ. κιλά σε είδος με τεμάχια).
 */
export function qtyForItem(heardQty: string | null | undefined, item: Item | null | undefined): number | null {
  try {
    if (!heardQty || !item) return null
    const segs = segment(tokenize(heardQty))
    let total = 0
    let any = false
    let sign = 1
    let lastUnit: MeasureUnit | null = null
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i]
      if (s.t === 'w') {
        if (MINUS_PRE.has(s.tok.n)) sign = -1
        continue
      }
      if (s.t !== 'n') continue
      let v = s.value
      const nx = segs[i + 1]
      const w = nx?.t === 'w' ? nx.tok.n : null
      const u = w ? unitWord(w) : null
      if (u && isMeasureUnit(u)) {
        const c = convertUnit(v, u, item.unit)
        if (c === null) return null
        v = c
        lastUnit = u
        i++
      } else if (w && (genericPack(w) || isItemPack(w, item))) {
        const pq = Number(item.pack_qty)
        if (!isItemPack(w, item) || !(pq > 0)) return null
        v *= pq
        lastUnit = null
        i++
      } else if (s.half && lastUnit) {
        // "ένα κιλό και μισό"
        const c = convertUnit(v, lastUnit, item.unit)
        if (c === null) return null
        v = c
      }
      total += sign * v
      sign = 1
      any = true
    }
    return any ? round(total, 6) : null
  } catch {
    return null
  }
}

export const localInterpreter: Interpreter = { interpret }
