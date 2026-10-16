import type { Item } from './types'
import type { Command, CommandKind, EntityRef, QtyLine, TallyChannel, VoicePhraseRule } from './voice/types'
import { parseYesNo } from './voice/describe'
import { applyPhrases, phraseKey } from './voice/normalize'
import { CHANNEL_LABEL, docCode } from './labels'
import { fmtDate, fmtQty, round } from './format'

/**
 * Κανόνες της κάρτας επιβεβαίωσης του «Πες το» και βοηθητικά των ενεργειών.
 * Καθαρές συναρτήσεις (χωρίς βάση / DOM), ώστε να ελέγχονται με vitest.
 */

// ---------------------------------------------------------------------
// Ανοιχτά πρόχειρα (μετρητής ημέρας, απογραφή σε εξέλιξη)
// ---------------------------------------------------------------------
export interface TallyRow {
  channel: TallyChannel; date: string; docId: string; docNo: number; qty: number; gross: number
  /** ανοιχτή ποσότητα ανά είδος (item_id → qty) */
  items: Record<string, number>
}
export interface RunningStocktake {
  id: string
  docNo: number
  date: string
  count: number
  /** μετρημένη ποσότητα ανά είδος (item_id → qty) */
  counted: Record<string, number>
}
/** Καταχωρημένες «Πωλήσεις ημέρας» ενός είδους: ποσότητα και παραστατικά (αριθμοί ΠΩ) */
export interface PostedQty { qty: number; docs: number[] }
/** Σημερινές πωλήσεις ενός καναλιού: καταχωρημένες + ανοιχτές */
export interface ChannelTotal {
  channel: TallyChannel; qty: number; gross: number
  /** από τα καταχωρημένα */
  postedQty: number
  /** καταχωρημένα ανά είδος */
  postedItems: Record<string, PostedQty>
}
export interface RunningState {
  /** σημερινές ανοιχτές πωλήσεις ανά κανάλι */
  tally: TallyRow[]
  /** ανοιχτές πωλήσεις προηγούμενων ημερών (δεν έχουν κλείσει ακόμα) */
  older: TallyRow[]
  /** σημερινά σύνολα ανά κανάλι (καταχωρημένες «Πωλήσεις ημέρας», π.χ. από μέτρηση, + ανοιχτές) */
  totals: ChannelTotal[]
  /** απογραφές σε εξέλιξη έως σήμερα, η παλιότερη πρώτη */
  stocktakes: RunningStocktake[]
  /**
   * Έχει γραφτεί ήδη κάτι με σημερινή ημερομηνία (κίνηση αποθήκης ή ανοιχτή
   * πώληση ημέρας); null = δεν ελέγχθηκε (ελέγχεται μόνο όταν υπάρχει χθεσινή
   * απογραφή σε εξέλιξη και καμία σημερινή).
   */
  movedToday: boolean | null
}

/** YYYY-MM-DD ± ημέρες */
export function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

/** Ως αυτή την ώρα (τοπική) ένα μέτρημα που πέρασε τα μεσάνυχτα συνεχίζει τη χθεσινή απογραφή */
export const NIGHT_END_HOUR = 5

/** Τοπική ώρα τώρα (0–23) */
export const localHour = () => new Date().getHours()

export interface StockTarget<T> {
  /** ημερομηνία των μετρήσεων */
  date: string
  /** η απογραφή σε εξέλιξη όπου μπαίνουν (null = θα ξεκινήσει νέα) */
  doc: T | null
  /** άλλες απογραφές σε εξέλιξη (παλιότερες) που δεν συνεχίζονται */
  stale: T[]
}

/**
 * Σε ποια απογραφή γράφονται οι μετρήσεις. Η μέτρηση μετράει τη στιγμή που
 * λέγεται, με σημερινή ημερομηνία: ό,τι γράφτηκε σήμερα ως τότε είναι πριν
 * από αυτήν. Η χθεσινή απογραφή συνεχίζει μόνο σε μέτρημα που πέρασε τα
 * μεσάνυχτα (ως τις 5 το πρωί) και όσο δεν έχει γραφτεί τίποτα με σημερινή
 * ημερομηνία· αλλιώς οι σημερινές αγορές / πωλήσεις πριν από τη μέτρηση θα
 * έμεναν «μετά» από αυτήν, ενώ είναι ήδη μέσα σε ό,τι μετρήθηκε (θα μετρούσαν
 * δύο φορές). Ξεχασμένη ανοιχτή απογραφή δεν συνεχίζει: νέα σημερινή.
 * movedToday null = άγνωστο (δεν συνεχίζει).
 */
