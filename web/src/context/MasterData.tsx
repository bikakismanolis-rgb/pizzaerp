import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { supabase } from '../lib/supabase'
import type { Item, Partner } from '../lib/types'
import { useCompany } from './CompanyContext'

interface MasterState {
  items: Item[]
  partners: Partner[]
  itemById: Map<string, Item>
  partnerById: Map<string, Partner>
  loading: boolean
  /** φορτώθηκαν τουλάχιστον μία φορά για την τρέχουσα εταιρεία */
  ready: boolean
  refresh: () => Promise<void>
}

const Ctx = createContext<MasterState | null>(null)

/** Είδη και συναλλασσόμενοι της τρέχουσας εταιρείας, φορτωμένα μία φορά (για pickers) */
export function MasterDataProvider({ children }: { children: ReactNode }) {
  const { company } = useCompany()
  const [items, setItems] = useState<Item[]>([])
  const [partners, setPartners] = useState<Partner[]>([])
  const [loading, setLoading] = useState(true)
  const [readyFor, setReadyFor] = useState<string | null>(null)
  const seq = useRef(0)
  const loadedFor = useRef<string | null>(null)

  const refresh = useCallback(async () => {
    const my = ++seq.current
    if (!company) { loadedFor.current = null; setItems([]); setPartners([]); setReadyFor(null); setLoading(false); return }
    // άλλη εταιρεία: όχι τα είδη της προηγούμενης όσο φορτώνει
    if (loadedFor.current !== company.id) { setItems([]); setPartners([]); setReadyFor(null) }
    setLoading(true)
    try {
      const [i, p] = await Promise.all([
        supabase.from('item').select('*').eq('company_id', company.id).order('code'),
        supabase.from('partner').select('*').eq('company_id', company.id).order('name'),
      ])
      if (my !== seq.current) return
      // σφάλμα (π.χ. κακό δίκτυο): μένουν τα προηγούμενα, όχι άδειες λίστες
      if (i.error || p.error) { console.warn('Φόρτωση ειδών/συναλλασσομένων:', (i.error ?? p.error)?.message); return }
      setItems((i.data ?? []) as Item[])
      setPartners((p.data ?? []) as Partner[])
      loadedFor.current = company.id
      setReadyFor(company.id)
    } catch (e) {
      console.warn('Φόρτωση ειδών/συναλλασσομένων:', e)
    } finally {
      if (my === seq.current) setLoading(false)
    }
  }, [company])

  useEffect(() => { refresh() }, [refresh])

  const itemById = useMemo(() => new Map(items.map((x) => [x.id, x])), [items])
  const partnerById = useMemo(() => new Map(partners.map((x) => [x.id, x])), [partners])
  const ready = !!company && readyFor === company.id

  return <Ctx.Provider value={{ items, partners, itemById, partnerById, loading, ready, refresh }}>{children}</Ctx.Provider>
}

export function useMaster() {
  const v = useContext(Ctx)
  if (!v) throw new Error('useMaster outside MasterDataProvider')
  return v
}
