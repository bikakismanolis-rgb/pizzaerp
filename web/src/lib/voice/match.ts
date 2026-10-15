import type { Item, Partner } from '../types'
import type { Candidate, EntityRef } from './types'
import { keySim, norm, stemKey, tokenize, type Tok } from './normalize'
import { segment, type Seg } from './numbers'
import { COMPANY_SUFFIX, LETTER_NAMES, isStop, packForms, unitWord, type NameUnit } from './lexicon'

/**
 * Αντιστοίχιση φράσεων με είδη / συναλλασσόμενους. Κάθε όνομα (και κάθε
 * alias) σπάει σε tokens με βάρη (σπάνιες λέξεις μετράνε περισσότερο).
 * Μια φράση που ακούστηκε βαθμολογείται με F0.5 (ακρίβεια × κάλυψη),
 * και ένας δυναμικός προγραμματισμός διαλέγει τις καλύτερες μη επικαλυπτόμενες
 * φράσεις της πρότασης.
 */

export type EntryKind = 'item' | 'partner'

interface FTok {
  k: 'w' | 'n' | 'u'
  n: string
  key: string
  value: number
  unit: NameUnit | null
  w: number
  opt: boolean
}

interface Form {
  toks: FTok[]
  alias: boolean
}

export interface Entry {
  kind: EntryKind
  id: string
  name: string
  item?: Item
  partner?: Partner
  forms: Form[]
  codeKey: string
}

export interface Index {
  entries: Entry[]
  /** κλειδί λέξης → entries */
  vocab: Map<string, number[]>
  /** αριθμός μέσα σε όνομα (Ζυμάρι 400γρ) → entries */
  nums: Map<number, number[]>
  /** κομμάτια κωδικών ("πυ", "001") */
  codeParts: Set<string>
  /** ομοιότητες λέξεων που έχουν ήδη υπολογιστεί για αυτόν τον κατάλογο */
  simCache: Map<string, Map<string, number>>
  /** όλοι οι τύποι των συσκευασιών των ενεργών ειδών ("σακιά", "κούτες") */
  packs: Set<string>
}

/** Πόσο "μετράει" κάθε entry για την τρέχουσα εντολή (0 = εκτός) */
export interface Pool {
  item?: (it: Item) => number
  partner?: (p: Partner) => number
}

const NUM_W = 0.3
const UNIT_W = 0.3

function formOf(text: string, alias: boolean): Form | null {
  const toks = tokenize(text)
  const segs = segment(toks)
  const out: FTok[] = []
  for (const s of segs) {
    if (s.t === 'n') out.push({ k: 'n', n: s.digits, key: '', value: s.value, unit: null, w: NUM_W, opt: false })
    else if (s.t === 'w') {
      const n = s.tok.n
      const u = unitWord(n)
      if (u && out.length > 0) out.push({ k: 'u', n, key: '', value: 0, unit: u, w: UNIT_W, opt: true })
      else if (COMPANY_SUFFIX.has(n)) out.push({ k: 'w', n, key: s.tok.key, value: 0, unit: null, w: 0.2, opt: true })
      else if (isStop(n) && out.length > 0) continue
      else out.push({ k: 'w', n, key: s.tok.key, value: 0, unit: null, w: 1, opt: false })
    }
  }
  if (!out.some((t) => !t.opt)) return null
  return { toks: out, alias }
}