export function stockTarget<T extends { date: string }>(
  open: T[], today: string, now: { hour: number; movedToday: boolean | null },
): StockTarget<T> {
  let doc = open.find((o) => o.date === today) ?? null
  if (!doc && now.hour < NIGHT_END_HOUR && now.movedToday === false) doc = open.find((o) => o.date === addDays(today, -1)) ?? null
  return { date: doc?.date ?? today, doc, stale: open.filter((o) => o !== doc && o.date < today) }
}

/** Η απογραφή όπου θα γραφτεί τώρα μια μέτρηση (από ό,τι έχει φορτωθεί) */
export function targetOf(running: Pick<RunningState, 'stocktakes' | 'movedToday'> | null, today: string, hour: number): StockTarget<RunningStocktake> {
  return stockTarget(running?.stocktakes ?? [], today, { hour, movedToday: running?.movedToday ?? null })
}

/** "1 είδος" / "3 είδη" */
export const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

// ---------------------------------------------------------------------
// Απογραφή δωμάτιο-δωμάτιο: πρόσθεση / αντικατάσταση
// ---------------------------------------------------------------------
/**
 * Οι μετρήσεις της ανοιχτής απογραφής στην οποία θα γραφτεί η φράση
 * (σημερινή ή χθεσινή που συνεχίζει μετά τα μεσάνυχτα)· {} όταν θα
 * ξεκινήσει νέα.
 */
export function countedFor(running: Pick<RunningState, 'stocktakes' | 'movedToday'> | null, today: string, hour: number): Record<string, number> {
  return targetOf(running, today, hour).doc?.counted ?? {}
}

/** Το είδος έχει μέτρηση σε παλιότερη απογραφή που δεν συνεχίζεται (η πιο πρόσφατη) */
export function staleCount(stale: RunningStocktake[], itemId: string): { date: string; docNo: number; qty: number } | null {
  for (let i = stale.length - 1; i >= 0; i--) {
    const s = stale[i]
    if (itemId in s.counted) return { date: s.date, docNo: s.docNo, qty: Number(s.counted[itemId]) }
  }
  return null
}

/** "ΑΠ-3 της 15/10/2026, ΑΠ-4 της 16/10/2026" */
export const stocktakeList = (sts: { docNo: number; date: string }[]) =>
  sts.map((s) => `${docCode('stocktake', s.docNo)} της ${fmtDate(s.date)}`).join(', ')

export type StockMode = 'add' | 'set'
interface StockLineIn { id: string | null; qty: number; mode?: StockMode }

export interface StockLineView {
  /** μέτρηση του είδους πριν από τη γραμμή (από την απογραφή ή από προηγούμενη γραμμή της φράσης)· null = πρώτη */
  before: number | null
  /** τι θα γίνει: null = πρώτη μέτρηση (πρόσθεση και αντικατάσταση δίνουν το ίδιο) */
  mode: StockMode | null
  /** η μέτρηση μετά τη γραμμή */
  after: number
}

/**
 * Τι θα γίνει σε κάθε γραμμή της κάρτας. Χωρίς λέξη (mode undefined):
 * πρόσθεση όταν το είδος έχει ήδη μέτρηση (άλλος χώρος), αλλιώς σκέτη
 * μέτρηση.
 */
export function stockLineViews(lines: StockLineIn[], counted: Record<string, number>): StockLineView[] {
  const cur = new Map<string, number>()
  return lines.map((l) => {
    const q = Number.isFinite(l.qty) ? l.qty : 0
    if (!l.id) return { before: null, mode: null, after: q }
    const before = cur.has(l.id) ? cur.get(l.id)! : l.id in counted ? Number(counted[l.id]) : null
    const mode: StockMode | null = before === null ? null : l.mode ?? 'add'
    const after = round(mode === 'add' ? (before ?? 0) + q : q, 4)
    cur.set(l.id, after)
    return { before, mode, after }
  })
}

