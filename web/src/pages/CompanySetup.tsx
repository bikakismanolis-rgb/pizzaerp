import { useState, type FormEvent } from 'react'
import { useAuth } from '../context/AuthContext'
import { useCompany } from '../context/CompanyContext'
import { errMsg } from '../lib/supabase'
import { joinTeam } from '../lib/team'
import { ErrorBox, Field } from '../components/ui'

const LS_KEY = 'pizza-erp.company'

/**
 * Πρώτη είσοδος χωρίς μαγαζί: ο υπάλληλος γράφει τον κωδικό που του έδωσε
 * ο ιδιοκτήτης· ο ιδιοκτήτης φτιάχνει το μαγαζί του.
 */
export function CompanySetup() {
  const { create, reload } = useCompany()
  const { signOut, user } = useAuth()
  const [mode, setMode] = useState<'join' | 'new'>('join')
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [vat, setVat] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const digits = code.replace(/\D/g, '')

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      if (mode === 'join') {
        const r = await joinTeam(digits)
        try { localStorage.setItem(LS_KEY, r.company_id) } catch { /* ignore */ }
        await reload()
      } else {
        await create(name.trim(), vat.trim() || undefined)
      }
    } catch (err) {
      setError(errMsg(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <form onSubmit={submit} className="card w-full max-w-md p-6">
        <div className="text-2xl font-bold text-red-700 mb-1">🍕 Pizza ERP</div>
        <div className="text-sm text-stone-600 mb-4">Καλωσήρθες, {user?.email}.</div>

        <div className="grid grid-cols-2 gap-2 mb-4" role="radiogroup" aria-label="Τι θέλεις να κάνεις">
          {([
            ['join', 'Δουλεύω σε μαγαζί', 'Έχω κωδικό από τον ιδιοκτήτη'],
            ['new', 'Είμαι ο ιδιοκτήτης', 'Φτιάχνω το μαγαζί μου'],
          ] as const).map(([m, title, help]) => (
            <button key={m} type="button" role="radio" aria-checked={mode === m}
              className={'rounded-md border-2 p-3 text-left ' + (mode === m ? 'border-red-700 bg-red-50' : 'border-stone-200 bg-white')}
              onClick={() => { setMode(m); setError(null) }}>
              <div className="font-semibold">{title}</div>
              <div className="text-sm text-stone-600">{help}</div>
            </button>
          ))}
        </div>

        <ErrorBox text={error} />
        {mode === 'join' ? (
          <>
            <Field label="Ο κωδικός του μαγαζιού (6 αριθμοί)" className="mb-2">
              <input className="input text-center text-2xl tracking-[0.3em] tabular-nums h-14" inputMode="numeric" autoComplete="one-time-code"
                value={code} onChange={(e) => setCode(e.target.value)} placeholder="123 456" maxLength={9} autoFocus aria-label="Κωδικός μαγαζιού" />
            </Field>
            <p className="text-sm text-stone-600 mb-4">Τον βγάζει ο ιδιοκτήτης από το μενού: Περισσότερα → Υπάλληλοι.</p>
            <button className="btn-primary w-full h-12 text-base" disabled={busy || digits.length !== 6}>{busy ? 'Περίμενε…' : 'Μπες στο μαγαζί'}</button>
          </>
        ) : (
          <>
            <Field label="Όνομα μαγαζιού" className="mb-3">
              <input className="input" required value={name} onChange={(e) => setName(e.target.value)} placeholder="π.χ. Πιτσαρία Μαρία" autoFocus />
            </Field>
            <Field label="ΑΦΜ (αν θες, μπαίνει και μετά)" className="mb-4">
              <input className="input" inputMode="numeric" value={vat} onChange={(e) => setVat(e.target.value)} />
            </Field>
            <button className="btn-primary w-full h-12 text-base" disabled={busy || !name.trim()}>{busy ? 'Περίμενε…' : 'Φτιάξε το μαγαζί'}</button>
          </>
        )}
        <button type="button" className="btn-ghost w-full mt-2" onClick={signOut}>Αποσύνδεση</button>
      </form>
    </div>
  )
}
