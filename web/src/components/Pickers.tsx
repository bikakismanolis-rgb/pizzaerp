import { useMemo } from 'react'
import { Combo } from './Combo'
import { useMaster } from '../context/MasterData'
import { useCompanyId } from '../context/CompanyContext'
import { quickPartner } from '../lib/partners'
import { useToast } from './ui'
import type { ItemType } from '../lib/types'
import { ITEM_TYPE_LABEL } from '../lib/labels'

export function ItemPicker({ value, onChange, types, onlyMakeToOrder, includeInactive, disabled, autoFocus, placeholder = 'Είδος...' }: {
  value: string | null
  onChange: (id: string | null) => void
  types?: ItemType[]
  onlyMakeToOrder?: boolean
  includeInactive?: boolean
  disabled?: boolean
  autoFocus?: boolean
  placeholder?: string
}) {
  const { items } = useMaster()
  const options = useMemo(
    () =>
      items
        .filter((i) => (includeInactive || i.is_active || i.id === value))
        .filter((i) => !types || types.includes(i.item_type))
        .filter((i) => !onlyMakeToOrder || i.make_to_order)
        .map((i) => ({ id: i.id, label: i.name, sub: `${i.code} · ${ITEM_TYPE_LABEL[i.item_type]} · ${i.unit}` })),
    [items, types, onlyMakeToOrder, includeInactive, value],
  )
  return <Combo options={options} value={value} onChange={onChange} disabled={disabled} autoFocus={autoFocus} placeholder={placeholder} />
}

export function PartnerPicker({ value, onChange, kind, disabled, placeholder, allowCreate }: {
  value: string | null
  onChange: (id: string | null) => void
  kind: 'customer' | 'supplier' | 'any'
  disabled?: boolean
  placeholder?: string
  /** «+ Νέος προμηθευτής «Χ»» στη λίστα, όταν δεν υπάρχει */
  allowCreate?: boolean
}) {
  const { partners, refresh } = useMaster()
  const companyId = useCompanyId()
  const toast = useToast()
  const options = useMemo(
    () =>
      partners
        .filter((p) => p.is_active || p.id === value)
        .filter((p) => kind === 'any' || (kind === 'customer' ? p.is_customer : p.is_supplier))
        .map((p) => ({ id: p.id, label: p.name, sub: p.code + (p.city ? ' · ' + p.city : '') })),
    [partners, kind, value],
  )
  return (
    <Combo
      options={options}
      value={value}
      onChange={onChange}
      disabled={disabled}
      placeholder={placeholder ?? (kind === 'supplier' ? 'Γράψε ή διάλεξε προμηθευτή…' : 'Γράψε ή διάλεξε πελάτη…')}
      create={allowCreate && kind !== 'any' ? {
        label: (t) => `+ Νέος ${kind === 'supplier' ? 'προμηθευτής' : 'πελάτης'} «${t}»`,
        run: async (t) => {
          try {
            const p = await quickPartner(companyId, t, kind)
            await refresh()
            toast.ok(`Μπήκε ο ${kind === 'supplier' ? 'προμηθευτής' : 'πελάτης'} «${p.name}». Τα στοιχεία του (ΑΦΜ, τηλέφωνο) τα βάζεις μετά.`)
            return p.id
          } catch (e) { toast.err(e instanceof Error ? e.message : String(e)); return null }
        },
      } : undefined}
    />
  )
}