/** Μία κλήση stocktake_count ανά είδος: add → p_add (πρόσθεση στην τρέχουσα μέτρηση) */
export interface StockOp { id: string; add: boolean; qty: number }

/**
 * Οι γραμμές ενωμένες ανά είδος, με τη σειρά τους. Χωρίς λέξη = πρόσθεση:
 * σε είδος χωρίς μέτρηση είναι το ίδιο με τη μέτρηση, και αν στο μεταξύ
 * μέτρησε κάτι άλλη συσκευή (άλλος χώρος), δεν σβήνεται.
 */
export function stockOps(lines: { id: string; qty: number; mode?: StockMode }[]): StockOp[] {
  const m = new Map<string, StockOp>()
  for (const l of lines) {
    const op = m.get(l.id) ?? { id: l.id, add: true, qty: 0 }
    if (l.mode === 'set') { op.add = false; op.qty = round(l.qty, 4) } else op.qty = round(op.qty + l.qty, 4)
    m.set(l.id, op)
  }
  return [...m.values()]
}

/** "Αλεύρι: 10 + 5 = 15 kg" / "Αλεύρι: 40 kg (αντί για 35)" / "Αλεύρι: 10 kg" */
export function stockResultText(v: StockLineView, name: string, unit: string): string {
  const u = unit === 'τεμ' ? '' : ` ${unit}`
  if (v.mode === 'add') return `${name}: ${fmtQty(v.before)} + ${fmtQty(round(v.after - (v.before ?? 0), 4))} = ${fmtQty(v.after)}${u}`
  if (v.mode === 'set') return `${name}: ${fmtQty(v.after)}${u} (αντί για ${fmtQty(v.before)})`
  return `${name}: ${fmtQty(v.after)}${u}`
}

/**
 * Για την ανάγνωση: το νέο σύνολο των ειδών όπου η μέτρηση προστίθεται σε
 * προηγούμενη ("Νέο σύνολο: Αλεύρι 15 kg."), αλλιώς '' (στο «σύνολο 40»
 * ακούγεται ήδη).
 */
export function stockTotalsText(lines: StockLineIn[], views: StockLineView[], label: (id: string) => { name: string; unit: string } | null): string {
  const last = new Map<string, StockLineView>()
  lines.forEach((l, i) => { if (l.id) last.set(l.id, views[i]) })
  const parts: string[] = []
  for (const [id, v] of last) {
    const it = label(id)
    if (!it || v.mode !== 'add') continue
    parts.push(`${it.name} ${fmtQty(v.after)}${it.unit === 'τεμ' ? '' : ' ' + it.unit}`)
  }
  return parts.length ? `Νέο σύνολο: ${parts.join(', ')}.` : ''
}

/** Βάζει κείμενο πριν από την ερώτηση στο τέλος ("… Να το περάσω;") */
export function beforeQuestion(sentence: string, extra: string): string {
  if (!extra) return sentence
  const m = /\s(Να [^.;]*;)$/.exec(sentence)
  return m ? `${sentence.slice(0, m.index)} ${extra} ${m[1]}` : `${sentence} ${extra}`
}


// ---------------------------------------------------------------------
// Αφαίρεση από τον μετρητή
// ---------------------------------------------------------------------
export interface TallyStep {
  id: string
  /** ό,τι θα σταλεί στο tally_add (0 = τίποτα) */
  delta: number
  /** ό,τι ζητήθηκε */
  asked: number
}

/**
 * Βήματα για τον μετρητή. Οι αφαιρέσεις περιορίζονται σε όσα υπάρχουν: ο
 * server σβήνει τη γραμμή στο 0, άρα η αναίρεση πρέπει να ξέρει πόσα βγήκαν
 * στην πραγματικότητα. lines: ένα ανά είδος (ήδη ενωμένα).
 */
export function tallySteps(lines: { id: string; qty: number }[], current: Map<string, number>): TallyStep[] {
  return lines.filter((l) => l.qty !== 0).map((l) => {
    if (l.qty > 0) return { id: l.id, delta: l.qty, asked: l.qty }
    const have = Math.max(0, current.get(l.id) ?? 0)
    return { id: l.id, delta: have > 0 ? -Math.min(have, -l.qty) : 0, asked: l.qty }
  })
}

