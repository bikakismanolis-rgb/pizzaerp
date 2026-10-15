import type { Item, ItemType, Partner } from '../types'
import type {
  Command, EntityRef, InterpretContext, Interpretation, Interpreter, PricedLine, QtyLine, TallyChannel,
} from './types'
import { capFirst, norm, titleCase, tokenize, type Tok } from './normalize'
import { segment, type NumSeg, type Seg } from './numbers'
import {
  AFM_WORDS, CENTS, CITY_PREP, EACH, MONEY, PER_ART, PHONE_WORDS, PRICE_PREP, REF_WORDS, TOTAL, UNIT_SHORT, VAT,
  channelAt, convertUnit, cueOf, genericPack, isItemPack, isMeasureUnit, isStop, unitWord,
  type Cue, type MeasureUnit,
} from './lexicon'
import { Matcher, emptyRef, getIndex, toRef, type Hit, type Index, type Pool, type Role, type Scored } from './match'

/**
 * Τοπικός interpreter (χωρίς API): κείμενο → εντολή.
 * Στρώσεις: tokens + κανονικοποίηση → αριθμοί → λέξεις εντολής / κανάλια →
 * απόφαση εντολής → φράσεις-οντότητες (είδη, συναλλασσόμενοι) → ζευγάρωμα
 * ποσοτήτων / τιμών / μονάδων → Command. Δεν πετάει ποτέ εξαίρεση.
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
}

interface Ent {
  from: number
  to: number
  hit: Hit
  unknown: boolean
}

interface Line {
  ent: Ent
  qty: NumInfo | null
  /** επιπλέον ποσότητες που προστίθενται ("2 σακιά και 10 κιλά") */
  more?: NumInfo[]
  price: NumInfo | null
}

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
  /** τμήματα που "καταναλώθηκαν" από πεδία (αρ. τιμολογίου, ΦΠΑ ...) */
  used = new Set<number>()
  gross: boolean | null = null
  vatRate: number | null = null

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

  /** Λέξεις "περιεχομένου": όχι γέμισμα, όχι λέξεις εντολών */
  contentCount(): number {
    let n = 0
    this.segs.forEach((s, i) => {
      if (s.t === 'n') n++
      else if (s.t === 'w' && !isStop(s.tok.n) && !this.cue[i]) n++
    })
    return n
  }

  roles(reserveChannels: boolean, extraBlock?: Set<number>): Role[] {
    return this.segs.map((s, i) => {
      if (this.used.has(i) || extraBlock?.has(i)) return 'block'
      if (s.t === 's') return 'block'
      if (s.t === 'n') return s.pct ? 'block' : 'num'
      const n = s.tok.n
      if (reserveChannels && this.chan[i]) return 'block'
      const c = this.cue[i]
      if (c && c !== 'pizza') return 'block'
      if (unitWord(n)) return 'unit'
      if (this.packSlot(i)) return 'unit'
      if (MONEY.has(n) || CENTS.has(n) || VAT.has(n) || TOTAL.has(n) || PRICE_PREP.has(n) || n === 'ανα' || n === '%') return 'block'
      if (REF_WORDS.has(n) || PHONE_WORDS.has(n) || AFM_WORDS.has(n)) return 'block'
      if (isStop(n)) return 'stop'
      return 'content'
    })
  }

  /** Εντοπισμός οντοτήτων + λέξεων που δεν βρέθηκαν */
  scan(pool: Pool, reserveChannels: boolean, lo = 0, hi = this.segs.length, extraBlock?: Set<number>) {
    const roles = this.roles(reserveChannels, extraBlock)
    const hits = this.m.find(roles, pool, lo, hi)
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

  /** "με ΦΠΑ", "χωρίς ΦΠΑ", "ΦΠΑ 24", "24%" */
  markVat() {
    this.segs.forEach((s, i) => {
      const n = this.w(i)
      if (n && VAT.has(n)) {
        this.used.add(i)
        const p = this.w(i - 1)
        const pp = this.w(i - 2)
        if (p === 'με') { this.gross = true; this.used.add(i - 1); if (pp === 'μαζι') this.used.add(i - 2) }
        else if (p && ['χωρισ', 'συν', 'πλεον', 'προ', 'εκτοσ', 'ανευ'].includes(p)) { this.gross = false; this.used.add(i - 1) }
        const nx = this.num(i + 1)
        if (nx && nx.value > 0 && nx.value <= 30) { this.vatRate = nx.value; this.used.add(i + 1) }
        else if (this.w(i + 1) === 'με' || this.w(i + 1) === 'στο' || this.w(i + 1) === 'στα') {
          const n2 = this.num(i + 2)
          if (n2 && n2.value > 0 && n2.value <= 30) { this.vatRate = n2.value; this.used.add(i + 1); this.used.add(i + 2) }
        }
      } else if (n && ['καθαρη', 'καθαρα', 'καθαρο', 'καθαρησ', 'καθαρων'].includes(n) && (this.num(i - 1) || this.num(i + 1))) {
        this.gross = false
        this.used.add(i)
      } else if (s.t === 'n' && s.pct && [6, 13, 24].includes(s.value)) {
        this.vatRate = s.value
        this.used.add(i)
      }
    })
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
      const u = skip.has(j) ? null : this.unitAt(j)
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
      if (tw && TOTAL.has(tw) && !info.unit && !info.pack) { info.total = true; j++; if (this.w(j) === 'μαζι') j++ }
      const prev = this.w(i - 1)
      const prev2 = this.w(i - 2)
      if (prev && (TOTAL.has(prev) || (prev === 'μαζι' && prev2 && TOTAL.has(prev2)))) info.total = true
      if (prev && (PRICE_PREP.has(prev) || this.cue[i - 1] === 'price')) info.prep = true
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
    return this.heard(x.i, x.qtyEnd)
  }
}

