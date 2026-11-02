import { useEffect, useRef, type MutableRefObject } from 'react'

/**
 * Cloudflare Turnstile («δεν είμαι ρομπότ»): φορτώνει το script μόνο όταν
 * το μαγαζί έχει κλειδί. Το token το ελέγχει ο server (shop-checkout).
 */

interface TurnstileApi {
  render(el: HTMLElement, opts: Record<string, unknown>): string
  reset(id?: string): void
  remove(id: string): void
}

const SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
let loading: Promise<TurnstileApi> | null = null

function loadApi(): Promise<TurnstileApi> {
  const w = window as unknown as { turnstile?: TurnstileApi }
  if (w.turnstile) return Promise.resolve(w.turnstile)
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const s = document.createElement('script')
      s.src = SRC
      s.async = true
      s.onload = () => (w.turnstile ? resolve(w.turnstile) : reject(new Error('turnstile')))
      s.onerror = () => { loading = null; reject(new Error('turnstile')) }
      document.head.appendChild(s)
    })
  }
  return loading
}

export function Turnstile({ siteKey, onToken, resetRef }: {
  siteKey: string; onToken: (t: string | null) => void; resetRef: MutableRefObject<() => void>
}) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let id: string | null = null
    let api: TurnstileApi | null = null
    let alive = true
    loadApi().then((a) => {
      if (!alive || !box.current) return
      api = a
      id = a.render(box.current, {
        sitekey: siteKey,
        language: 'el',
        callback: (t: string) => onToken(t),
        'expired-callback': () => onToken(null),
        'error-callback': () => onToken(null),
      })
      resetRef.current = () => { try { if (id) a.reset(id) } catch { /* ignore */ } }
    }).catch(() => onToken(null))
    return () => {
      alive = false
      try { if (api && id) api.remove(id) } catch { /* ignore */ }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteKey])
  return <div ref={box} className="min-h-[65px]" aria-label="Έλεγχος «δεν είμαι ρομπότ»" />
}
