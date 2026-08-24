import { useState, type FormEvent } from 'react'
import { useAuth } from '../context/AuthContext'
import { errMsg } from '../lib/supabase'
import { ErrorBox, Field } from '../components/ui'

export function Login() {
  const { signIn, signUp } = useAuth()
  const [mode, setMode] = useState<'in' | 'up'>('in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setInfo(null)
    try {
      if (mode === 'in') {
        await signIn(email.trim(), password)
      } else {
        const r = await signUp(email.trim(), password)
        if (r.needsConfirm) setInfo('Στάλθηκε email επιβεβαίωσης. Επιβεβαίωσε τον λογαριασμό και μετά συνδέσου.')
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
        <div className="text-sm text-stone-500 mb-5">{mode === 'in' ? 'Σύνδεση' : 'Δημιουργία λογαριασμού'}</div>
        <ErrorBox text={error} />
        {info && <div className="rounded-md bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm px-3 py-2 mb-3">{info}</div>}
        <Field label="Email" className="mb-3">
          <input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
        </Field>
        <Field label="Κωδικός" className="mb-4">
          <input className="input" type="password" required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'in' ? 'current-password' : 'new-password'} />
        </Field>
        <button className="btn-primary w-full" disabled={busy}>
          {busy ? 'Παρακαλώ περιμένετε...' : mode === 'in' ? 'Σύνδεση' : 'Εγγραφή'}
        </button>
        <button type="button" className="btn-ghost w-full mt-2" onClick={() => { setMode(mode === 'in' ? 'up' : 'in'); setError(null); setInfo(null) }}>
          {mode === 'in' ? 'Δεν έχω λογαριασμό' : 'Έχω ήδη λογαριασμό'}
        </button>
      </form>
    </div>
  )
}
