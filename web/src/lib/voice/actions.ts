import { supabase, errMsg } from '../supabase'
import { createDraft, deleteDraft, postDoc, replaceLines, unpostDoc, type LineInput } from '../docs'
import type { Doc, DocType, Item, ItemType, Partner } from '../types'
import type { Command, EntityRef, TallyChannel } from './types'
import { CHANNEL_LABEL, ITEM_TYPE_LABEL, docCode } from '../labels'
import { fmtCost, fmtDate, fmtMoney, fmtQty, round } from '../format'

/**
 * Εκτέλεση μιας επιβεβαιωμένης εντολής πάνω στη βάση. Καλείται ΜΟΝΟ μετά
 * από ρητό "ναι" του χρήστη. Επιστρέφει μήνυμα και (όπου γίνεται) αναίρεση.
 */

export interface ExecEnv {
  companyId: string
  /** σημερινή ημερομηνία YYYY-MM-DD */
  today: string
  items: Item[]
  partners: Partner[]
  refreshMaster: () => Promise<void>
}

export interface ExecResult {
  message: string
  undo?: () => Promise<void>
  navigateTo?: string
}

// ---------------------------------------------------------------------
// Βοηθητικά
// ---------------------------------------------------------------------

/** Σφάλμα Supabase/JS → Error με ελληνικό μήνυμα */
export function voiceError(e: unknown): Error {
  const code = (e as { code?: string } | null)?.code
  if (code === '23505') return new Error('Υπάρχει ήδη εγγραφή με τον ίδιο κωδικό.')
  if (code === '23503') return new Error('Χρησιμοποιείται ήδη αλλού και δεν διαγράφεται.')
  if (code === '42501') return new Error('Δεν έχετε δικαίωμα για αυτή την ενέργεια.')
  if (code === 'PGRST202' || code === '42883') return new Error('Η βάση δεν έχει την ενημέρωση για τις φωνητικές εντολές (0004_voice.sql).')
  if (e instanceof Error) return e
  return new Error(errMsg(e))
}

function fail(e: unknown): never { throw voiceError(e) }

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args)
  if (error) fail(error)
  return data as T
}

/** Το id μιας αναφοράς, ή σφάλμα αν δεν έχει επιλεγεί */
function need(ref: EntityRef, what: string): string {
  if (!ref.id) throw new Error(`Διάλεξε ${what} για «${ref.heard}».`)
  return ref.id
}

function itemOf(env: ExecEnv, id: string): Item {
  const it = env.items.find((i) => i.id === id)
  if (!it) throw new Error('Δεν βρέθηκε το είδος (ανανέωσε τη σελίδα).')
  return it
}

function partnerOf(env: ExecEnv, id: string): Partner {
  const p = env.partners.find((x) => x.id === id)
  if (!p) throw new Error('Δεν βρέθηκε ο συναλλασσόμενος (ανανέωσε τη σελίδα).')
  return p
}

/** "3 Μαργαρίτα" για τεμάχια, "6 kg Μοτσαρέλα" για τα υπόλοιπα */
export function qtyText(it: Pick<Item, 'unit' | 'name'>, qty: number): string {
  return it.unit === 'τεμ' ? `${fmtQty(qty)} ${it.name}` : `${fmtQty(qty)} ${it.unit} ${it.name}`
}

const okQty = (q: number) => Number.isFinite(q) && q > 0

/** Ελέγχει ότι δεν υπάρχουν ίδια είδη δύο φορές· ενώνει τις ποσότητες */
function mergeLines<T extends { id: string; qty: number }>(lines: T[]): T[] {
  const m = new Map<string, T>()
  for (const l of lines) {
    const cur = m.get(l.id)
    if (cur) cur.qty = round(cur.qty + l.qty, 4)
    else m.set(l.id, { ...l })
  }
  return [...m.values()]
}

async function docHead(id: string): Promise<Pick<Doc, 'id' | 'doc_no' | 'status' | 'total_net' | 'total_gross' | 'doc_type'> | null> {
  const { data, error } = await supabase.from('doc').select('id, doc_no, status, total_net, total_gross, doc_type').eq('id', id).maybeSingle()
  if (error) fail(error)
  return data as Pick<Doc, 'id' | 'doc_no' | 'status' | 'total_net' | 'total_gross' | 'doc_type'> | null
}

/** Πρόχειρο → γραμμές → καταχώρηση. Αν κάτι αποτύχει, σβήνει το πρόχειρο. */
async function postNew(env: ExecEnv, type: DocType, fields: Partial<Doc>, lines: LineInput[]) {
  let id: string | null = null
  try {
    id = await createDraft(env.companyId, type, { doc_date: env.today, ...fields })
    await replaceLines(env.companyId, id, lines)
    await postDoc(id)
  } catch (e) {
    if (id) await deleteDraft(id).catch(() => { /* μένει πρόχειρο */ })
    fail(e)
  }
  const head = await docHead(id!)
  return { id: id!, docNo: head?.doc_no ?? 0, net: Number(head?.total_net ?? 0), gross: Number(head?.total_gross ?? 0) }
}

