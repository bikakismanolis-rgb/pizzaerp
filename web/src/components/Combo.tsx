import { useEffect, useMemo, useRef, useState } from 'react'

export interface ComboOption {
  id: string
  label: string
  sub?: string
}

/**
 * Απλό searchable dropdown: γράφεις και φιλτράρει, Enter/κλικ επιλέγει.
 */
export function Combo({ options, value, onChange, placeholder = 'Αναζήτηση...', disabled, autoFocus, className = '' }: {
  options: ComboOption[]
  value: string | null
  onChange: (id: string | null) => void
  placeholder?: string
  disabled?: boolean
  autoFocus?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [hi, setHi] = useState(0)
  const wrap = useRef<HTMLDivElement>(null)

  const selected = useMemo(() => options.find((o) => o.id === value) ?? null, [options, value])

  useEffect(() => {
    if (!open) setText(selected ? selected.label : '')
  }, [selected, open])

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  const filtered = useMemo(() => {
    const q = norm(text.trim())
    if (!q) return options.slice(0, 50)
    return options.filter((o) => norm(o.label).includes(q) || (o.sub && norm(o.sub).includes(q))).slice(0, 50)
  }, [options, text])

  const pick = (o: ComboOption | null) => {
    onChange(o ? o.id : null)
    setOpen(false)
    setText(o ? o.label : '')
  }

  return (
    <div ref={wrap} className={'relative ' + className}>
      <input
        className="input"
        value={text}
        disabled={disabled}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onFocus={() => { setOpen(true); setText(''); setHi(0) }}
        onChange={(e) => { setText(e.target.value); setOpen(true); setHi(0) }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, filtered.length - 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)) }
          else if (e.key === 'Enter') { e.preventDefault(); if (filtered[hi]) pick(filtered[hi]) }
          else if (e.key === 'Escape') { setOpen(false) }
        }}
      />
      {open && !disabled && (
        <div className="absolute z-30 mt-1 w-full max-h-64 overflow-y-auto rounded-md border border-stone-300 bg-white shadow-lg">
          {value && (
            <div className="px-3 py-2 text-xs text-stone-500 cursor-pointer hover:bg-stone-100" onMouseDown={() => pick(null)}>
              (καθαρισμός επιλογής)
            </div>
          )}
          {filtered.length === 0 && <div className="px-3 py-2 text-sm text-stone-500">Δεν βρέθηκε</div>}
          {filtered.map((o, i) => (
            <div
              key={o.id}
              className={'px-3 py-2 text-sm cursor-pointer ' + (i === hi ? 'bg-red-50' : 'hover:bg-stone-100')}
              onMouseEnter={() => setHi(i)}
              onMouseDown={() => pick(o)}
            >
              <div>{o.label}</div>
              {o.sub && <div className="text-xs text-stone-500">{o.sub}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
