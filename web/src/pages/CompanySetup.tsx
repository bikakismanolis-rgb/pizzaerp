import { useState, type FormEvent } from 'react'
import { useAuth } from '../context/AuthContext'
import { useCompany } from '../context/CompanyContext'
import { errMsg } from '../lib/supabase'
import { ErrorBox, Field } from '../components/ui'

/** Πρώτη είσοδος: δημιουργία εταιρείας */
export function CompanySetup() {
  const { create } = useCompany()
  const { signOut, user } = useAuth()
  const [name, setName] = useState('')
  const [vat, setVat] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await create(name.trim(), vat.trim() || undefined)
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
        <div className="text-sm text-stone-500 mb-5">Καλωσήρθες, {user?.email}. Ας φτιάξουμε την επιχείρησή σου.</div>
        <ErrorBox text={error} />
        <Field label="Επωνυμία επιχείρησης" className="mb-3">
          <input className="input" required value={name} onChange={(e) => setName(e.target.value)} placeholder="π.χ. Πιτσαρία Μαρία" autoFocus />
        </Field>
        <Field label="ΑΦΜ (προαιρετικό)" className="mb-4">
          <input className="input" value={vat} onChange={(e) => setVat(e.target.value)} />
        </Field>
        <button className="btn-primary w-full" disabled={busy || !name.trim()}>Δημιουργία</button>
        <button type="button" className="btn-ghost w-full mt-2" onClick={signOut}>Αποσύνδεση</button>
      </form>
    </div>
  )
}