/** Αναίρεση καταχωρημένου παραστατικού: ακύρωση καταχώρησης + διαγραφή */
function undoPosted(env: ExecEnv, id: string) {
  return async () => {
    const head = await docHead(id)
    if (!head) return
    try {
      if (head.status === 'posted') await unpostDoc(id)
      await deleteDraft(id)
    } catch (e) { fail(e) }
    await env.refreshMaster()
  }
}

// ---------------------------------------------------------------------
// Ανοιχτά πρόχειρα (μετρητής ημέρας, απογραφή σε εξέλιξη)
// ---------------------------------------------------------------------
export interface TallyRow { channel: TallyChannel; docId: string; docNo: number; qty: number; gross: number }
export interface RunningStocktake { id: string; docNo: number; date: string; count: number }
export interface RunningState { tally: TallyRow[]; stocktake: RunningStocktake | null }

interface DocWithLines { id: string; doc_no: number; doc_date: string; channel: string | null; status: string; is_running: boolean; doc_line: { item_id: string; qty: number; gross: number }[] }

/** Ανοιχτές πωλήσεις ημέρας ανά κανάλι + η πιο πρόσφατη απογραφή σε εξέλιξη */
export async function loadRunning(companyId: string, date: string): Promise<RunningState> {
  const [s, t] = await Promise.all([
    supabase.from('doc').select('id, doc_no, doc_date, channel, status, is_running, doc_line(item_id, qty, gross)')
      .eq('company_id', companyId).eq('doc_type', 'sale').eq('doc_date', date).eq('is_running', true).eq('status', 'draft'),
    supabase.from('doc').select('id, doc_no, doc_date, channel, status, is_running, doc_line(item_id, qty, gross)')
      .eq('company_id', companyId).eq('doc_type', 'stocktake').eq('is_running', true).eq('status', 'draft')
      .lte('doc_date', date).order('doc_date', { ascending: false }).limit(1),
  ])
  if (s.error) fail(s.error)
  if (t.error) fail(t.error)
  const order: TallyChannel[] = ['efood', 'wolt', 'box', 'phone', 'store']
  const tally = ((s.data ?? []) as unknown as DocWithLines[])
    .filter((d) => d.channel && order.includes(d.channel as TallyChannel))
    .map((d) => ({
      channel: d.channel as TallyChannel,
      docId: d.id,
      docNo: d.doc_no,
      qty: round(d.doc_line.reduce((a, l) => a + Number(l.qty), 0), 4),
      gross: round(d.doc_line.reduce((a, l) => a + Number(l.gross), 0)),
    }))
    .sort((a, b) => order.indexOf(a.channel) - order.indexOf(b.channel))
  const st = ((t.data ?? []) as unknown as DocWithLines[])[0]
  return {
    tally,
    stocktake: st ? { id: st.id, docNo: st.doc_no, date: st.doc_date, count: st.doc_line.length } : null,
  }
}

async function tallyAdd(env: ExecEnv, channel: TallyChannel, date: string, itemId: string, delta: number): Promise<string | null> {
  return rpc<string | null>('tally_add', { p_company: env.companyId, p_date: date, p_channel: channel, p_item: itemId, p_delta: delta })
}

async function stocktakeCount(env: ExecEnv, date: string, itemId: string, qty: number | null): Promise<string | null> {
  return rpc<string | null>('stocktake_count', { p_company: env.companyId, p_date: date, p_item: itemId, p_qty: qty, p_add: false })
}

/** Αναίρεση σε ανοιχτό πρόχειρο: μόνο αν δεν έχει καταχωρηθεί στο μεταξύ */
async function assertStillOpen(docId: string | null, what: string) {
  if (!docId) return
  const head = await docHead(docId)
  if (head && head.status === 'posted') {
    throw new Error(`${what} ${docCode(head.doc_type, head.doc_no)} έχει ήδη καταχωρηθεί. Αναίρεση από τη λίστα παραστατικών (ακύρωση καταχώρησης).`)
  }
}

// ---------------------------------------------------------------------
// Νέα είδη / συναλλασσόμενοι (κωδικός αυτόματα)
// ---------------------------------------------------------------------
const ITEM_PREFIX: Record<ItemType, string> = { raw: 'ΠΥ', semi: 'ΗΜ', finished: 'ΠΡ' }

const normName = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ς/g, 'σ').replace(/\s+/g, ' ').trim()