/**
 * Γιατί δεν αφαιρείται (όλη) η ποσότητα από τον μετρητή: μόνο οι ανοιχτές
 * αλλάζουν από εδώ· οι καταχωρημένες (κλείσιμο ημέρας ή πρώτη μέτρηση
 * απογραφής) διορθώνονται από το παραστατικό τους. null = αφαιρείται όλη.
 */
export function removalNote(name: string, channel: TallyChannel, asked: number, open: number, posted: PostedQty | null | undefined): string | null {
  const want = Math.abs(asked)
  const have = Math.max(0, round(open, 4))
  if (have >= want) return null
  const ch = CHANNEL_LABEL[channel]
  const p = posted && posted.qty > 0 ? posted : null
  const docs = p && p.docs.length ? p.docs.map((n) => docCode('sale', n)).join(', ') : ''
  const done = p
    ? `${fmtQty(p.qty)} έχουν ήδη καταχωρηθεί${docs ? ` (${docs})` : ''} και δεν αφαιρούνται από εδώ: διόρθωση από το παραστατικό${docs ? ` ${docs}` : ''} στις Πωλήσεις (ακύρωση καταχώρησης).`
    : ''
  if (have === 0) return p ? `«${name}» στο ${ch} σήμερα: ${done}` : `Δεν υπάρχει «${name}» στο ${ch} σήμερα για αφαίρεση.`
  return `«${name}» στο ${ch}: ανοιχτές μόνο ${fmtQty(have)}, βγαίνουν αυτές.${p ? ` Οι άλλες ${done}` : ''}`
}

/** Ανοιχτές και καταχωρημένες σημερινές ποσότητες ενός είδους σε ένα κανάλι */
export function tallyHave(running: Pick<RunningState, 'tally' | 'totals'>, channel: TallyChannel, itemId: string): { open: number; posted: PostedQty | null } {
  const open = running.tally.filter((t) => t.channel === channel).reduce((s, t) => s + Number(t.items[itemId] ?? 0), 0)
  return { open: round(open, 4), posted: running.totals.find((t) => t.channel === channel)?.postedItems[itemId] ?? null }
}

/** Σημειώσεις της κάρτας για αφαιρέσεις («βγάλε μία μαργαρίτα») που δεν γίνονται όλες */
export function removalNotes(cmd: Command, running: Pick<RunningState, 'tally' | 'totals'> | null, nameOf: (id: string) => string): string[] {
  if (cmd.kind !== 'sale_tally' || !running) return []
  const asked = new Map<string, number>()
  for (const l of cmd.lines) if (l.item.id && Number.isFinite(l.qty)) asked.set(l.item.id, round((asked.get(l.item.id) ?? 0) + l.qty, 4))
  const out: string[] = []
  for (const [id, q] of asked) {
    if (!(q < 0)) continue
    const h = tallyHave(running, cmd.channel, id)
    const n = removalNote(nameOf(id), cmd.channel, q, h.open, h.posted)
    if (n) out.push(n)
  }
  return out
}

// ---------------------------------------------------------------------
// Αναφορές (είδη / συναλλασσόμενοι) μέσα σε μια εντολή
// ---------------------------------------------------------------------
export type RefKind = 'item' | 'partner'
export interface RefSlot { path: string; kind: RefKind; ref: EntityRef }

type WithLines = Extract<Command, { lines: QtyLine[] }>
export const hasLines = (c: Command): c is WithLines => 'lines' in c

export function refSlots(cmd: Command): RefSlot[] {
  const out: RefSlot[] = []
  if ('partner' in cmd) out.push({ path: 'partner', kind: 'partner', ref: cmd.partner })
  if ('item' in cmd) out.push({ path: 'item', kind: 'item', ref: cmd.item })
  if (hasLines(cmd)) cmd.lines.forEach((l, i) => out.push({ path: `lines.${i}.item`, kind: 'item', ref: l.item }))
  return out
}

export function setRefAt(cmd: Command, path: string, ref: EntityRef): Command {
  const [head, idx] = path.split('.')
  if (head === 'lines' && hasLines(cmd)) {
    return { ...cmd, lines: cmd.lines.map((l, i) => (i === Number(idx) ? { ...l, item: ref } : l)) } as Command
  }
  return { ...cmd, [head]: ref } as Command
}

