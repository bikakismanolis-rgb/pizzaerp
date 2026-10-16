import type { VoicePhraseRule } from './types'
import { readNumber } from './numbers'

/**
 * Κανονικοποίηση για τον τοπικό interpreter: πεζά, χωρίς τόνους, ς→σ,
 * tokens που κρατούν την αρχική μορφή τους (για «όπως ακούστηκε»),
 * φωνητικό κλειδί κοινό για ελληνικά και λατινικά ("special" ≈ "σπέσιαλ",
 * "pepperoni" ≈ "πεπερόνι") και ελαφριά αποκοπή καταλήξεων (μαργαρίτες ≈ μαργαρίτα).
 */

/** Πεζά, χωρίς τόνους / διαλυτικά, ς→σ */
export function norm(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/ς/g, 'σ')
}

// ---------------------------------------------------------------------
// Φωνητικό κλειδί (greeklish)
// ---------------------------------------------------------------------
const GR_DI: Record<string, string> = {
  ου: 'u', ει: 'i', οι: 'i', υι: 'i', αι: 'e', αυ: 'av', ευ: 'ev',
  μπ: 'b', ντ: 'd', γκ: 'g', γγ: 'g', τσ: 'ts', τζ: 'dz', γχ: 'x',
}
const GR: Record<string, string> = {
  α: 'a', β: 'v', γ: 'g', δ: 'd', ε: 'e', ζ: 'z', η: 'i', θ: '8', ι: 'i', κ: 'k', λ: 'l', μ: 'm',
  ν: 'n', ξ: 'ks', ο: 'o', π: 'p', ρ: 'r', σ: 's', τ: 't', υ: 'i', φ: 'f', χ: 'x', ψ: 'ps', ω: 'o',
}
const LA_DI: Record<string, string> = {
  ph: 'f', ch: 'x', th: '8', sh: 's', gh: 'g', ck: 'k', ou: 'u', oo: 'u', ee: 'i', zz: 'ts',
  qu: 'k', mb: 'b', nd: 'd', tz: 'dz',
}
const LA: Record<string, string> = {
  a: 'a', b: 'b', d: 'd', e: 'e', f: 'f', g: 'g', i: 'i', j: 'dz', k: 'k', l: 'l', m: 'm', n: 'n',
  o: 'o', p: 'p', q: 'k', r: 'r', s: 's', t: 't', u: 'u', v: 'v', w: 'v', x: 'ks', y: 'i', z: 'z',
}

/** Φωνητικό κλειδί λέξης (δέχεται ήδη κανονικοποιημένο κείμενο) */
export function phon(n: string): string {
  let out = ''
  for (let i = 0; i < n.length; i++) {
    const c = n[i]
    const two = n.slice(i, i + 2)
    if (GR_DI[two]) { out += GR_DI[two]; i++; continue }
    if (LA_DI[two]) { out += LA_DI[two]; i++; continue }
    if (GR[c]) { out += GR[c]; continue }
    if (c === 'c') { out += /[eiy]/.test(n[i + 1] ?? '') ? 's' : 'k'; continue }
    if (c === 'h') { if (/[aeiouy]/.test(n[i + 1] ?? '')) out += 'x'; continue }
    if (LA[c]) { out += LA[c]; continue }
    if (/[0-9]/.test(c)) out += c
  }
  return out.replace(/(.)\1+/g, '$1')
}

const GREEK = /[α-ω]/

/** Ρίζα: φωνητικό κλειδί χωρίς κατάληξη (μαργαρίτες, μαργαρίτας → margarit) */
export function stemKey(n: string): string {
  let w = n
  if (GREEK.test(w)) {
    // γενικές: ζυμαριών, αλευριού
    if (w.length > 4 && w.endsWith('ων')) w = w.slice(0, -2)
    else if (w.length > 5 && w.endsWith('ουσ')) w = w.slice(0, -3)
    else if (w.length > 5 && w.endsWith('ου')) w = w.slice(0, -2)
  }
  let k = phon(w)
  if (k.length > 3 && k.endsWith('s')) k = k.slice(0, -1)
  while (k.length > 3 && /[aeiou]$/.test(k)) k = k.slice(0, -1)
  return k
}

