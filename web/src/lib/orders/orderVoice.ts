import { tokenize } from '../voice/normalize'
import { segment, type Seg } from '../voice/numbers'

/**
 * Φωνητικές εντολές για τις online παραγγελίες («δεκτή η 12 σε 20 λεπτά»,
 * «απόρριψε την 5», «έφυγε η 12», «κλείσε τις παραγγελίες», «διάβασε»).
 * Χωριστά από τον κατανοητή του «Πες το»: λίγες, σταθερές φράσεις της
 * κουζίνας. Δεν γράφει τίποτα· η οθόνη βρίσκει την παραγγελία και εκτελεί.
 *
 * strict (για το «Πες το», όπου ακούγονται και πωλήσεις / αγορές): μόνο
 * φράσεις που δεν μπορεί να είναι τίποτα άλλο, χωρίς άλλες λέξεις.
 */

/** Ποια παραγγελία: αριθμός, η πρώτη / η τελευταία νέα, ή όποια μένει (null) */
export type OrderPick = number | 'first' | 'last' | null

export type OrderVoiceCommand =
  | { kind: 'accept'; pick: OrderPick; minutes: number | null }
  | { kind: 'reject'; pick: OrderPick; reason: string | null }
  | { kind: 'done'; pick: OrderPick; all: boolean }
  | { kind: 'open' }
  | { kind: 'close' }
  | { kind: 'read'; pick: OrderPick }
  | { kind: 'stop' }

const ACCEPT = /^(δεκτ|δεχτ|δεχομ|δεξου|δεξ|αποδοχ|αποδεχ|αποδεξ)/
/** αυτά δεν είναι παρά αποδοχή παραγγελίας (και στο «Πες το») */
const ACCEPT_STRONG = /^(δεκτη|δεκτεσ|δεκτο|δεξου|αποδοχη|αποδεξου)$/
const REJECT = /^(απορρ|απορι)/
const DONE = /^(εφυγ|παραδοθ|παραδωσ|παρεδωσ|βγηκ)/
const OPEN = /^(ανοιξ|ανοιγ|ανοιχτ)/
const CLOSE = /^(κλεισ|κλειν|κλειστ)/
const READ = /^(διαβασ|ξαναπεσ|ξαναδιαβασ|επαναλαβ|ξαναλεγ)/
const STOP = /^(σταματα|σταματησε|σωπα|σιωπη|φτανει|αρκετα|σκασε)$/
const ORDER_NOUN = /^(παραγγελ|site$|σαιτ$|online$|ονλαιν$|σαιτ)/
const MINUTE = /^λεπτ/
const HOUR = /^ωρ(α|εσ|ουλα)$/
const QUARTER = /^τεταρτ/
const HALF_HOUR = /^(μισαωρο|μισαωρακι)$/
const REASON_START = new Set(['γιατι', 'επειδη', 'διοτι', 'λογω'])
const FIRST = new Set(['πρωτη', 'πρωτο', 'παλια', 'παλιοτερη'])
const LAST = new Set(['τελευταια', 'τελευταιο', 'καινουρια', 'νεοτερη'])
const ALL = new Set(['ολεσ', 'ολα', 'ολη', 'ολοι', 'ολουσ'])
/** για «τι παραγγελίες έχουμε;» */
const QUERY = new Set(['τι', 'ποιεσ', 'ποσεσ', 'εχουμε', 'εχει', 'εχω', 'ηρθαν', 'ηρθε', 'μεινανε', 'μενουν', 'περιμενουν'])
const FILLER = new Set([
  'η', 'ο', 'οι', 'το', 'τα', 'την', 'τη', 'τον', 'τισ', 'του', 'τησ', 'των', 'σε', 'στο', 'στη', 'στην', 'στα', 'στισ', 'στον',
  'και', 'κι', 'ναι', 'οκ', 'ok', 'λοιπον', 'παρακαλω', 'ευχαριστω', 'ενταξει', 'αυτη', 'αυτην', 'αυτο', 'αυτεσ',
  'νουμερο', 'αριθμο', 'αριθμοσ', 'νεα', 'νεεσ', 'μαγαζι', 'μασ', 'μου', 'πια', 'τωρα', 'αμεσωσ', 'εε', 'α', 'για',
])

interface Parsed { minutes: number | null; num: number | null; extra: number | null; used: Set<number> }