/** Μετά από αφαίρεση γραμμής i, οι σημαίες των επόμενων γραμμών μετακινούνται */
export function shiftFlags(flags: Record<string, boolean>, removed: number): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const [k, v] of Object.entries(flags)) {
    const m = /^lines\.(\d+)\.(.+)$/.exec(k)
    if (!m) { out[k] = v; continue }
    const i = Number(m[1])
    if (i === removed) continue
    out[i > removed ? `lines.${i - 1}.${m[2]}` : k] = v
  }
  return out
}

// ---------------------------------------------------------------------
// Τι εμποδίζει την εκτέλεση
// ---------------------------------------------------------------------
export interface CardEnv {
  itemById: Map<string, Item>
  /** πεδία που έγραψε ο χρήστης: 'lines.0.qty', 'lines.0.unitPrice', 'qty', 'netPrice', 'amount', 'outputQty' */
  edited: Record<string, boolean>
  running: RunningState | null
  hasUndo: boolean
  /** τιμή (χωρίς ΦΠΑ) που θα πάρει γραμμή χονδρικής χωρίς ειπωμένη τιμή· undefined = δεν είναι γνωστή ακόμα */
  saleFallback?: (itemId: string) => number | undefined
}

const okNum = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n)

/**
 * Σφάλμα που εμποδίζει το «ναι» (null = όλα καλά). Οι τιμές που βάζει ο
 * parser όταν δεν ακούστηκε κάτι (ποσότητα 0, τιμή 0) δεν περνάνε ποτέ
 * σιωπηλά: χρειάζεται αριθμός που ακούστηκε ή που έγραψε ο χρήστης.
 */
