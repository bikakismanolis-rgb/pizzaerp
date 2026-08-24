import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { supabase } from '../lib/supabase'
import type { Company } from '../lib/types'
import { useAuth } from './AuthContext'

interface CompanyState {
  companies: Company[]
  company: Company | null
  loading: boolean
  select: (id: string) => void
  create: (name: string, vatNo?: string) => Promise<Company>
  reload: () => Promise<void>
}

const Ctx = createContext<CompanyState | null>(null)
const LS_KEY = 'pizza-erp.company'

export function CompanyProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const [companies, setCompanies] = useState<Company[]>([])
  const [company, setCompany] = useState<Company | null>(null)
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    if (!user) {
      setCompanies([])
      setCompany(null)
      setLoading(false)
      return
    }
    setLoading(true)
    const { data, error } = await supabase.from('company').select('*').order('name')
    if (error) {
      console.error(error)
      setCompanies([])
      setCompany(null)
    } else {
      const list = (data ?? []) as Company[]
      setCompanies(list)
      let saved: string | null = null
      try { saved = localStorage.getItem(LS_KEY) } catch { /* ignore */ }
      const found = list.find((c) => c.id === saved) ?? list[0] ?? null
      setCompany(found)
    }
    setLoading(false)
  }, [user])

  useEffect(() => { reload() }, [reload])

  const select = (id: string) => {
    const c = companies.find((x) => x.id === id) ?? null
    setCompany(c)
    try { localStorage.setItem(LS_KEY, id) } catch { /* ignore */ }
  }

  const create = async (name: string, vatNo?: string) => {
    const { data, error } = await supabase.rpc('create_company', { p_name: name, p_vat_no: vatNo || null })
    if (error) throw error
    const id = data as string
    await reload()
    try { localStorage.setItem(LS_KEY, id) } catch { /* ignore */ }
    const { data: row } = await supabase.from('company').select('*').eq('id', id).single()
    const c = row as Company
    setCompany(c)
    return c
  }

  return <Ctx.Provider value={{ companies, company, loading, select, create, reload }}>{children}</Ctx.Provider>
}

export function useCompany() {
  const v = useContext(Ctx)
  if (!v) throw new Error('useCompany outside CompanyProvider')
  return v
}

/** Επιστρέφει την τρέχουσα εταιρεία (υποθέτει ότι υπάρχει, για τις εσωτερικές σελίδες) */
export function useCompanyId(): string {
  const { company } = useCompany()
  return company?.id ?? ''
}
