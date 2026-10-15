import type { Tok } from './normalize'

/**
 * Αριθμοί από ομιλία: ψηφία ("3", "6,5", "0.62", "1.000") και λέξεις
 * ("είκοσι τρία", "εκατόν πενήντα", "δύο χιλιάδες", "μισό", "ενάμισι",
 * "έξι κόμμα πέντε", "δύο και μισό"). Η σειρά tokens γίνεται σειρά από
 * τμήματα (Seg): λέξεις, αριθμοί, διαχωριστικά.
 */

export interface NumSeg {
  t: 'n'
  /** tokens [from, to) */
  from: number
  to: number
  value: number
  /** ψηφία για συνένωση (τηλέφωνα, ΑΦΜ, αρ. τιμολογίου) */
  digits: string
  /** ειπώθηκε (και) με λέξεις */
  words: boolean
  /** σκέτο "μισό" */
  half?: boolean
  /** "τετρακοσάρι", "400άρια": μέγεθος (μέρος ονόματος), όχι ποσότητα */
  size?: boolean
  /** "24%", "24 τοις εκατό" */
  pct?: boolean
}

export interface WordSeg {
  t: 'w'
  from: number
  to: number
  tok: Tok
}

export interface SepSeg {
  t: 's'
  from: number
  to: number
}

export type Seg = WordSeg | NumSeg | SepSeg

const UNITS: Record<string, number> = {
  μηδεν: 0, ενα: 1, ενασ: 1, ενοσ: 1, μια: 1, μιασ: 1, μιαν: 1, μιαμια: 1,
  δυο: 2, δυω: 2, τρια: 3, τρεισ: 3, τριων: 3, τεσσερα: 4, τεσσερισ: 4, τεσσερεισ: 4, τεσσαρα: 4, τεσσερων: 4,
  πεντε: 5, εξι: 6, εφτα: 7, επτα: 7, οχτω: 8, οκτω: 8, εννια: 9, εννεα: 9, δεκα: 10, εντεκα: 11, ενδεκα: 11,
  δωδεκα: 12, δεκατρια: 13, δεκατρεισ: 13, δεκατεσσερα: 14, δεκατεσσερισ: 14, δεκαπεντε: 15, δεκαεξι: 16,
  δεκαξι: 16, δεκαεφτα: 17, δεκαεπτα: 17, δεκαοχτω: 18, δεκαοκτω: 18, δεκαεννια: 19, δεκαεννεα: 19,
}
const TENS: Record<string, number> = {
  εικοσι: 20, τριαντα: 30, σαραντα: 40, πενηντα: 50, εξηντα: 60, εβδομηντα: 70, ογδοντα: 80, ενενηντα: 90,
}
const HUNDRED_PREFIX: Record<string, number> = {
  δια: 200, τρια: 300, τετρα: 400, πεντα: 500, εξα: 600, εφτα: 700, επτα: 700, οχτα: 800, οκτα: 800, εννια: 900, εννεα: 900,
}
const THOUSAND = new Set(['χιλια', 'χιλιεσ', 'χιλιουσ', 'χιλιοι', 'χιλιων'])
const MULT_K = new Set(['χιλιαδεσ', 'χιλιαδων', 'χιλιαδα'])
const HALF = new Set(['μισο', 'μιση', 'μισα', 'μισου', 'μισησ', 'μισοσ', 'μισεσ'])
/** "κατοστάρι", "τετρακοσάρια": μεγέθη */
const SIZE: Record<string, number> = {
  κατοσταρ: 100, εκατοσταρ: 100, διακοσαρ: 200, διακοσαπενηνταρ: 250, τριακοσαρ: 300, τριακοσαπενηνταρ: 350,
  τετρακοσαρ: 400, πεντακοσαρ: 500, εξακοσαρ: 600, εικοσαρ: 20, τριανταρ: 30, σαρανταρ: 40, πενηνταρ: 50, εξηνταρ: 60,
}
const SIZE_SUFFIX = new Set(['αρι', 'αρια', 'αρακι', 'αρακια', 'αρη', 'αρηδεσ'])