export function cardProblem(cmd: Command, env: CardEnv): string | null {
  for (const s of refSlots(cmd)) {
    if (!s.ref.id) return `Διάλεξε ${s.kind === 'partner' ? 'συναλλασσόμενο' : 'είδος'} για «${s.ref.heard}».`
  }
  const itemOf = (r: EntityRef) => (r.id ? env.itemById.get(r.id) : undefined)
  const nameOf = (r: EntityRef) => itemOf(r)?.name ?? r.heard
  const ed = (k: string) => !!env.edited[k]
  switch (cmd.kind) {
    case 'sale_tally': {
      if (cmd.lines.length === 0) return 'Δεν έμεινε καμία γραμμή.'
      for (const l of cmd.lines) {
        if (!okNum(l.qty) || l.qty === 0) return `Βάλε ποσότητα για «${nameOf(l.item)}».`
        const it = itemOf(l.item)
        // tally_add γράφει την τιμή του είδους και την κρατάει για όλη τη μέρα
        if (l.qty > 0 && it && !(Number(it.sale_price) > 0)) {
          return `Το «${it.name}» δεν έχει τιμή πώλησης (θα γραφόταν 0 €). Βάλε τιμή στα Είδη ή πες «η ${it.name.toLocaleLowerCase('el')} κάνει … ευρώ».`
        }
      }
      // μόνο αφαιρέσεις και καμία ανοιχτή: δεν θα γινόταν τίποτα
      if (env.running && cmd.lines.every((l) => l.qty < 0 && l.item.id) &&
          cmd.lines.every((l) => tallyHave(env.running!, cmd.channel, l.item.id!).open <= 0)) {
        return removalNotes(cmd, env.running, (id) => env.itemById.get(id)?.name ?? '?')[0] ?? null
      }
      return null
    }
    case 'sale': case 'purchase': {
      if (cmd.lines.length === 0) return 'Δεν έμεινε καμία γραμμή.'
      for (const l of cmd.lines) {
        if (!okNum(l.qty) || l.qty <= 0) return `Βάλε ποσότητα για «${nameOf(l.item)}».`
        if (l.unitPrice != null) {
          if (!(okNum(l.unitPrice) && l.unitPrice >= 0)) return `Λάθος τιμή για «${nameOf(l.item)}».`
          continue
        }
        const it = itemOf(l.item)
        if (cmd.kind === 'sale') {
          const fb = it ? env.saleFallback?.(it.id) : undefined
          if (fb !== undefined && !(fb > 0)) return `Δεν υπάρχει τιμή για «${nameOf(l.item)}» (ούτε του πελάτη ούτε γενική). Γράψε τιμή.`
        } else if (it && !(Number(it.avg_cost) > 0)) {
          return `Γράψε τιμή για «${it.name}» (δεν υπάρχει μέσο κόστος).`
        }
      }
      return null
    }
    case 'stocktake': {
      if (cmd.lines.length === 0) return 'Δεν έμεινε καμία γραμμή.'
      for (const [i, l] of cmd.lines.entries()) {
        if (!okNum(l.qty) || l.qty < 0) return `Βάλε ποσότητα για «${nameOf(l.item)}».`
        if (l.qty === 0 && !l.heardQty?.trim() && !ed(`lines.${i}.qty`)) {
          return l.mode === 'add'
            ? `Δεν ακούστηκε πόσο ακόμα για «${nameOf(l.item)}». Γράψε την ποσότητα (π.χ. «άλλα πέντε κιλά»).`
            : `Δεν ακούστηκε ποσότητα για «${nameOf(l.item)}». Γράψε τη μέτρηση (0 αν δεν έχει καθόλου).`
        }
      }
      return null
    }
    case 'recipe': {
      if (cmd.lines.length === 0) return 'Δεν έμεινε καμία γραμμή.'
      for (const l of cmd.lines) if (!okNum(l.qty) || l.qty <= 0) return `Βάλε ποσότητα για «${nameOf(l.item)}».`
      return okNum(cmd.outputQty) && cmd.outputQty > 0 ? null : 'Βάλε για πόσα τεμάχια είναι η συνταγή.'
    }
    case 'production': return okNum(cmd.qty) && cmd.qty > 0 ? null : 'Βάλε ποσότητα παραγωγής.'
    case 'receipt': case 'payment': return okNum(cmd.amount) && cmd.amount > 0 ? null : 'Βάλε ποσό.'
    case 'item_price': case 'partner_price':
      if (!(okNum(cmd.netPrice) && cmd.netPrice >= 0)) return 'Βάλε τιμή.'
      return cmd.netPrice === 0 && !ed('netPrice') ? `Δεν ακούστηκε τιμή για «${nameOf(cmd.item)}». Γράψε την τιμή.` : null
    case 'new_item': return cmd.name.trim() ? null : 'Βάλε όνομα.'
    case 'new_partner':
      if (!cmd.name.trim()) return 'Βάλε όνομα.'
      return cmd.isCustomer || cmd.isSupplier ? null : 'Διάλεξε πελάτης ή προμηθευτής.'
    case 'new_phrase': return phraseProblem(cmd.phrase, cmd.meaning)
    case 'close_day': return env.running && env.running.tally.length + env.running.older.length > 0 ? null : 'Δεν υπάρχουν ανοιχτές πωλήσεις ημέρας.'
    case 'close_stocktake': return env.running?.stocktakes.length ? null : 'Δεν υπάρχει απογραφή σε εξέλιξη.'
    case 'undo': return env.hasUndo ? null : 'Δεν υπάρχει κάτι για αναίρεση.'
    default: return null
  }
}

/** Ό,τι εμποδίζει μια δική τους φράση (null = εντάξει) */
export function phraseProblem(phrase: string, meaning: string): string | null {
  const p = phrase.trim()
  const m = meaning.trim()
  if (!p) return 'Γράψε τι λες («Όταν λέω…»).'
  if (!m) return 'Γράψε τι εννοείς («…εννοώ»).'
  if (p.length > 200 || m.length > 200) return 'Πολύ μεγάλη φράση (έως 200 χαρακτήρες).'
  const k = phraseKey(p)
  if (!k) return 'Η φράση χρειάζεται τουλάχιστον μία λέξη.'
  if (k === phraseKey(m)) return 'Η φράση και αυτό που εννοείς είναι ίδια.'
  if (parseYesNo(p) !== null) return `Το «${p}» το κρατάμε για το «ναι» / «όχι». Διάλεξε άλλη λέξη.`
  return null
}

// άρθρα και καταλήξεις ενικού → πληθυντικού (ονομαστική· ό,τι λέγεται με αριθμό: «2 οικογενειακές»)
const ART_PL: Record<string, string> = { ο: 'οι', η: 'οι', το: 'τα' }
const PL_END = ['ια', 'ιά', 'ες', 'ές', 'οι', 'οί']
const SG_PL: [string, string][] = [['ός', 'οί'], ['ος', 'οι'], ['ή', 'ές'], ['η', 'ες'], ['α', 'ες'], ['ό', 'ά'], ['ο', 'α'], ['ί', 'ιά'], ['ι', 'ια']]

