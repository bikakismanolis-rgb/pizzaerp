import { useState, type FormEvent } from 'react'
import { useAuth } from '../context/AuthContext'
import { errMsg } from '../lib/supabase'
import { ErrorBox, Field } from '../components/ui'

type Mode = 'in' | 'up' | 'forgot'

const TITLE: Record<Mode, string> = {
  in: 'Σύνδεση',
  up: 'Νέος λογαριασμός',
  forgot: 'Ξέχασα τον κωδικό',
}

/**
 * Σύνδεση, νέος λογαριασμός (και για νέο υπάλληλο: μετά γράφει τον κωδικό
 * του μαγαζιού), και «Ξέχασα τον κωδικό» με email.
 */
export function Login() {
  const { signIn, signUp, sendReset } = useAuth()
  const [mode, setMode] = useState<Mode>('in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  const go = (m: Mode) => { setMode(m); setError(null); setInfo(null) }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setInfo(null)
    try {
      if (mode === 'in') {
        await signIn(email.trim(), password)
      } else if (mode === 'up') {
        const r = await signUp(email.trim(), password)
        if (r.needsConfirm) setInfo('Σου στείλαμε email. Άνοιξέ το (δες και στα ανεπιθύμητα), πάτα τον σύνδεσμο, και μετά έλα εδώ και συνδέσου.')
      } else {
        await sendReset(email.trim())
        setInfo('Σου στείλαμε email με σύνδεσμο. Άνοιξέ το (δες και στα ανεπιθύμητα) και πάτα τον σύνδεσμο για να βάλεις νέο κωδικό.')
      }
    } catch (err) {
      setError(errMsg(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <form onSubmit={submit} className="card w-full max-w-sm p-6">
        <div className="text-2xl font-bold text-red-700 mb-1">🍕 Pizza ERP</div>
        <h1 className="text-lg font-semibold mb-1">{TITLE[mode]}</h1>
        {mode === 'up' && <p className="text-sm text-stone-600 mb-3">Νέος υπάλληλος; Φτιάξε λογαριασμό και μετά γράψε τον κωδικό που σου έδωσε ο ιδιοκτήτης.</p>}
        {mode === 'forgot' && <p className="text-sm text-stone-600 mb-3">Γράψε το email σου και θα σου στείλουμε σύνδεσμο για νέο κωδικό.</p>}
        <ErrorBox text={error} />
        {info && <div className="rounded-md bg-emerald-50 border border-emerald-200 text-emerald-800 text-base px-3 py-2 mb-3">{info}</div>}
        <Field label="Email" className="mb-3">
          <input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" inputMode="email" placeholder="π.χ. maria@gmail.com" />
        </Field>
        {mode !== 'forgot' && (
          <Field label={mode === 'up' ? 'Κωδικός (τουλάχιστον 6 γράμματα ή αριθμοί)' : 'Κωδικός'} className="mb-4">
            <input className="input" type="password" required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'in' ? 'current-password' : 'new-password'} />
          </Field>
        )}
        <button className="btn-primary w-full h-12 text-base" disabled={busy}>
          {busy ? 'Περίμενε…' : mode === 'in' ? 'Μπες' : mode === 'up' ? 'Φτιάξε λογαριασμό' : 'Στείλε μου email'}
        </button>
        <div className="grid gap-1 mt-3">
          {mode !== 'in' && <button type="button" className="btn-ghost w-full" onClick={() => go('in')}>Έχω ήδη λογαριασμό</button>}
          {mode !== 'up' && <button type="button" className="btn-ghost w-full" onClick={() => go('up')}>Δεν έχω λογαριασμό</button>}
          {mode === 'in' && <button type="button" className="btn-ghost w-full" onClick={() => go('forgot')}>Ξέχασα τον κωδικό</button>}
        </div>
      </form>
    </div>
  )
}

/** Ήρθε από το email «Ξέχασα τον κωδικό»: γράφει νέο */
export function NewPassword() {
  const { setNewPassword, signOut } = useAuth()
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (password !== again) { setError('Οι δύο κωδικοί δεν είναι ίδιοι. Γράψ\' τους ξανά.'); return }
    setBusy(true)
    setError(null)
    try { await setNewPassword(password) } catch (err) { setError(errMsg(err)) } finally { setBusy(false) }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <form onSubmit={submit} className="card w-full max-w-sm p-6">
        <div className="text-2xl font-bold text-red-700 mb-1">🍕 Pizza ERP</div>
        <h1 className="text-lg font-semibold mb-3">Νέος κωδικός</h1>
        <ErrorBox text={error} />
        <Field label="Νέος κωδικός (τουλάχιστον 6)" className="mb-3">
          <input className="input" type="password" required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" autoFocus />
        </Field>
        <Field label="Ξανά ο ίδιος" className="mb-4">
          <input className="input" type="password" required minLength={6} value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" />
        </Field>
        <button className="btn-primary w-full h-12 text-base" disabled={busy}>{busy ? 'Περίμενε…' : 'Βάλε τον νέο κωδικό'}</button>
        <button type="button" className="btn-ghost w-full mt-2" onClick={signOut}>Άκυρο</button>
      </form>
    </div>
  )
}
