import { useCallback, useEffect, useState } from 'react'
import { errMsg, supabase } from '../lib/supabase'
import { fmtDateTime } from '../lib/format'
import { useToast } from './ui'

/**
 * Κλειδιά παρόχων (Viva, Stripe, CAPTCHA, παραστατικά). Γράφονται μόνο:
 * ο browser δεν τα ξαναδιαβάζει ποτέ (τα διαβάζουν οι Edge Functions).
 * Εδώ φαίνεται μόνο αν έχουν μπει και πότε.
 */

export type SecretInfo = Record<string, string>

export function useSecretNames(companyId: string) {
  const [names, setNames] = useState<SecretInfo>({})
  const reload = useCallback(async () => {
    if (!companyId) return
    const { data, error } = await supabase.rpc('secret_names', { p_company: companyId })
    if (error) return
    const out: SecretInfo = {}
    for (const r of (data ?? []) as { name: string; updated_at: string }[]) out[r.name] = r.updated_at
    setNames(out)
  }, [companyId])
  useEffect(() => { reload() }, [reload])
  return { names, reload }
}

export function SecretField({ companyId, name, label, help, saved, onSaved, disabled }: {
  companyId: string; name: string; label: string; help?: string; saved?: string; onSaved: () => void; disabled?: boolean
}) {
  const toast = useToast()
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const save = async (v: string | null) => {
    setBusy(true)
    const { error } = await supabase.rpc('secret_set', { p_company: companyId, p_name: name, p_value: v })
    setBusy(false)
    if (error) { toast.err(errMsg(error)); return }
    setValue('')
    toast.ok(v ? 'Αποθηκεύτηκε το κλειδί' : 'Σβήστηκε το κλειδί')
    onSaved()
  }
  return (
    <div>
      <span className="label">{label}</span>
      <div className="flex gap-2">
        <input className="input font-mono" type="password" autoComplete="off" spellCheck={false} value={value} disabled={disabled || busy}
          onChange={(e) => setValue(e.target.value)} placeholder={saved ? '•••••••• (έχει μπει)' : 'επικόλληση εδώ'} aria-label={label} />
        <button type="button" className="btn-secondary" disabled={disabled || busy || !value.trim()} onClick={() => save(value)}>Αποθήκευση</button>
        {saved && <button type="button" className="btn-ghost" disabled={disabled || busy} onClick={() => save(null)} aria-label={`Σβήσε ${label}`}>✕</button>}
      </div>
      <div className="text-xs mt-1">
        {saved ? <span className="text-emerald-800">✓ Έχει μπει ({fmtDateTime(saved)})</span> : <span className="text-stone-500">Δεν έχει μπει.</span>}
        {help && <span className="text-stone-500"> {help}</span>}
      </div>
    </div>
  )
}