/**
 * Πληθυντικός μιας φράσης έως 3 ελληνικών λέξεων με απλούς κανόνες
 * («οικογενειακή» → «οικογενειακές», «ζυμάρι» → «ζυμάρια», «η σκέτη» →
 * «οι σκέτες»)· null όταν δεν ξέρουμε (άλλες καταλήξεις, λατινικά, αριθμοί).
 */
export function pluralGuess(phrase: string): string | null {
  const ws = phrase.trim().split(/\s+/).filter(Boolean)
  if (!ws.length || ws.length > 3) return null
  const out: string[] = []
  for (const w of ws) {
    if (!/^\p{Script=Greek}+$/u.test(w)) return null
    const lw = w.toLocaleLowerCase('el')
    const up = w.length > 1 && w === w.toLocaleUpperCase('el')
    const fix = (s: string) => (up ? s.toLocaleUpperCase('el') : s)
    const art = ART_PL[lw]
    if (art) { out.push(up ? fix(art) : w[0] !== lw[0] ? art[0].toLocaleUpperCase('el') + art.slice(1) : art); continue }
    // ήδη πληθυντικός (ή αμφίβολο: «ζυμάρια», «οικογενειακές»)
    if (PL_END.some((e) => lw.endsWith(e))) return null
    const end = SG_PL.find(([sg]) => lw.endsWith(sg) && lw.length > sg.length + 1)
    if (!end) return null
    out.push(w.slice(0, w.length - end[0].length) + fix(end[1]))
  }
  // μόνο άρθρο: όχι
  return ws.every((w) => ART_PL[w.toLocaleLowerCase('el')]) ? null : out.join(' ')
}

/**
 * Ο πληθυντικός που αξίζει να μάθει (ή να αλλάξει) μαζί με μια φράση («efood
 * 2 οικογενειακές»): όταν δεν τον καταλαβαίνει ήδη (κλίσεις που πιάνει ο
 * interpreter, άλλη φράση) ή όταν είναι δική τους φράση με άλλη σημασία
 * (αλλαγή «οικογενειακή» → «special»: αλλάζει μαζί)· null αλλιώς.
 */
export function pluralOffer(phrase: string, meaning: string, rules: VoicePhraseRule[]): string | null {
  if (phraseProblem(phrase, meaning)) return null
  const pl = pluralGuess(phrase.trim().replace(/\s+/g, ' '))
  const k = pl ? phraseKey(pl) : ''
  if (!pl || k === phraseKey(phrase) || phraseProblem(pl, meaning)) return null
  const same = rules.find((r) => phraseKey(r.phrase) === k)
  if (same && phraseKey(same.meaning) === phraseKey(meaning)) return null
  const others = rules.filter((r) => r !== same)
  return applyPhrases(pl, [{ phrase: phrase.trim(), meaning: meaning.trim() }, ...others]) === pl ? pl : null
}

/** Ο interpreter πιάνει μόνος του τον πληθυντικό μιας φράσης; (για τα κείμενα βοήθειας) */
export const phrasesMatchPlural = (): boolean => applyPhrases('2 οικογενειακές', [{ phrase: 'οικογενειακή', meaning: 'μαργαρίτα' }]) !== '2 οικογενειακές'

// ---------------------------------------------------------------------
// Προειδοποιήσεις του parser που ισχύουν ακόμα
// ---------------------------------------------------------------------
export interface Solved {
  /** φράσεις για τις οποίες ο χρήστης διάλεξε είδος/συναλλασσόμενο */
  entity: string[]
  /** ονόματα (ή φράσεις) γραμμών με ποσότητα που έγραψε ο χρήστης */
  qty: string[]
  /** ονόματα (ή φράσεις) γραμμών με τιμή που έγραψε ο χρήστης */
  price: string[]
  /** πεδία χωρίς γραμμή που έγραψε ο χρήστης */
  fields: ('qty' | 'price' | 'amount')[]
}

