import { errMsg, supabase } from './supabase'

/**
 * Υπάλληλοι (0009): ο ιδιοκτήτης βγάζει 6ψήφιο κωδικό, ο υπάλληλος τον
 * γράφει μετά την εγγραφή του και μπαίνει στο μαγαζί.
 */

export interface Invite { code: string; expires_at: string }
export interface Member { user_id: string; email: string | null; role: 'owner' | 'staff'; since: string; is_me: boolean }

/** Βάση χωρίς το 0009: λείπουν οι functions */
const missing = (m: string) => /could not find the function|function .* does not exist|PGRST202/i.test(m)
export const TEAM_MISSING = 'Οι υπάλληλοι θέλουν ενημέρωση της βάσης (0009_team.sql). Δες το docs/DEPLOY.md.'

async function call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args)
  if (error) {
    const m = errMsg(error)
    throw new Error(missing(m) || missing(error.code ?? '') ? TEAM_MISSING : m)
  }
  return data as T
}

export const loadInvite = (companyId: string) => call<Invite | null>('team_invite_get', { p_company: companyId })
export const newInvite = (companyId: string) => call<Invite>('team_invite', { p_company: companyId })
export const stopInvite = (companyId: string) => call<void>('team_invite_stop', { p_company: companyId })
export const loadTeam = (companyId: string) => call<Member[]>('team_list', { p_company: companyId })
export const removeMember = (companyId: string, userId: string) => call<void>('team_remove', { p_company: companyId, p_user: userId })
export const setMemberRole = (companyId: string, userId: string, role: Member['role']) =>
  call<void>('team_set_role', { p_company: companyId, p_user: userId, p_role: role })

/** Γράφει τον κωδικό: το μαγαζί, ή λάθος με απλά λόγια */
export async function joinTeam(code: string): Promise<{ company_id: string; name: string }> {
  const r = await call<{ company_id?: string; name?: string; error?: string }>('team_join', { p_code: code })
  if (!r || r.error || !r.company_id) throw new Error(r?.error ?? 'Ο κωδικός δεν ισχύει.')
  return { company_id: r.company_id, name: r.name ?? '' }
}

/** «123 456»: πιο εύκολο να το διαβάσεις και να το πεις */
export const spacedCode = (code: string) => code.replace(/^(\d{3})(\d{3})$/, '$1 $2')

/** Το μήνυμα για τον νέο υπάλληλο (Viber / WhatsApp / SMS) */
export const inviteText = (shop: string, code: string, origin = typeof window !== 'undefined' ? window.location.origin : '') =>
  `Για να μπεις στο ${shop}: 1) άνοιξε ${origin} 2) πάτα «Δεν έχω λογαριασμό» και φτιάξε λογαριασμό με το email σου 3) γράψε τον κωδικό ${spacedCode(code)}.`
