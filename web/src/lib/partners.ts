import { errMsg, supabase } from './supabase'
import type { Partner } from './types'

/**
 * Νέος πελάτης / προμηθευτής από τη φόρμα (μόνο όνομα): κωδικός αυτόματα
 * (ΠΕ-004 / ΠΡ-007), όπως και από το «Πες το». Τα υπόλοιπα στοιχεία μετά.
 */
export async function quickPartner(companyId: string, name: string, kind: 'customer' | 'supplier'): Promise<Partner> {
  const prefix = kind === 'customer' ? 'ΠΕ' : 'ΠΡ'
  const clean = name.trim().replace(/\s+/g, ' ')
  if (!clean) throw new Error('Γράψε όνομα.')
  const { data: codes, error: e1 } = await supabase.from('partner').select('code').eq('company_id', companyId).like('code', prefix + '-%')
  if (e1) throw new Error(errMsg(e1))
  let n = 1 + ((codes ?? []) as { code: string }[]).reduce((m, r) => { const x = /^.+?-(\d+)$/.exec(r.code); return x ? Math.max(m, Number(x[1])) : m }, 0)
  for (let attempt = 0; attempt < 6; attempt++, n++) {
    const { data, error } = await supabase.from('partner').insert({
      company_id: companyId, code: `${prefix}-${String(n).padStart(3, '0')}`, name: clean,
      is_customer: kind === 'customer', is_supplier: kind === 'supplier',
    }).select('*').single()
    if (!error) return data as Partner
    if (error.code !== '23505') throw new Error(errMsg(error))
  }
  throw new Error('Δεν βρέθηκε ελεύθερος κωδικός. Δοκίμασε ξανά.')
}