function buildIndex(items: Item[], partners: Partner[]): Index {
  const entries: Entry[] = []
  const mk = (kind: EntryKind, id: string, name: string, code: string, aliases: string[] | null | undefined) => {
    const forms: Form[] = []
    const f = formOf(name, false)
    if (f) forms.push(f)
    for (const a of aliases ?? []) {
      const fa = typeof a === 'string' ? formOf(a, true) : null
      if (fa) forms.push(fa)
    }
    return { kind, id, name, forms, codeKey: norm(code ?? '').replace(/[^0-9a-zα-ω]/g, '') }
  }
  for (const it of items ?? []) {
    if (!it || !it.is_active) continue
    entries.push({ ...mk('item', it.id, it.name, it.code, it.aliases), item: it })
  }
  for (const p of partners ?? []) {
    if (!p || !p.is_active) continue
    entries.push({ ...mk('partner', p.id, p.name, p.code, p.aliases), partner: p })
  }
  // βάρη: 1/√(πλήθος entries του ίδιου τύπου με αυτή τη λέξη)
  const df = new Map<string, number>()
  const vocab = new Map<string, number[]>()
  const nums = new Map<number, number[]>()
  entries.forEach((e, idx) => {
    const keys = new Set<string>()
    const vals = new Set<number>()
    for (const f of e.forms) for (const t of f.toks) { if (t.k === 'w' && t.key) keys.add(t.key); if (t.k === 'n') vals.add(t.value) }
    for (const v of vals) { const l = nums.get(v); if (l) l.push(idx); else nums.set(v, [idx]) }
    for (const k of keys) {
      df.set(e.kind + ':' + k, (df.get(e.kind + ':' + k) ?? 0) + 1)
      const l = vocab.get(k)
      if (l) l.push(idx)
      else vocab.set(k, [idx])
    }
  })
  for (const e of entries) {
    for (const f of e.forms) {
      for (const t of f.toks) {
        if (t.k === 'w' && !t.opt) t.w = 1 / Math.sqrt(df.get(e.kind + ':' + t.key) ?? 1)
      }
    }
  }
  const codeParts = new Set<string>()
  for (const it of items ?? []) if (it?.is_active && it.code) for (const t of tokenize(it.code)) if (!t.sep) codeParts.add(t.digits ?? t.n)
  for (const p of partners ?? []) if (p?.is_active && p.code) for (const t of tokenize(p.code)) if (!t.sep) codeParts.add(t.digits ?? t.n)
  const packs = new Set<string>()
  for (const it of items ?? []) if (it?.is_active && it.pack_name) for (const f of packForms(it.pack_name)) packs.add(f)
  return { entries, vocab, nums, codeParts, simCache: new Map(), packs }
}

const cache = new WeakMap<object, WeakMap<object, { sig: string; idx: Index }>>()

/** Φθηνή υπογραφή: πιάνει αλλαγές "μέσα" στον ίδιο πίνακα (push, νέο alias, απενεργοποίηση) */
function signature(items: Item[], partners: Partner[]): string {
  let h = 0
  const add = (s: string) => { for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0 }
  for (const it of items) if (it) { add(it.id + it.name + (it.is_active ? 1 : 0) + (it.aliases ?? []).join('|') + (it.pack_name ?? '')) }
  for (const p of partners) if (p) { add(p.id + p.name + (p.is_active ? 1 : 0) + (p.aliases ?? []).join('|')) }
  return `${items.length}:${partners.length}:${h}`
}

/** Ευρετήριο καταλόγου (κρατιέται όσο ο κατάλογος δεν αλλάζει) */
export function getIndex(items: Item[], partners: Partner[]): Index {
  const its = Array.isArray(items) ? items : []
  const ps = Array.isArray(partners) ? partners : []
  let m = cache.get(its)
  if (!m) { m = new WeakMap(); cache.set(its, m) }
  const sig = signature(its, ps)
  const hit = m.get(ps)
  if (hit && hit.sig === sig) return hit.idx
  const idx = buildIndex(its, ps)
  m.set(ps, { sig, idx })
  return idx
}

// ---------------------------------------------------------------------
// Βαθμολόγηση φράσης
// ---------------------------------------------------------------------
interface HTok {
  k: 'w' | 'n' | 'u'
  size?: boolean
  n: string
  key: string
  value: number
  unit: NameUnit | null
  letter: string
  hw: number
  /** ομοιότητα με λέξεις του καταλόγου (κλειδί → 0..1) */
  sims: Map<string, number> | null
}

function tokSim(h: HTok, f: FTok): number {
  if (h.k !== f.k) return 0
  if (h.k === 'n') return h.value === f.value ? 1 : 0
  if (h.k === 'u') return h.unit === f.unit ? 1 : 0
  if (h.n === f.n) return 1
  if (f.n.length === 1) return h.letter === f.n ? 1 : 0
  return h.sims?.get(f.key) ?? 0
}

