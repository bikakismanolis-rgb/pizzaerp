const money = new Intl.NumberFormat('el-GR', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 })
const money4 = new Intl.NumberFormat('el-GR', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 4 })
const qtyFmt = new Intl.NumberFormat('el-GR', { minimumFractionDigits: 0, maximumFractionDigits: 3 })
const pct = new Intl.NumberFormat('el-GR', { minimumFractionDigits: 0, maximumFractionDigits: 1 })

export const fmtMoney = (v: number | null | undefined) => money.format(Number(v ?? 0))
export const fmtCost = (v: number | null | undefined) => money4.format(Number(v ?? 0))
export const fmtQty = (v: number | null | undefined) => qtyFmt.format(Number(v ?? 0))
export const fmtPct = (v: number | null | undefined) => pct.format(Number(v ?? 0)) + '%'

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const [y, m, d] = iso.slice(0, 10).split('-')
  return `${d}/${m}/${y}`
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const dt = new Date(iso)
  return dt.toLocaleString('el-GR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** Σημερινή ημερομηνία σε μορφή YYYY-MM-DD (τοπική ώρα) */
export function today(): string {
  const d = new Date()
  const off = d.getTimezoneOffset()
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10)
}

/** Πρώτη μέρα του μήνα, YYYY-MM-DD */
export function monthStart(date = today()): string {
  return date.slice(0, 7) + '-01'
}

export function toNum(v: string | number | null | undefined): number {
  if (v === null || v === undefined || v === '') return 0
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'))
  return Number.isFinite(n) ? n : 0
}

export function round(v: number, dec = 2): number {
  const f = Math.pow(10, dec)
  return Math.round((v + Number.EPSILON) * f) / f
}

/** "μαργαρίτα σκέτη, μαργαρ" → ['μαργαρίτα σκέτη', 'μαργαρ'] (χωρίς διπλά) */
export function parseAliases(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of text.split(/[,;\n]/)) {
    const a = raw.trim().replace(/\s+/g, ' ')
    const k = a.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    if (a && !seen.has(k)) { seen.add(k); out.push(a) }
  }
  return out
}