/** Damerau-Levenshtein (περιορισμένη) για μικρές λέξεις, με τρεις γραμμές */
export function editDistance(a: string, b: string): number {
  const la = a.length
  const lb = b.length
  if (!la) return lb
  if (!lb) return la
  let prev2 = new Int32Array(lb + 1)
  let prev = new Int32Array(lb + 1)
  let cur = new Int32Array(lb + 1)
  for (let j = 0; j <= lb; j++) prev[j] = j
  for (let i = 1; i <= la; i++) {
    cur[0] = i
    const ca = a.charCodeAt(i - 1)
    for (let j = 1; j <= lb; j++) {
      const cb = b.charCodeAt(j - 1)
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca === cb ? 0 : 1))
      if (i > 1 && j > 1 && ca === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === cb) v = Math.min(v, prev2[j - 2] + 1)
      cur[j] = v
    }
    const t = prev2
    prev2 = prev
    prev = cur
    cur = t
  }
  return prev[lb]
}

/** Ομοιότητα δύο κλειδιών 0..1 (κάτω από 0.7 θεωρείται άσχετο → 0) */
export function keySim(a: string, b: string): number {
  if (a === b) return a ? 1 : 0
  if (!a || !b) return 0
  const short = a.length <= b.length ? a : b
  const long = a.length <= b.length ? b : a
  // σύνθετες λέξεις: "λάδι" ≈ "ελαιόλαδο"
  if (short.length >= 3 && long.length - short.length >= 3 && long.endsWith(short) && long.length - short.length <= 5) return 0.72
  // σύντομες λέξεις: μόνο ακριβές
  if (short.length <= 3) return 0
  // πρόθεμα: κοντές ρίζες μένουν κάτω από ένα πραγματικό ταίριασμα ρίζας
  // ("krem" ≠ "kremid", "domat" ≠ "domatin")
  if (long.startsWith(short)) return short.length < 6 ? 0.8 : 0.75 + (0.2 * short.length) / long.length
  if (long.length - short.length > 3) return 0
  const s = 1 - editDistance(a, b) / long.length
  if (short.length <= 4 && s < 0.75) return 0
  return s >= 0.7 ? s : 0
}

// ---------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------
export interface Tok {
  /** όπως γράφτηκε / ακούστηκε */
  raw: string
  /** κανονικοποιημένο */
  n: string
  /** φωνητική ρίζα ('' για αριθμούς και σημεία στίξης) */
  key: string
  /** τιμή, για tokens με ψηφία */
  num?: number
  /** τα ψηφία όπως ειπώθηκαν (για τηλέφωνα, ΑΦΜ, αριθμούς τιμολογίων) */
  digits?: string
  /** διαχωριστικό (κόμμα, τελεία, ερωτηματικό) */
  sep?: boolean
  /** γράφτηκε κολλητά με το προηγούμενο ("3Ε", "400γρ") */
  glued?: boolean
}

/** Γνωστές συντομογραφίες από μονά γράμματα (Φ.Π.Α., Α.Ε.) */
const ABBREV = new Set(['φπα', 'αφμ', 'αε', 'οε', 'εε', 'ικε', 'επε', 'τμχ', 'fpa', 'afm', 'ae', 'oe', 'ike'])

const TOKEN_RE = /\d+\/\d+(?!\d)|\d+(?:[.,]\d+)*|[\p{L}\p{M}]+|[€%/]|[,;:.!?·\u037e]/gu

/** "6,5" → 6.5, "0.62" → 0.62, "1.000" → 1000, "1.250,50" → 1250.5 */
export function parseDigits(s: string): number {
  // "1/2" → 0.5
  const fr = /^(\d+)\/(\d+)$/.exec(s)
  if (fr) return Number(fr[2]) ? Math.round((Number(fr[1]) / Number(fr[2])) * 1e6) / 1e6 : 0
  let t = s
  const dots = (t.match(/\./g) ?? []).length
  const commas = (t.match(/,/g) ?? []).length
  if (dots && commas) t = t.replace(/\./g, '').replace(',', '.')
  else if (commas === 1) t = t.replace(',', '.')
  else if (commas > 1) t = t.replace(/,/g, '')
  else if (dots > 1) t = t.replace(/\./g, '')
  else if (dots === 1) {
    const [a, b] = t.split('.')
    if (b.length === 3 && a !== '0' && !/^0/.test(a)) t = a + b
  }
  const v = Number(t)
  return Number.isFinite(v) ? v : 0
}