// ---------------------------------------------------------------------
// Ζευγάρωμα ποσοτήτων / τιμών με είδη
// ---------------------------------------------------------------------
const isPriceNum = (x: NumInfo) => x.money || !!x.per || x.total || x.prep

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

function pairLines(a: Analysis, known: Ent[], unknown: Ent[], nums: NumInfo[], priced: boolean, pool: Pool): Line[] {
  const ents = known.slice().sort((x, y) => x.from - y.from)
  const lines: Line[] = ents.map((e) => ({ ent: e, qty: null, price: null }))
  const k = lines.length
  // "60 σπέσιαλ κατεψυγμένες 3,90": δεκαδικός χωρίς μονάδα δίπλα σε είδος σε τεμάχια = τιμή
  const unitOfNear = (x: NumInfo) => {
    let near: Ent | undefined
    for (const e of ents) if (e.to <= x.i) near = e
    near = near ?? ents.find((e) => e.from >= x.end)
    return near?.hit.ranked[0]?.entry.item?.unit ?? null
  }
  const looksPrice = (x: NumInfo) =>
    isPriceNum(x) || (!Number.isInteger(x.value) && !x.unit && !x.pack && !x.half && unitOfNear(x) === 'τεμ')
  const qn = nums.filter((x) => !x.size && !x.pct && !(priced && looksPrice(x)) && !(!priced && (x.money || x.per)))
  const pn = priced ? nums.filter((x) => !x.size && !x.pct && looksPrice(x)) : []
  const gapOf = (pos: number) => { let g = 0; while (g < k && ents[g].to <= pos) g++; return g }
  const give = (g: number, x: NumInfo) => {
    if (g >= 0 && g < k && !lines[g].qty) { lines[g].qty = x; return true }
    return false
  }
  const left: NumInfo[] = []
  if (k === 0) left.push(...qn)
  else {
    const gaps: NumInfo[][] = Array.from({ length: k + 1 }, () => [])
    for (const x of qn) gaps[gapOf(x.i)].push(x)
    // "3 μαργαρίτες 2 σπέσιαλ" (πριν) ή "μοτσαρέλα 6 αλεύρι 47" (μετά) ή ανάμεικτο
    const style = gaps[0].length && !gaps[k].length ? 'pre' : gaps[k].length && !gaps[0].length ? 'post' : 'mixed'
    gaps[0].forEach((x, j) => { if (!(j === gaps[0].length - 1 && give(0, x))) left.push(x) })
    for (let g = 1; g < k; g++) {
      const L = gaps[g]
      if (!L.length) continue
      if (L.length >= 2) {
        if (style === 'post') {
          if (!give(g - 1, L[0])) left.push(L[0])
          left.push(...L.slice(1))
        } else if (style === 'pre') {
          const last = L[L.length - 1]
          left.push(...L.slice(0, -1))
          if (!give(g, last)) left.push(last)
        } else {
          if (!give(g - 1, L[0])) left.push(L[0])
          left.push(...L.slice(1, -1))
          const last = L[L.length - 1]
          if (!give(g, last)) left.push(last)
        }
      } else {
        const x = L[0]
        const sb = a.sepBetween(ents[g - 1].to, x.i)
        const sa = a.sepBetween(x.end, ents[g].from)
        let toLeft = style === 'post'
        if (sb && !sa) toLeft = false
        else if (sa && !sb) toLeft = true
        const ok = toLeft ? give(g - 1, x) || give(g, x) : give(g, x) || give(g - 1, x)
        if (!ok) left.push(x)
      }
    }
    gaps[k].forEach((x, j) => { if (!(j === 0 && give(k - 1, x))) left.push(x) })
  }
  // "αλεύρι 2 σακιά και 10 κιλά", "μοτσαρέλα 5 κιλά και άλλα 2": πρόσθεση στην ίδια γραμμή
  const MORE = new Set(['αλλα', 'αλλεσ', 'αλλουσ', 'αλλοι', 'αλλο', 'αλλη', 'ακομα', 'ακομη', 'επιπλεον', 'συν'])
  const glue = (p: number, q: number, ent: Ent) => {
    let more = false
    for (let i = p; i < q; i++) {
      if (i >= ent.from && i < ent.to) continue
      const s = a.segs[i]
      if (s.t !== 'w') return null
      const n = s.tok.n
      if (MORE.has(n)) more = true
      else if (!(n === 'και' || n === 'κι' || isStop(n))) return null
    }
    return { more }
  }
  const sameUnit = (x: NumInfo, y: NumInfo) => (x.unit && x.unit === y.unit) || (x.pack && x.pack === y.pack)
  for (const x of left.slice()) {
    for (const l of lines) {
      const prev = l.more?.length ? l.more[l.more.length - 1] : l.qty
      if (!prev || prev.i > x.i) continue
      const gl = glue(prev.end, x.i, l.ent)
      const after = a.w(x.end)
      const explicit = !!gl?.more || after === 'ακομα' || after === 'επιπλεον'
      if (!gl || (!prev.unit && !prev.pack && !explicit)) continue
      if (!x.unit && !x.pack) {
        // "5 κιλά και άλλα 2": ίδια μονάδα με πριν
        if (!explicit) continue
        l.more = [...(l.more ?? []), { ...x, unit: prev.unit, pack: prev.pack }]
      } else if (explicit || !sameUnit(prev, x)) {
        l.more = [...(l.more ?? []), x]
      } else continue
      left.splice(left.indexOf(x), 1)
      break
    }
  }
  // περισσευούμενοι αριθμοί: σε λέξεις που δεν βρέθηκαν ("δύο καλτσόνε")
  const extra: Line[] = []
  const rest: NumInfo[] = []
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
    if (ui >= 0) {
      extra.push({ ent: free[ui], qty: x, price: null })
      free.splice(ui, 1)
    } else if (x.pack && packRanked(a, x.pack, pool).length) {
      const hit: Hit = { from: x.i, to: x.qtyEnd, heard: a.heard(x.qtyEnd - 1, x.qtyEnd), ranked: packRanked(a, x.pack, pool), unknown: true }
      extra.push({ ent: { from: x.i, to: x.qtyEnd, hit, unknown: true }, qty: x, price: null })
    } else rest.push(x)
  }
  const all = lines.concat(extra).sort((p, q) => p.ent.from - q.ent.from)
  if (priced) {
    // τιμές: στο είδος αριστερά (που δεν έχει τιμή), αλλιώς δεξιά
    const prices = pn.concat(rest).sort((p, q) => p.i - q.i)
    for (const p of prices) {
      let target: Line | null = null
      for (const l of all) if (l.ent.to <= p.i && !l.price) target = l
      if (!target) target = all.find((l) => l.ent.from >= p.end && !l.price) ?? null
      if (target) target.price = p
    }
  }
  return all
}