/** F0.5 ανάμεσα σε ό,τι ακούστηκε (H) και ένα όνομα (f), με άπληστο ταίριασμα tokens */
function scoreForm(H: HTok[], f: Form): { score: number; explained: number; mass: number } {
  const nh = H.length
  const nf = f.toks.length
  const sim = new Float64Array(nh * nf)
  let any = false
  for (let i = 0; i < nh; i++) {
    for (let j = 0; j < nf; j++) {
      const v = tokSim(H[i], f.toks[j])
      sim[i * nf + j] = v
      if (v > 0) any = true
    }
  }
  if (!any) return { score: 0, explained: 0, mass: 0 }
  const hs = new Float64Array(nh)
  const fs = new Float64Array(nf)
  const fOf = new Int8Array(nh).fill(-1)
  const hUsed = new Uint8Array(nh)
  const fUsed = new Uint8Array(nf)
  for (;;) {
    let bv = 0
    let bi = -1
    let bj = -1
    for (let i = 0; i < nh; i++) {
      if (hUsed[i]) continue
      for (let j = 0; j < nf; j++) {
        if (fUsed[j]) continue
        const v = sim[i * nf + j]
        if (v > bv) { bv = v; bi = i; bj = j }
      }
    }
    if (bi < 0) break
    hUsed[bi] = 1
    fUsed[bj] = 1
    hs[bi] = bv
    fs[bj] = bv
    fOf[bi] = bj
  }
  // αριθμός στην αρχή της φράσης μόνο αν και το όνομα ξεκινά με αυτόν τον αριθμό
  if (H[0]?.k === 'n' && !H[0].size) {
    const first = f.toks.findIndex((t) => !t.opt)
    if (fOf[0] !== first || f.toks[first]?.k !== 'n') return { score: 0, explained: 0, mass: 0 }
  }
  let recNum = 0
  let recDen = 0
  for (let j = 0; j < nf; j++) {
    const t = f.toks[j]
    if (fUsed[j]) { recNum += t.w * fs[j]; recDen += t.w }
    else if (!t.opt) recDen += t.w
  }
  let precNum = 0
  let precDen = 0
  for (let i = 0; i < nh; i++) { precDen += H[i].hw; precNum += H[i].hw * hs[i] }
  if (!recDen || !precDen || !recNum || !precNum) return { score: 0, explained: 0, mass: 0 }
  const R = recNum / recDen
  const P = precNum / precDen
  const score = (1.25 * P * R) / (0.25 * P + R)
  return { score, explained: precNum, mass: precDen }
}

export interface Scored {
  entry: Entry
  score: number
  /** πόσο από ό,τι ακούστηκε εξηγεί το όνομα */
  explained: number
  /** σύνολο βάρους των tokens της φράσης */
  mass?: number
}

/** Ρόλος κάθε τμήματος για τον εντοπισμό φράσεων */
export type Role = 'content' | 'stop' | 'num' | 'unit' | 'block'

export interface Hit {
  /** τμήματα [from, to) */
  from: number
  to: number
  heard: string
  ranked: Scored[]
  /** χωρίς ταίριασμα: λέξεις που δεν βρέθηκαν στον κατάλογο */
  unknown?: boolean
}

export class Matcher {
  private rawCache = new Map<string, Scored[]>()
  constructor(
    private idx: Index,
    private toks: Tok[],
    private segs: Seg[],
  ) {}

  private hTok(s: Seg, role: Role): HTok | null {
    if (s.t === 'n') return { k: 'n', n: s.digits, key: '', value: s.value, unit: null, letter: '', hw: 0.7, size: !!s.size, sims: null }
    if (s.t !== 'w' || role === 'stop') return null
    const n = s.tok.n
    if (role === 'unit') return { k: 'u', n, key: '', value: 0, unit: unitWord(n), letter: '', hw: 0.5, sims: null }
    return {
      k: 'w', n, key: s.tok.key, value: 0, unit: null, letter: LETTER_NAMES[n] ?? (n.length === 1 ? n : ''), hw: 1,
      sims: this.similar(s.tok.key, n),
    }
  }

