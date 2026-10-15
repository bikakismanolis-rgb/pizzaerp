import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useCompanyId } from '../context/CompanyContext'
import { useMaster } from '../context/MasterData'
import type { Item, ItemType } from '../lib/types'
import type { Command, EntityRef, InterpretContext, Interpretation, Interpreter, QtyLine, TallyChannel } from '../lib/voice/types'
import { localInterpreter, qtyForItem, warmUp } from '../lib/voice/interpret'
import { describe } from '../lib/voice/describe'
import { cancelSpeech, speak, useSpeechRecognition } from '../lib/voice/speech'
import {
  addAlias, createItem, createPartner, execute, loadRunning, resolveSalePrices, undoCreate, voiceError,
  type ExecEnv, type RunningState, type SalePrice,
} from '../lib/voice/actions'
import {
  answerTo, cardProblem, hasLines, plural, refSlots, setRefAt, shiftFlags, stocktakeDate, suggestName, visibleIssues,
  type RefSlot, type Solved, type TallyRow,
} from '../lib/voiceRules'
import { CHANNEL_LABEL, ITEM_TYPE_LABEL, TALLY_CHANNELS, UNITS, VAT_RATES, docCode } from '../lib/labels'
import { fmtCost, fmtDate, fmtMoney, fmtQty, round, today } from '../lib/format'
import { MicIcon, useToast } from '../components/ui'
import { ItemPicker, PartnerPicker } from '../components/Pickers'

/**
 * Ο "κατανοητής" της οθόνης. Σήμερα ο τοπικός parser (χωρίς API). Για μοντέλο
 * μέσω API ή δικό σας AI: ένα άλλο αντικείμενο που υλοποιεί το Interpreter
 * (μπορεί να είναι async). Αν αποτύχει, πέφτουμε πίσω στον τοπικό.
 */
const interpreter: Interpreter = localInterpreter

const LS_CHANNEL = 'pizza-erp.channel'
const LS_READ = 'pizza-erp.voice.read'
const LS_CONFIRM = 'pizza-erp.voice.confirm'

function lsGet(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}
function lsSet(key: string, v: string) {
  try { localStorage.setItem(key, v) } catch { /* ignore */ }
}

const normText = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ς/g, 'σ').replace(/\s+/g, ' ').trim()
const shortDate = (d: string) => fmtDate(d).slice(0, 5)
const tallyText = (t: TallyRow, withDate: boolean) => `${withDate ? shortDate(t.date) + ' ' : ''}${CHANNEL_LABEL[t.channel]} ${fmtQty(t.qty)}`

/** Ποια είδη επιτρέπονται σε κάθε θέση (ίδια λογική με τον parser) */
function itemTypesFor(cmd: Command, path: string, itemById: Map<string, Item>): ItemType[] | undefined {
  switch (cmd.kind) {
    case 'sale_tally': case 'sale': case 'item_price': case 'partner_price': return ['finished']
    case 'production': return ['semi', 'finished']
    case 'recipe': {
      if (path === 'item') return ['semi', 'finished']
      const prod = cmd.item.id ? itemById.get(cmd.item.id) : null
      return prod?.item_type === 'semi' ? ['raw'] : ['raw', 'semi']
    }
    default: return undefined
  }
}

function partnerRoleFor(cmd: Command): 'customer' | 'supplier' | 'any' {
  switch (cmd.kind) {
    case 'sale': case 'receipt': case 'partner_price': return 'customer'
    case 'purchase': case 'payment': return 'supplier'
    default: return 'any'
  }
}

const isQuery = (c: Command) => c.kind === 'query_stock' || c.kind === 'query_balance' || c.kind === 'query_today'

// ---------------------------------------------------------------------
// Κατάσταση οθόνης
// ---------------------------------------------------------------------
interface Pending {
  /** μοναδικό ανά φράση (κλειδί για τα πεδία) */
  id: number
  /** σταθερά κλειδιά γραμμών (για αφαίρεση γραμμής) */
  lineKeys: number[]
  interp: Interpretation
  cmd: Command
  /** θέσεις που διάλεξε ο χρήστης (όχι ο parser) */
  picked: Record<string, boolean>
  /** "να το θυμάμαι ως ..." */
  remember: Record<string, boolean>
  /** πεδία που έγραψε ο χρήστης ('lines.0.qty', 'netPrice', ...) */
  edited: Record<string, boolean>
}

interface LogEntry {
  id: number
  at: Date
  heard: string
  message: string
  undo?: () => Promise<void>
  state: 'done' | 'undoing' | 'undone'
  error?: string
}

type Tone = 'ok' | 'info' | 'warn' | 'err'
interface Answer { text: string; tone: Tone }

const EXAMPLES: { title: string; items: string[] }[] = [
  { title: 'Πωλήσεις', items: ['efood τρεις μαργαρίτες και δύο σπέσιαλ', 'τηλέφωνο μία πεπερόνι', 'βγάλε μία μαργαρίτα από το efood', 'πούλησα στο ξενοδοχείο Αστέρια εξήντα σπέσιαλ κατεψυγμένες'] },
  { title: 'Αγορές', items: ['πήρα από τον μύλο δέκα σακιά αλεύρι 0,62 το κιλό', 'τιμολόγιο 1234 από το τυροκομείο μοτσαρέλα 20 κιλά 7 ευρώ το κιλό'] },
  { title: 'Παραγωγή', items: ['έφτιαξα ογδόντα ζυμάρια'] },
  { title: 'Απογραφή', items: ['μέτρησα μοτσαρέλα έξι κιλά και αλεύρι σαράντα επτά κιλά', 'τέλος απογραφής'] },
  { title: 'Χρήματα', items: ['το ξενοδοχείο Αστέρια πλήρωσε 300 ευρώ', 'πλήρωσα τον μύλο 500 ευρώ'] },
  { title: 'Νέα είδη & πελάτες', items: ['νέα πρώτη ύλη ρίγανη σε γραμμάρια', 'νέα πίτσα καρμπονάρα 10 ευρώ', 'νέος πελάτης ξενοδοχείο Αστέρια τηλέφωνο 2810 123 456'] },
  { title: 'Συνταγές & τιμές', items: ['η μαργαρίτα έχει ένα ζυμάρι, ογδόντα γραμμάρια σάλτσα και εκατόν είκοσι γραμμάρια μοτσαρέλα', 'η μαργαρίτα κάνει οκτώ ευρώ', 'το ξενοδοχείο Αστέρια παίρνει τη σπέσιαλ τέσσερα και είκοσι'] },
  { title: 'Ερωτήσεις', items: ['πόση μοτσαρέλα έχουμε', 'πόσα μας χρωστάει το ξενοδοχείο Αστέρια', 'τι πουλήσαμε σήμερα'] },
  { title: 'Κλείσιμο & αναίρεση', items: ['κλείσε τη μέρα', 'ακύρωσε το τελευταίο'] },
]

