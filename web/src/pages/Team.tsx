import { useState } from 'react'
import { useCompany, useCompanyId } from '../context/CompanyContext'
import { useLoad } from '../lib/useLoad'
import { supabase } from '../lib/supabase'
import { fmtDate } from '../lib/format'
import { inviteText, loadInvite, loadTeam, newInvite, removeMember, setMemberRole, spacedCode, stopInvite, TEAM_MISSING, type Member } from '../lib/team'
import { Confirm, ErrorBox, PageTitle, Spinner, useToast } from '../components/ui'

const ROLE_LABEL: Record<Member['role'], string> = { owner: 'Ιδιοκτήτης', staff: 'Υπάλληλος' }

/**
 * Υπάλληλοι (0009): ποιοι μπαίνουν στο μαγαζί, και ο κωδικός για νέο
 * υπάλληλο. Ο υπάλληλος δεν βλέπει κέρδος, μισθούς και ρυθμίσεις πληρωμών.
 */
export function Team() {
  const companyId = useCompanyId()
  const { company } = useCompany()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [ask, setAsk] = useState<{ kind: 'remove' | 'owner' | 'staff'; m: Member } | null>(null)

  const data = useLoad(async () => {
    const { data: owner } = await supabase.rpc('is_owner', { p_company: companyId })
    if (owner === false) return 'denied' as const
    const [invite, team] = await Promise.all([loadInvite(companyId), loadTeam(companyId)])
    return { invite, team }
  }, [companyId])

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true)
    try { await fn(); toast.ok(ok) } catch (e) { toast.err(e instanceof Error ? e.message : String(e)) }
    setBusy(false)
    data.reload()
  }

  if (data.data === 'denied') {
    return <div><PageTitle title="Υπάλληλοι" /><div className="card p-4">Τους υπαλλήλους τους βλέπει μόνο ο ιδιοκτήτης.</div></div>
  }
  if (data.loading && !data.data) return <Spinner />
  const d = data.data
  const invite = d?.invite ?? null
  const text = invite ? inviteText(company?.name ?? 'το μαγαζί', invite.code) : ''

  const share = async () => {
    try {
      if (navigator.share) { await navigator.share({ text }); return }
      await navigator.clipboard.writeText(text)
      toast.ok('Αντιγράφηκε: επικόλλησέ το σε Viber, WhatsApp ή SMS.')
    } catch { /* ακύρωσε το μοίρασμα */ }
  }

  return (
    <div className="max-w-3xl">
      <PageTitle title="Υπάλληλοι" />
      <ErrorBox text={data.error === TEAM_MISSING ? TEAM_MISSING : data.error} />

      <div className="card p-4 mb-4">
        <h2 className="text-lg font-semibold mb-1">Νέος υπάλληλος</h2>
        {invite ? (
          <>
            <p className="text-base mb-2">Δώσε του αυτόν τον κωδικό. Φτιάχνει λογαριασμό στην εφαρμογή και τον γράφει.</p>
            <div className="text-5xl font-bold tabular-nums tracking-widest text-center py-3 bg-stone-50 rounded-md border border-stone-200 mb-2" aria-label={`Κωδικός ${invite.code.split('').join(' ')}`}>
              {spacedCode(invite.code)}
            </div>
            <p className="text-sm text-stone-600 mb-3">Ισχύει ως τις {fmtDate(invite.expires_at.slice(0, 10))}, για όσους τον γράψουν ως τότε.</p>
            <div className="flex flex-wrap gap-2">
              <button className="btn-primary h-12 text-base" onClick={share}>📤 Στείλ' το (Viber, WhatsApp, SMS)</button>
              <button className="btn-secondary h-12" disabled={busy} onClick={() => run(() => newInvite(companyId), 'Νέος κωδικός. Ο παλιός δεν ισχύει πια.')}>Νέος κωδικός</button>
              <button className="btn-ghost h-12" disabled={busy} onClick={() => run(() => stopInvite(companyId), 'Ο κωδικός σταμάτησε.')}>Σταμάτα τον κωδικό</button>
            </div>
          </>
        ) : (
          <>
            <p className="text-base mb-3">Φτιάξε έναν κωδικό 6 αριθμών και δώσ' τον στον υπάλληλο. Μπαίνει μόνος του, χωρίς να σου πει τον κωδικό του.</p>
            <button className="btn-primary h-12 text-base" disabled={busy || !!data.error} onClick={() => run(() => newInvite(companyId), 'Έτοιμος ο κωδικός.')}>Φτιάξε κωδικό για νέο υπάλληλο</button>
          </>
        )}
      </div>

      <div className="card p-4">
        <h2 className="text-lg font-semibold mb-2">Ποιοι μπαίνουν στο μαγαζί</h2>
        <ul className="divide-y divide-stone-100">
          {(d?.team ?? []).map((m) => (
            <li key={m.user_id} className="py-2 flex flex-wrap items-center gap-2">
              <div className="flex-1 min-w-[12rem]">
                <div className="font-medium break-all">{m.email ?? '—'}{m.is_me && <span className="text-stone-500 font-normal"> (εσύ)</span>}</div>
                <div className="text-sm text-stone-600">{ROLE_LABEL[m.role]} · από {fmtDate(m.since.slice(0, 10))}</div>
              </div>
              {!m.is_me && (
                <>
                  {m.role === 'staff'
                    ? <button className="btn-secondary" disabled={busy} onClick={() => setAsk({ kind: 'owner', m })}>Κάν' τον ιδιοκτήτη</button>
                    : <button className="btn-secondary" disabled={busy} onClick={() => setAsk({ kind: 'staff', m })}>Κάν' τον υπάλληλο</button>}
                  <button className="btn-danger" disabled={busy} onClick={() => setAsk({ kind: 'remove', m })}>Βγάλ' τον</button>
                </>
              )}
            </li>
          ))}
        </ul>
        <p className="text-sm text-stone-600 mt-2">Ο υπάλληλος κάνει όλη τη δουλειά της μέρας, αλλά δεν βλέπει το κέρδος, τους μισθούς και τις ρυθμίσεις πληρωμών.</p>
      </div>

      {ask && (
        <Confirm open
          title={ask.kind === 'remove' ? 'Βγάλσιμο' : 'Αλλαγή ρόλου'}
          text={ask.kind === 'remove'
            ? `Να μην μπαίνει πια ο ${ask.m.email ?? 'χρήστης'} στο μαγαζί; Ό,τι πέρασε μένει.`
            : ask.kind === 'owner'
              ? `Ο ${ask.m.email ?? 'χρήστης'} θα βλέπει και κέρδος, μισθούς, ρυθμίσεις, και θα βγάζει κωδικούς. Να γίνει ιδιοκτήτης;`
              : `Ο ${ask.m.email ?? 'χρήστης'} δεν θα βλέπει πια κέρδος, μισθούς και ρυθμίσεις. Να γίνει υπάλληλος;`}
          yes={ask.kind === 'remove' ? "Ναι, βγάλ' τον" : 'Ναι'}
          danger={ask.kind === 'remove'}
          onNo={() => setAsk(null)}
          onYes={() => {
            const a = ask; setAsk(null)
            if (a.kind === 'remove') void run(() => removeMember(companyId, a.m.user_id), 'Βγήκε από το μαγαζί.')
            else void run(() => setMemberRole(companyId, a.m.user_id, a.kind === 'owner' ? 'owner' : 'staff'), 'Άλλαξε ο ρόλος.')
          }}
        />
      )}
    </div>
  )
}