  /** λέξεις του καταλόγου που μοιάζουν με το κλειδί */
  private similar(key: string, n: string): Map<string, number> {
    const ck = key + '|' + n
    const cache = this.idx.simCache
    const hit = cache.get(ck)
    if (hit) return hit
    const out = new Map<string, number>()
    for (const vk of this.idx.vocab.keys()) {
      const s = vk === key ? 1 : keySim(key, vk)
      if (s > 0) out.set(vk, s)
    }
    const letter = LETTER_NAMES[n]
    if (letter) {
      const lk = stemKey(letter)
      if (this.idx.vocab.has(lk)) out.set(lk, 1)
    }
    if (cache.size > 5000) cache.clear()
    cache.set(ck, out)
    return out
  }

  /** Μπορεί αυτό το τμήμα να ανήκει σε κάποιο όνομα; (για κλάδεμα φράσεων) */
  private matchable(i: number, role: Role): boolean {
    const s = this.segs[i]
    if (role === 'unit') return true
    if (s.t === 'n') return !!this.idx.nums.get(s.value)?.length || this.idx.codeParts.has(s.digits)
    if (s.t !== 'w') return false
    const n = s.tok.n
    return this.similar(s.tok.key, n).size > 0 || this.idx.codeParts.has(n)
  }

  /** Βαθμοί χωρίς βάρη δεξαμενής (κρατιούνται για όλες τις σαρώσεις της φράσης) */
  private raw(from: number, to: number, roles: Role[]): Scored[] {
    const ck = from + ':' + to + ':' + roles.slice(from, to).join(',')
    const hit = this.rawCache.get(ck)
    if (hit) return hit
    const H: HTok[] = []
    const cand = new Set<number>()
    let code = ''
    for (let i = from; i < to; i++) {
      const h = this.hTok(this.segs[i], roles[i])
      if (!h) continue
      H.push(h)
      if (h.k === 'w' && h.sims) {
        for (const vk of h.sims.keys()) for (const e of this.idx.vocab.get(vk) ?? []) cand.add(e)
      } else if (h.k === 'n' && h.size) for (const e of this.idx.nums.get(h.value) ?? []) cand.add(e)
      code += h.n
    }
    const out: Scored[] = []
    if (H.length) {
      const codeKey = code.replace(/[^0-9a-zα-ω]/g, '')
      const consider = (ei: number) => {
        const e = this.idx.entries[ei]
        let best = { score: 0, explained: 0, mass: 0 }
        for (const f of e.forms) {
          const r = scoreForm(H, f)
          if (r.score > best.score) best = r
        }
        if (codeKey.length >= 3 && e.codeKey === codeKey) best = { score: 0.97, explained: H.length, mass: H.length }
        if (best.score > 0) out.push({ entry: e, score: best.score, explained: best.explained, mass: best.mass })
      }
      for (const ei of cand) consider(ei)
      // ακριβής κωδικός
      if (codeKey.length >= 3) this.idx.entries.forEach((e, ei) => { if (e.codeKey === codeKey && !cand.has(ei)) consider(ei) })
    }
    this.rawCache.set(ck, out)
    return out
  }

  /** Κατάταξη υποψηφίων για τα τμήματα [from, to) */
  rank(from: number, to: number, roles: Role[], pool: Pool): Scored[] {
    const out: Scored[] = []
    for (const r of this.raw(from, to, roles)) {
      const e = r.entry
      const w = e.kind === 'item' ? (e.item && pool.item ? pool.item(e.item) : 0) : e.partner && pool.partner ? pool.partner(e.partner) : 0
      if (w > 0) out.push({ entry: e, score: r.score * w, explained: r.explained, mass: r.mass })
    }
    out.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
    return out
  }

  private isSize(i: number): boolean {
    const s = this.segs[i]
    return s?.t === 'n' && !!s.size
  }

  heard(from: number, to: number): string {
    if (from >= to) return ''
    const a = this.segs[from].from
    const b = this.segs[to - 1].to
    return this.toks.slice(a, b).map((t) => t.raw).join(' ')
  }