/** Λεπτά και αριθμός παραγγελίας από τα τμήματα */
function numbers(segs: Seg[]): Parsed {
  const used = new Set<number>()
  let minutes: number | null = null
  const plain: number[] = []
  const w = (i: number) => {
    const s = segs[i]
    return s && s.t === 'w' ? s.tok.n : null
  }
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]
    if (s.t === 'w') {
      if (HALF_HOUR.test(s.tok.n) && minutes === null) { minutes = 30; used.add(i) }
      else if (w(i) === 'μιση' && HOUR.test(w(i + 1) ?? '') && minutes === null) { minutes = 30; used.add(i); used.add(i + 1) }
      continue
    }
    if (s.t !== 'n') continue
    const next = w(i + 1) ?? ''
    if (MINUTE.test(next)) { minutes = s.value; used.add(i); used.add(i + 1); continue }
    if (HOUR.test(next)) { minutes = Math.round(s.value * 60); used.add(i); used.add(i + 1); continue }
    if (QUARTER.test(next)) { minutes = Math.round(s.value * 15); used.add(i); used.add(i + 1); continue }
    // «σε 20» χωρίς «λεπτά»: χρόνος
    if (w(i - 1) === 'σε' && minutes === null && s.value >= 5) { minutes = s.value; used.add(i); continue }
    plain.push(i)
  }
  // μόνο «τέταρτο» («σε ένα τέταρτο» το έπιασε ήδη το 1 + τέταρτο)
  if (minutes === null) {
    const q = segs.findIndex((s) => s.t === 'w' && QUARTER.test(s.tok.n))
    if (q >= 0) { minutes = 15; used.add(q) }
  }
  const val = (i: number | undefined) => (i === undefined ? null : (segs[i] as { value: number }).value)
  const num = val(plain[0])
  const extra = val(plain[1])
  for (const i of plain.slice(0, 2)) used.add(i)
  return { minutes, num, extra, used }
}

const isInt = (v: number | null): v is number => v !== null && Number.isInteger(v) && v > 0 && v < 1000

export function parseOrderVoice(text: string, opts: { strict?: boolean } = {}): OrderVoiceCommand | null {
  const strict = !!opts.strict
  const raw = String(text ?? '').slice(0, 300)
  const toks = tokenize(raw).filter((t) => !t.sep)
  if (toks.length === 0) return null
  const segs = segment(toks)
  const ws = segs.map((s) => (s.t === 'w' ? s.tok.n : null))
  const findW = (re: RegExp) => ws.findIndex((x) => x !== null && re.test(x))

  // λόγος απόρριψης: ό,τι μένει μετά το «γιατί»
  const ri = ws.findIndex((x) => x !== null && REASON_START.has(x))
  const body = ri >= 0 ? segs.slice(0, ri) : segs
  const bodyW = ws.slice(0, ri >= 0 ? ri : ws.length)
  let reason: string | null = null
  if (ri >= 0) {
    const from = segs[ri].to
    const r = toks.slice(from).map((t) => t.raw).join(' ').trim()
    reason = r ? r.charAt(0).toUpperCase() + r.slice(1) : null
  }

  const { minutes, num, extra, used } = numbers(body)
  const has = (set: Set<string>) => bodyW.some((x) => x !== null && set.has(x))
  const noun = bodyW.some((x) => x !== null && ORDER_NOUN.test(x))
  const pick: OrderPick = isInt(num) ? num : has(FIRST) ? 'first' : has(LAST) ? 'last' : null

  /** λέξεις που δεν είναι μέρος της εντολής (στο strict: καμία) */
  const leftovers = (verbAt: number, extraOk: (x: string) => boolean = () => false) =>
    bodyW.filter((x, i) => x !== null && i !== verbAt && !used.has(i) && !FILLER.has(x) && !ORDER_NOUN.test(x)
      && !FIRST.has(x) && !LAST.has(x) && !extraOk(x)).length

  const ai = findW(ACCEPT)
  const rj = findW(REJECT)
  const di = findW(DONE)
  const oi = findW(OPEN)
  const ci = findW(CLOSE)
  const rd = findW(READ)

  if (ai >= 0 && (rj < 0 || ai < rj)) {
    if (strict && (!(ACCEPT_STRONG.test(ws[ai]!) || noun) || leftovers(ai) > 0)) return null
    const mins = minutes ?? (isInt(num) && isInt(extra) && extra >= 5 ? extra : null)
    return { kind: 'accept', pick, minutes: mins !== null && mins >= 5 && mins <= 240 ? Math.round(mins) : null }
  }
  if (rj >= 0) {
    if (strict && leftovers(rj) > 0) return null
    return { kind: 'reject', pick, reason }
  }
  if (di >= 0) {
    const all = has(ALL)
    if (strict && ((!isInt(num) && !noun && !all) || leftovers(di, (x) => ALL.has(x)) > 0)) return null
    return { kind: 'done', pick: all ? null : pick, all }
  }
  if (oi >= 0 || ci >= 0) {
    // «κλείσε τη μέρα / την απογραφή» δεν είναι δική μας
    const vi = oi >= 0 && (ci < 0 || oi < ci) ? oi : ci
    if ((strict && !noun) || leftovers(vi) > 0) return null
    return vi === oi ? { kind: 'open' } : { kind: 'close' }
  }
  if (rd >= 0) {
    if (strict && (!noun || leftovers(rd) > 0)) return null
    return { kind: 'read', pick }
  }
  // «τι παραγγελίες έχουμε;», «έχουμε παραγγελίες;»
  if (noun && has(QUERY) && leftovers(-1, (x) => QUERY.has(x)) === 0) return { kind: 'read', pick: null }
  if (!strict && bodyW.length > 0 && bodyW.every((x) => x === null || STOP.test(x) || FILLER.has(x)) && bodyW.some((x) => x !== null && STOP.test(x))) {
    return { kind: 'stop' }
  }
  return null
}