export function tokenize(text: string): Tok[] {
  let s = String(text ?? '')
  // Φ.Π.Α. → ΦΠΑ, Α.Ε. → ΑΕ
  // (χωρίς lookbehind: παλιά Safari δεν το υποστηρίζουν)
  s = s.replace(/(^|[^\p{L}])(\p{L}(?:\.\p{L}(?!\p{L}))+\.?)/gu, (_m, pre: string, ab: string) => pre + ab.replace(/\./g, ''))
  // μισόκιλο → μισό κιλό
  s = s.replace(/μισ[οό]κιλ([οόαά])/gi, 'μισό κιλ$1').replace(/μισ[οό]λιτρ([οα])/gi, 'μισό λίτρ$1')
  // απόστροφοι, παύλες, εισαγωγικά → κενό
  s = s.replace(/[’'`´ʼ"«»“”()[\]{}_\-–—+*=<>|\\]/g, ' ')
  // 400γρ → 400 γρ, x2 → x 2 (το \u0001 θυμάται ότι ήταν κολλητά)
  s = s.replace(/(\d)(?=\p{L})/gu, '$1\u0001').replace(/(\p{L})(?=\d)/gu, '$1\u0001')
  const out: Tok[] = []
  for (const m of s.matchAll(TOKEN_RE)) {
    const raw = m[0]
    const at = m.index ?? 0
    let t: Tok
    if (/^\d/.test(raw)) {
      t = { raw, n: raw, key: '', num: parseDigits(raw), digits: raw.replace(/\D/g, '') }
    } else if (/^[,;:.!?·;]$/.test(raw)) {
      t = { raw, n: raw, key: '', sep: true }
    } else if (raw === '€') {
      t = { raw, n: 'ευρω', key: 'evro' }
    } else if (raw === '/') {
      t = { raw, n: 'ανα', key: 'ana' }
    } else if (raw === '%') {
      t = { raw, n: '%', key: '' }
    } else {
      const n = norm(raw)
      t = { raw, n, key: stemKey(n) }
    }
    if (at > 0 && s[at - 1] === '\u0001') t.glued = true
    out.push(t)
  }
  // συντομογραφίες με κενά: "φ π α" → "φπα"
  for (let i = 0; i < out.length; i++) {
    if (out[i].n.length !== 1 || out[i].sep || out[i].num !== undefined) continue
    for (let len = 3; len >= 2; len--) {
      const part = out.slice(i, i + len)
      if (part.length < len || part.some((t) => t.n.length !== 1 || t.sep || t.num !== undefined)) continue
      const joined = part.map((t) => t.n).join('')
      if (ABBREV.has(joined)) {
        out.splice(i, len, { raw: part.map((t) => t.raw).join(''), n: joined, key: stemKey(joined) })
        break
      }
    }
  }
  return out
}

/** Κανονικοποιημένο κείμενο με απλά κενά (για φράσεις-κλειδιά) */
export function normText(text: string): string {
  return tokenize(text).filter((t) => !t.sep).map((t) => t.n).join(' ')
}

// ---------------------------------------------------------------------
// Δικές τους φράσεις ("όταν λέω Χ εννοώ Υ")
// ---------------------------------------------------------------------
/** Λέξη του αρχικού κειμένου με τη θέση της (γράμματα ή ψηφία, χωριστά) */
export interface Word {
  /** κανονικοποιημένη (πεζά, χωρίς τόνους, ς→σ) */
  n: string
  from: number
  to: number
}

const WORD_RE = /[\p{L}\p{M}]+|\d+/gu

/** Λέξεις κειμένου με θέσεις ("400γρ" → "400", "γρ") */
export function words(text: string): Word[] {
  const out: Word[] = []
  for (const m of String(text ?? '').matchAll(WORD_RE)) {
    const n = norm(m[0])
    if (n) out.push({ n, from: m.index ?? 0, to: (m.index ?? 0) + m[0].length })
  }
  return out
}

/**
 * Σύγκριση λέξεων φράσης: ίδια λέξη, ή μόνο το τελικό -ς διαφορετικό
 * (ονομαστική / αιτιατική: "ο Γιώργος" ≈ "τον Γιώργο", "Κώστας" ≈ "Κώστα").
 * Άλλες καταλήξεις όχι: «ζυμάρι» ≠ «ζυμάρια».
 */
const fold = (w: string) => (w.length >= 4 && w.endsWith('σ') ? w.slice(0, -1) : w)

/** Λέξη φράσης: λέξη ή αριθμός (ψηφία ή λέξεις: "1" = "ένα", "20" = "είκοσι") */
interface PWord { n: string; num?: number }

/** Tokens για τον αναγνώστη αριθμών από τις λέξεις (χωρίς στίξη) */
function wordToks(ws: Word[]): Tok[] {
  return ws.map((w) => (/^\d/.test(w.n) ? { raw: w.n, n: w.n, key: '', num: Number(w.n), digits: w.n } : { raw: w.n, n: w.n, key: '' }))
}

/** Αριθμός που αρχίζει στη λέξη k ("6,5" = δύο λέξεις ψηφίων, "είκοσι τρία" = δύο λέξεις) */
function numAt(text: string, ws: Word[], toks: Tok[], k: number): { value: number; len: number } | null {
  const w = ws[k]
  if (!w) return null
  if (/^\d/.test(w.n)) {
    let j = k
    while (j + 1 < ws.length && /^\d/.test(ws[j + 1].n) && /^[.,]$/.test(text.slice(ws[j].to, ws[j + 1].from))) j++
    return { value: parseDigits(text.slice(w.from, ws[j].to)), len: j - k + 1 }
  }
  const r = readNumber(toks, k)
  return r && r.words && !r.size && !r.pct ? { value: r.value, len: r.to - k } : null
}

/** Λέξεις φράσης με τους αριθμούς ενωμένους σε τιμές */
function phraseWords(s: string): PWord[] {
  const ws = words(s)
  const toks = wordToks(ws)
  const out: PWord[] = []
  for (let k = 0; k < ws.length; ) {
    const x = numAt(s, ws, toks, k)
    if (x) { out.push({ n: String(x.value), num: x.value }); k += x.len }
    else { out.push({ n: ws[k].n }); k++ }
  }
  return out
}

const pwKey = (w: PWord) => (w.num !== undefined ? '#' + w.num : fold(w.n))

/**
 * Κλειδί φράσης για σύγκριση (ίδιο με το ταίριασμα): "Ο Γιώργος" = "ο γιωργο",
 * "νούμερο ένα" = "νούμερο 1" ("νουμερο 1")
 */
export function phraseKey(s: string): string {
  const str = String(s ?? '')
  let k = keyCache.get(str)
  if (k === undefined) {
    k = phraseWords(str).map((w) => (w.num !== undefined ? String(w.num) : fold(w.n))).join(' ')
    if (keyCache.size > 5000) keyCache.clear()
    keyCache.set(str, k)
  }
  return k
}
const keyCache = new Map<string, string>()

/** Ανάμεσα σε λέξεις της ίδιας φράσης: κενά, παύλες, εισαγωγικά (όχι τελεία/κόμμα, εκτός από "6,5") */
const GAP_OK = /^[\s'’`´ʼ"«»“”\-–—]*$/

interface PhraseRule { words: PWord[]; meaning: string; chars: number }
interface PhraseSet { byFirst: Map<string, PhraseRule[]>; sig: string }

/** άρθρα στην αρχή μιας φράσης: η φράση πιάνει και χωρίς αυτά ("ο Γιώργος" → "Γιώργος") */
const LEAD_ART = new Set(['ο', 'η', 'το', 'οι', 'τα', 'τον', 'την', 'τη', 'του', 'τησ', 'των', 'τουσ', 'τισ'])
/**
 * Μία λέξη που δεν στέκει μόνη της ως φράση: χωρίς το άρθρο, "η μία" / "το
 * πρώτο" / "τα άλλα" θα έπιαναν κάθε "μία", "πρώτο", "άλλα" της πρότασης
 */
const NOT_ALONE = new Set([
  'ναι', 'οχι', 'οκ', 'ενταξει', 'λαθοσ', 'σωστο', 'ολα', 'ολεσ', 'ολοι', 'ολο', 'ολη', 'ολουσ', 'αυτο', 'αυτη', 'αυτα', 'αυτοσ',
  'αυτεσ', 'αυτοι', 'εκεινο', 'εκεινη', 'εκεινα', 'αλλο', 'αλλη', 'αλλα', 'αλλεσ', 'αλλοι', 'πρωτο', 'πρωτη', 'πρωτα', 'πρωτεσ',
  'δευτερο', 'δευτερη', 'τριτο', 'τριτη', 'επομενο', 'επομενη', 'τελευταιο', 'τελευταια', 'τελευταιεσ', 'ιδιο', 'ιδια',
  'πιτσα', 'πιτσεσ', 'μου', 'σου', 'μασ', 'σασ', 'και', 'με', 'για', 'απο', 'σε', 'στο',
  'στη', 'στην', 'στον', 'στα', 'που', 'πωσ', 'τι', 'ποιο', 'ποια', 'ποσο', 'ποσα',
])

const phraseCache = new WeakMap<object, PhraseSet>()

function phraseSig(rules: VoicePhraseRule[]): string {
  let h = 0
  for (const r of rules) {
    const s = `${r?.phrase}\u0000${r?.meaning}\u0001`
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  }
  return `${rules.length}:${h}`
}

function compilePhrases(rules: VoicePhraseRule[]): PhraseSet {
  const sig = phraseSig(rules)
  const hit = phraseCache.get(rules)
  if (hit && hit.sig === sig) return hit
  const byFirst = new Map<string, PhraseRule[]>()
  const seen = new Set<string>()
  const add = (ws: PWord[], meaning: string) => {
    const key = ws.map(pwKey).join(' ')
    // ίδια φράση δύο φορές (π.χ. με και χωρίς τόνο): μετράει η πρώτη
    if (!ws.length || seen.has(key)) return
    seen.add(key)
    const r: PhraseRule = { words: ws, meaning, chars: key.length }
    const l = byFirst.get(pwKey(ws[0]))
    if (l) l.push(r)
    else byFirst.set(pwKey(ws[0]), [r])
  }
  for (const r of rules) {
    if (!r || typeof r.phrase !== 'string') continue
    add(phraseWords(r.phrase), String(r.meaning ?? '').trim())
  }
  // χωρίς το αρχικό άρθρο, μόνο αν δεν υπάρχει άλλη φράση έτσι και αν αυτό
  // που μένει στέκει μόνο του ("η μία", "το πρώτο" όχι)
  for (const r of rules) {
    if (!r || typeof r.phrase !== 'string') continue
    const ws = phraseWords(r.phrase)
    if (ws.length < 2 || ws[0].num !== undefined || !LEAD_ART.has(ws[0].n)) continue
    const rest = ws.slice(1)
    if (rest.length === 1 && (rest[0].num !== undefined || rest[0].n.length <= 3 || NOT_ALONE.has(rest[0].n))) continue
    add(rest, String(r.meaning ?? '').trim())
  }
  // πρώτα η μεγαλύτερη φράση
  for (const l of byFirst.values()) l.sort((a, b) => b.words.length - a.words.length || b.chars - a.chars)
  const out = { byFirst, sig }
  phraseCache.set(rules, out)
  return out
}

/** Κείμενο προς ταίριασμα: λέξεις, tokens για αριθμούς, αριθμοί / ρίζες ανά θέση (τεμπέλικα) */
class Src {
  ws: Word[]
  private toks: Tok[]
  private nums = new Map<number, { value: number; len: number } | null>()
  private stems = new Map<number, string>()
  constructor(public text: string) {
    this.ws = words(text)
    this.toks = wordToks(this.ws)
  }
  num(k: number) {
    if (!this.nums.has(k)) this.nums.set(k, numAt(this.text, this.ws, this.toks, k))
    return this.nums.get(k) ?? null
  }
  stem(k: number): string {
    let s = this.stems.get(k)
    if (s === undefined) { s = stemKey(this.ws[k].n); this.stems.set(k, s) }
    return s
  }
}

/**
 * Οι λέξεις του κειμένου από το i είναι ακριβώς η φράση (ολόκληρες λέξεις,
 * συνεχόμενες); Επιστρέφει πόσες λέξεις πιάνει, αλλιώς 0.
 */
function matchAt(src: Src, i: number, p: PWord[]): number {
  const { ws, text } = src
  let j = i
  for (let k = 0; k < p.length; k++) {
    if (j >= ws.length) return 0
    if (k > 0) {
      const gap = text.slice(ws[j - 1].to, ws[j].from)
      if (!GAP_OK.test(gap)) return 0
    }
    if (p[k].num !== undefined) {
      const x = src.num(j)
      if (!x || x.value !== p[k].num) return 0
      j += x.len
    } else {
      if (fold(ws[j].n) !== fold(p[k].n)) return 0
      j++
    }
  }
  return j - i
}

// ---------------------------------------------------------------------
// Ονόματα του καταλόγου που δεν "σπάνε" από φράσεις
// ---------------------------------------------------------------------
/** Ό,τι χρειάζεται από είδος / συναλλασσόμενο (δομικά: Item, Partner) */
interface Named { name?: string | null; code?: string | null; aliases?: string[] | null; is_active?: boolean | null }
/** Ο κατάλογος (π.χ. το InterpretContext) */
export interface PhraseCatalog { items?: Named[] | null; partners?: Named[] | null }

/** λέξη ονόματος: ρίζα (κλίσεις: «ζυμάρια» = «ζυμάρι») ή αριθμός */
interface NWord { stem?: string; num?: number }
interface Protect { byFirst: Map<string, NWord[][]> }

/** μονάδα κολλητά στο τέλος ονόματος ("400γρ"): το όνομα πιάνει και χωρίς αυτή ("ζυμάρι 400") */
const NAME_UNIT = new Set(['γρ', 'γραμ', 'g', 'gr', 'kg', 'κιλα', 'κιλο', 'κγρ', 'l', 'lt', 'λιτ', 'λιτρα', 'λιτρο', 'ml', 'εκ', 'cm', 'τεμ'])

const nwKey = (w: NWord) => (w.num !== undefined ? '#' + w.num : (w.stem as string))

/**
 * Λέξεις ονόματος (ρίζες / αριθμοί) και πόσες είναι "όλο το όνομα": χωρίς
 * κολλητή μονάδα στο τέλος ("Ζυμάρι 400γρ" = "ζυμάρι 400")
 */
function nameWords(s: string): { nw: NWord[]; full: number } {
  let r = nameCache.get(s)
  if (!r) {
    const raw = phraseWords(s)
    const nw = raw.map((w): NWord => (w.num !== undefined ? { num: w.num } : { stem: stemKey(w.n) }))
    const n = raw.length
    r = { nw, full: n >= 3 && raw[n - 2].num !== undefined && NAME_UNIT.has(raw[n - 1].n) ? n - 1 : n }
    if (nameCache.size > 5000) nameCache.clear()
    nameCache.set(s, r)
  }
  return r
}
const nameCache = new Map<string, { nw: NWord[]; full: number }>()

function buildProtect(cat: PhraseCatalog): Protect {
  const byFirst = new Map<string, NWord[][]>()
  const add = (ws: NWord[]) => {
    // μονολεκτικά ονόματα δεν κόβονται ποτέ από φράση (η φράση τα καλύπτει όλα)
    if (ws.length < 2) return
    const k = nwKey(ws[0])
    const l = byFirst.get(k)
    if (l) l.push(ws)
    else byFirst.set(k, [ws])
  }
  const all = [...(Array.isArray(cat.items) ? cat.items : []), ...(Array.isArray(cat.partners) ? cat.partners : [])]
  for (const e of all) {
    if (!e || !e.is_active) continue
    for (const s of [e.name, e.code, ...(Array.isArray(e.aliases) ? e.aliases : [])]) {
      if (typeof s !== 'string' || !s.trim()) continue
      const { nw, full } = nameWords(s)
      add(nw)
      if (full < nw.length) add(nw.slice(0, full))
    }
  }
  return { byFirst }
}

const protectCache = new WeakMap<object, WeakMap<object, { sig: string; p: Protect }>>()
const NO_LIST: Named[] = []

function protectSig(xs: Named[]): string {
  let h = 0
  for (const e of xs) {
    if (!e) continue
    const s = `${e.name}|${e.code}|${e.is_active ? 1 : 0}|${Array.isArray(e.aliases) ? e.aliases.join('|') : ''};`
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  }
  return `${xs.length}:${h}`
}

function getProtect(cat: PhraseCatalog | null | undefined): Protect | null {
  if (!cat) return null
  const its = Array.isArray(cat.items) ? cat.items : NO_LIST
  const ps = Array.isArray(cat.partners) ? cat.partners : NO_LIST
  if (!its.length && !ps.length) return null
  let m = protectCache.get(its)
  if (!m) { m = new WeakMap(); protectCache.set(its, m) }
  const sig = protectSig(its) + '/' + protectSig(ps)
  const hit = m.get(ps)
  if (hit && hit.sig === sig) return hit.p
  const p = buildProtect({ items: its, partners: ps })
  m.set(ps, { sig, p })
  return p
}

/** Ονόματα του καταλόγου μέσα στο κείμενο: [από, έως) σε λέξεις, το μεγαλύτερο σε κάθε θέση */
function protectedSpans(src: Src, pr: Protect): [number, number][] {
  const out: [number, number][] = []
  const { ws, text } = src
  for (let i = 0; i < ws.length; i++) {
    const keys = [src.stem(i)]
    const x = src.num(i)
    if (x) keys.push('#' + x.value)
    let best = 0
    for (const key of keys) {
      for (const name of pr.byFirst.get(key) ?? []) {
        let j = i
        let ok = true
        for (let k = 0; k < name.length && ok; k++) {
          if (j >= ws.length) { ok = false; break }
          // στο ίδιο κομμάτι της πρότασης ("Α.Ε." ναι, κόμμα / ερωτηματικό όχι)
          if (k > 0 && /[,;:!?·;]/.test(text.slice(ws[j - 1].to, ws[j].from))) { ok = false; break }
          const w = name[k]
          if (w.num !== undefined) {
            const n = src.num(j)
            if (!n || n.value !== w.num) ok = false
            else j += n.len
          } else if (src.stem(j) !== w.stem) ok = false
          else j++
        }
        if (ok && j - i > best) best = j - i
      }
    }
    if (best) out.push([i, i + best])
  }
  return out
}

/**
 * Η φράση είναι η αρχή ονόματος του καταλόγου με περισσότερες λέξεις;
 * ("ζυμάρι" → «Ζυμάρι 400γρ»). except: όνομα που δεν μετράει (η σημασία της φράσης).
 */
export function phraseStartsName(phrase: string, cat: PhraseCatalog | null | undefined, except?: string): string | null {
  const pw = nameWords(phrase).nw
  if (!pw.length || !cat) return null
  const ex = except ? phraseKey(except) : null
  const all = [...(Array.isArray(cat.items) ? cat.items : []), ...(Array.isArray(cat.partners) ? cat.partners : [])]
  for (const e of all) {
    if (!e || !e.is_active || typeof e.name !== 'string') continue
    const names = [e.name, ...(Array.isArray(e.aliases) ? e.aliases : [])]
    if (ex && names.some((x) => typeof x === 'string' && phraseKey(x) === ex)) continue
    for (const s of names) {
      if (typeof s !== 'string') continue
      const { nw, full } = nameWords(s)
      if (full > pw.length && pw.every((w, k) => nwKey(w) === nwKey(nw[k]))) return e.name
    }
  }
  return null
}

/**
 * Εφαρμόζει τις δικές τους φράσεις: κάθε φράση (ολόκληρες λέξεις, χωρίς
 * τόνους / κεφαλαία) αντικαθίσταται από τη σημασία της, όπως γράφτηκε.
 * Πρώτα οι μεγαλύτερες φράσεις, ένα πέρασμα: ό,τι μπήκε δεν ξαναψάχνεται.
 * Μόνο ολόκληρες λέξεις: «ζυμάρι» δεν πιάνει το «ζυμάρια» (χρειάζεται δική
 * του φράση)· μόνο το τελικό -ς δεν μετράει ("Γιώργος" = "Γιώργο"). Φράση
 * που αρχίζει με άρθρο πιάνει και χωρίς αυτό ("ο Γιώργος" → "στον Γιώργο").
 * Αριθμοί με ψηφία ή λέξεις είναι ίδιοι ("νούμερο 1" = "νούμερο ένα").
 * Με τον κατάλογο (catalog): φράση που θα έκοβε μεγαλύτερο όνομα ("ζυμάρι"
 * μέσα στο "ζυμάρι 400", "το ξενοδοχείο" μέσα στο "το ξενοδοχείο Χ") δεν
 * αλλάζει· η ίδια φράση ή μεγαλύτερη από το όνομα αλλάζει κανονικά.
 */
export function applyPhrases(text: string, rules: VoicePhraseRule[] | null | undefined, catalog?: PhraseCatalog | null): string {
  const t = String(text ?? '')
  if (!Array.isArray(rules) || !rules.length) return t
  const ps = compilePhrases(rules)
  if (!ps.byFirst.size) return t
  const src = new Src(t)
  const ws = src.ws
  // ο κατάλογος διαβάζεται μόνο όταν πιάσει κάποια φράση
  let spans: [number, number][] | null = null
  /** κόβει όνομα του καταλόγου; (επικάλυψη χωρίς να το περιέχει όλο) */
  const cuts = (i: number, j: number) => {
    if (!spans) {
      const pr = getProtect(catalog)
      spans = pr ? protectedSpans(src, pr) : []
    }
    return spans.some(([s, e]) => s < j && e > i && (s < i || e > j))
  }
  let out = ''
  let last = 0
  let changed = false
  for (let i = 0; i < ws.length; ) {
    const cands: PhraseRule[] = []
    for (const key of [fold(ws[i].n), ...(src.num(i) ? ['#' + (src.num(i) as { value: number }).value] : [])]) {
      for (const c of ps.byFirst.get(key) ?? []) cands.push(c)
    }
    if (cands.length > 1) cands.sort((a, b) => b.words.length - a.words.length || b.chars - a.chars)
    // η φράση που πιάνει τις περισσότερες λέξεις (στην ισοπαλία: η πρώτη της σειράς)
    let r: PhraseRule | null = null
    let len = 0
    for (const c of cands) {
      const n = matchAt(src, i, c.words)
      if (n > len && !cuts(i, i + n)) { r = c; len = n }
    }
    if (!r) { i++; continue }
    const from = ws[i].from
    const to = ws[i + len - 1].to
    // κολλητά με γράμμα / ψηφίο ("2οικογενειακές"): κενά γύρω από τη σημασία
    const pre = from > 0 && /[\p{L}\p{N}]/u.test(t[from - 1]) ? ' ' : ''
    const post = to < t.length && /[\p{L}\p{N}]/u.test(t[to]) ? ' ' : ''
    out += t.slice(last, from) + pre + r.meaning + post
    last = to
    changed = true
    i += len
  }
  return changed ? out + t.slice(last) : t
}

/** Πρώτο γράμμα κεφαλαίο */
export function capFirst(s: string): string {
  return s ? s.charAt(0).toLocaleUpperCase('el-GR') + s.slice(1) : s
}

const LOWER_WORDS = new Set(['του', 'τησ', 'των', 'και', 'το', 'τα', 'η', 'ο', 'οι', 'στο', 'στη', 'στην', 'στον', 'με', 'απο', 'σε'])

/** Κεφαλαίο το πρώτο γράμμα κάθε λέξης (εκτός από άρθρα κλπ μετά την πρώτη) */
export function titleCase(s: string): string {
  return s
    .split(/\s+/)
    .filter(Boolean)
    .map((w, i) => (i > 0 && LOWER_WORDS.has(norm(w)) ? w.toLowerCase() : capFirst(w)))
    .join(' ')
}