  /**
   * Καλύτερη διαμέριση της πρότασης σε φράσεις-οντότητες (μόνο μέσα στο
   * [lo, hi) και μόνο σε τμήματα που δεν είναι 'block').
   */
  find(roles: Role[], pool: Pool, lo = 0, hi = this.segs.length, minScore = 0.5): Hit[] {
    const n = hi
    const best = new Array<number>(n + 1).fill(0)
    const choice = new Array<number>(n + 1).fill(-1)
    const ranked = new Map<string, Scored[]>()
    const MAXLEN = 6
    for (let i = n - 1; i >= lo; i--) {
      best[i] = best[i + 1]
      choice[i] = -1
      const r0 = roles[i]
      if (r0 !== 'content' && r0 !== 'num') continue
      // φράση που ξεκινά ή τελειώνει με λέξη που δεν μοιάζει με τίποτα δεν κερδίζει ποτέ
      if (!this.matchable(i, r0)) continue
      for (let end = i + 1; end <= Math.min(n, i + MAXLEN); end++) {
        const r = roles[end - 1]
        if (r === 'block') break
        if (r === 'stop') continue
        if (!this.matchable(end - 1, r)) continue
        if (!roles.slice(i, end).some((x, k) => x === 'content' || this.isSize(i + k))) continue
        const list = this.rank(i, end, roles, pool)
        const top = list[0]
        if (!top || top.score < minScore) continue
        // αξία: ό,τι εξηγείται, μείον σταθερό κόστος ανά φράση, μείον ό,τι μένει ανεξήγητο μέσα της
        const v = top.score * top.explained - 0.3 - 0.5 * Math.max(0, (top.mass ?? top.explained) - top.explained)
        if (v <= 0) continue
        if (v + best[end] > best[i] + 1e-9) {
          best[i] = v + best[end]
          choice[i] = end
          ranked.set(i + ':' + end, list)
        }
      }
    }
    const hits: Hit[] = []
    let i = lo
    while (i < n) {
      const end = choice[i]
      if (end > i) {
        hits.push({ from: i, to: end, heard: this.heard(i, end), ranked: ranked.get(i + ':' + end) ?? [] })
        i = end
      } else i++
    }
    return hits
  }

  /** Συνεχόμενες λέξεις περιεχομένου που δεν ταίριαξαν πουθενά */
  unknownRuns(roles: Role[], hits: Hit[], pool: Pool, lo = 0, hi = this.segs.length): Hit[] {
    const covered = new Array<boolean>(this.segs.length).fill(false)
    for (const h of hits) for (let i = h.from; i < h.to; i++) covered[i] = true
    const out: Hit[] = []
    let i = lo
    while (i < hi) {
      if (covered[i] || roles[i] !== 'content') { i++; continue }
      let j = i
      while (j < hi && !covered[j] && (roles[j] === 'content' || roles[j] === 'stop')) j++
      let e = j
      while (e > i && roles[e - 1] === 'stop') e--
      if (e - i <= 4) {
        const ranked = this.rank(i, e, roles, pool).filter((s) => s.score >= 0.3)
        out.push({ from: i, to: e, heard: this.heard(i, e), ranked, unknown: true })
      }
      i = j
    }
    return out
  }
}

// ---------------------------------------------------------------------
// Από υποψηφίους σε EntityRef
// ---------------------------------------------------------------------
export const SURE = 0.75
export const GAP = 0.12

/** Ο καλύτερος υποψήφιος, αν είναι αρκετά σίγουρος */
export function confident(ranked: Scored[]): Scored | null {
  const [a, b] = ranked
  if (!a) return null
  if (a.score >= SURE && (!b || a.score - b.score >= GAP)) return a
  if (a.score >= 0.6 && (!b || b.score < 0.45)) return a
  return null
}

export function toCandidates(ranked: Scored[], min = 0.4): Candidate[] {
  return ranked
    .filter((s) => s.score >= min)
    .slice(0, 5)
    .map((s) => ({ id: s.entry.id, name: s.entry.name, score: Math.round(Math.min(1, s.score) * 1000) / 1000 }))
}

export function toRef(heard: string, ranked: Scored[]): EntityRef {
  const c = confident(ranked)
  let cands = toCandidates(ranked)
  if (c && !cands.some((x) => x.id === c.entry.id)) cands = [{ id: c.entry.id, name: c.entry.name, score: Math.round(c.score * 1000) / 1000 }, ...cands].slice(0, 5)
  return { heard, id: c ? c.entry.id : null, candidates: cands }
}

/** Κενή αναφορά (δεν ακούστηκε τίποτα) με προτάσεις */
export function emptyRef(ranked: Scored[] = []): EntityRef {
  return { heard: '', id: null, candidates: toCandidates(ranked, 0) }
}