interface Card { v: number; slot: number }

/** Μία λέξη-αριθμός: slot 0 μονάδες (0-19), 1 δεκάδες, 2 εκατοντάδες, 3 χιλιάδα */
export function cardinal(n: string): Card | null {
  if (n in UNITS) return { v: UNITS[n], slot: 0 }
  if (n in TENS) return { v: TENS[n], slot: 1 }
  if (n === 'εκατο' || n === 'εκατον') return { v: 100, slot: 2 }
  const h = /^(.+)κοσι(α|εσ|ουσ|οι|ων)$/.exec(n)
  if (h && h[1] in HUNDRED_PREFIX) return { v: HUNDRED_PREFIX[h[1]], slot: 2 }
  if (THOUSAND.has(n)) return { v: 1000, slot: 3 }
  // "εικοσιπέντε", "τριανταδύο" (γραμμένα μαζί)
  for (const t in TENS) {
    if (n.length > t.length && n.startsWith(t)) {
      const rest = n.slice(t.length)
      if (rest in UNITS && UNITS[rest] >= 1 && UNITS[rest] <= 9) return { v: TENS[t] + UNITS[rest], slot: 0 }
    }
  }
  return null
}

/** Αριθμός από λέξεις που ξεκινά στο i ("δύο χιλιάδες πεντακόσια" = 2500) */
function readCardinal(toks: Tok[], i: number): { value: number; to: number } | null {
  const c0 = cardinal(toks[i].n)
  if (!c0) return null
  let total = 0
  let cur = c0.v
  let last = c0.slot
  if (c0.slot === 3) { total = c0.v; cur = 0 }
  let j = i + 1
  while (j < toks.length) {
    const n = toks[j].n
    if (MULT_K.has(n) && cur > 0 && last < 3) { total += cur * 1000; cur = 0; last = 3; j++; continue }
    const c = cardinal(n)
    if (!c || c.slot >= last || c.slot === 3 || c.v === 0 || c0.v === 0) break
    cur += c.v
    last = c.slot
    j++
  }
  return { value: total + cur, to: j }
}

/** "ενάμισι", "δυόμισι", "τρεισήμισι" */
function compoundHalf(n: string): number | null {
  const m = /^(.+?)η?μισ[ιηυο]$/.exec(n)
  if (!m) return null
  const p = m[1]
  if (p in UNITS && UNITS[p] > 0) return UNITS[p] + 0.5
  return null
}

function sizeWord(n: string): number | null {
  const m = /^(.+αρ)(ι|ια|ακι|ακια|η|ηδεσ)$/.exec(n)
  if (m && m[1] in SIZE) return SIZE[m[1]]
  return null
}

/** Δεκαδικό μέρος μετά το "κόμμα" */
function readFraction(toks: Tok[], j: number): { frac: number; to: number } | null {
  const t = toks[j]
  if (!t || t.sep) return null
  if (t.num !== undefined && t.digits) return { frac: Number('0.' + t.digits), to: j + 1 }
  let zeros = 0
  let k = j
  while (toks[k]?.n === 'μηδεν') { zeros++; k++ }
  const c = toks[k] && !toks[k].sep ? readCardinal(toks, k) : null
  if (!c) return zeros ? { frac: 0, to: k } : null
  const d = String(Math.round(c.value)).length
  return { frac: c.value / Math.pow(10, zeros + d), to: c.to }
}

export function isHalfWord(n: string): boolean {
  return HALF.has(n)
}

/** Μετά από "χιλιάδες": υπόλοιπο κάτω από 1000 ("2 χιλιάδες 500", "δυόμισι χιλιάδες") */
function belowThousand(toks: Tok[], j: number): { value: number; to: number } | null {
  const t = toks[j]
  if (!t || t.sep) return null
  if (t.num !== undefined) return Number.isInteger(t.num) && t.num > 0 && t.num < 1000 && !t.digits?.startsWith('0') ? { value: t.num, to: j + 1 } : null
  const c0 = cardinal(t.n)
  if (!c0 || c0.slot === 3 || c0.v === 0) return null
  const c = readCardinal(toks, j)
  return c && c.value < 1000 ? c : null
}

