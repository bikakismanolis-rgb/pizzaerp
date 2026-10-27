import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { errMsg, supabase } from '../../lib/supabase'
import { fmtMoney, round } from '../../lib/format'
import {
  MODE_LABEL, phoneLooksValid,
  type MenuItem, type OrderInput, type OrderMode, type OrderPayment, type ShopMenu,
} from '../../lib/online'
import { ShopHeader, readStore, writeStore } from './shared'

/**
 * Η σελίδα του μαγαζιού για τον πελάτη (/s/:slug): μενού, καλάθι,
 * στοιχεία, αποστολή. Χωρίς λογαριασμό· οι τιμές και οι έλεγχοι γίνονται
 * στη βάση (place_order), εδώ μόνο για ευκολία.
 */

interface CartLine { qty: number; note: string }
type Cart = Record<string, CartLine>

interface Customer { name: string; phone: string; address: string; mode: OrderMode; payment: OrderPayment }

const CUSTOMER_KEY = 'pizza-shop.customer'
const cartKey = (slug: string) => `pizza-shop.cart.${slug}`
export const lastOrderKey = (slug: string) => `pizza-shop.last.${slug}`

const emptyCustomer: Customer = { name: '', phone: '', address: '', mode: 'delivery', payment: 'cash' }

export function Shop() {
  const { slug = '' } = useParams()
  const nav = useNavigate()
  const [menu, setMenu] = useState<ShopMenu | null | undefined>(undefined)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [cart, setCart] = useState<Cart>(() => readStore<Cart>('session', cartKey(slug), {}))
  const [step, setStep] = useState<'menu' | 'checkout'>('menu')
  const [cust, setCust] = useState<Customer>(() => ({ ...emptyCustomer, ...readStore<Partial<Customer>>('local', CUSTOMER_KEY, {}) }))
  const [notes, setNotes] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const last = readStore<{ token: string; no: number } | null>('local', lastOrderKey(slug), null)

  const load = useCallback(async () => {
    const { data, error: e } = await supabase.rpc('shop_menu', { p_slug: slug })
    if (e) { setLoadError(errMsg(e)); return }
    setLoadError(null)
    setMenu((data as ShopMenu | null) ?? null)
  }, [slug])

  useEffect(() => { load() }, [load])
  // ανοιχτό / κλειστό αλλάζει: ξανά όταν γυρίζει στη σελίδα
  useEffect(() => {
    const h = () => { if (document.visibilityState === 'visible') load() }
    document.addEventListener('visibilitychange', h)
    return () => document.removeEventListener('visibilitychange', h)
  }, [load])
  useEffect(() => { if (menu) document.title = menu.name }, [menu])
  useEffect(() => { writeStore('session', cartKey(slug), cart) }, [slug, cart])

  // τρόπος που δεν υποστηρίζει το μαγαζί → ο άλλος
  useEffect(() => {
    if (!menu) return
    if (cust.mode === 'delivery' && !menu.delivery) setCust((c) => ({ ...c, mode: 'pickup' }))
    if (cust.mode === 'pickup' && !menu.pickup) setCust((c) => ({ ...c, mode: 'delivery' }))
  }, [menu, cust.mode])

  const byId = useMemo(() => new Map((menu?.items ?? []).map((i) => [i.id, i])), [menu])
  // ό,τι δεν υπάρχει πια στο μενού φεύγει από το καλάθι
  const lines = Object.entries(cart).filter(([id, l]) => l.qty > 0 && byId.has(id)).map(([id, l]) => ({ item: byId.get(id)!, ...l }))
  const count = lines.reduce((s, l) => s + l.qty, 0)
  const itemsTotal = round(lines.reduce((s, l) => s + l.qty * l.item.price, 0))
  const fee = menu && cust.mode === 'delivery' ? Number(menu.delivery_fee) : 0
  const total = round(itemsTotal + fee)
  const belowMin = !!menu && itemsTotal < Number(menu.min_order)

  const setQty = (id: string, qty: number) => setCart((c) => {
    const q = Math.max(0, Math.min(50, qty))
    const next = { ...c }
    if (q === 0) delete next[id]
    else next[id] = { qty: q, note: c[id]?.note ?? '' }
    return next
  })
  const setNote = (id: string, note: string) => setCart((c) => (c[id] ? { ...c, [id]: { ...c[id], note } } : c))

  const groups = useMemo(() => {
    const out: { cat: string; items: MenuItem[] }[] = []
    for (const it of menu?.items ?? []) {
      const cat = it.category?.trim() || 'Μενού'
      const g = out.find((x) => x.cat === cat)
      if (g) g.items.push(it); else out.push({ cat, items: [it] })
    }
    return out
  }, [menu])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!menu) return
    setError(null)
    if (cust.name.trim().length < 2) { setError('Γράψε το όνομά σου.'); return }
    if (!phoneLooksValid(cust.phone)) { setError('Γράψε ένα σωστό τηλέφωνο (10 ψηφία).'); return }
    if (cust.mode === 'delivery' && cust.address.trim().length < 5) { setError('Γράψε τη διεύθυνση για τη διανομή.'); return }
    const order: OrderInput = {
      name: cust.name.trim(),
      phone: cust.phone.trim(),
      mode: cust.mode,
      address: cust.mode === 'delivery' ? cust.address.trim() : null,
      payment: cust.payment,
      notes: notes.trim() || null,
      lines: lines.map((l) => ({ item_id: l.item.id, qty: l.qty, note: l.note.trim() || null })),
    }
    setSending(true)
    const { data, error: er } = await supabase.rpc('place_order', { p_slug: slug, p_order: order })
    setSending(false)
    if (er) {
      const msg = errMsg(er)
      setError(msg)
      if (/διαθέσιμο|δεν δέχεται/.test(msg)) load()
      return
    }
    const r = data as { token: string; order_no: number }
    writeStore('local', CUSTOMER_KEY, cust)
    writeStore('local', lastOrderKey(slug), { token: r.token, no: r.order_no })
    setCart({})
    nav(`/s/${slug}/o/${r.token}`)
  }

  if (loadError && menu === undefined) {
    return <Centered>
      <p className="mb-3">{loadError}</p>
      <button className="btn-primary" onClick={load}>Ξανά</button>
    </Centered>
  }
  if (menu === undefined) return <Centered>Φόρτωση...</Centered>
  if (menu === null) return <Centered>Δεν βρέθηκε το κατάστημα. Έλεγξε τη διεύθυνση.</Centered>

  return (
    <div className="min-h-screen bg-stone-100 pb-28">
      <ShopHeader name={menu.name} phone={menu.phone} open={menu.open} />
      <div className="max-w-2xl mx-auto px-4">
        {menu.note && <p className="text-sm text-stone-600 mt-3">{menu.note}</p>}
        {!menu.open && (
          <div className="rounded-md bg-amber-50 border border-amber-200 text-amber-900 text-sm px-3 py-2 mt-3">
            Αυτή τη στιγμή δεν δεχόμαστε online παραγγελίες.
            {menu.phone && <> Πάρε μας τηλέφωνο: <a className="underline font-medium" href={`tel:${menu.phone.replace(/\s/g, '')}`}>{menu.phone}</a></>}
          </div>
        )}
        {last && (
          <Link to={`/s/${slug}/o/${last.token}`} className="block text-sm text-red-700 underline mt-3">
            Η τελευταία σου παραγγελία (#{last.no}) →
          </Link>
        )}

        {step === 'menu' && (
          <>
            {groups.length > 1 && (
              <nav className="flex gap-2 overflow-x-auto py-3 -mx-4 px-4 sticky top-0 bg-stone-100 z-10">
                {groups.map((g) => (
                  <a key={g.cat} href={`#cat-${encodeURIComponent(g.cat)}`} className="shrink-0 rounded-full bg-white border border-stone-300 px-3 py-1 text-sm">
                    {g.cat}
                  </a>
                ))}
              </nav>
            )}
            {groups.length === 0 && <p className="text-stone-500 text-center py-10">Το μενού ετοιμάζεται.</p>}
            {groups.map((g) => (
              <section key={g.cat} id={`cat-${encodeURIComponent(g.cat)}`} className="mt-4 scroll-mt-16">
                <h2 className="text-lg font-semibold mb-2">{g.cat}</h2>
                <div className="card divide-y divide-stone-100">
                  {g.items.map((it) => {
                    const l = cart[it.id]
                    return (
                      <div key={it.id} className="p-3">
                        <div className="flex items-start gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="font-medium">{it.name}</div>
                            {it.description && <div className="text-sm text-stone-500">{it.description}</div>}
                            <div className="text-sm font-semibold mt-1 tabular-nums">{fmtMoney(it.price)}</div>
                          </div>
                          {l ? (
                            <div className="flex items-center gap-1 shrink-0">
                              <button type="button" className="btn-secondary h-11 w-11 p-0 text-xl" aria-label={`Ένα λιγότερο ${it.name}`} onClick={() => setQty(it.id, l.qty - 1)}>−</button>
                              <span className="w-8 text-center font-semibold tabular-nums" aria-live="polite">{l.qty}</span>
                              <button type="button" className="btn-secondary h-11 w-11 p-0 text-xl" aria-label={`Ένα ακόμα ${it.name}`} onClick={() => setQty(it.id, l.qty + 1)}>+</button>
                            </div>
                          ) : (
                            <button type="button" className="btn-primary h-11 shrink-0" disabled={!menu.open} onClick={() => setQty(it.id, 1)}>+ Προσθήκη</button>
                          )}
                        </div>
                        {l && (
                          <input className="input mt-2" maxLength={100} value={l.note} onChange={(e) => setNote(it.id, e.target.value)}
                            placeholder="Σημείωση (π.χ. χωρίς κρεμμύδι)" aria-label={`Σημείωση για ${it.name}`} />
                        )}
                      </div>
                    )
                  })}
                </div>
              </section>
            ))}
          </>
        )}

        {step === 'checkout' && (
          <form onSubmit={submit} className="mt-4 grid gap-4">
            <button type="button" className="btn-ghost justify-self-start -ml-3" onClick={() => setStep('menu')}>← Πίσω στο μενού</button>

            <div className="card p-4">
              <h2 className="font-semibold mb-2">Η παραγγελία σου</h2>
              <ul className="text-sm divide-y divide-stone-100">
                {lines.map((l) => (
                  <li key={l.item.id} className="py-1.5 flex gap-2">
                    <span className="tabular-nums w-8">{l.qty}×</span>
                    <span className="flex-1">{l.item.name}{l.note.trim() && <span className="text-stone-500"> ({l.note.trim()})</span>}</span>
                    <span className="tabular-nums">{fmtMoney(l.qty * l.item.price)}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="card p-4 grid gap-3">
              {menu.delivery && menu.pickup && (
                <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Τρόπος">
                  {(['delivery', 'pickup'] as const).map((m) => (
                    <button key={m} type="button" role="radio" aria-checked={cust.mode === m}
                      className={'h-12 rounded-md border text-sm font-medium ' + (cust.mode === m ? 'bg-red-700 text-white border-red-700' : 'bg-white border-stone-300')}
                      onClick={() => setCust({ ...cust, mode: m })}>
                      {MODE_LABEL[m]}{m === 'delivery' && Number(menu.delivery_fee) > 0 ? ` (+${fmtMoney(menu.delivery_fee)})` : ''}
                    </button>
                  ))}
                </div>
              )}
              {!(menu.delivery && menu.pickup) && <p className="text-sm text-stone-600">{menu.delivery ? 'Μόνο διανομή.' : 'Μόνο παραλαβή από το μαγαζί.'}</p>}
              <label className="block">
                <span className="label">Όνομα</span>
                <input className="input" autoComplete="name" required maxLength={60} value={cust.name} onChange={(e) => setCust({ ...cust, name: e.target.value })} />
              </label>
              <label className="block">
                <span className="label">Τηλέφωνο</span>
                <input className="input" type="tel" inputMode="tel" autoComplete="tel" required maxLength={20} value={cust.phone}
                  onChange={(e) => setCust({ ...cust, phone: e.target.value })} placeholder="69..." />
              </label>
              {cust.mode === 'delivery' && (
                <label className="block">
                  <span className="label">Διεύθυνση (οδός, αριθμός, όροφος, κουδούνι)</span>
                  <input className="input" autoComplete="street-address" required maxLength={200} value={cust.address}
                    onChange={(e) => setCust({ ...cust, address: e.target.value })} />
                </label>
              )}
              <label className="block">
                <span className="label">Σημειώσεις (προαιρετικό)</span>
                <textarea className="input" rows={2} maxLength={300} value={notes} onChange={(e) => setNotes(e.target.value)} />
              </label>
              <div>
                <span className="label">Πληρωμή</span>
                <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Πληρωμή">
                  {(['cash', 'card'] as const).map((p) => (
                    <button key={p} type="button" role="radio" aria-checked={cust.payment === p}
                      className={'h-12 rounded-md border text-sm font-medium ' + (cust.payment === p ? 'bg-red-700 text-white border-red-700' : 'bg-white border-stone-300')}
                      onClick={() => setCust({ ...cust, payment: p })}>
                      {p === 'cash' ? 'Μετρητά' : cust.mode === 'delivery' ? 'Κάρτα στην πόρτα' : 'Κάρτα στο ταμείο'}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="card p-4 text-sm grid gap-1">
              <div className="flex justify-between"><span>Προϊόντα</span><span className="tabular-nums">{fmtMoney(itemsTotal)}</span></div>
              {fee > 0 && <div className="flex justify-between"><span>Μεταφορικά</span><span className="tabular-nums">{fmtMoney(fee)}</span></div>}
              <div className="flex justify-between text-base font-semibold"><span>Σύνολο</span><span className="tabular-nums">{fmtMoney(total)}</span></div>
              {belowMin && <div className="text-amber-800 mt-1">Η ελάχιστη παραγγελία είναι {fmtMoney(menu.min_order)}.</div>}
            </div>

            {error && <div role="alert" className="rounded-md bg-red-50 border border-red-200 text-red-800 text-sm px-3 py-2">{error}</div>}
            <button className="btn-primary h-14 text-base" disabled={sending || !menu.open || belowMin || lines.length === 0}>
              {sending ? 'Αποστολή...' : `Στείλε την παραγγελία · ${fmtMoney(total)}`}
            </button>
            <p className="text-xs text-stone-500 text-center -mt-2">
              Το μαγαζί τη βλέπει αμέσως και σου λέει σε πόση ώρα θα είναι έτοιμη. Τα στοιχεία σου πάνε μόνο στο μαγαζί.
            </p>
          </form>
        )}
      </div>

      {step === 'menu' && count > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-20 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] bg-white border-t border-stone-200 shadow-lg">
          <div className="max-w-2xl mx-auto flex items-center gap-3">
            <div className="flex-1 text-sm">
              <div className="font-semibold">{count} {count === 1 ? 'προϊόν' : 'προϊόντα'} · {fmtMoney(itemsTotal)}</div>
              {belowMin && <div className="text-amber-800 text-xs">Ελάχιστη παραγγελία {fmtMoney(menu.min_order)}</div>}
            </div>
            <button className="btn-primary h-12 px-5 text-base" disabled={!menu.open} onClick={() => { setStep('checkout'); window.scrollTo(0, 0) }}>
              Συνέχεια →
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="min-h-screen flex flex-col items-center justify-center p-6 text-center text-stone-700">{children}</div>
}