const UNLABELED: Record<Solved['fields'][number], string> = {
  qty: 'Δεν ακούστηκε ποσότητα.',
  price: 'Δεν ακούστηκε τιμή.',
  amount: 'Δεν ακούστηκε ποσό.',
}

/**
 * Κρύβει μόνο ό,τι έλυσε ο χρήστης: η επιλογή είδους λύνει το «δεν
 * βρέθηκε / εννοείς…», όχι το «δεν ακούστηκε ποσότητα» της ίδιας φράσης.
 */
export function visibleIssues(issues: string[], solved: Solved): string[] {
  const has = (i: string, label: string) => !!label && i.includes(`«${label}»`)
  return issues.filter((i) => {
    if (solved.entity.some((h) => has(i, h) && (i.startsWith(`Δεν βρέθηκε «${h}»`) || i.startsWith(`«${h}»: εννοείς`)))) return false
    if (solved.qty.some((l) => has(i, l) && /ποσότητα|μετέτρεψα|πέρασα|πήρα το/.test(i))) return false
    if (solved.price.some((l) => has(i, l) && /τιμή/.test(i))) return false
    if (solved.fields.some((f) => i === UNLABELED[f])) return false
    return true
  })
}

// ---------------------------------------------------------------------
// Απάντηση όσο περιμένει κάρτα επιβεβαίωσης
// ---------------------------------------------------------------------
const normWords = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ς/g, 'σ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean)

// λέξεις που συνοδεύουν ένα «ναι» χωρίς να αλλάζουν το νόημα
const YES_FILLER = new Set([
  'το', 'τα', 'τον', 'την', 'ολα', 'ολο', 'τωρα', 'παρακαλω', 'ρε', 'ε', 'λοιπον', 'και', 'πολυ', 'μια', 'χαρα',
  'φιλε', 'ετσι', 'αυτο', 'ειναι', 'σου', 'μου', 'please',
])

/**
 * yes: σκέτη επιβεβαίωση ("ναι", "οκ πέρασέ το").
 * no: σκέτη άρνηση ("όχι", "άκυρο").
 * fix: άρνηση + νέα εντολή ("όχι, τέσσερις μαργαρίτες"): ακύρωση και νέα κάρτα.
 * new: νέα εντολή (ακόμα κι αν περιέχει "πέρασε": "πέρασε δύο σπέσιαλ").
 * unclear: "ναι" με κάτι ακόμα που δεν καταλαβαίνουμε ("ναι αλλά δύο"): ρωτάμε ξανά.
 * kind: τι κατάλαβε ο interpreter από όλη τη φράση.
 */
export type Answer = 'yes' | 'no' | 'fix' | 'new' | 'unclear'
export function answerTo(text: string, kind: CommandKind): Answer {
  const words = normWords(text)
  const yn = parseYesNo(text)
  if (yn === 'yes') {
    if (kind !== 'unknown') return 'new'
    return words.every((w) => YES_FILLER.has(w) || parseYesNo(w) === 'yes') ? 'yes' : 'unclear'
  }
  // άρνηση, ή φράση που αρχίζει με άρνηση ("όχι, τέσσερις μαργαρίτες")
  const lead = words.length > 1 && parseYesNo(words[0]) === 'no'
  // "ακύρωσε (το τελευταίο)" όσο περιμένει κάρτα = ακύρωση της κάρτας, όχι αναίρεση
  if (yn === 'no' || lead) return kind === 'unknown' || kind === 'undo' ? 'no' : 'fix'
  return 'new'
}

// ---------------------------------------------------------------------
// Νέο είδος από ό,τι ακούστηκε
// ---------------------------------------------------------------------
/**
 * Πρόταση ονόματος: κεφαλαίο πρώτο γράμμα· μία λέξη είδους σε άτονο -ες
 * γίνεται ενικός σε -α ("μαργαρίτες" → "Μαργαρίτα", "τρούφες" → "Τρούφα").
 */
export function suggestName(heard: string, kind: RefKind): string {
  let t = heard.trim().replace(/\s+/g, ' ')
  if (!t) return ''
  if (kind === 'item' && !t.includes(' ') && /[α-ωάέήίόύώϊϋΐΰ]{3,}ες$/i.test(t)) t = t.slice(0, -2) + 'α'
  return t[0].toLocaleUpperCase('el') + t.slice(1)
}
