import type { ReactNode } from 'react'

/** Κοινά της σελίδας του πελάτη (χωρίς login, χωρίς τα contexts της εφαρμογής) */

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type StoreKind = 'local' | 'session'

const storeOf = (k: StoreKind): Storage => (k === 'local' ? window.localStorage : window.sessionStorage)

/** Ανάγνωση από localStorage / sessionStorage· σε ιδιωτικό παράθυρο ή μπλοκαρισμένο: fallback */
export function readStore<T>(kind: StoreKind, key: string, fallback: T): T {
  try {
    const raw = storeOf(kind).getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

export function writeStore(kind: StoreKind, key: string, value: unknown): void {
  try { storeOf(kind).setItem(key, JSON.stringify(value)) } catch { /* μόνο ευκολία */ }
}

export function ShopHeader({ name, phone, open }: { name: string; phone: string | null; open?: boolean }) {
  return (
    <header className="bg-red-700 text-white">
      <div className="max-w-2xl mx-auto px-4 py-4 flex items-center gap-3">
        <div className="text-2xl" aria-hidden="true">🍕</div>
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-bold leading-tight truncate">{name}</h1>
          {open !== undefined && (
            <div className="text-xs opacity-90">{open ? 'Δεχόμαστε παραγγελίες τώρα' : 'Κλειστό για online παραγγελίες'}</div>
          )}
        </div>
        {phone && (
          <a href={`tel:${phone.replace(/\s/g, '')}`} className="rounded-md bg-white/15 px-3 py-2 text-sm font-medium" aria-label={`Τηλέφωνο ${phone}`}>
            📞 {phone}
          </a>
        )}
      </div>
    </header>
  )
}

export function Centered({ children }: { children: ReactNode }) {
  return <div className="min-h-screen flex flex-col items-center justify-center gap-3 p-6 text-center text-stone-700">{children}</div>
}

export const telHref = (phone: string) => `tel:${phone.replace(/\s/g, '')}`
