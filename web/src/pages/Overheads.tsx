import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useCompanyId } from '../context/CompanyContext'
import { errMsg, supabase } from '../lib/supabase'
import { fmtMoney, round, toNum } from '../lib/format'
import { addMonths, monthAcc, monthKey, monthLabel, OVERHEAD_CATEGORIES, parseOverheadVoice } from '../lib/overhead'
import { cancelSpeech, speak, useSpeechRecognition } from '../lib/voice/speech'
import { ErrorBox, MicIcon, NumInput, PageTitle, Spinner, useToast } from '../components/ui'

/**
 * Γενικά έξοδα του μήνα (0008): ένα ποσό ανά κατηγορία, γράφεται μόλις
 * φύγεις από το κουτί (ή με φωνή: «ρεύμα 320»). Μόνο ο ιδιοκτήτης.
 */

interface Row { id: string; category: string; amount: number }

export function Overheads() {
  const companyId = useCompanyId()
  const toast = useToast()
  const [month, setMonth] = useState(monthKey)
  const [rows, setRows] = useState<Row[] | null | 'missing' | 'denied'>(null)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [newAmount, setNewAmount] = useState('')
  const [typed, setTyped] = useState('')
  const [heard, setHeard] = useState<{ ok: boolean; text: string } | null>(null)
  const sr = useSpeechRecognition()

  const load = useCallback(async () => {
    if (!companyId) return
    const { data: owner } = await supabase.rpc('is_owner', { p_company: companyId })
    if (owner === false) { setRows('denied'); return }
    const { data, error: e } = await supabase.from('overhead').select('id, category, amount').eq('company_id', companyId).eq('month', month)
    if (e) {
      if (e.code === 'PGRST205' || e.code === '42P01' || /overhead/.test(e.message)) { setRows('missing'); return }
      setError(errMsg(e)); return
    }
    const list = ((data ?? []) as Row[]).map((r) => ({ ...r, amount: Number(r.amount) }))
    setRows(list)
    setDraft(Object.fromEntries(list.map((r) => [r.category, String(r.amount)])))
    setError(null)
  }, [companyId, month])
  useEffect(() => { setRows(null); load() }, [load])

  const list = Array.isArray(rows) ? rows : []
  const extra = list.filter((r) => !OVERHEAD_CATEGORIES.some((c) => c.name === r.category))
  const total = round(list.reduce((s, r) => s + r.amount, 0))

  /** γράφει (ή σβήνει με κενό) το ποσό μιας κατηγορίας */
  const save = async (category: string, raw: string): Promise<boolean> => {
    const had = list.find((r) => r.category === category)
    const v = raw.trim() === '' ? null : round(toNum(raw))
    if (v === null && !had) return true
    if (v !== null && had && had.amount === v) return true
    const q = v === null
      ? supabase.from('overhead').delete().eq('company_id', companyId).eq('month', month).eq('category', category)
      : supabase.from('overhead').upsert({ company_id: companyId, month, category, amount: v }, { onConflict: 'company_id,month,category' })
    const { error: e } = await q
    if (e) { toast.err(errMsg(e)); return false }
    setSaved(category)
    window.setTimeout(() => setSaved((s) => (s === category ? null : s)), 2000)
    await load()
    return true
  }

  const copyLast = async () => {
    const prev = addMonths(month, -1)
    const { data, error: e } = await supabase.from('overhead').select('category, amount').eq('company_id', companyId).eq('month', prev)
    if (e) { toast.err(errMsg(e)); return }
    const have = new Set(list.map((r) => r.category))
    const add = ((data ?? []) as { category: string; amount: number }[]).filter((r) => !have.has(r.category))
    if (add.length === 0) { toast.ok(`Τίποτα να φέρω από τον ${monthAcc(prev)}.`); return }
    const { error: e2 } = await supabase.from('overhead').insert(add.map((r) => ({ company_id: companyId, month, category: r.category, amount: r.amount })))
    if (e2) { toast.err(errMsg(e2)); return }
    toast.ok(`Ήρθαν ${add.length} ποσά από τον ${monthAcc(prev)}. Άλλαξε όσα διαφέρουν.`)
    load()
  }

  const addOther = async (e: FormEvent) => {
    e.preventDefault()
    const name = newName.trim()
    if (!name || newAmount.trim() === '') return
    if (await save(name, newAmount)) { setNewName(''); setNewAmount('') }
  }

  const onVoice = async (text: string) => {
    const c = parseOverheadVoice(text)
    if (!c) {
      const m = `«${text}»: δεν κατάλαβα. Πες π.χ. «ρεύμα 320» ή «μισθοί δύο χιλιάδες».`
      setHeard({ ok: false, text: m })
      void speak('Δεν κατάλαβα. Πες για παράδειγμα, ρεύμα τριακόσια είκοσι.')
      return
    }
    setDraft((d) => ({ ...d, [c.category]: String(c.amount) }))
    if (await save(c.category, String(c.amount))) {
      const m = `${c.category}: ${fmtMoney(c.amount)} για τον ${monthAcc(month)}.`
      setHeard({ ok: true, text: m })
      void speak(m)
    }
  }
  const listen = () => { cancelSpeech(); sr.start({ onFinal: (t) => { void onVoice(t) } }) }

  const months = useMemo(() => [addMonths(monthKey(), -2), addMonths(monthKey(), -1), monthKey()], [])

  if (rows === null && !error) return <Spinner />
  if (rows === 'missing') {
    return <div><PageTitle title="Γενικά έξοδα" /><div className="card p-4 text-sm">Η βάση δεν έχει ακόμα τα γενικά έξοδα. Χρειάζεται το <code>supabase/migrations/0008_overhead.sql</code> (βλ. README).</div></div>
  }
  if (rows === 'denied') {
    return <div><PageTitle title="Γενικά έξοδα" /><div className="card p-4 text-sm">Τα γενικά έξοδα (μαζί με τους μισθούς) τα βλέπει μόνο ο ιδιοκτήτης.</div></div>
  }

  return (
    <div className="max-w-3xl">
      <PageTitle title="Γενικά έξοδα">
        <Link to="/reports/profit" className="btn-secondary">Κέρδος του μήνα</Link>
      </PageTitle>
      <ErrorBox text={error} />

      <div className="card p-3 mb-3 flex flex-wrap items-center gap-2">
        <button className="btn-secondary h-11 w-11 p-0 text-lg" onClick={() => setMonth(addMonths(month, -1))} aria-label="Προηγούμενος μήνας">‹</button>
        <div className="text-lg font-semibold min-w-[11rem] text-center">{monthLabel(month)}</div>
        <button className="btn-secondary h-11 w-11 p-0 text-lg" onClick={() => setMonth(addMonths(month, 1))} aria-label="Επόμενος μήνας" disabled={month >= monthKey()}>›</button>
        <div className="flex gap-1 ml-auto">
          {months.map((m) => (
            <button key={m} className={m === month ? 'btn-primary' : 'btn-ghost'} onClick={() => setMonth(m)}>{monthLabel(m).split(' ')[0]}</button>
          ))}
        </div>
      </div>

      {/* Φωνή */}
      <div className="card p-3 mb-3 flex flex-wrap items-center gap-3">
        <button className={'h-14 w-14 shrink-0 rounded-full text-white flex items-center justify-center ' + (sr.listening ? 'bg-red-900 animate-pulse' : 'bg-red-700')}
          onClick={() => (sr.listening ? sr.stop() : listen())} aria-label={sr.listening ? 'Σταμάτα' : 'Πες το'}>
          <MicIcon className="h-7 w-7" />
        </button>
        <div className="flex-1 min-w-[12rem] text-sm">
          {sr.listening ? <div>{sr.interim || 'Σε ακούω…'}</div>
            : heard ? <div className={heard.ok ? 'text-emerald-800 font-medium' : 'text-red-800'}>{heard.text}</div>
            : <div className="text-stone-500">Πες «ρεύμα 320», «ενοίκιο 800», «μισθοί δύο χιλιάδες τετρακόσια».</div>}
          {sr.error && <div className="text-red-800">{sr.error}</div>}
        </div>
        <form className="w-full sm:w-auto flex gap-2" onSubmit={(e) => { e.preventDefault(); const t = typed; setTyped(''); if (t.trim()) void onVoice(t) }}>
          <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="ή γράψε: ρεύμα 320" aria-label="Εντολή" />
          <button className="btn-secondary" disabled={!typed.trim()}>OK</button>
        </form>
      </div>

      <div className="card divide-y divide-stone-100">
        {[...OVERHEAD_CATEGORIES.map((c) => ({ name: c.name, hint: c.hint })), ...extra.map((r) => ({ name: r.category, hint: undefined }))].map((c) => (
          <label key={c.name} className="flex items-center gap-3 p-3">
            <span className="flex-1 min-w-0">
              <span className="block font-medium">{c.name}</span>
              {c.hint && <span className="block text-xs text-stone-500">{c.hint}</span>}
            </span>
            {saved === c.name && <span className="text-xs text-emerald-700">✓ γράφτηκε</span>}
            <span className="w-36">
              <NumInput value={draft[c.name] ?? ''} min={0} placeholder="—" label={`${c.name} (€)`}
                onChange={(v) => setDraft((d) => ({ ...d, [c.name]: v }))}
                onBlur={() => { void save(c.name, draft[c.name] ?? '') }} />
            </span>
          </label>
        ))}
        <form onSubmit={addOther} className="flex flex-wrap items-center gap-2 p-3">
          <input className="input flex-1 min-w-[10rem]" maxLength={40} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Άλλο έξοδο (π.χ. Ασφάλεια)" aria-label="Όνομα άλλου εξόδου" />
          <span className="w-36"><NumInput value={newAmount} onChange={setNewAmount} min={0} placeholder="ποσό" /></span>
          <button className="btn-secondary" disabled={!newName.trim() || newAmount.trim() === ''}>Πρόσθεσε</button>
        </form>
        <div className="flex justify-between p-3 text-base font-semibold">
          <span>Σύνολο του μήνα</span><span className="tabular-nums">{fmtMoney(total)}</span>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 mt-3">
        <button className="btn-secondary" onClick={copyLast}>Ίδια ποσά με τον {monthAcc(addMonths(month, -1))}</button>
      </div>
      <p className="text-xs text-stone-500 mt-3">
        Ποσά χωρίς ΦΠΑ. Γράφονται μόλις βγεις από το κουτί· κενό = σβήνει. Τα υλικά των συνταγών (αλεύρι, μοτσαρέλα, κουτιά) δεν μπαίνουν εδώ:
        μετράνε ήδη από τις αγορές. Το «Κέρδος του μήνα» τα μοιράζει στα είδη που πουλήθηκαν.
      </p>
    </div>
  )
}

