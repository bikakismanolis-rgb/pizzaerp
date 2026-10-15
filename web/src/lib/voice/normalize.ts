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
  if (long.startsWith(short)) return 0.75 + (0.2 * short.length) / long.length
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
  // 400γρ → 400 γρ, x2 → x 2
  s = s.replace(/(\d)(?=\p{L})/gu, '$1 ').replace(/(\p{L})(?=\d)/gu, '$1 ')
  const out: Tok[] = []
  for (const m of s.matchAll(TOKEN_RE)) {
    const raw = m[0]
    if (/^\d/.test(raw)) {
      out.push({ raw, n: raw, key: '', num: parseDigits(raw), digits: raw.replace(/\D/g, '') })
    } else if (/^[,;:.!?·;]$/.test(raw)) {
      out.push({ raw, n: raw, key: '', sep: true })
    } else if (raw === '€') {
      out.push({ raw, n: 'ευρω', key: 'evro' })
    } else if (raw === '/') {
      out.push({ raw, n: 'ανα', key: 'ana' })
    } else if (raw === '%') {
      out.push({ raw, n: '%', key: '' })
    } else {
      const n = norm(raw)
      out.push({ raw, n, key: stemKey(n) })
    }
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