async function nextCode(table: 'item' | 'partner', companyId: string, prefix: string): Promise<number> {
  const { data, error } = await supabase.from(table).select('code').eq('company_id', companyId).like('code', prefix + '-%')
  if (error) fail(error)
  let max = 0
  for (const r of (data ?? []) as { code: string }[]) {
    const m = /^.+?-(\d+)$/.exec(r.code)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return max + 1
}

const pad = (n: number) => String(n).padStart(3, '0')

/** Insert με αυτόματο κωδικό ΠΡΟΘΕΜΑ-NNN· αν πιαστεί ο κωδικός, δοκιμάζει τον επόμενο */
async function insertWithCode<T>(table: 'item' | 'partner', companyId: string, prefix: string, row: Record<string, unknown>): Promise<T> {
  let n = await nextCode(table, companyId, prefix)
  for (let attempt = 0; attempt < 6; attempt++, n++) {
    const { data, error } = await supabase.from(table).insert({ ...row, company_id: companyId, code: `${prefix}-${pad(n)}` }).select('*').single()
    if (!error) return data as T
    if (error.code !== '23505') fail(error)
  }
  throw new Error('Δεν βρέθηκε ελεύθερος κωδικός. Δοκίμασε ξανά.')
}

export interface NewItemSpec {
  itemType: ItemType
  name: string
  unit: string
  vatRate: number
  salePrice: number | null
  makeToOrder: boolean
  packName: string | null
  packQty: number | null
}

/** Νέο είδος με κωδικό ΠΥ/ΗΜ/ΠΡ-NNN */
export async function createItem(env: ExecEnv, spec: NewItemSpec): Promise<Item> {
  const name = spec.name.trim().replace(/\s+/g, ' ')
  if (!name) throw new Error('Χρειάζεται όνομα.')
  const same = env.items.find((i) => normName(i.name) === normName(name))
  if (same) throw new Error(`Υπάρχει ήδη είδος «${same.name}» (${same.code}).`)
  const isRaw = spec.itemType === 'raw'
  const item = await insertWithCode<Item>('item', env.companyId, ITEM_PREFIX[spec.itemType], {
    name,
    item_type: spec.itemType,
    unit: spec.unit || (isRaw ? 'kg' : 'τεμ'),
    vat_rate: Number.isFinite(spec.vatRate) ? spec.vatRate : 13,
    sale_price: spec.itemType === 'finished' && spec.salePrice != null && spec.salePrice >= 0 ? round(spec.salePrice, 4) : 0,
    make_to_order: isRaw ? false : spec.makeToOrder,
    pack_name: isRaw && spec.packName?.trim() ? spec.packName.trim() : null,
    pack_qty: isRaw && spec.packQty && spec.packQty > 0 ? spec.packQty : null,
    is_active: true,
    aliases: [],
  })
  await env.refreshMaster()
  return item
}

export interface NewPartnerSpec {
  name: string
  isCustomer: boolean
  isSupplier: boolean
  phone: string | null
  vatNo: string | null
  city: string | null
}

/** Νέος συναλλασσόμενος: ΠΕ-NNN για πελάτες, ΠΡ-NNN για σκέτους προμηθευτές */
export async function createPartner(env: ExecEnv, spec: NewPartnerSpec): Promise<Partner> {
  const name = spec.name.trim().replace(/\s+/g, ' ')
  if (!name) throw new Error('Χρειάζεται όνομα.')
  if (!spec.isCustomer && !spec.isSupplier) throw new Error('Διάλεξε πελάτης ή προμηθευτής.')
  const same = env.partners.find((p) => normName(p.name) === normName(name))
  if (same) throw new Error(`Υπάρχει ήδη «${same.name}» (${same.code}).`)
  const partner = await insertWithCode<Partner>('partner', env.companyId, spec.isCustomer ? 'ΠΕ' : 'ΠΡ', {
    name,
    is_customer: spec.isCustomer,
    is_supplier: spec.isSupplier,
    phone: spec.phone?.trim() || null,
    vat_no: spec.vatNo?.trim() || null,
    city: spec.city?.trim() || null,
    is_active: true,
    aliases: [],
  })
  await env.refreshMaster()
  return partner
}

/** Διαγραφή είδους/συναλλασσόμενου που μόλις φτιάχτηκε (αναίρεση) */
export function undoCreate(env: ExecEnv, table: 'item' | 'partner', id: string) {
  return async () => {
    const { error } = await supabase.from(table).delete().eq('id', id)
    if (error) {
      if (error.code === '23503') throw new Error(`Χρησιμοποιείται ήδη σε κινήσεις ή συνταγές. Κάν' το ανενεργό από τα ${table === 'item' ? 'Είδη' : 'Πελάτες & προμηθευτές'}.`)
      fail(error)
    }
    await env.refreshMaster()
  }
}

/** Προσθέτει μια φράση στα "άλλα ονόματα" (aliases), αν δεν υπάρχει ήδη */
export async function addAlias(table: 'item' | 'partner', id: string, phrase: string): Promise<boolean> {
  const p = phrase.trim().replace(/\s+/g, ' ')
  if (!p) return false
  const { data, error } = await supabase.from(table).select('name, aliases').eq('id', id).single()
  if (error) fail(error)
  const row = data as { name: string; aliases: string[] | null }
  const cur = row.aliases ?? []
  if (normName(row.name) === normName(p) || cur.some((a) => normName(a) === normName(p))) return false
  const { error: eu } = await supabase.from(table).update({ aliases: [...cur, p] }).eq('id', id)
  if (eu) fail(eu)
  return true
}

// ---------------------------------------------------------------------
// Εκτέλεση
// ---------------------------------------------------------------------
export async function execute(cmd: Command, env: ExecEnv): Promise<ExecResult> {
  switch (cmd.kind) {
    case 'sale_tally': return saleTally(cmd, env)
    case 'sale': return sale(cmd, env)
    case 'purchase': return purchase(cmd, env)
    case 'production': return production(cmd, env)
    case 'stocktake': return stocktake(cmd, env)
    case 'receipt':
    case 'payment': return money(cmd, env)
    case 'new_item': {
      const it = await createItem(env, cmd)
      const extra = it.item_type !== 'raw' ? ` Πες τώρα τη συνταγή, π.χ. «η ${it.name} έχει …».` : ''
      return {
        message: `Νέο είδος (${ITEM_TYPE_LABEL[it.item_type].toLowerCase()}) «${it.name}», κωδικός ${it.code}, σε ${it.unit}.${extra}`,
        undo: undoCreate(env, 'item', it.id),
      }
    }
    case 'new_partner': {
      const p = await createPartner(env, cmd)
      const role = p.is_customer && p.is_supplier ? 'πελάτης και προμηθευτής' : p.is_customer ? 'πελάτης' : 'προμηθευτής'
      return { message: `Νέος ${role} «${p.name}», κωδικός ${p.code}.`, undo: undoCreate(env, 'partner', p.id) }
    }
    case 'recipe': return recipe(cmd, env)
    case 'item_price': return itemPrice(cmd, env)
    case 'partner_price': return partnerPrice(cmd, env)
    case 'close_day': return closeDay(env)
    case 'close_stocktake': return closeStocktake(env)
    case 'query_stock': return queryStock(cmd, env)
    case 'query_balance': return queryBalance(cmd, env)
    case 'query_today': return { message: await todaySummary(env) }
    case 'help': return { message: 'Πες π.χ. «efood δύο μαργαρίτες», «αγόρασα από τον μύλο δέκα σακιά αλεύρι», «μέτρησα μοτσαρέλα έξι κιλά».' }
    case 'undo': throw new Error('Η αναίρεση γίνεται από τη λίστα ενεργειών.')
    case 'unknown': throw new Error('Δεν κατάλαβα την εντολή.')
  }
}

type Cmd<K extends Command['kind']> = Extract<Command, { kind: K }>

async function saleTally(cmd: Cmd<'sale_tally'>, env: ExecEnv): Promise<ExecResult> {
  const lines = mergeLines(cmd.lines.map((l) => ({ id: need(l.item, 'προϊόν'), qty: round(l.qty, 4) })))
  if (lines.length === 0 || lines.some((l) => !okQty(l.qty))) throw new Error('Λείπει ή είναι λάθος κάποια ποσότητα.')
  const date = env.today
  const done: typeof lines = []
  let docId: string | null = null
  try {
    for (const l of lines) {
      docId = (await tallyAdd(env, cmd.channel, date, l.id, l.qty)) ?? docId
      done.push(l)
    }
  } catch (e) {
    // επαναφορά όσων πρόλαβαν να μπουν
    for (const l of done) await tallyAdd(env, cmd.channel, date, l.id, -l.qty).catch(() => { /* ignore */ })
    fail(e)
  }
  const list = lines.map((l) => qtyText(itemOf(env, l.id), l.qty)).join(', ')
  return {
    message: `Μπήκαν στο ${CHANNEL_LABEL[cmd.channel]}: ${list}.`,
    undo: async () => {
      await assertStillOpen(docId, 'Η πώληση ημέρας')
      for (const l of lines) await tallyAdd(env, cmd.channel, date, l.id, -l.qty)
    },
  }
}

async function sale(cmd: Cmd<'sale'>, env: ExecEnv): Promise<ExecResult> {
  const partnerId = need(cmd.partner, 'πελάτη')
  const partner = partnerOf(env, partnerId)
  if (cmd.lines.length === 0) throw new Error('Δεν υπάρχουν είδη.')
  const lines: LineInput[] = []
  for (const [i, l] of cmd.lines.entries()) {
    const id = need(l.item, 'είδος')
    const it = itemOf(env, id)
    if (!okQty(l.qty)) throw new Error(`Λάθος ποσότητα για «${it.name}».`)
    let price = l.unitPrice
    if (price == null) price = Number((await rpc<number | null>('item_price_for', { p_item: id, p_partner: partnerId })) ?? it.sale_price)
    if (!(price >= 0)) throw new Error(`Λάθος τιμή για «${it.name}».`)
    lines.push({ line_no: i + 1, role: 'item', item_id: id, qty: round(l.qty, 4), unit_price: round(price, 4), vat_rate: Number(it.vat_rate) })
  }
  const d = await postNew(env, 'sale', { partner_id: partnerId, channel: 'wholesale' }, lines)
  await env.refreshMaster()
  const list = lines.map((l) => qtyText(itemOf(env, l.item_id), l.qty)).join(', ')
  return {
    message: `Πώληση ${docCode('sale', d.docNo)} σε «${partner.name}»: ${list}. Σύνολο ${fmtMoney(d.gross)} με ΦΠΑ.`,
    undo: undoPosted(env, d.id),
  }
}

async function purchase(cmd: Cmd<'purchase'>, env: ExecEnv): Promise<ExecResult> {
  const partnerId = need(cmd.partner, 'προμηθευτή')
  const partner = partnerOf(env, partnerId)
  if (cmd.lines.length === 0) throw new Error('Δεν υπάρχουν είδη.')
  const lines: LineInput[] = cmd.lines.map((l, i) => {
    const id = need(l.item, 'είδος')
    const it = itemOf(env, id)
    if (!okQty(l.qty)) throw new Error(`Λάθος ποσότητα για «${it.name}».`)
    const price = l.unitPrice ?? Number(it.avg_cost)
    if (!(price >= 0)) throw new Error(`Λάθος τιμή για «${it.name}».`)
    return { line_no: i + 1, role: 'item', item_id: id, qty: round(l.qty, 4), unit_price: round(price, 4), vat_rate: Number(it.vat_rate) }
  })
  const d = await postNew(env, 'purchase', { partner_id: partnerId, ref_no: cmd.refNo?.trim() || null }, lines)
  await env.refreshMaster()
  const list = lines.map((l) => qtyText(itemOf(env, l.item_id), l.qty)).join(', ')
  return {
    message: `Αγορά ${docCode('purchase', d.docNo)} από «${partner.name}»: ${list}. Σύνολο ${fmtMoney(d.gross)} με ΦΠΑ.`,
    undo: undoPosted(env, d.id),
  }
}

async function production(cmd: Cmd<'production'>, env: ExecEnv): Promise<ExecResult> {
  const id = need(cmd.item, 'προϊόν')
  const it = itemOf(env, id)
  if (it.item_type === 'raw') throw new Error('Οι πρώτες ύλες δεν παράγονται.')
  if (!okQty(cmd.qty)) throw new Error('Λείπει η ποσότητα παραγωγής.')
  // μόνο η γραμμή προϊόντος: ο server αναπτύσσει τη συνταγή στην καταχώρηση
  const d = await postNew(env, 'production', {}, [{ line_no: 1, role: 'output', item_id: id, qty: round(cmd.qty, 4) }])
  await env.refreshMaster()
  const unit = cmd.qty > 0 ? d.net / cmd.qty : 0
  return {
    message: `Παραγωγή ${docCode('production', d.docNo)}: ${qtyText(it, cmd.qty)}. Κόστος ${fmtMoney(d.net)} (${fmtCost(unit)} ανά ${it.unit}).`,
    undo: undoPosted(env, d.id),
  }
}

async function stocktake(cmd: Cmd<'stocktake'>, env: ExecEnv): Promise<ExecResult> {
  const lines = cmd.lines.map((l) => ({ id: need(l.item, 'είδος'), qty: round(l.qty, 4) }))
  if (lines.length === 0) throw new Error('Δεν υπάρχουν μετρήσεις.')
  for (const l of lines) if (!(Number.isFinite(l.qty) && l.qty >= 0)) throw new Error(`Λάθος μέτρηση για «${itemOf(env, l.id).name}».`)
  // τελευταία μέτρηση μετράει (ίδιο είδος δύο φορές = διόρθωση)
  const last = new Map(lines.map((l) => [l.id, l.qty]))
  const date = env.today
  // προηγούμενες μετρήσεις, για αναίρεση
  const prev = new Map<string, number>()
  {
    const { data, error } = await supabase.from('doc').select('id, doc_line(item_id, qty)')
      .eq('company_id', env.companyId).eq('doc_type', 'stocktake').eq('doc_date', date).eq('is_running', true).eq('status', 'draft')
    if (error) fail(error)
    for (const d of (data ?? []) as unknown as { doc_line: { item_id: string; qty: number }[] }[]) {
      for (const l of d.doc_line) prev.set(l.item_id, Number(l.qty))
    }
  }
  const done: string[] = []
  let docId: string | null = null
  try {
    for (const [id, qty] of last) {
      docId = (await stocktakeCount(env, date, id, qty)) ?? docId
      done.push(id)
    }
  } catch (e) {
    for (const id of done) await stocktakeCount(env, date, id, prev.get(id) ?? null).catch(() => { /* ignore */ })
    fail(e)
  }
  let count = 0
  if (docId) {
    const { count: c } = await supabase.from('doc_line').select('id', { count: 'exact', head: true }).eq('doc_id', docId)
    count = c ?? 0
  }
  const list = [...last].map(([id, q]) => qtyText(itemOf(env, id), q)).join(', ')
  return {
    message: `Απογραφή σε εξέλιξη: ${list}. Μετρημένα μέχρι τώρα: ${count} ${count === 1 ? 'είδος' : 'είδη'}. Στο τέλος πες «τέλος απογραφής».`,
    undo: async () => {
      await assertStillOpen(docId, 'Η απογραφή')
      for (const id of last.keys()) await stocktakeCount(env, date, id, prev.get(id) ?? null)
    },
  }
}

async function money(cmd: Cmd<'receipt'> | Cmd<'payment'>, env: ExecEnv): Promise<ExecResult> {
  const isReceipt = cmd.kind === 'receipt'
  const partnerId = need(cmd.partner, isReceipt ? 'πελάτη' : 'προμηθευτή')
  const partner = partnerOf(env, partnerId)
  if (!okQty(cmd.amount)) throw new Error('Λείπει το ποσό.')
  const d = await postNew(env, cmd.kind, { partner_id: partnerId, amount: round(cmd.amount, 2) }, [])
  const { data } = await supabase.from('v_partner_balance').select('customer_balance, supplier_balance').eq('partner_id', partnerId).maybeSingle()
  const bal = data as { customer_balance: number; supplier_balance: number } | null
  const rest = bal ? ` Υπόλοιπο: ${fmtMoney(isReceipt ? bal.customer_balance : bal.supplier_balance)}.` : ''
  return {
    message: isReceipt
      ? `Είσπραξη ${docCode('receipt', d.docNo)} από «${partner.name}»: ${fmtMoney(cmd.amount)}.${rest}`
      : `Πληρωμή ${docCode('payment', d.docNo)} σε «${partner.name}»: ${fmtMoney(cmd.amount)}.${rest}`,
    undo: undoPosted(env, d.id),
  }
}

interface BomRow { id: string; output_qty: number }
interface BomLineRow { component_item_id: string; qty: number }

async function recipe(cmd: Cmd<'recipe'>, env: ExecEnv): Promise<ExecResult> {
  const id = need(cmd.item, 'προϊόν')
  const it = itemOf(env, id)
  if (it.item_type === 'raw') throw new Error('Οι πρώτες ύλες δεν έχουν συνταγή.')
  if (!okQty(cmd.outputQty)) throw new Error('Λάθος ποσότητα συνταγής.')
  const lines = mergeLines(cmd.lines.map((l) => ({ id: need(l.item, 'υλικό'), qty: round(l.qty, 4) })))
  if (lines.length === 0) throw new Error('Η συνταγή δεν έχει υλικά.')
  for (const l of lines) {
    const c = itemOf(env, l.id)
    if (!okQty(l.qty)) throw new Error(`Λάθος ποσότητα για «${c.name}».`)
    if (c.id === it.id) throw new Error('Το είδος δεν μπορεί να είναι υλικό του εαυτού του.')
    if (c.item_type === 'finished') throw new Error(`Το «${c.name}» είναι έτοιμο προϊόν και δεν μπαίνει σε συνταγή.`)
    if (it.item_type === 'semi' && c.item_type !== 'raw') throw new Error(`Το ημιέτοιμο «${it.name}» παίρνει μόνο πρώτες ύλες («${c.name}» δεν είναι).`)
  }

  // παλιά συνταγή, για αναίρεση
  const { data: ob, error: eb } = await supabase.from('bom').select('id, output_qty').eq('item_id', id).eq('is_default', true).eq('is_active', true).maybeSingle()
  if (eb) fail(eb)
  const oldBom = ob as BomRow | null
  let oldLines: BomLineRow[] = []
  if (oldBom) {
    const { data, error } = await supabase.from('bom_line').select('component_item_id, qty').eq('bom_id', oldBom.id).order('line_no')
    if (error) fail(error)
    oldLines = (data ?? []) as BomLineRow[]
  }

  const writeLines = async (bomId: string, ls: BomLineRow[]) => {
    const { error: ed } = await supabase.from('bom_line').delete().eq('bom_id', bomId)
    if (ed) fail(ed)
    if (ls.length === 0) return
    const { error: ei } = await supabase.from('bom_line').insert(
      ls.map((l, i) => ({ company_id: env.companyId, bom_id: bomId, line_no: i + 1, component_item_id: l.component_item_id, qty: l.qty })),
    )
    if (ei) fail(ei)
  }

  let bomId: string
  if (oldBom) {
    bomId = oldBom.id
    const { error } = await supabase.from('bom').update({ output_qty: round(cmd.outputQty, 4) }).eq('id', bomId)
    if (error) fail(error)
  } else {
    const { data, error } = await supabase.from('bom')
      .insert({ company_id: env.companyId, item_id: id, name: 'Βασική', output_qty: round(cmd.outputQty, 4), is_default: true, is_active: true })
      .select('id').single()
    if (error) fail(error)
    bomId = (data as { id: string }).id
  }
  try {
    await writeLines(bomId, lines.map((l) => ({ component_item_id: l.id, qty: l.qty })))
  } catch (e) {
    // επαναφορά
    if (oldBom) {
      await supabase.from('bom').update({ output_qty: oldBom.output_qty }).eq('id', bomId)
      await writeLines(bomId, oldLines).catch(() => { /* ignore */ })
    } else {
      await supabase.from('bom').delete().eq('id', bomId)
    }
    throw e
  }
  await env.refreshMaster()

  const cost = lines.reduce((s, l) => s + l.qty * Number(itemOf(env, l.id).avg_cost), 0)
  const unitCost = cost / cmd.outputQty
  const list = lines.map((l) => qtyText(itemOf(env, l.id), l.qty)).join(', ')
  return {
    message: `Συνταγή «${it.name}» για ${fmtQty(cmd.outputQty)} ${it.unit}: ${list}. Κόστος περίπου ${fmtCost(unitCost)} ανά ${it.unit}.`,
    undo: async () => {
      if (oldBom) {
        const { error } = await supabase.from('bom').update({ output_qty: oldBom.output_qty }).eq('id', bomId)
        if (error) fail(error)
        await writeLines(bomId, oldLines)
      } else {
        const { error } = await supabase.from('bom').delete().eq('id', bomId)
        if (error) {
          // χρησιμοποιήθηκε ήδη σε παραγωγή: απενεργοποίηση αντί για διαγραφή
          const { error: e2 } = await supabase.from('bom').update({ is_active: false, is_default: false }).eq('id', bomId)
          if (e2) fail(e2)
        }
      }
      await env.refreshMaster()
    },
  }
}

async function itemPrice(cmd: Cmd<'item_price'>, env: ExecEnv): Promise<ExecResult> {
  const id = need(cmd.item, 'προϊόν')
  const it = itemOf(env, id)
  if (!(cmd.netPrice >= 0) || !Number.isFinite(cmd.netPrice)) throw new Error('Λάθος τιμή.')
  const old = Number(it.sale_price)
  const net = round(cmd.netPrice, 4)
  const { error } = await supabase.from('item').update({ sale_price: net }).eq('id', id)
  if (error) fail(error)
  await env.refreshMaster()
  const gross = net * (1 + Number(it.vat_rate) / 100)
  return {
    message: `Νέα τιμή «${it.name}»: ${fmtMoney(net)} χωρίς ΦΠΑ (${fmtMoney(gross)} με ΦΠΑ ${fmtQty(it.vat_rate)}%). Πριν ήταν ${fmtMoney(old)}.`,
    undo: async () => {
      const { error: e } = await supabase.from('item').update({ sale_price: old }).eq('id', id)
      if (e) fail(e)
      await env.refreshMaster()
    },
  }
}

async function partnerPrice(cmd: Cmd<'partner_price'>, env: ExecEnv): Promise<ExecResult> {
  const partnerId = need(cmd.partner, 'πελάτη')
  const itemId = need(cmd.item, 'προϊόν')
  const p = partnerOf(env, partnerId)
  const it = itemOf(env, itemId)
  if (!(cmd.netPrice >= 0) || !Number.isFinite(cmd.netPrice)) throw new Error('Λάθος τιμή.')
  const { data: old, error: eo } = await supabase.from('partner_price').select('id, price').eq('partner_id', partnerId).eq('item_id', itemId).maybeSingle()
  if (eo) fail(eo)
  const oldRow = old as { id: string; price: number } | null
  const net = round(cmd.netPrice, 4)
  const { error } = await supabase.from('partner_price')
    .upsert({ company_id: env.companyId, partner_id: partnerId, item_id: itemId, price: net }, { onConflict: 'partner_id,item_id' })
  if (error) fail(error)
  return {
    message: `Τιμή για «${p.name}»: ${it.name} ${fmtMoney(net)} χωρίς ΦΠΑ${oldRow ? ` (πριν ${fmtMoney(oldRow.price)})` : ''}.`,
    undo: async () => {
      const q = oldRow
        ? supabase.from('partner_price').update({ price: oldRow.price }).eq('partner_id', partnerId).eq('item_id', itemId)
        : supabase.from('partner_price').delete().eq('partner_id', partnerId).eq('item_id', itemId)
      const { error: e } = await q
      if (e) fail(e)
    },
  }
}

/** Καταχωρεί τις ανοιχτές πωλήσεις ημέρας (σήμερα). Χωρίς αναίρεση. */
async function closeDay(env: ExecEnv): Promise<ExecResult> {
  const running = await loadRunning(env.companyId, env.today)
  if (running.tally.length === 0) return { message: 'Δεν υπάρχουν ανοιχτές πωλήσεις για σήμερα.' }
  const ok: string[] = []
  const bad: string[] = []
  for (const t of running.tally) {
    try {
      await postDoc(t.docId)
      const head = await docHead(t.docId)
      ok.push(`${CHANNEL_LABEL[t.channel]} ${fmtQty(t.qty)} τεμ (${fmtMoney(head?.total_gross ?? t.gross)})`)
    } catch (e) {
      bad.push(`${CHANNEL_LABEL[t.channel]}: ${voiceError(e).message}`)
    }
  }
  await env.refreshMaster()
  if (ok.length === 0) throw new Error('Δεν έκλεισε η μέρα. ' + bad.join(' · '))
  return {
    message: `Έκλεισε η μέρα: ${ok.join(', ')}.` + (bad.length ? ` Δεν έκλεισαν: ${bad.join(' · ')}.` : '') +
      ' Δεν αναιρείται από εδώ (ακύρωση καταχώρησης από τις Πωλήσεις).',
  }
}

/** Καταχωρεί την απογραφή σε εξέλιξη και ανοίγει τη σελίδα της (διαφορές) */
async function closeStocktake(env: ExecEnv): Promise<ExecResult> {
  const { stocktake: st } = await loadRunning(env.companyId, env.today)
  if (!st) throw new Error('Δεν υπάρχει απογραφή σε εξέλιξη.')
  try { await postDoc(st.id) } catch (e) { fail(e) }
  await env.refreshMaster()
  return {
    message: `Καταχωρήθηκε η απογραφή ${docCode('stocktake', st.docNo)} (${st.count} είδη, ${fmtDate(st.date)}). Δεν αναιρείται από εδώ.`,
    navigateTo: `/docs/stocktake/${st.id}`,
  }
}

async function queryStock(cmd: Cmd<'query_stock'>, env: ExecEnv): Promise<ExecResult> {
  const id = need(cmd.item, 'είδος')
  const it = itemOf(env, id)
  const { data, error } = await supabase.from('v_stock_balance').select('on_hand, min_stock, below_min').eq('item_id', id).maybeSingle()
  if (error) fail(error)
  const b = data as { on_hand: number; min_stock: number | null; below_min: boolean } | null
  const onHand = Number(b?.on_hand ?? 0)
  let msg = `«${it.name}»: ${fmtQty(onHand)} ${it.unit}.`
  if (b?.below_min) msg += ` Κάτω από το ελάχιστο (${fmtQty(b.min_stock)} ${it.unit}).`
  if (it.make_to_order) msg += it.item_type === 'semi' ? ' Φτιάχνεται αυτόματα όταν χρειάζεται.' : ' Φτιάχνεται κατά παραγγελία.'
  return { message: msg }
}

async function queryBalance(cmd: Cmd<'query_balance'>, env: ExecEnv): Promise<ExecResult> {
  const id = need(cmd.partner, 'συναλλασσόμενο')
  const p = partnerOf(env, id)
  const { data, error } = await supabase.from('v_partner_balance').select('customer_balance, supplier_balance').eq('partner_id', id).maybeSingle()
  if (error) fail(error)
  const b = data as { customer_balance: number; supplier_balance: number } | null
  const parts: string[] = []
  const cb = Number(b?.customer_balance ?? 0)
  const sb = Number(b?.supplier_balance ?? 0)
  if (p.is_customer) parts.push(cb > 0 ? `μας χρωστάει ${fmtMoney(cb)}` : cb < 0 ? `έχει πιστωτικό ${fmtMoney(-cb)}` : 'δεν μας χρωστάει τίποτα')
  if (p.is_supplier) parts.push(sb > 0 ? `του χρωστάμε ${fmtMoney(sb)}` : sb < 0 ? `μας έχει πιστώσει ${fmtMoney(-sb)}` : 'δεν του χρωστάμε τίποτα')
  return { message: `«${p.name}»: ${parts.join(' · ')}.` }
}

/** Σύνοψη πωλήσεων ημέρας (ανοιχτές + καταχωρημένες) ανά κανάλι και είδος */
export async function todaySummary(env: Pick<ExecEnv, 'companyId' | 'today' | 'items'>): Promise<string> {
  const { data, error } = await supabase.from('doc').select('id, channel, status, doc_line(item_id, qty, gross)')
    .eq('company_id', env.companyId).eq('doc_type', 'sale').eq('doc_date', env.today).eq('is_auto', false)
  if (error) fail(error)
  const docs = (data ?? []) as unknown as { channel: string | null; doc_line: { item_id: string; qty: number; gross: number }[] }[]
  const byCh = new Map<string, number>()
  const byItem = new Map<string, number>()
  let qty = 0, gross = 0
  for (const d of docs) {
    const ch = d.channel ?? 'wholesale'
    for (const l of d.doc_line) {
      const q = Number(l.qty)
      byCh.set(ch, (byCh.get(ch) ?? 0) + q)
      byItem.set(l.item_id, (byItem.get(l.item_id) ?? 0) + q)
      qty += q
      gross += Number(l.gross)
    }
  }
  if (qty === 0) return 'Σήμερα δεν έχουν περαστεί πωλήσεις.'
  const label = (c: string) => CHANNEL_LABEL[c as keyof typeof CHANNEL_LABEL] ?? c
  const chs = [...byCh].map(([c, q]) => `${label(c)} ${fmtQty(q)}`).join(', ')
  const top = [...byItem].sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([id, q]) => `${env.items.find((i) => i.id === id)?.name ?? '?'} ${fmtQty(q)}`).join(', ')
  return `Σήμερα: ${chs}. Σύνολο ${fmtQty(qty)} τεμ, ${fmtMoney(gross)} με ΦΠΑ. ${top}.`
}
