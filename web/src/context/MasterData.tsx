import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { supabase } from '../lib/supabase'
import type { Item, Partner } from '../lib/types'
import { useCompany } from './CompanyContext'

interface MasterState {
  items: Item[]
  partners: Partner[]
  itemById: Map<string, Item>
  partnerById: Map<string, Partner>
  loading: boolean
  refresh: () => Promise<void>
}

const Ctx = createContext<MasterState | null>(null)

/** Είδη και συναλλασσόμενοι της τρέχουσας εταιρείας, φορτωμένα μία φορά (για pickers) */
export function MasterDataProvider({ children }: { children: ReactNode }) {
  const { company } = useCompany()
  const [items, setItems] = useState<Item[]>([])
  const [partners, setPartners] = useState<Partner[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    if (!company) { setItems([]); setPartners([]); setLoading(false); return }
    setLoading(true)
    const [i, p] = await Promise.all([
      supabase.from('item').select('*').eq('company_id', company.id).order('code'),
      supabase.from('partner').select('*').eq('company_id', company.id).order('name'),
    ])
    setItems((i.data ?? []) as Item[])
    setPartners((p.data ?? []) as Partner[])
    setLoading(false)
  }, [company])

  useEffect(() => { refresh() }, [refresh])

  const itemById = useMemo(() => new Map(items.map((x) => [x.id, x])), [items])
  const partnerById = useMemo(() => new Map(partners.map((x) => [x.id, x])), [partners])

  return <Ctx.Provider value={{ items, partners, itemById, partnerById, loading, refresh }}>{children}</Ctx.Provider>
}

export function useMaster() {
  const v = useContext(Ctx)
  if (!v) throw new Error('useMaster outside MasterDataProvider')
  return v
}
