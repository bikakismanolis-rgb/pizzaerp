import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { supabase } from '../lib/supabase'
import type { Item, Partner, VoicePhrase } from '../lib/types'
import { useCompany } from './CompanyContext'

interface MasterState {
  items: Item[]
  partners: Partner[]
  /** δικές τους φράσεις για το «Πες το» ("όταν λέω Χ εννοώ Υ") */
  phrases: VoicePhrase[]
  itemById: Map<string, Item>
  partnerById: Map<string, Partner>
  loading: boolean
  /** φορτώθηκαν τουλάχιστον μία φορά για την τρέχουσα εταιρεία */
  ready: boolean
  refresh: () => Promise<void>
  /** μόνο οι φράσεις (μετά από προσθήκη / αλλαγή / διαγραφή) */
  refreshPhrases: () => Promise<void>
}

const Ctx = createContext<MasterState | null>(null)

type PhraseRes = { data: VoicePhrase[] | null; error: { message: string } | null }

/** Φράσεις της εταιρείας· χωρίς τον πίνακα (βάση πριν από το 0004) = καμία, όχι σφάλμα */
async function fetchPhrases(companyId: string): Promise<VoicePhrase[] | null> {
  try {
    const r = (await supabase.from('voice_phrase').select('id, company_id, phrase, meaning')
      .eq('company_id', companyId).order('phrase')) as unknown as PhraseRes
    if (r.error) { console.warn('Φόρτωση φράσεων:', r.error.message); return null }
    return r.data ?? []
  } catch (e) {
    console.warn('Φόρτωση φράσεων:', e)
    return null
  }
}

/** Είδη, συναλλασσόμενοι και φράσεις της τρέχουσας εταιρείας, φορτωμένα μία φορά (για pickers / «Πες το») */
export function MasterDataProvider({ children }: { children: ReactNode }) {
  const { company } = useCompany()
  const [items, setItems] = useState<Item[]>([])
  const [partners, setPartners] = useState<Partner[]>([])
  const [phrases, setPhrases] = useState<VoicePhrase[]>([])
  const [loading, setLoading] = useState(true)
  const [readyFor, setReadyFor] = useState<string | null>(null)
  const seq = useRef(0)
  const phraseSeq = useRef(0)
  const loadedFor = useRef<string | null>(null)

  const refresh = useCallback(async () => {
    const my = ++seq.current
    const myP = ++phraseSeq.current
    if (!company) { loadedFor.current = null; setItems([]); setPartners([]); setPhrases([]); setReadyFor(null); setLoading(false); return }
    // άλλη εταιρεία: όχι τα είδη της προηγούμενης όσο φορτώνει
    if (loadedFor.current !== company.id) { setItems([]); setPartners([]); setPhrases([]); setReadyFor(null) }
    setLoading(true)
    try {
      const [i, p, ph] = await Promise.all([
        supabase.from('item').select('*').eq('company_id', company.id).order('code'),
        supabase.from('partner').select('*').eq('company_id', company.id).order('name'),
        fetchPhrases(company.id),
      ])
      if (my !== seq.current) return
      // σφάλμα (π.χ. κακό δίκτυο): μένουν τα προηγούμενα, όχι άδειες λίστες
      if (i.error || p.error) { console.warn('Φόρτωση ειδών/συναλλασσομένων:', (i.error ?? p.error)?.message); return }
      setItems((i.data ?? []) as Item[])
      setPartners((p.data ?? []) as Partner[])
      if (ph && myP === phraseSeq.current) setPhrases(ph)
      loadedFor.current = company.id
      setReadyFor(company.id)
    } catch (e) {
      console.warn('Φόρτωση ειδών/συναλλασσομένων:', e)
    } finally {
      if (my === seq.current) setLoading(false)
    }
  }, [company])

  const refreshPhrases = useCallback(async () => {
    if (!company) return
    const my = ++phraseSeq.current
    const ph = await fetchPhrases(company.id)
    if (ph && my === phraseSeq.current && loadedFor.current === company.id) setPhrases(ph)
  }, [company])

  useEffect(() => { refresh() }, [refresh])

  const itemById = useMemo(() => new Map(items.map((x) => [x.id, x])), [items])
  const partnerById = useMemo(() => new Map(partners.map((x) => [x.id, x])), [partners])
  const ready = !!company && readyFor === company.id

  return (
    <Ctx.Provider value={{ items, partners, phrases, itemById, partnerById, loading, ready, refresh, refreshPhrases }}>
      {children}
    </Ctx.Provider>
  )
}

export function useMaster() {
  const v = useContext(Ctx)
  if (!v) throw new Error('useMaster outside MasterDataProvider')
  return v
}
