import { tokenize } from '../voice/normalize'
import { segment } from '../voice/numbers'

/**
 * Φωνή του διανομέα: «παραδόθηκε», «παραδόθηκε η 12», «την παίρνω η 12»,
 * «φεύγω με την 12», «δεν την πήρα η 12», «διάβασε». Λίγες φράσεις, για
 * όταν τα χέρια είναι στο τιμόνι.
 */

export type DriverCommand =
  | { kind: 'delivered'; no: number | null }
  | { kind: 'take'; no: number | null }
  | { kind: 'release'; no: number | null }
  | { kind: 'read' }

const DELIVERED = /^(παραδοθ|παρεδοθ|παραδωσ|παρεδωσ|εδωσα|δοθηκε|τελειωσ|παραδοσ)/
const TAKE = /^(παιρν|πηρα|αναλαμβ|φευγω|φευγ)/
const NOT = new Set(['δεν', 'δε', 'οχι'])
const READ = /^(διαβασ|επομεν|ποια|ποιες|τι|πες|ξαναπεσ)/

export function parseDriverVoice(text: string): DriverCommand | null {
  const toks = tokenize(String(text ?? '').slice(0, 200)).filter((t) => !t.sep)
  if (toks.length === 0) return null
  const segs = segment(toks)
  const words = segs.flatMap((s) => (s.t === 'w' ? [s.tok.n] : []))
  const nums = segs.flatMap((s) => (s.t === 'n' && Number.isInteger(s.value) && s.value > 0 && s.value < 1000 ? [s.value] : []))
  const no = nums.length ? nums[0] : null
  const neg = words.some((w) => NOT.has(w))
  if (words.some((w) => DELIVERED.test(w))) return neg ? null : { kind: 'delivered', no }
  if (words.some((w) => TAKE.test(w))) return neg ? { kind: 'release', no } : { kind: 'take', no }
  if (words.some((w) => READ.test(w))) return { kind: 'read' }
  return null
}