/** Αριθμός που ξεκινά στο token i, ή null */
export function readNumber(toks: Tok[], i: number): NumSeg | null {
  const t = toks[i]
  if (!t || t.sep) return null
  let value: number
  let j: number
  let words = false
  let half = false
  let size = false
  let digits: string
  if (t.num !== undefined) {
    value = t.num
    digits = t.digits ?? String(value)
    j = i + 1
    if (toks[j] && MULT_K.has(toks[j].n) && value > 0 && Number.isInteger(value * 1000)) {
      value *= 1000
      words = true
      j++
      const r = Number.isInteger(value) ? belowThousand(toks, j) : null
      if (r) { value += r.value; j = r.to }
      digits = String(value)
    } else if (toks[j] && SIZE_SUFFIX.has(toks[j].n)) { size = true; j++ }
  } else {
    const n = t.n
    words = true
    j = i + 1
    if (HALF.has(n)) { value = 0.5; half = true }
    else {
      const ch = compoundHalf(n)
      const sz = ch === null ? sizeWord(n) : null
      if (ch !== null) {
        value = ch
        // "δυόμισι χιλιάδες"
        if (toks[j] && MULT_K.has(toks[j].n)) { value *= 1000; j++ }
      } else if (sz !== null) { value = sz; size = true }
      else {
        const c = readCardinal(toks, i)
        if (!c) return null
        value = c.value
        j = c.to
        // "δύο χιλιάδες 500" (λέξεις και ψηφία μαζί)
        if (value >= 1000 && value % 1000 === 0 && (MULT_K.has(toks[j - 1]?.n) || THOUSAND.has(toks[j - 1]?.n))) {
          const t2 = toks[j]
          if (t2 && t2.num !== undefined) {
            const r = belowThousand(toks, j)
            if (r) { value += r.value; j = r.to }
          }
        }
      }
    }
    digits = String(value)
  }
  if (!size) {
    // "έξι κόμμα πέντε"
    if ((toks[j]?.n === 'κομμα' || toks[j]?.n === 'κομα') && !half) {
      const f = readFraction(toks, j + 1)
      if (f) { value += f.frac; j = f.to; words = true; digits = String(value) }
    }
    // "δύο και μισό"
    if (!half && Number.isInteger(value) && toks[j]?.n === 'και' && toks[j + 1] && HALF.has(toks[j + 1].n)) {
      value += 0.5; j += 2; words = true; digits = String(value)
    }
  }
  let pct = false
  if (toks[j]?.n === '%') { pct = true; j++ }
  else if (toks[j]?.n === 'τοισ' && (toks[j + 1]?.n === 'εκατο' || toks[j + 1]?.n === 'εκατον')) { pct = true; j += 2 }
  value = Math.round(value * 1e6) / 1e6
  const seg: NumSeg = { t: 'n', from: i, to: j, value, digits, words }
  if (half) seg.half = true
  if (size) seg.size = true
  if (pct) seg.pct = true
  return seg
}

/** Tokens → τμήματα (λέξεις, αριθμοί, διαχωριστικά) */
export function segment(toks: Tok[]): Seg[] {
  const out: Seg[] = []
  let i = 0
  while (i < toks.length) {
    const t = toks[i]
    if (t.sep) { out.push({ t: 's', from: i, to: i + 1 }); i++; continue }
    const r = readNumber(toks, i)
    if (r) { out.push(r); i = r.to; continue }
    out.push({ t: 'w', from: i, to: i + 1, tok: t })
    i++
  }
  return out
}

/** Όλοι οι αριθμοί ενός κειμένου (βοηθητικό, π.χ. για tests) */
export function numbersIn(toks: Tok[]): number[] {
  return segment(toks).filter((s): s is NumSeg => s.t === 'n').map((s) => s.value)
}