/** Ποσότητα γραμμής (με τις επιπλέον ποσότητες) στη μονάδα του είδους */
function lineQty(a: Analysis, l: Line, item: Item | null, label: string): number | null {
  const q = qtyFor(a, l.qty, item, label)
  if (q === null || !l.more?.length) return q
  return round(l.more.reduce((s, x) => s + (qtyFor(a, x, item, label) ?? 0), q), 6)
}

function lineHeardQty(a: Analysis, l: Line): string | undefined {
  if (!l.qty) return undefined
  return [l.qty, ...(l.more ?? [])].map((x) => a.heardQty(x)).join(' και ')
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

/** Τιμή ανά μονάδα είδους, χωρίς ΦΠΑ */
function priceFor(a: Analysis, l: Line, item: Item | null, qty: number | null): number | null {
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
    // χωρίς "το κιλό" / "σύνολο": ανά μονάδα, ανά συσκευασία ή σύνολο γραμμής;
    const pq = Number(item.pack_qty)
    const inPacks = !!l.qty?.pack && pq > 0 && isItemPack(l.qty.pack, item)
    const options = [inPacks ? v / pq : v, v / qty]
    const avg = Number(item.avg_cost)
    if (avg > 0) {
      // το πιο κοντινό στο μέσο κόστος
      const dist = (x: number) => Math.abs(Math.log(x / avg))
      v = options.reduce((b, x) => (x > 0 && dist(x) < dist(b) ? x : b), options[0])
    } else if (inPacks && l.qty && l.qty.value > 1 && v > 50) v = options[1]
    else v = options[0]
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

/** Προειδοποίηση για αναφορά χωρίς σίγουρο id */
function refIssue(a: Analysis, r: EntityRef, what: string) {
  if (r.id) return
  if (!r.heard) { a.issues.push(`Δεν ακούστηκε ${what}.`); return }
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
}

function decide(a: Analysis): Decision {
  const has = (...c: Cue[]) => a.has(...c)
  if (a.contentCount() === 0 && !a.cue.some(Boolean) && !a.hasChannel()) return { kind: 'unknown', conf: 0 }
  const txt = a.toks.filter((t) => !t.sep).map((t) => t.n).join(' ')
  if (has('help') || /(^| )τι (μπορω|λεω|να πω|ξερεισ|κανω)/.test(txt) || /πωσ (δουλευ|λειτουργ)/.test(txt)) return { kind: 'help', conf: 0.95 }
  const nums = a.segs.some((s) => s.t === 'n')
  // κλεισίματα
  if (has('close') && has('stocktakeNoun')) return { kind: 'close_stocktake', conf: 0.95 }
  if (has('close') && (has('dayNoun') || has('today') || (has('sell') && !nums))) return { kind: 'close_day', conf: 0.95 }
  if (has('close') && !nums && a.contentCount() <= 1 && /^(κλεισ|τελοσ)/.test(txt)) return { kind: 'close_day', conf: 0.7 }
  // αναίρεση
  if (has('undo') && !has('new')) return { kind: 'undo', conf: /τελευται/.test(txt) ? 0.95 : 0.85 }
  if (has('wrong') && a.contentCount() <= 1) return { kind: 'undo', conf: 0.7 }
  // νέο είδος / συναλλασσόμενος
  if (has('new') && !has('order', 'sell', 'buy', 'take1', 'produce', 'count')) {
    if (has('customerWord', 'supplierWord')) return { kind: 'new_partner', conf: 0.9 }
    return { kind: 'new_item', conf: has('typeRaw', 'typeSemi', 'typeFinished', 'pizza') || /νε(α|εσ) πρωτ(η|εσ) υλ/.test(txt) ? 0.9 : 0.7 }
  }

  // προκαταρκτικός εντοπισμός οντοτήτων
  const pre = a.scan(POOL.all, true)
  const ph = pre.hits.filter((h) => topKind(h) === 'partner' && (h.ranked[0]?.score ?? 0) >= 0.6)
  const ih = pre.hits.filter((h) => topKind(h) === 'item')
  const partner = ph[0]?.ranked[0]?.entry.partner ?? null
  const itemsOf = ih.map((h) => h.ranked[0].entry.item as Item)
  const moneyNum = a.segs.some((s, i) => s.t === 'n' && (MONEY.has(a.w(i + 1) ?? '') || CENTS.has(a.w(i + 1) ?? '')))
  const isCustomer = !!partner?.is_customer
  const isSupplier = !!partner?.is_supplier

  // ερωτήσεις
  // "πόσο κάνει η μαργαρίτα;": ερώτηση τιμής, δεν υποστηρίζεται (και δεν πρέπει να γίνει αλλαγή τιμής)
  if (has('question') && has('priceVerb', 'price') && !has('owe1', 'owe3')) return { kind: 'unknown', conf: 0 }
  const asked = has('question') || a.toks.some((t) => t.raw === '?' || t.raw === ';' || t.raw === '\u037e')
  if (asked && !nums && has('have', 'remain', 'stockNoun') && ih.length) return { kind: 'query_stock', conf: 0.85 }
  if (has('question', 'owe1', 'owe3') || (has('balance', 'stockNoun') && !nums)) {
    if (has('owe1', 'owe3') || (has('balance') && ph.length)) return { kind: 'query_balance', conf: 0.9 }
    if (has('today') && !ih.length) return { kind: 'query_today', conf: 0.9 }
    if (has('sell') && !ih.length) return { kind: 'query_today', conf: 0.8 }
    if (has('today') && ih.length) return { kind: 'query_today', conf: 0.7 }
    if (ih.length) return { kind: 'query_stock', conf: 0.9 }
    if (ph.length) return { kind: 'query_balance', conf: 0.75 }
    if (has('stockNoun', 'remain', 'have')) return { kind: 'query_stock', conf: 0.5 }
    if (has('question') && has('pizza')) return { kind: 'query_today', conf: 0.6 }
  }
  // συνταγή
  if (has('recipe')) return { kind: 'recipe', conf: 0.9 }
  const rv = a.at('recipeVerb')
  if (rv >= 0) {
    const before = pre.hits.filter((h) => h.to <= rv)
    const after = ih.filter((h) => h.from > rv)
    // υποκείμενο: το πρώτο έτοιμο/ημιέτοιμο ή ο πρώτος συναλλασσόμενος πριν από το ρήμα
    const subj = before.find((h) => topKind(h) === 'partner' || h.ranked[0].entry.item?.item_type !== 'raw')
    if (subj && topKind(subj) === 'item' && after.length) {
      return { kind: 'recipe', conf: 0.85 }
    }
    if (subj && topKind(subj) === 'partner' && after.length) {
      const afterNum = a.segs.some((s, i) => s.t === 'n' && i > after[0].from)
      const beforeNum = a.segs.some((s, i) => s.t === 'n' && i > rv && i < after[0].from)
      if (afterNum && !beforeNum) return { kind: 'partner_price', conf: 0.8 }
      if (beforeNum) return { kind: 'sale', conf: 0.65 }
    }
  }
  // τιμές
  const trade = has('buy', 'sell', 'take1', 'take3', 'invoice', 'note', 'order', 'brought', 'produce', 'count', 'pay', 'receive')
  if (has('price', 'priceVerb') && !trade && !a.hasChannel()) {
    // "2 μαργαρίτες κάνουν 16": ποσότητα πριν από το είδος → πώληση, όχι αλλαγή τιμής
    const first = ih[0]
    const qtyBefore = !!first && a.segs.some((s, i) => s.t === 'n' && i < first.from && !MONEY.has(a.w(i + 1) ?? ''))
    if (!ph.length && qtyBefore) return { kind: 'sale_tally', conf: 0.6 }
    return { kind: ph.length ? 'partner_price' : 'item_price', conf: 0.9 }
  }
  // χρήματα
  if (has('receive')) return { kind: 'receipt', conf: 0.9 }
  if (has('pay')) {
    // "πλήρωσα 10 σακιά αλεύρι 155 ευρώ": αγορά τοις μετρητοίς
    if (ih.length && nums) return { kind: 'purchase', conf: 0.6 }
    return { kind: 'payment', conf: 0.9 }
  }
  if (has('paid3', 'gave3')) {
    if (ih.length && !moneyNum && has('gave3') && isCustomer) return { kind: 'sale', conf: 0.6 }
    if (isSupplier && !isCustomer) return { kind: 'payment', conf: 0.85 }
    return { kind: 'receipt', conf: ph.length ? 0.9 : 0.75 }
  }
  if ((has('take1') || has('brought')) && !ih.length && (moneyNum || (nums && isCustomer))) {
    if (isSupplier && !isCustomer && has('brought')) return { kind: 'purchase', conf: 0.5 }
    return { kind: 'receipt', conf: ph.length ? 0.85 : 0.7 }
  }
  // συναλλαγές
  if (has('buy')) return { kind: 'purchase', conf: 0.9 }
  if (has('take1', 'brought') && nums && !moneyNum && !ih.length && !isCustomer) return { kind: 'purchase', conf: 0.55 }
  if (has('take1', 'brought') && ih.length) return { kind: 'purchase', conf: isCustomer && !isSupplier ? 0.6 : 0.85 }
  if (has('invoice', 'note', 'order')) {
    if (a.hasChannel() && !ph.length) return { kind: 'sale_tally', conf: 0.85 }
    if (isCustomer && !isSupplier) return { kind: 'sale', conf: 0.85 }
    if (isSupplier) return { kind: 'purchase', conf: 0.85 }
    if (itemsOf.length && itemsOf.every((it) => it.item_type === 'finished')) return { kind: 'sale', conf: 0.6 }
    return { kind: 'purchase', conf: has('invoice') ? 0.7 : 0.55 }
  }
  if (has('sell', 'take3')) {
    if (ph.length && !a.hasChannel()) return { kind: 'sale', conf: isCustomer ? 0.9 : 0.6 }
    if (has('take3') && !a.hasChannel()) return { kind: 'sale', conf: 0.6 }
    if (!a.hasChannel() && itemsOf.length && itemsOf.every((it) => it.item_type === 'finished' && !it.make_to_order)) {
      return { kind: 'sale', conf: 0.6 }
    }
    return { kind: 'sale_tally', conf: 0.9 }
  }
  if (has('produce', 'knead')) return { kind: 'production', conf: 0.9 }
  if (has('count', 'stocktakeNoun', 'remain', 'have')) return { kind: 'stocktake', conf: has('count', 'stocktakeNoun') ? 0.9 : 0.75 }
  if (a.hasChannel()) return { kind: 'sale_tally', conf: 0.85 }
  // χωρίς ρήμα: από τα είδη
  if (ph.length && ih.length) {
    // "στο Αστέρια η σπέσιαλ 3,90": μόνο τιμή, καμία ποσότητα → ειδική τιμή πελάτη
    const nn = a.segs.filter((s): s is NumSeg => s.t === 'n')
    if (isCustomer && ih.length === 1 && nn.length === 1 && (!Number.isInteger(nn[0].value) || moneyNum)) {
      return { kind: 'partner_price', conf: 0.55 }
    }
    return { kind: isSupplier && !isCustomer ? 'purchase' : 'sale', conf: 0.55 }
  }
  if (ph.length && nums) return { kind: isSupplier && !isCustomer ? 'payment' : 'receipt', conf: 0.45 }
  if (ih.length) {
    const allFin = itemsOf.every((it) => it.item_type === 'finished')
    if (allFin && ih.length === 1 && moneyNum) return { kind: 'item_price', conf: 0.55 }
    if (allFin) return { kind: 'sale_tally', conf: nums ? 0.75 : 0.6 }
    if (nums) return { kind: 'stocktake', conf: 0.45 }
  }
  if (has('stockNoun')) return { kind: 'query_stock', conf: 0.5 }
  return { kind: 'unknown', conf: 0 }
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
    if (a.w(j) === 'αριθμοσ' || a.w(j) === 'αριθμο' || a.w(j) === 'νουμερο' || a.w(j) === 'αρ') j++
    const parts: string[] = []
    const idx: number[] = []
    while (a.num(j) && !(a.num(j) as NumSeg).half) {
      const x = a.num(j) as NumSeg
      if (a.unitAt(j + 1)) break
      parts.push(x.words ? String(x.value) : x.digits)
      idx.push(j)
      j++
    }
    if (parts.length) {
      idx.forEach((k) => a.used.add(k))
      return parts.join('')
    }
  }
  return null
}

/** Γραμμές με ποσότητες (και τιμές) για τα είδη μιας περιοχής */
function buildLines(a: Analysis, pool: Pool, priced: boolean, lo = 0, hi = a.segs.length, reserveChannels = true) {
  const sc = a.scan(pool, reserveChannels, lo, hi)
  const itemHits = sc.hits.filter((h) => topKind(h) === 'item')
  const partnerHits = sc.hits.filter((h) => topKind(h) === 'partner')
  const cov = a.covered(sc.hits)
  let nums = a.numbers(cov).filter((x) => x.i >= lo && x.i < hi)
  if (priced) nums = a.mergeCents(nums, false)
  const lines = pairLines(a, hitsToEnts(itemHits), hitsToEnts(sc.unknown, true), nums, priced, pool)
  const usedUnknown = new Set<Hit>(lines.filter((l) => l.ent.unknown).map((l) => l.ent.hit))
  return { lines, partnerHits, sc, usedUnknown, nums }
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
  return toRef(l.ent.hit.heard, ranked)
}

function qtyLines(a: Analysis, lines: Line[], missing: 'one' | 'issue'): { out: QtyLine[]; conf: number } {
  const out: QtyLine[] = []
  let conf = 1
  for (const l of lines) {
    const ref = lineRef(l)
    refIssue(a, ref, 'είδος')
    conf = Math.min(conf, refConf(ref))
    const item = itemById(a, ref.id)
    const label = item?.name ?? ref.heard
    let qty = lineQty(a, l, item, label)
    if (qty === null) {
      if (missing === 'one') qty = 1
      else { a.issues.push(`Δεν ακούστηκε ποσότητα για «${label}».`); qty = 0; conf = Math.min(conf, 0.5) }
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

function buildSaleTally(a: Analysis): Built {
  const ci = a.chan.findIndex(Boolean)
  const chans = new Set(a.chan.filter(Boolean))
  const channel = (ci >= 0 ? a.chan[ci] : null) ?? a.ctx?.defaultChannel ?? 'store'
  if (chans.size > 1) a.issues.push(`Άκουσα ${chans.size} κανάλια· κράτησα το πρώτο.`)
  const { lines } = buildLines(a, POOL.saleTally, false)
  const q = qtyLines(a, lines, 'one')
  const out = mergeSame(q.out)
  const conf = q.conf
  if (a.has('minus')) for (const l of out) l.qty = -Math.abs(l.qty)
  if (!out.length) a.issues.push('Δεν κατάλαβα ποια προϊόντα.')
  return {
    command: { kind: 'sale_tally', channel: channel as TallyChannel, channelHeard: ci >= 0, lines: out },
    conf: out.length ? conf : 0.2,
  }
}

function pricedLines(a: Analysis, lines: Line[], missingPriceIssue: boolean, missingQty: 'one' | 'issue'): { out: PricedLine[]; conf: number } {
  const out: PricedLine[] = []
  let conf = 1
  for (const l of lines) {
    const ref = lineRef(l)
    refIssue(a, ref, 'είδος')
    conf = Math.min(conf, refConf(ref))
    const item = itemById(a, ref.id)
    const label = item?.name ?? ref.heard
    let qty = lineQty(a, l, item, label)
    if (qty === null && missingQty === 'one') {
      qty = 1
      conf = Math.min(conf, 0.85)
    } else if (qty === null) {
      a.issues.push(`Δεν ακούστηκε ποσότητα για «${label}».`)
      qty = 0
      conf = Math.min(conf, 0.5)
    }
    const unitPrice = priceFor(a, l, item, qty)
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
  refNo(a)
  const { lines, partnerHits, sc, usedUnknown } = buildLines(a, POOL.sale, true)
  const partner = pickPartner(a, partnerHits, sc.unknown, usedUnknown, 'πελάτης')
  const { out, conf } = pricedLines(a, lines, false, 'one')
  if (!out.length) a.issues.push('Δεν κατάλαβα ποια προϊόντα.')
  return { command: { kind: 'sale', partner, lines: out }, conf: Math.min(conf, refConf(partner)) * (out.length ? 1 : 0.3) }
}

function buildPurchase(a: Analysis): Built {
  a.markVat()
  const ref = refNo(a)
  const { lines, partnerHits, sc, usedUnknown } = buildLines(a, POOL.purchase, true)
  const partner = pickPartner(a, partnerHits, sc.unknown, usedUnknown, 'προμηθευτής')
  const { out, conf } = pricedLines(a, lines, true, 'issue')
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
    // "ζύμωσα 80": ζυμάρια
    const kneadIdx = a.at('knead')
    const doughs = a.items.filter((i) => i.is_active && i.item_type === 'semi' && /^ζυμαρ/.test(norm(i.name)))
    const x = a.numbers(new Set()).find((n) => !n.money)
    let item: EntityRef = emptyRef()
    if (kneadIdx >= 0 && doughs.length) {
      item = {
        heard: a.heard(kneadIdx, kneadIdx + 1),
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

function buildStocktake(a: Analysis): Built {
  const { lines } = buildLines(a, POOL.stock, false)
  const q = qtyLines(a, lines, 'issue')
  const out = mergeSame(q.out)
  const conf = q.conf
  if (!out.length) a.issues.push('Δεν κατάλαβα ποια είδη μετρήθηκαν.')
  return { command: { kind: 'stocktake', lines: out }, conf: out.length ? conf : 0.2 }
}

function amountOf(a: Analysis, skip: Set<number>): number | null {
  const nums = a.mergeCents(a.numbers(skip), false).filter((x) => !x.pct && !x.size)
  const money = nums.filter((x) => x.money)
  const pick = money[0] ?? nums.slice().sort((p, q) => q.value - p.value)[0]
  return pick ? round(pick.value, 2) : null
}

function buildMoney(a: Analysis, kind: 'receipt' | 'payment'): Built {
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

function buildItemPrice(a: Analysis): Built {
  a.markVat()
  const sc = a.scan(POOL.itemPrice, true)
  const h = sc.hits.find((x) => topKind(x) === 'item')
  const item = h ? itemRef(h) : sc.unknown[0] ? toRef(sc.unknown[0].heard, onlyKind(sc.unknown[0].ranked, 'item')) : emptyRef()
  refIssue(a, item, 'είδος')
  const price = priceValue(a, a.covered(sc.hits))
  const it = itemById(a, item.id)
  let heardGross = it ? isFin(it) && it.make_to_order : false
  if (a.gross !== null) heardGross = a.gross
  if (price === null) a.issues.push('Δεν ακούστηκε τιμή.')
  const vat = Number(it?.vat_rate ?? 13)
  const netPrice = price === null ? 0 : heardGross ? round(price / (1 + vat / 100)) : round(price)
  return {
    command: { kind: 'item_price', item, netPrice, heardGross },
    conf: refConf(item) * (price === null ? 0.3 : 1),
  }
}

function buildPartnerPrice(a: Analysis): Built {
  a.markVat()
  const sc = a.scan(POOL.partnerPrice, false)
  const partner = pickPartner(a, sc.hits, [], new Set(), 'πελάτης')
  const h = sc.hits.find((x) => topKind(x) === 'item')
  const item = h ? itemRef(h) : sc.unknown[0] ? toRef(sc.unknown[0].heard, onlyKind(sc.unknown[0].ranked, 'item')) : emptyRef()
  refIssue(a, item, 'είδος')
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
  const v = a.at('recipeVerb')
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
      if ((s.t === 's' && i > pLo) || forQty || a.cue[i] === 'recipeVerb' || (s.t === 'n' && a.unitAt(i + 1))) { pHi = i; break }
    }
  } else if (v >= 0) pHi = v
  const ps = a.scan(POOL.recipeProduct, true, pLo, pHi)
  const ph = ps.hits.filter((h) => topKind(h) === 'item')
  const prodHit = ph[ph.length - 1] ?? null
  const product = prodHit ? itemRef(prodHit) : ps.unknown[0] ? toRef(ps.unknown[0].heard, onlyKind(ps.unknown[0].ranked, 'item')) : emptyRef()
  refIssue(a, product, 'σε ποιο είδος')
  const prodItem = itemById(a, product.id)
  // ποσότητα παρτίδας: "για 40 (τεμάχια)", "βγάζει 40", "παρτίδα 40"
  let outputQty = 1
  const block = new Set<number>()
  for (let i = 0; i < n; i++) {
    const wd = a.w(i)
    if (wd === 'για' || wd === 'βγαζει' || wd === 'βγαζουν' || wd === 'παρτιδα' || wd === 'αναλογια') {
      let j = i + 1
      if (a.w(j) === 'των' || a.w(j) === 'τα' || a.w(j) === 'τουσ' || a.w(j) === 'τισ') j++
      const x = a.num(j)
      const xu = a.unitAt(j + 1)
      if (x && !x.size && (!xu || xu.unit === 'τεμ')) {
        outputQty = x.value
        block.add(j)
        // "για 40 τεμάχια / ζυμάρια / πίτσες"
        const nx = a.w(j + 1)
        const nxKey = (a.segs[j + 1] as { tok?: Tok })?.tok?.key ?? ''
        const sameAsProduct = !!prodItem && tokenize(prodItem.name).some((t) => t.key && t.key === nxKey)
        if (nx && (unitWord(nx) === 'τεμ' || sameAsProduct || /^(ζυμαρ|πιτσ|τεμαχ|κομματ|μεριδ|μπαλ)/.test(nx))) block.add(j + 1)
        break
      }
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
  const { out, conf } = qtyLines(a, lines, 'issue')
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
    if (c === 'typeFinished') { type = 'finished'; i++; if (a.cue[i] === 'pizza') i++; break }
    if (c === 'typeGeneric') { i++; break }
    if (/^ζυμαρ/.test(wd)) { type = 'semi'; break }
    if (isStop(wd)) { i++; continue }
    break
  }
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
      if (type !== 'raw' && (u === 'g' || u === 'εκ' || u === 'ml' || u === 'kg' || u === 'L')) {
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
    parts.push(s.tok.raw)
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
  if (type === 'finished' && mto === null) mto = !/κατεψυγμεν|χονδρικ|συσκευασμεν/.test(norm(name) + ' ' + txt)
  if (/κατα παραγγελια|αυτοματα/.test(txt)) mto = true
  if (type !== 'finished' && mto === null) mto = false
  const vatRate = a.vatRate !== null && [0, 6, 13, 24].includes(a.vatRate) ? a.vatRate : 13
  if (a.vatRate !== null && vatRate !== a.vatRate) a.issues.push(`Ο ΦΠΑ ${a.vatRate}% δεν υπάρχει· έβαλα 13%.`)
  let salePrice: number | null = null
  if (price !== null) {
    const gross = a.gross ?? (type === 'finished' && !!mto)
    salePrice = gross ? round(price / (1 + vatRate / 100)) : round(price)
  }
  if (!name) a.issues.push('Δεν ακούστηκε όνομα.')
  if (packName && packQty === null) a.issues.push(`Δεν ακούστηκε πόσο έχει το ${packName}.`)
  const exists = name ? a.items.find((it) => norm(it.name) === norm(name)) : null
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
    if (mode === 'city') cityParts.push((s as { tok: Tok }).tok.raw)
    else if (!(nameParts.length === 0 && wd && isStop(wd))) nameParts.push((s as { tok: Tok }).tok.raw)
    j++
  }
  while (nameParts.length && TRAIL.has(norm(nameParts[nameParts.length - 1]))) nameParts.pop()
  if (cityParts.length) city = titleCase(cityParts.join(' '))
  const name = titleCase(nameParts.join(' '))
  if (!isCustomer && !isSupplier) isCustomer = true
  if (!name) a.issues.push('Δεν ακούστηκε όνομα.')
  if (phone && phone.length !== 10) a.issues.push(`Το τηλέφωνο έχει ${phone.length} ψηφία.`)
  if (vatNo && vatNo.length !== 9) a.issues.push(`Το ΑΦΜ έχει ${vatNo.length} ψηφία.`)
  const exists = name ? a.partners.find((p) => norm(p.name) === norm(name)) : null
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
      return { text, command: { kind: 'unknown' }, confidence: 0, issues: [] }
  }
  const issues = Array.from(new Set(a.issues))
  const confidence = Math.max(0.05, Math.min(1, Math.round(d.conf * b.conf * 100) / 100))
  return { text, command: b.command, confidence, issues }
}

/** Κείμενο → εντολή. Δεν πετάει ποτέ: σε σφάλμα επιστρέφει 'unknown'. */
export function interpret(text: string, ctx: InterpretContext): Interpretation {
  const t = typeof text === 'string' ? text : String(text ?? '')
  try {
    return { ...run(t.slice(0, 500), ctx), text: t }
  } catch {
    return { text: t, command: { kind: 'unknown' }, confidence: 0, issues: [] }
  }
}

export const localInterpreter: Interpreter = { interpret }