// ---------------------------------------------------------------------
// Σελίδα
// ---------------------------------------------------------------------
export function Voice() {
  const companyId = useCompanyId()
  const { items, partners, itemById, partnerById, refresh, ready, loading: masterLoading } = useMaster()
  const toast = useToast()
  const nav = useNavigate()
  const location = useLocation()
  const sr = useSpeechRecognition('el-GR')

  const [channel, setChannelState] = useState<TallyChannel>(() => {
    const c = lsGet(LS_CHANNEL) as TallyChannel | null
    return c && TALLY_CHANNELS.includes(c) ? c : 'efood'
  })
  const [readAloud, setReadAloud] = useState(() => lsGet(LS_READ) !== '0')
  const [voiceConfirm, setVoiceConfirm] = useState(() => lsGet(LS_CONFIRM) === '1')
  const [input, setInput] = useState('')
  const [pending, setPendingState] = useState<Pending | null>(null)
  const [answer, setAnswer] = useState<Answer | null>(null)
  const [thinking, setThinking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [log, setLog] = useState<LogEntry[]>([])
  const [running, setRunning] = useState<RunningState | null>(null)
  const [showHelp, setShowHelp] = useState(false)
  // τιμές χονδρικής (πελάτη ή γενική) για γραμμές χωρίς ειπωμένη τιμή: "πελάτης|είδος"
  const [salePrices, setSalePrices] = useState<Map<string, SalePrice>>(new Map())
  const pendingRef = useRef<Pending | null>(null)
  const seqRef = useRef(0)
  const pendSeq = useRef(0)
  // εκτελείται τώρα (φρουρός και για διπλό "ναι" φωνή + πάτημα)
  const execRef = useRef(false)
  // αναίρεση σε εξέλιξη (φρουρός για διπλό πάτημα)
  const undoingRef = useRef(false)
  const mountedRef = useRef(true)
  // φράση που ήρθε πριν φορτώσει ο κατάλογος
  const queuedRef = useRef<string | null>(null)
  const logSeq = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const helpRef = useRef<HTMLDivElement>(null)

  const newPending = (interp: Interpretation): Pending => ({
    id: ++pendSeq.current,
    lineKeys: hasLines(interp.command) ? interp.command.lines.map((_, i) => i) : [],
    interp, cmd: interp.command, picked: {}, remember: {}, edited: {},
  })

  const setPending = (p: Pending | null | ((cur: Pending | null) => Pending | null)) => {
    const next = typeof p === 'function' ? p(pendingRef.current) : p
    pendingRef.current = next
    setPendingState(next)
  }

  const ctx: InterpretContext = useMemo(() => ({ items, partners, defaultChannel: channel }), [items, partners, channel])
  const env = (): ExecEnv => ({ companyId, today: today(), items, partners, refreshMaster: refresh })

  // ευρετήριο του καταλόγου από πριν: η πρώτη φράση να μην περιμένει
  useEffect(() => {
    if (!ready) return
    const t = window.setTimeout(() => warmUp({ items, partners, defaultChannel: 'efood' }), 50)
    return () => window.clearTimeout(t)
  }, [ready, items, partners])

  /** Ανάγνωση φωναχτά· true αν διαβάστηκε ως το τέλος. Ποτέ μέσα σε ανοιχτό μικρόφωνο. */
  const say = (text: string): Promise<boolean> => {
    if (!readAloud) return Promise.resolve(true)
    sr.abort()
    return speak(text)
  }

  const setChannel = (c: TallyChannel) => {
    setChannelState(c)
    lsSet(LS_CHANNEL, c)
    // εκκρεμής πώληση χωρίς ειπωμένο κανάλι: ακολουθεί την προεπιλογή
    setPending((p) => (p && p.cmd.kind === 'sale_tally' && !p.cmd.channelHeard ? { ...p, cmd: { ...p.cmd, channel: c } } : p))
  }

  // φεύγοντας από τη σελίδα: ούτε ανάγνωση ούτε μικρόφωνο που μένει ανοιχτό
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false; cancelSpeech(); sr.abort() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // -------------------------------------------------------------------
  // Ανοιχτά πρόχειρα (μετρητής, απογραφή)
  // -------------------------------------------------------------------
  const refreshRunning = useCallback(async () => {
    if (!companyId) return
    try { setRunning(await loadRunning(companyId, today())) } catch { /* π.χ. χωρίς 0004 */ }
  }, [companyId])

  useEffect(() => { refreshRunning() }, [refreshRunning])
  useEffect(() => {
    const h = () => { if (document.visibilityState === 'visible') refreshRunning() }
    window.addEventListener('focus', h)
    document.addEventListener('visibilitychange', h)
    return () => { window.removeEventListener('focus', h); document.removeEventListener('visibilitychange', h) }
  }, [refreshRunning])

  // τιμές χονδρικής: ξανά για κάθε νέα κάρτα και με κάθε ανανέωση του καταλόγου
  // (τιμή πελάτη μπορεί να άλλαξε από άλλη συσκευή)
  const pendingId = pending?.id
  useEffect(() => { setSalePrices(new Map()) }, [items, pendingId])
  const salePartner = pending?.cmd.kind === 'sale' ? pending.cmd.partner.id : null
  const saleItems = pending?.cmd.kind === 'sale' ? pending.cmd.lines.filter((l) => l.unitPrice == null && l.item.id).map((l) => l.item.id!).join(',') : ''
  useEffect(() => {
    if (!salePartner || !saleItems) return
    const missing = saleItems.split(',').filter((id) => !salePrices.has(`${salePartner}|${id}`))
    if (missing.length === 0) return
    let alive = true
    resolveSalePrices({ items }, salePartner, missing).then((m) => {
      if (!alive) return
      setSalePrices((cur) => {
        const n = new Map(cur)
        for (const [id, v] of m) n.set(`${salePartner}|${id}`, v)
        return n
      })
    }).catch(() => { /* η εκτέλεση ξαναελέγχει την τιμή */ })
    return () => { alive = false }
  }, [salePartner, saleItems, salePrices, items])
  const salePriceOf = (itemId: string): SalePrice | undefined => (salePartner ? salePrices.get(`${salePartner}|${itemId}`) : undefined)

  // -------------------------------------------------------------------
  // Ροή: κείμενο → κατανόηση → κάρτα επιβεβαίωσης → ναι → εκτέλεση
  // -------------------------------------------------------------------
  const heardRef = useRef<(t: string) => void>(() => {})
  const listen = (quiet = false) => {
    if (!sr.supported) {
      if (!quiet) inputRef.current?.focus()
      return
    }
    sr.start({ quiet, onFinal: (t) => heardRef.current(t) })
  }

  const interpretText = async (text: string): Promise<Interpretation> => {
    try {
      return await interpreter.interpret(text, ctx)
    } catch {
      try { return await localInterpreter.interpret(text, ctx) } catch { return { text, command: { kind: 'unknown' }, confidence: 0, issues: [] } }
    }
  }

  const handleText = async (raw: string) => {
    const text = raw.trim()
    if (!text || busy || execRef.current) return
    setInput('')
    // ο κατάλογος δεν έχει φορτώσει ακόμα: αλλιώς όλα «δεν βρέθηκε» (και διπλά νέα είδη)
    if (!ready) {
      queuedRef.current = text
      setAnswer({ text: `Φορτώνω τα είδη… μόλις φορτώσουν συνεχίζω με «${text}».`, tone: 'info' })
      return
    }
    const p = pendingRef.current
    if (!p) { await understand(text); return }

    // περιμένει κάρτα: «ναι»/«όχι» μόνο ως σκέτη απάντηση, όχι μέσα σε νέα εντολή
    const seq = ++seqRef.current
    setThinking(true)
    const interp = await interpretText(text)
    if (seq !== seqRef.current) return
    setThinking(false)
    if (pendingRef.current !== p) { await understand(text, interp); return }
    switch (answerTo(text, interp.command.kind)) {
      case 'yes': await confirm(); return
      case 'no': cancel(); return
      case 'fix': await understand(text, interp, p); return
      case 'unclear': {
        const m = `Δεν κατάλαβα αν είναι «ναι» («${text}»). Πες «ναι» για να περάσει ή «όχι» για ακύρωση.`
        setAnswer({ text: m, tone: 'warn' })
        say('Πες ναι ή όχι.')
        return
      }
      default:
        if (interp.command.kind === 'unknown') {
          setAnswer({ text: `Δεν κατάλαβα «${text}». Η κάρτα περιμένει: «ναι» ή «όχι».`, tone: 'warn' })
          say('Δεν κατάλαβα. Πες ναι ή όχι.')
          return
        }
        await understand(text, interp)
    }
  }
  heardRef.current = (t) => { handleText(t) }

  // ό,τι ειπώθηκε πριν φορτώσει ο κατάλογος
  useEffect(() => {
    if (!ready || !queuedRef.current) return
    const t = queuedRef.current
    queuedRef.current = null
    setAnswer(null)
    handleText(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready])

  /**
   * prev: η κάρτα που διορθώνεται («όχι, τέσσερις μαργαρίτες»)· κρατάμε το
   * κανάλι της αν η διόρθωση δεν λέει άλλο.
   */
  const understand = async (text: string, pre?: Interpretation, prev?: Pending) => {
    const seq = ++seqRef.current
    let interp = pre
    if (!interp) {
      setThinking(true)
      interp = await interpretText(text)
      if (seq !== seqRef.current) return
      setThinking(false)
    }
    let cmd = interp.command
    if (prev && prev.cmd.kind === 'sale_tally' && cmd.kind === 'sale_tally' && !cmd.channelHeard) {
      cmd = { ...cmd, channel: prev.cmd.channel, channelHeard: prev.cmd.channelHeard }
      interp = { ...interp, command: cmd }
    }

    if (cmd.kind === 'help') {
      setPending(null)
      setShowHelp(true)
      const msg = 'Δες τα παραδείγματα παρακάτω. Πάτα ένα για να το δοκιμάσεις.'
      setAnswer({ text: msg, tone: 'info' })
      window.setTimeout(() => helpRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
      say(msg)
      return
    }
    if (cmd.kind === 'unknown') {
      setPending(null)
      const msg = describe(interp, ctx)
      setAnswer({ text: [msg, ...interp.issues].join(' '), tone: 'warn' })
      // η εξήγηση του parser (φύρα, παραγγελία, «κλείσε τι;») λέει περισσότερα από το γενικό
      say(interp.issues[0] ?? msg)
      return
    }
    // ερώτηση με σίγουρες αναφορές: απάντηση αμέσως (δεν γράφει τίποτα)
    if (isQuery(cmd) && refSlots(cmd).every((s) => s.ref.id)) {
      setPending(null)
      await runQuery(cmd)
      return
    }

    const p = newPending(interp)
    setPending(p)
    setAnswer(prev ? { text: 'Η προηγούμενη ακυρώθηκε. Νέα κάρτα:', tone: 'info' } : null)
    // ό,τι εμποδίζει το «ναι» διαβάζεται κι αυτό· τότε δεν ακούμε για «ναι»
    const why = problem(p)
    const finished = await say(describe(interp, ctx) + notice(cmd) + (why ? ' ' + why : ''))
    // επιβεβαίωση με φωνή: μία φορά ακούμε για ναι/όχι, μόνο αν η ανάγνωση τελείωσε
    // κανονικά (όχι αν κόπηκε από μικρόφωνο / νέα φράση / έξοδο από τη σελίδα)
    if (voiceConfirm && sr.supported && finished && !why && !isQuery(cmd)) {
      window.setTimeout(() => {
        if (mountedRef.current && pendingRef.current === p && !execRef.current && !sr.active()) listen(true)
      }, 250)
    }
  }

  const runQuery = async (cmd: Command) => {
    setBusy(true)
    try {
      const res = await execute(cmd, env())
      setAnswer({ text: res.message, tone: 'info' })
      say(res.message)
    } catch (e) {
      const m = voiceError(e).message
      setAnswer({ text: m, tone: 'err' })
      say(m)
    } finally { setBusy(false) }
  }

  const addLog = (heard: string, message: string, undo?: () => Promise<void>) => {
    const id = ++logSeq.current
    setLog((l) => [{ id, at: new Date(), heard, message, undo, state: 'done' as const }, ...l].slice(0, 50))
  }

  const lastUndoable = log.find((e) => e.undo && e.state === 'done') ?? null

  const undoEntry = async (entry: LogEntry) => {
    // μία αναίρεση τη φορά: διπλό πάτημα δεν αναιρεί και την προηγούμενη ενέργεια
    if (!entry.undo || entry.state !== 'done' || undoingRef.current) return
    undoingRef.current = true
    setBusy(true)
    setLog((l) => l.map((e) => (e.id === entry.id ? { ...e, state: 'undoing', error: undefined } : e)))
    try {
      await entry.undo()
      setLog((l) => l.map((e) => (e.id === entry.id ? { ...e, state: 'undone' } : e)))
      setAnswer({ text: 'Αναιρέθηκε: ' + entry.message, tone: 'ok' })
      say('Αναιρέθηκε.')
      refreshRunning()
    } catch (e) {
      const m = voiceError(e).message
      setLog((l) => l.map((x) => (x.id === entry.id ? { ...x, state: 'done', error: m } : x)))
      setAnswer({ text: m, tone: 'err' })
      toast.err(m)
    } finally {
      undoingRef.current = false
      setBusy(false)
    }
  }

  /** Συνέπεια που πρέπει να ακουστεί πριν από το «ναι» */
  const notice = (cmd: Command): string => (
    cmd.kind === 'close_stocktake' && running?.stocktake?.date === today()
      ? ' Μετά δεν θα μπαίνουν άλλες σημερινές πωλήσεις για τα είδη που μετρήθηκαν.'
      : ''
  )

  /** Σφάλμα που εμποδίζει την εκτέλεση (null = όλα καλά) */
  const problem = (p: Pending): string | null => cardProblem(p.cmd, {
    itemById,
    edited: p.edited,
    running,
    hasUndo: !!lastUndoable,
    saleFallback: (id) => salePriceOf(id)?.price,
  })

  /** Ό,τι έλυσε ο χρήστης στην κάρτα (για να κρυφτούν οι αντίστοιχες προειδοποιήσεις) */
  const solvedOf = (p: Pending): Solved => {
    const entity = refSlots(p.cmd).filter((s) => s.ref.id && p.picked[s.path]).map((s) => s.ref.heard)
    const qty: string[] = []
    const price: string[] = []
    if (hasLines(p.cmd)) {
      p.cmd.lines.forEach((l, i) => {
        const labels = [l.item.heard, l.item.id ? itemById.get(l.item.id)?.name ?? '' : ''].filter(Boolean)
        if (p.edited[`lines.${i}.qty`]) qty.push(...labels)
        if (p.edited[`lines.${i}.unitPrice`]) price.push(...labels)
      })
    }
    const fields: Solved['fields'] = []
    if (p.edited.qty) fields.push('qty')
    if (p.edited.netPrice) fields.push('price')
    if (p.edited.amount) fields.push('amount')
    return { entity, qty, price, fields }
  }

  const rememberable = (p: Pending, s: RefSlot): boolean => {
    if (!p.picked[s.path] || !s.ref.id || !s.ref.heard.trim()) return false
    const ent = s.kind === 'item' ? itemById.get(s.ref.id) : partnerById.get(s.ref.id)
    if (!ent) return false
    const h = normText(s.ref.heard)
    return normText(ent.name) !== h && !(ent.aliases ?? []).some((a) => normText(a) === h)
  }

  const confirm = async () => {
    const p = pendingRef.current
    if (!p || busy || execRef.current || undoingRef.current) return
    const why = problem(p)
    if (why) { setAnswer({ text: why, tone: 'warn' }); say(why); return }
    cancelSpeech()
    sr.abort()
    if (p.cmd.kind === 'undo') {
      setPending(null)
      if (lastUndoable) await undoEntry(lastUndoable)
      return
    }
    setBusy(true)
    execRef.current = true
    try {
      const res = await execute(p.cmd, env())
      // "να το θυμάμαι ως ..."
      const learned: string[] = []
      for (const s of refSlots(p.cmd)) {
        if (!p.remember[s.path] || !rememberable(p, s)) continue
        try {
          if (await addAlias(s.kind, s.ref.id!, s.ref.heard)) learned.push(`«${s.ref.heard}»`)
        } catch (e) { toast.err(voiceError(e).message) }
      }
      if (learned.length) await refresh()
      const q = isQuery(p.cmd)
      if (!q) addLog(p.interp.text, res.message, res.undo)
      setAnswer({ text: res.message + (learned.length ? ` Θα θυμάμαι ${learned.join(', ')}.` : ''), tone: q ? 'info' : 'ok' })
      setPending(null)
      say(q ? res.message : 'Έγινε.')
      refreshRunning()
      if (res.navigateTo) nav(res.navigateTo)
    } catch (e) {
      const m = voiceError(e).message
      setAnswer({ text: m, tone: 'err' })
      say(m)
    } finally {
      execRef.current = false
      setBusy(false)
    }
  }

  const cancel = () => {
    cancelSpeech()
    sr.abort()
    seqRef.current++
    setThinking(false)
    setPending(null)
    setAnswer({ text: 'Ακυρώθηκε. Δεν πέρασε τίποτα.', tone: 'info' })
  }

  /** Κουμπιά κλεισίματος από τις λωρίδες: ίδια ροή επιβεβαίωσης */
  const askClose = (kind: 'close_day' | 'close_stocktake') => {
    const text = kind === 'close_day' ? 'Κλείσιμο ημέρας' : 'Τέλος απογραφής'
    const interp: Interpretation = { text, command: { kind }, confidence: 1, issues: [] }
    setPending(newPending(interp))
    setAnswer(null)
    say(describe(interp, ctx) + notice(interp.command))
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  // από το στρογγυλό μικρόφωνο άλλων σελίδων: ακούμε αμέσως.
  // Χωρίς αναγνώριση φωνής: έτοιμο το κουτί (μικρόφωνο του πληκτρολογίου).
  useEffect(() => {
    if ((location.state as { listen?: boolean } | null)?.listen) {
      nav(location.pathname, { replace: true, state: null })
      listen(true)
    }
    if (!sr.supported) inputRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // -------------------------------------------------------------------
  // Επεξεργασία της εκκρεμούς εντολής
  // -------------------------------------------------------------------
  /** edited: το πεδίο που άλλαξε ο χρήστης (π.χ. 'netPrice') */
  const updCmd = (f: (c: Command) => Command, edited?: string) => setPending((p) => (
    p ? { ...p, cmd: f(p.cmd), edited: edited ? { ...p.edited, [edited]: true } : p.edited } : p
  ))

  const pickRef = (path: string, ref: EntityRef, byUser: boolean) => setPending((p) => {
    if (!p) return p
    const picked = { ...p.picked, [path]: byUser }
    const remember = { ...p.remember }
    if (byUser && remember[path] === undefined) remember[path] = true
    let cmd = setRefAt(p.cmd, path, ref)
    // ποσότητα ξανά στη μονάδα του είδους που διαλέχτηκε ("500 γραμμάρια" → 0,5 kg)
    const li = /^lines\.(\d+)\.item$/.exec(path)
    if (li && hasLines(cmd) && cmd.kind !== 'sale_tally' && !p.edited[`lines.${li[1]}.qty`]) {
      const i = Number(li[1])
      const q = qtyForItem(cmd.lines[i]?.heardQty, ref.id ? itemById.get(ref.id) : null)
      if (q !== null && Number.isFinite(q) && q >= 0) {
        cmd = { ...cmd, lines: cmd.lines.map((l, j) => (j === i ? { ...l, qty: q } : l)) } as Command
      }
    }
    return { ...p, cmd, picked, remember }
  })

  const removeLine = (i: number) => setPending((p) => {
    if (!p || !hasLines(p.cmd)) return p
    return {
      ...p,
      cmd: { ...p.cmd, lines: p.cmd.lines.filter((_, j) => j !== i) } as Command,
      lineKeys: p.lineKeys.filter((_, j) => j !== i),
      picked: shiftFlags(p.picked, i),
      remember: shiftFlags(p.remember, i),
      edited: shiftFlags(p.edited, i),
    }
  })

  const setLine = (i: number, patch: Partial<QtyLine> & { unitPrice?: number | null }) => setPending((p) => {
    if (!p || !hasLines(p.cmd)) return p
    const edited = { ...p.edited }
    for (const k of Object.keys(patch)) edited[`lines.${i}.${k}`] = true
    // γραμμένη ποσότητα = ειπωμένη (π.χ. μέτρηση 0: όχι «δεν ακούστηκε ποσότητα»)
    if (patch.qty !== undefined) patch = { ...patch, heardQty: numText(patch.qty) }
    return { ...p, edited, cmd: { ...p.cmd, lines: p.cmd.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) } as Command }
  })

  const onCreated = (label: string, table: 'item' | 'partner', id: string) => {
    addLog(label, label, undoCreate(env(), table, id))
  }

  // -------------------------------------------------------------------
  // Απόδοση
  // -------------------------------------------------------------------
  const why = pending ? problem(pending) : null
  const issues = pending ? visibleIssues(pending.interp.issues, solvedOf(pending)) : []
  // με τις προειδοποιήσεις που ισχύουν ακόμα: τιμή που γράφτηκε δεν είναι πια «δεν ακούστηκε»
  const sentence = pending ? describe({ ...pending.interp, command: pending.cmd, issues }, ctx) : ''
  const confirmLabel = !pending ? '' : isQuery(pending.cmd) ? 'Δείξε' : pending.cmd.kind === 'undo' ? 'Ναι, αναίρεσέ το' : 'Ναι, πέρασέ το'
  const live = sr.listening ? (sr.interim || 'Ακούω…') : thinking ? 'Σκέφτομαι…' : ''

  return (
    <div className={'max-w-2xl mx-auto ' + (pending ? 'pb-44' : 'pb-28')}>
      <div className="flex items-center justify-between gap-2 mb-3">
        <h1 className="text-xl font-semibold">Πες το</h1>
        <button type="button" className="btn-ghost text-sm h-11" onClick={() => { setShowHelp((v) => !v); window.setTimeout(() => helpRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50) }}>
          Τι μπορώ να πω;
        </button>
      </div>

      {!ready && !masterLoading && (
        <div className="mb-3 rounded-md bg-amber-50 border border-amber-200 text-amber-900 text-sm px-3 py-2 flex items-center gap-2">
          <span className="flex-1">Δεν φόρτωσαν τα είδη και οι πελάτες (σύνδεση;).</span>
          <button type="button" className="btn-secondary h-10 text-xs" onClick={() => refresh()}>Ξανά</button>
        </div>
      )}

      <RunningStrips running={running} onCloseDay={() => askClose('close_day')} onCloseStocktake={() => askClose('close_stocktake')} disabled={busy} />

      {pending ? (
        <div className="card p-3 sm:p-4 mb-3 border-red-200 shadow">
          <div className="text-xs text-stone-500 break-words">Άκουσα: «{pending.interp.text}»</div>
          <div className="text-lg leading-snug font-medium mt-1">{sentence}</div>
          {pending.interp.confidence < 0.5 && !why && Object.keys(pending.picked).length === 0 && Object.keys(pending.edited).length === 0 && (
            <div className="text-xs text-amber-700 mt-1">Δεν είμαι σίγουρος: έλεγξε τα στοιχεία πριν πεις ναι.</div>
          )}
          {issues.length > 0 && (
            <ul className="mt-2 text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 list-disc list-inside space-y-0.5">
              {issues.map((i, k) => <li key={k}>{i}</li>)}
            </ul>
          )}
          <div className="mt-3 flex flex-col gap-3">
            <Editor
              pending={pending}
              running={running}
              lastUndo={lastUndoable}
              itemById={itemById}
              salePriceOf={salePriceOf}
              setChannel={(c) => updCmd((cmd) => (cmd.kind === 'sale_tally' ? { ...cmd, channel: c, channelHeard: true } : cmd))}
              updCmd={updCmd}
              setLine={setLine}
              removeLine={removeLine}
              refField={(path, label) => {
                const slot = refSlots(pending.cmd).find((s) => s.path === path)
                if (!slot) return null
                const li = /^lines\.(\d+)\./.exec(path)
                return (
                  <RefField
                    key={`${pending.id}:${li ? 'L' + pending.lineKeys[Number(li[1])] : path}`}
                    label={label}
                    slot={slot}
                    types={itemTypesFor(pending.cmd, path, itemById)}
                    role={partnerRoleFor(pending.cmd)}
                    newItemDefaults={newItemDefaults(pending.cmd, path)}
                    needPrice={pending.cmd.kind === 'sale_tally'}
                    env={env}
                    onPick={(ref) => pickRef(path, ref, true)}
                    picked={!!pending.picked[path]}
                    remember={rememberable(pending, slot) ? pending.remember[path] !== false : null}
                    onRemember={(v) => setPending((p) => (p ? { ...p, remember: { ...p.remember, [path]: v } } : p))}
                    onCreated={onCreated}
                  />
                )
              }}
            />
          </div>
          {why && <div className="mt-3 text-sm text-red-700">{why}</div>}
        </div>
      ) : (
        <div className="flex flex-col items-center pt-2 pb-4">
          <button
            type="button"
            onClick={() => (sr.listening ? sr.stop() : listen())}
            aria-label={sr.listening ? 'Σταμάτα' : 'Μίλα'}
            className={'relative h-32 w-32 rounded-full text-white shadow-xl flex items-center justify-center transition active:scale-95 ' +
              (sr.listening ? 'bg-red-600' : sr.supported ? 'bg-red-700' : 'bg-stone-400')}
          >
            {sr.listening && <span className="absolute inset-0 rounded-full bg-red-500 opacity-40 animate-ping" />}
            <MicIcon className="h-14 w-14 relative" />
          </button>
          <div className="mt-3 min-h-[2.75rem] px-2 text-center text-base text-stone-700 break-words max-w-full">
            {live ? <span className={sr.listening ? 'text-red-700' : ''}>{live}</span>
              : !ready ? <span className="text-stone-500">Φορτώνω τα είδη…</span>
              : sr.supported ? <span className="text-stone-500">Πάτα και πες π.χ. «efood δύο μαργαρίτες»</span>
              : <span className="text-stone-600 text-sm">Ο browser δεν έχει αναγνώριση φωνής. Πάτα το μικρόφωνο του πληκτρολογίου και μίλα στο κουτί κάτω.</span>}
          </div>
        </div>
      )}

      {sr.error && !sr.listening && (
        <div className="mb-3 rounded-md bg-amber-50 border border-amber-200 text-amber-900 text-sm px-3 py-2 flex items-start gap-2">
          <span className="flex-1">{sr.error}</span>
          <button type="button" className="text-amber-900/70 px-1" onClick={sr.clearError} aria-label="Κλείσιμο">✕</button>
        </div>
      )}

      {answer && (
        <div className={'mb-3 rounded-md border text-sm px-3 py-2 ' + {
          ok: 'bg-emerald-50 border-emerald-200 text-emerald-900',
          info: 'bg-white border-stone-200 text-stone-800',
          warn: 'bg-amber-50 border-amber-200 text-amber-900',
          err: 'bg-red-50 border-red-200 text-red-800',
        }[answer.tone]}>
          {answer.text}
        </div>
      )}

      {/* Ρυθμίσεις: κανάλι + φωνή (κρυφές όσο περιμένει επιβεβαίωση) */}
      <div className={'card p-3 mb-3 ' + (pending ? 'hidden' : '')}>
        <div className="text-xs font-medium text-stone-600 mb-2">Κανάλι όταν δεν το λες</div>
        <div className="flex gap-2 flex-wrap">
          {TALLY_CHANNELS.map((c) => (
            <Chip key={c} active={c === channel} onClick={() => setChannel(c)}>{CHANNEL_LABEL[c]}</Chip>
          ))}
        </div>
        <div className="mt-3 flex flex-col gap-2 text-sm">
          <Toggle checked={readAloud} onChange={(v) => { setReadAloud(v); lsSet(LS_READ, v ? '1' : '0'); if (!v) cancelSpeech() }}>
            Ανάγνωση φωναχτά
          </Toggle>
          <Toggle checked={voiceConfirm} disabled={!sr.supported} onChange={(v) => { setVoiceConfirm(v); lsSet(LS_CONFIRM, v ? '1' : '0') }}>
            Επιβεβαίωση με φωνή (μετά την ανάγνωση λες «ναι» ή «όχι»)
          </Toggle>
        </div>
      </div>

      {/* Τι πέρασε σε αυτή τη συνεδρία */}
      {log.length > 0 && (
        <div className="card mb-3">
          <div className="flex items-center justify-between px-3 py-2 border-b border-stone-200">
            <h2 className="font-semibold text-sm">Τι πέρασε</h2>
            <button type="button" className="btn-secondary h-10 text-xs" disabled={!lastUndoable || busy} onClick={() => lastUndoable && undoEntry(lastUndoable)}>
              ↶ Αναίρεση τελευταίου
            </button>
          </div>
          <ul className="divide-y divide-stone-100">
            {log.map((e) => (
              <li key={e.id} className="px-3 py-2 flex items-start gap-2">
                <div className="flex-1 min-w-0">
                  <div className={'text-sm ' + (e.state === 'undone' ? 'line-through text-stone-400' : '')}>{e.message}</div>
                  <div className="text-xs text-stone-500 truncate">
                    {e.at.toLocaleTimeString('el-GR', { hour: '2-digit', minute: '2-digit' })}
                    {e.heard !== e.message && <> · «{e.heard}»</>}
                    {e.state === 'undone' && ' · αναιρέθηκε'}
                  </div>
                  {e.error && <div className="text-xs text-red-700 mt-0.5">{e.error}</div>}
                </div>
                {e.undo && e.state !== 'undone' && (
                  <button type="button" className="btn-ghost h-10 text-xs shrink-0" disabled={e.state === 'undoing' || busy} onClick={() => undoEntry(e)}>
                    {e.state === 'undoing' ? '…' : 'Αναίρεση'}
                  </button>
                )}
                {!e.undo && <span className="text-[11px] text-stone-400 shrink-0 mt-1">χωρίς αναίρεση</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Βοήθεια */}
      <div ref={helpRef} className="card mb-3 scroll-mt-16">
        <button type="button" className="w-full flex items-center justify-between px-3 py-3 text-left" onClick={() => setShowHelp((v) => !v)}>
          <span className="font-semibold text-sm">Τι μπορώ να πω;</span>
          <span className="text-stone-400">{showHelp ? '▴' : '▾'}</span>
        </button>
        {showHelp && (
          <div className="px-3 pb-3 flex flex-col gap-3">
            <p className="text-xs text-stone-500">Πάτα ένα παράδειγμα για να μπει στο κουτί. Τίποτα δεν περνάει χωρίς το δικό σου «ναι».</p>
            {EXAMPLES.map((g) => (
              <div key={g.title}>
                <div className="text-xs font-medium text-stone-600 mb-1">{g.title}</div>
                <div className="flex flex-wrap gap-2">
                  {g.items.map((x) => (
                    <button key={x} type="button" className="text-left text-sm rounded-lg border border-stone-300 bg-stone-50 px-3 py-2 active:bg-stone-200"
                      onClick={() => { setInput(x); inputRef.current?.focus() }}>
                      {x}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Κάτω μπάρα: ναι/άκυρο + κουτί κειμένου + μικρόφωνο (για τον αντίχειρα) */}
      <div className="fixed bottom-0 left-0 right-0 md:left-60 z-20 bg-white/95 backdrop-blur border-t border-stone-200 shadow-[0_-2px_8px_rgba(0,0,0,0.06)] px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <div className="max-w-2xl mx-auto flex flex-col gap-2">
          {pending && live && <div className="text-sm text-red-700 truncate">{live}</div>}
          {pending && (
            <div className="flex gap-2">
              <button type="button" className="btn-secondary h-12 flex-1 text-base" onClick={cancel} disabled={busy}>Άκυρο</button>
              <button type="button" className="btn-primary h-12 flex-[2] text-base" onClick={confirm} disabled={busy || !!why}>
                {busy ? 'Περνάει…' : confirmLabel}
              </button>
            </div>
          )}
          <form className="flex gap-2 items-center" onSubmit={(e) => { e.preventDefault(); handleText(input) }}>
            <button
              type="button"
              onClick={() => (sr.listening ? sr.stop() : listen())}
              aria-label={sr.listening ? 'Σταμάτα' : 'Μίλα'}
              className={'relative shrink-0 h-12 w-12 rounded-full text-white flex items-center justify-center active:scale-95 transition ' +
                (sr.listening ? 'bg-red-600' : sr.supported ? 'bg-red-700' : 'bg-stone-400')}
            >
              {sr.listening && <span className="absolute inset-0 rounded-full bg-red-500 opacity-40 animate-ping" />}
              <MicIcon className="h-6 w-6 relative" />
            </button>
            <input
              ref={inputRef}
              className="input h-12 text-base flex-1 min-w-0"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={pending ? 'ναι / όχι ή νέα φράση…' : 'Γράψε ή υπαγόρευσε…'}
              enterKeyHint="send"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <button className="btn-primary h-12 px-3 shrink-0" disabled={!input.trim() || busy || thinking}>Στείλε</button>
          </form>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------
// Λωρίδες "σε εξέλιξη"
// ---------------------------------------------------------------------
function RunningStrips({ running, onCloseDay, onCloseStocktake, disabled }: {
  running: RunningState | null; onCloseDay: () => void; onCloseStocktake: () => void; disabled: boolean
}) {
  if (!running) return null
  const st = running.stocktake
  return (
    <div className="flex flex-col gap-2 mb-3">
      {running.older.length > 0 && (
        <div className="card px-3 py-1 flex items-center gap-2 border-amber-200 bg-amber-50">
          <Link to="/docs/sale" className="flex-1 min-w-0 min-h-[44px] flex items-center text-sm text-amber-900">
            <span>Ανοιχτές από προηγούμενες μέρες: {running.older.map((t) => tallyText(t, true)).join(' · ')}</span>
          </Link>
          <button type="button" className="btn-secondary h-11 text-xs shrink-0" onClick={onCloseDay} disabled={disabled}>Κλείσιμο</button>
        </div>
      )}
      <div className="card px-3 py-1 flex items-center gap-2">
        <Link to="/daily-sales" className="flex-1 min-w-0 min-h-[44px] flex items-center text-sm">
          <span>
            <span className="text-stone-500">Σήμερα: </span>
            {running.tally.length === 0 ? <span className="text-stone-500">καμία πώληση ακόμα</span>
              : running.tally.map((t, i) => (
                <span key={t.channel}>{i > 0 && <span className="text-stone-400"> · </span>}<b className="font-semibold">{CHANNEL_LABEL[t.channel]}</b> {fmtQty(t.qty)}</span>
              ))}
          </span>
        </Link>
        {running.tally.length > 0 && (
          <button type="button" className="btn-secondary h-11 text-xs shrink-0" onClick={onCloseDay} disabled={disabled}>Κλείσιμο ημέρας</button>
        )}
      </div>
      {st && (
        <div className="card px-3 py-1 flex items-center gap-2 border-amber-200 bg-amber-50">
          <Link to={`/docs/stocktake/${st.id}`} className="flex-1 min-w-0 min-h-[44px] flex items-center text-sm text-amber-900">
            <span>Απογραφή σε εξέλιξη: <b>{st.count}</b> {plural(st.count, 'είδος', 'είδη')}{st.date !== today() && <> (από {fmtDate(st.date)})</>} →</span>
          </Link>
          <button type="button" className="btn-secondary h-11 text-xs shrink-0" onClick={onCloseStocktake} disabled={disabled}>Τέλος απογραφής</button>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------
// Μικρά στοιχεία
// ---------------------------------------------------------------------
function Chip({ active, onClick, children, title }: { active?: boolean; onClick: () => void; children: ReactNode; title?: string }) {
  return (
    <button type="button" title={title} onClick={onClick}
      className={'shrink-0 rounded-full px-3.5 h-11 inline-flex items-center text-sm font-medium border transition ' +
        (active ? 'bg-red-700 text-white border-red-700' : 'bg-white text-stone-700 border-stone-300 active:bg-stone-100')}>
      {children}
    </button>
  )
}

function Toggle({ checked, onChange, disabled, children }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; children: ReactNode }) {
  return (
    <label className={'flex items-center gap-3 py-1 ' + (disabled ? 'opacity-50' : '')}>
      <button type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}
        className={'relative shrink-0 h-7 w-12 rounded-full transition ' + (checked ? 'bg-red-700' : 'bg-stone-300')}>
        <span className={'absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-all ' + (checked ? 'left-[1.375rem]' : 'left-0.5')} />
      </button>
      <span>{children}</span>
    </label>
  )
}

const numText = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '' : String(round(v, 4)).replace('.', ','))

/** Αριθμός με κόμμα ή τελεία· null όταν είναι κενό */
function NumField({ value, onChange, placeholder, suffix, label, className = '' }: {
  value: number | null; onChange: (v: number | null) => void; placeholder?: string; suffix?: string; label?: string; className?: string
}) {
  const [text, setText] = useState(numText(value))
  const focused = useRef(false)
  useEffect(() => { if (!focused.current) setText(numText(value)) }, [value])
  return (
    <div className={'relative ' + className}>
      <input
        type="text" inputMode="decimal" aria-label={label} placeholder={placeholder}
        className={'input num h-11 text-base ' + (suffix ? 'pr-12' : '')}
        value={text}
        onFocus={(e) => { focused.current = true; e.target.select() }}
        onBlur={() => { focused.current = false; setText(numText(value)) }}
        onChange={(e) => {
          const t = e.target.value
          setText(t)
          const n = t.trim() === '' ? null : Number(t.replace(/\s/g, '').replace(',', '.'))
          onChange(n != null && Number.isFinite(n) ? n : null)
        }}
      />
      {suffix && <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-stone-500">{suffix}</span>}
    </div>
  )
}

/**
 * − [ποσότητα] + για τεμάχια, απλό πεδίο για τα υπόλοιπα.
 * allowNegative: αφαίρεση από τον μετρητή ημέρας («βγάλε μία μαργαρίτα»).
 */
function QtyInput({ value, onChange, unit, label, allowNegative = false, blank = false }: {
  value: number; onChange: (v: number) => void; unit: string; label: string; allowNegative?: boolean
  /** δεν ακούστηκε ποσότητα: κενό πεδίο (όχι «0») μέχρι να γράψει ο χρήστης */
  blank?: boolean
}) {
  if (unit !== 'τεμ') {
    return <NumField value={blank ? null : value} onChange={(v) => onChange(v ?? 0)} suffix={unit} label={label} className="w-32" placeholder="πόσο;" />
  }
  const dec = round((value || 0) - 1, 4)
  return (
    <div className="flex items-center gap-1">
      <button type="button" className="btn-secondary h-11 w-11 p-0 text-xl" aria-label={`Μείον ${label}`} onClick={() => onChange(allowNegative ? dec : Math.max(0, dec))}>−</button>
      <NumField value={blank ? null : value} onChange={(v) => onChange(v ?? 0)} label={label} className="w-16" placeholder=";" />
      <button type="button" className="btn-secondary h-11 w-11 p-0 text-xl" aria-label={`Συν ${label}`} onClick={() => onChange(round((value || 0) + 1, 4))}>+</button>
    </div>
  )
}

/** "10 σακιά", "500 γρ": ναι· "τρεις", "έξι κιλά": όχι (φαίνεται ήδη στο πεδίο) */
function showHeardQty(h: string | undefined): boolean {
  if (!h || h.trim().split(/\s+/).length < 2) return false
  return !/(κιλ|kg|λιτρ|lt|τεμ|κομματ)/.test(normText(h))
}

function newItemDefaults(cmd: Command, path: string): { itemType: ItemType; unit: string; makeToOrder: boolean } {
  switch (cmd.kind) {
    case 'sale_tally': return { itemType: 'finished', unit: 'τεμ', makeToOrder: true }
    case 'sale': case 'item_price': case 'partner_price': return { itemType: 'finished', unit: 'τεμ', makeToOrder: false }
    case 'production': return { itemType: 'semi', unit: 'τεμ', makeToOrder: false }
    case 'recipe': return path === 'item' ? { itemType: 'finished', unit: 'τεμ', makeToOrder: true } : { itemType: 'raw', unit: 'kg', makeToOrder: false }
    default: return { itemType: 'raw', unit: 'kg', makeToOrder: false }
  }
}

// ---------------------------------------------------------------------
// Επιλογή είδους / συναλλασσόμενου για μια φράση που ακούστηκε
// ---------------------------------------------------------------------
function RefField({ label, slot, types, role, newItemDefaults: nd, needPrice, env, onPick, picked, remember, onRemember, onCreated }: {
  label: string
  /** νέο έτοιμο προϊόν χωρίς τιμή δεν επιτρέπεται (π.χ. στον μετρητή: θα γραφόταν 0 €) */
  needPrice: boolean
  /** το διάλεξε ο χρήστης (δείχνουμε τι ακούστηκε) */
  picked: boolean
  slot: RefSlot
  types?: ItemType[]
  role: 'customer' | 'supplier' | 'any'
  newItemDefaults: { itemType: ItemType; unit: string; makeToOrder: boolean }
  env: () => ExecEnv
  onPick: (ref: EntityRef) => void
  /** null = να μη φανεί το "να το θυμάμαι" */
  remember: boolean | null
  onRemember: (v: boolean) => void
  onCreated: (label: string, table: 'item' | 'partner', id: string) => void
}) {
  const { itemById, partnerById } = useMaster()
  const toast = useToast()
  const { ref, kind } = slot
  const [mode, setMode] = useState<'idle' | 'other' | 'new' | 'chips'>('idle')
  const [busy, setBusy] = useState(false)
  // φόρμα νέου
  const [name, setName] = useState(suggestName(ref.heard, kind))
  const [itemType, setItemType] = useState<ItemType>(nd.itemType)
  const [unit, setUnit] = useState(nd.unit)
  const [mto, setMto] = useState(nd.makeToOrder)
  const [vat, setVat] = useState(13)
  // τιμή όπως τη γράφει ο χρήστης: με ΦΠΑ για λιανική (κατά παραγγελία), χωρίς για τα άλλα
  const [price, setPrice] = useState<number | null>(null)
  const isFinished = kind === 'item' && itemType === 'finished'
  const priceGross = isFinished && mto
  const netPrice = price == null || !(price >= 0) ? null : priceGross ? round(price / (1 + vat / 100), 4) : price
  const priceMissing = isFinished && needPrice && !(netPrice != null && netPrice > 0)
  const [isCustomer, setIsCustomer] = useState(role !== 'supplier')
  const [isSupplier, setIsSupplier] = useState(role === 'supplier')

  const nameOf = (id: string) => (kind === 'item' ? itemById.get(id)?.name : partnerById.get(id)?.name) ?? '?'
  const cands = ref.candidates.slice(0, 4)
  const close = cands.length > 1 && cands[1].score >= cands[0].score - 0.12
  const showChips = mode === 'chips' || ref.id == null || close
  const entity = ref.id ? (kind === 'item' ? itemById.get(ref.id) : partnerById.get(ref.id)) : null
  const pick = (id: string) => { onPick({ ...ref, id }); setMode('idle') }

  const create = async () => {
    setBusy(true)
    try {
      if (kind === 'item') {
        const it = await createItem(env(), {
          itemType, name, unit, vatRate: vat, salePrice: isFinished ? netPrice : null,
          makeToOrder: itemType !== 'raw' && mto, packName: null, packQty: null,
        })
        onCreated(`Νέο είδος «${it.name}» (${it.code})`, 'item', it.id)
        pick(it.id)
        if (it.item_type !== 'raw' && it.make_to_order) toast.info(`Το «${it.name}» θέλει συνταγή πριν καταχωρηθεί πώληση.`)
        else if (it.item_type === 'finished' && !(Number(it.sale_price) > 0)) toast.info(`Το «${it.name}» δεν έχει τιμή πώλησης: βάλε τιμή στα Είδη.`)
      } else {
        const p = await createPartner(env(), { name, isCustomer, isSupplier, phone: null, vatNo: null, city: null })
        onCreated(`Νέος συναλλασσόμενος «${p.name}» (${p.code})`, 'partner', p.id)
        pick(p.id)
      }
    } catch (e) {
      toast.err(voiceError(e).message)
    } finally { setBusy(false) }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-xs font-medium text-stone-500">{label}</span>
        {entity ? (
          <>
            <span className="font-semibold">{entity.name}</span>
            {picked && normText(entity.name) !== normText(ref.heard) && ref.heard && <span className="text-xs text-stone-500">(για «{ref.heard}»)</span>}
            {!showChips && mode === 'idle' && (
              <button type="button" className="text-sm text-red-700 underline underline-offset-2 px-3 min-h-[44px] -my-2" onClick={() => setMode('chips')}>αλλαγή</button>
            )}
          </>
        ) : (
          <span className="text-sm text-red-700">«{ref.heard || '…'}»: διάλεξε</span>
        )}
      </div>

      {showChips && (
        <div className="flex gap-2 flex-wrap">
          {cands.map((c) => (
            <Chip key={c.id} active={c.id === ref.id} onClick={() => pick(c.id)} title={`${Math.round(c.score * 100)}%`}>{nameOf(c.id) !== '?' ? nameOf(c.id) : c.name}</Chip>
          ))}
          <Chip active={mode === 'other'} onClick={() => setMode(mode === 'other' ? 'idle' : 'other')}>Άλλο…</Chip>
          <Chip active={mode === 'new'} onClick={() => setMode(mode === 'new' ? 'idle' : 'new')}>{kind === 'item' ? 'Νέο είδος…' : 'Νέος…'}</Chip>
        </div>
      )}

      {mode === 'other' && (
        kind === 'item'
          ? <ItemPicker value={ref.id} types={types} onChange={(id) => id && pick(id)} autoFocus placeholder="Αναζήτηση είδους..." />
          : <PartnerPicker value={ref.id} kind={role} onChange={(id) => id && pick(id)} placeholder="Αναζήτηση..." />
      )}

      {mode === 'new' && (
        <div className="rounded-md border border-stone-200 bg-stone-50 p-2 flex flex-col gap-2">
          <input className="input h-11 text-base" value={name} onChange={(e) => setName(e.target.value)} placeholder="Όνομα" aria-label="Όνομα"
            autoFocus onFocus={(e) => e.target.select()} />
          <div className="text-xs text-stone-500 -mt-1">
            Γράψε το όνομα όπως θες να φαίνεται {kind === 'item' ? '(π.χ. «Μαργαρίτα», όχι «μαργαρίτες»)' : '(π.χ. «Γιώργος Παπαδάκης»)'}.
          </div>
          {kind === 'item' ? (
            <div className="flex gap-2 flex-wrap items-center">
              <select className="input h-11 w-auto" value={itemType} aria-label="Τύπος" onChange={(e) => {
                const t = e.target.value as ItemType
                setItemType(t); setUnit(t === 'raw' ? 'kg' : 'τεμ')
              }}>
                {(['raw', 'semi', 'finished'] as ItemType[]).filter((t) => !types || types.includes(t)).map((t) => <option key={t} value={t}>{ITEM_TYPE_LABEL[t]}</option>)}
              </select>
              <select className="input h-11 w-auto" value={unit} aria-label="Μονάδα" onChange={(e) => setUnit(e.target.value)}>
                {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
              {itemType !== 'raw' && (
                <label className="text-sm flex items-center gap-2 min-h-[44px]">
                  <input type="checkbox" className="h-5 w-5" checked={mto} onChange={(e) => setMto(e.target.checked)} />
                  {itemType === 'finished' ? 'Κατά παραγγελία' : 'Γίνεται αυτόματα'}
                </label>
              )}
              {isFinished && (
                <div className="flex gap-2 items-center flex-wrap w-full">
                  <NumField value={price} onChange={setPrice} suffix="€" label={priceGross ? 'Τιμή με ΦΠΑ' : 'Τιμή χωρίς ΦΠΑ'}
                    placeholder={priceGross ? 'τιμή με ΦΠΑ' : 'τιμή χ. ΦΠΑ'} className="w-36" />
                  <select className="input h-11 w-auto" value={vat} aria-label="ΦΠΑ" onChange={(e) => setVat(Number(e.target.value))}>
                    {VAT_RATES.map((v) => <option key={v} value={v}>ΦΠΑ {v}%</option>)}
                  </select>
                  {priceGross && netPrice != null && <span className="text-xs text-stone-500">= {fmtCost(netPrice)} χωρίς ΦΠΑ</span>}
                </div>
              )}
              {priceMissing && <div className="text-xs text-red-700 w-full">Βάλε τιμή: αλλιώς η πώληση γράφεται 0 €.</div>}
            </div>
          ) : (
            <div className="flex gap-4 text-sm">
              <label className="flex items-center gap-2 min-h-[44px]"><input type="checkbox" className="h-5 w-5" checked={isCustomer} onChange={(e) => setIsCustomer(e.target.checked)} /> Πελάτης</label>
              <label className="flex items-center gap-2 min-h-[44px]"><input type="checkbox" className="h-5 w-5" checked={isSupplier} onChange={(e) => setIsSupplier(e.target.checked)} /> Προμηθευτής</label>
            </div>
          )}
          <div className="flex gap-2">
            <button type="button" className="btn-secondary h-11 flex-1" onClick={() => setMode('idle')} disabled={busy}>Πίσω</button>
            <button type="button" className="btn-primary h-11 flex-[2]" onClick={create} disabled={busy || !name.trim() || priceMissing || (kind === 'partner' && !isCustomer && !isSupplier)}>
              {busy ? 'Δημιουργία…' : 'Δημιουργία'}
            </button>
          </div>
        </div>
      )}

      {remember !== null && (
        <label className="text-sm flex items-center gap-2 text-stone-700 min-h-[44px]">
          <input type="checkbox" className="h-5 w-5" checked={remember} onChange={(e) => onRemember(e.target.checked)} />
          Να το θυμάμαι ως «{ref.heard}»
        </label>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------
// Λεπτομέρειες ανά είδος εντολής (επεξεργάσιμες)
// ---------------------------------------------------------------------
function Editor({ pending, running, lastUndo, itemById, salePriceOf, setChannel, updCmd, setLine, removeLine, refField }: {
  pending: Pending
  running: RunningState | null
  lastUndo: LogEntry | null
  itemById: Map<string, Item>
  /** τιμή χονδρικής (πελάτη ή γενική) για γραμμή χωρίς ειπωμένη τιμή */
  salePriceOf: (itemId: string) => SalePrice | undefined
  setChannel: (c: TallyChannel) => void
  updCmd: (f: (c: Command) => Command, edited?: string) => void
  setLine: (i: number, patch: Partial<QtyLine> & { unitPrice?: number | null }) => void
  removeLine: (i: number) => void
  refField: (path: string, label: string) => ReactNode
}) {
  const c = pending.cmd
  const unitOf = (r: EntityRef) => (r.id ? itemById.get(r.id)?.unit : null) ?? 'τεμ'
  const nameOf = (r: EntityRef) => (r.id ? itemById.get(r.id)?.name : null) ?? r.heard

  /** η τιμή που θα μπει όταν το πεδίο μείνει κενό */
  const pricePlaceholder = (kind: 'sale' | 'purchase', it: Item | null | undefined) => {
    if (!it) return kind === 'sale' ? 'τιμή πελάτη' : 'τιμή'
    if (kind === 'purchase') return Number(it.avg_cost) > 0 ? `μέσο ${numText(Number(it.avg_cost))}` : 'γράψε τιμή'
    const sp = salePriceOf(it.id)
    if (!sp) return 'τιμή πελάτη'
    return sp.price > 0 ? `${numText(sp.price)} (${sp.partner ? 'πελάτη' : 'γενική'})` : 'γράψε τιμή'
  }

  const lines = (opts: { price?: 'sale' | 'purchase'; label: string; negative?: boolean }) => hasLines(c) && (
    <div className="flex flex-col gap-2">
      {c.lines.map((l, i) => {
        const it = l.item.id ? itemById.get(l.item.id) : null
        const price = 'unitPrice' in l ? (l as { unitPrice: number | null }).unitPrice : null
        const removing = !!opts.negative && l.qty < 0
        return (
          <div key={pending.lineKeys[i] ?? i} className={'rounded-md border p-2 flex flex-col gap-2 ' + (removing ? 'border-red-300 bg-red-50/40' : 'border-stone-200')}>
            <div className="flex items-start gap-2">
              <div className="flex-1 min-w-0">{refField(`lines.${i}.item`, removing ? 'Αφαίρεση' : opts.label)}</div>
              <button type="button" className="btn-ghost h-11 w-11 p-0 shrink-0" aria-label="Αφαίρεση γραμμής" onClick={() => removeLine(i)}>✕</button>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <QtyInput value={l.qty} unit={unitOf(l.item)} label={nameOf(l.item)} allowNegative={opts.negative} onChange={(v) => setLine(i, { qty: v })}
                blank={l.qty === 0 && !l.heardQty?.trim() && !pending.edited[`lines.${i}.qty`]} />
              {removing && <span className="text-xs font-medium text-red-700">{l.qty === -1 ? 'βγαίνει' : 'βγαίνουν'} από τον μετρητή</span>}
              {/* "10 σακιά", "μισό κιλό": δείχνουμε τι ακούστηκε όταν έγινε μετατροπή */}
              {showHeardQty(l.heardQty) && <span className="text-xs text-stone-500">({l.heardQty})</span>}
              {opts.price && (
                <NumField
                  value={price}
                  onChange={(v) => setLine(i, { unitPrice: v })}
                  suffix={`€/${unitOf(l.item)}`}
                  label={`Τιμή ${nameOf(l.item)}`}
                  className="w-44"
                  placeholder={pricePlaceholder(opts.price, it)}
                />
              )}
            </div>
          </div>
        )
      })}
    </div>
  )

  switch (c.kind) {
    case 'sale_tally':
      return (
        <>
          <div>
            <div className="text-xs font-medium text-stone-500 mb-1">Κανάλι{!c.channelHeard && ' (προεπιλογή)'}</div>
            <div className="flex gap-2 flex-wrap">
              {TALLY_CHANNELS.map((ch) => <Chip key={ch} active={ch === c.channel} onClick={() => setChannel(ch)}>{CHANNEL_LABEL[ch]}</Chip>)}
            </div>
          </div>
          {lines({ label: 'Προϊόν', negative: true })}
        </>
      )
    case 'sale':
      return <>{refField('partner', 'Πελάτης')}{lines({ price: 'sale', label: 'Προϊόν' })}<p className="text-xs text-stone-500">Τιμές χωρίς ΦΠΑ. Κενό = η τιμή που φαίνεται (πελάτη ή γενική).</p></>
    case 'purchase':
      return (
        <>
          {refField('partner', 'Προμηθευτής')}
          <label className="flex items-center gap-2 text-sm">
            <span className="text-xs font-medium text-stone-500 shrink-0">Αρ. τιμολογίου</span>
            <input className="input h-11 text-base" value={c.refNo ?? ''} onChange={(e) => updCmd((x) => (x.kind === 'purchase' ? { ...x, refNo: e.target.value || null } : x))} />
          </label>
          {lines({ price: 'purchase', label: 'Είδος' })}
          <p className="text-xs text-stone-500">Τιμές ανά μονάδα, χωρίς ΦΠΑ. Κενό = μέσο κόστος.</p>
        </>
      )
    case 'production':
      return (
        <>
          {refField('item', 'Προϊόν')}
          <QtyInput value={c.qty} unit={unitOf(c.item)} label={nameOf(c.item)} onChange={(v) => updCmd((x) => (x.kind === 'production' ? { ...x, qty: v } : x), 'qty')} />
          <p className="text-xs text-stone-500">Τα υλικά βγαίνουν από τη συνταγή.</p>
        </>
      )
    case 'stocktake': {
      const d = stocktakeDate(running?.stocktake ?? null, today())
      return (
        <>
          {lines({ label: 'Είδος' })}
          <p className="text-xs text-stone-500">
            Μπαίνουν στην απογραφή σε εξέλιξη {d === today() ? 'της ημέρας' : `της ${fmtDate(d)} (συνεχίζει από χθες)`}. Καταχωρείται με «τέλος απογραφής».
          </p>
        </>
      )
    }
    case 'receipt':
    case 'payment':
      return (
        <>
          {refField('partner', c.kind === 'receipt' ? 'Από πελάτη' : 'Σε προμηθευτή')}
          <NumField value={c.amount} onChange={(v) => updCmd((x) => (x.kind === 'receipt' || x.kind === 'payment' ? { ...x, amount: v ?? 0 } : x), 'amount')} suffix="€" label="Ποσό" className="w-40" />
        </>
      )
    case 'recipe':
      return (
        <>
          {refField('item', 'Προϊόν')}
          <div className="flex items-center gap-2 text-sm">
            <span className="text-xs font-medium text-stone-500">Για</span>
            <NumField value={c.outputQty} onChange={(v) => updCmd((x) => (x.kind === 'recipe' ? { ...x, outputQty: v ?? 0 } : x), 'outputQty')} suffix={unitOf(c.item)} label="Ποσότητα συνταγής" className="w-32" />
          </div>
          {lines({ label: 'Υλικό' })}
          <p className="text-xs text-stone-500">Αντικαθιστά την τωρινή συνταγή.</p>
        </>
      )
    case 'item_price': {
      const it = c.item.id ? itemById.get(c.item.id) : null
      const vat = Number(it?.vat_rate ?? 13)
      return (
        <>
          {refField('item', 'Προϊόν')}
          <div className="flex items-center gap-2 flex-wrap">
            <NumField value={c.netPrice} onChange={(v) => updCmd((x) => (x.kind === 'item_price' ? { ...x, netPrice: v ?? 0 } : x), 'netPrice')} suffix="€" label="Χωρίς ΦΠΑ" className="w-32" />
            <span className="text-xs text-stone-500">χωρίς ΦΠΑ =</span>
            <NumField value={round(c.netPrice * (1 + vat / 100), 2)} onChange={(v) => updCmd((x) => (x.kind === 'item_price' ? { ...x, netPrice: round((v ?? 0) / (1 + vat / 100), 4) } : x), 'netPrice')} suffix="€" label="Με ΦΠΑ" className="w-32" />
            <span className="text-xs text-stone-500">με ΦΠΑ {vat}%</span>
          </div>
        </>
      )
    }
    case 'partner_price':
      return (
        <>
          {refField('partner', 'Πελάτης')}
          {refField('item', 'Προϊόν')}
          <div className="flex items-center gap-2">
            <NumField value={c.netPrice} onChange={(v) => updCmd((x) => (x.kind === 'partner_price' ? { ...x, netPrice: v ?? 0 } : x), 'netPrice')} suffix="€" label="Τιμή" className="w-32" />
            <span className="text-xs text-stone-500">χωρίς ΦΠΑ</span>
          </div>
        </>
      )
    case 'new_item': {
      const set = (patch: Partial<Extract<Command, { kind: 'new_item' }>>) => updCmd((x) => (x.kind === 'new_item' ? { ...x, ...patch } : x))
      return (
        <div className="grid grid-cols-2 gap-2">
          <input className="input h-11 text-base col-span-2" value={c.name} onChange={(e) => set({ name: e.target.value })} placeholder="Όνομα" aria-label="Όνομα" />
          <select className="input h-11" value={c.itemType} aria-label="Τύπος" onChange={(e) => {
            const t = e.target.value as ItemType
            set({ itemType: t, unit: t === 'raw' ? (c.unit === 'τεμ' ? 'kg' : c.unit) : 'τεμ', makeToOrder: t === 'raw' ? false : c.makeToOrder })
          }}>
            {(['raw', 'semi', 'finished'] as ItemType[]).map((t) => <option key={t} value={t}>{ITEM_TYPE_LABEL[t]}</option>)}
          </select>
          <select className="input h-11" value={c.unit} aria-label="Μονάδα" onChange={(e) => set({ unit: e.target.value })}>
            {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
          </select>
          <select className="input h-11" value={c.vatRate} aria-label="ΦΠΑ" onChange={(e) => set({ vatRate: Number(e.target.value) })}>
            {VAT_RATES.map((v) => <option key={v} value={v}>ΦΠΑ {v}%</option>)}
          </select>
          {c.itemType === 'finished' && (
            <>
              <NumField value={c.salePrice} onChange={(v) => set({ salePrice: v })} suffix="€" label="Τιμή χωρίς ΦΠΑ" placeholder="τιμή χ. ΦΠΑ" />
              <NumField value={c.salePrice == null ? null : round(c.salePrice * (1 + c.vatRate / 100), 2)}
                onChange={(v) => set({ salePrice: v == null ? null : round(v / (1 + c.vatRate / 100), 4) })}
                suffix="€" label="Τιμή με ΦΠΑ" placeholder="με ΦΠΑ" />
            </>
          )}
          {c.itemType !== 'raw' && (
            <label className="col-span-2 text-sm flex items-center gap-2">
              <input type="checkbox" className="h-5 w-5" checked={c.makeToOrder} onChange={(e) => set({ makeToOrder: e.target.checked })} />
              {c.itemType === 'finished' ? 'Φτιάχνεται κατά παραγγελία (λιανική)' : 'Φτιάχνεται αυτόματα όταν χρειάζεται'}
            </label>
          )}
          {c.itemType === 'raw' && (
            <>
              <input className="input h-11" value={c.packName ?? ''} onChange={(e) => set({ packName: e.target.value || null })} placeholder="Συσκευασία (π.χ. σακί)" aria-label="Συσκευασία" />
              <NumField value={c.packQty} onChange={(v) => set({ packQty: v })} suffix={c.unit} label="Ποσότητα συσκευασίας" placeholder="ανά συσκ." />
            </>
          )}
          {c.itemType === 'finished' && !(c.salePrice != null && c.salePrice > 0) && (
            <div className="col-span-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-2 py-1">
              Χωρίς τιμή πώλησης: δεν θα μπορεί να μπει στις πωλήσεις ημέρας μέχρι να βάλεις τιμή.
            </div>
          )}
        </div>
      )
    }
    case 'new_partner': {
      const set = (patch: Partial<Extract<Command, { kind: 'new_partner' }>>) => updCmd((x) => (x.kind === 'new_partner' ? { ...x, ...patch } : x))
      return (
        <div className="grid grid-cols-2 gap-2">
          <input className="input h-11 text-base col-span-2" value={c.name} onChange={(e) => set({ name: e.target.value })} placeholder="Όνομα" aria-label="Όνομα" />
          <label className="text-sm flex items-center gap-2"><input type="checkbox" className="h-5 w-5" checked={c.isCustomer} onChange={(e) => set({ isCustomer: e.target.checked })} /> Πελάτης</label>
          <label className="text-sm flex items-center gap-2"><input type="checkbox" className="h-5 w-5" checked={c.isSupplier} onChange={(e) => set({ isSupplier: e.target.checked })} /> Προμηθευτής</label>
          <input className="input h-11" inputMode="tel" value={c.phone ?? ''} onChange={(e) => set({ phone: e.target.value || null })} placeholder="Τηλέφωνο" aria-label="Τηλέφωνο" />
          <input className="input h-11" inputMode="numeric" value={c.vatNo ?? ''} onChange={(e) => set({ vatNo: e.target.value || null })} placeholder="ΑΦΜ" aria-label="ΑΦΜ" />
          <input className="input h-11 col-span-2" value={c.city ?? ''} onChange={(e) => set({ city: e.target.value || null })} placeholder="Πόλη" aria-label="Πόλη" />
        </div>
      )
    }
    case 'close_day': {
      const all = running ? [...running.older, ...running.tally] : []
      return all.length > 0 ? (
        <div className="text-sm">
          Θα καταχωρηθούν: {all.map((t) => `${tallyText(t, t.date !== today())} τεμ (${fmtMoney(t.gross)})`).join(', ')}.
          <div className="text-xs text-stone-500 mt-1">Οι πίτσες κατεβαίνουν από την αποθήκη μαζί με τα υλικά τους. Δεν αναιρείται από εδώ.</div>
        </div>
      ) : null
    }
    case 'close_stocktake': {
      const st = running?.stocktake
      if (!running || !st) return null
      const before = [...running.older, ...running.tally].filter((t) => t.date <= st.date)
      return (
        <div className="text-sm">
          Απογραφή {docCode('stocktake', st.docNo)}: {st.count} {plural(st.count, 'είδος', 'είδη')} ({fmtDate(st.date)}).
          <div className="text-xs text-stone-500 mt-1">Μετά την καταχώρηση ανοίγει η σελίδα της με τις διαφορές. Δεν αναιρείται από εδώ.</div>
          {before.length > 0 && (
            <div className="mt-2 rounded-md bg-amber-50 border border-amber-200 text-amber-900 text-xs px-2 py-1.5">
              Πρώτα θα καταχωρηθούν οι ανοιχτές πωλήσεις ημέρας έως {fmtDate(st.date)} ({before.map((t) => tallyText(t, t.date !== today())).join(', ')}):
              η απογραφή «κλειδώνει» τις μέρες έως τότε.
            </div>
          )}
          {st.date === today() && (
            <div className="mt-2 rounded-md bg-red-50 border border-red-200 text-red-800 text-xs px-2 py-1.5">
              Η απογραφή είναι με σημερινή ημερομηνία: μετά την καταχώρηση δεν θα μπαίνουν άλλες σημερινές πωλήσεις
              για ό,τι περιέχει τα είδη που μετρήθηκαν. Πες «τέλος απογραφής» όταν κλείσει η βάρδια.
            </div>
          )}
        </div>
      )
    }
    case 'undo':
      return lastUndo ? <div className="text-sm">Θα αναιρεθεί: <b>{lastUndo.message}</b></div> : null
    case 'query_stock':
      return refField('item', 'Είδος')
    case 'query_balance':
      return refField('partner', 'Συναλλασσόμενος')
    default:
      return null
  }
}
