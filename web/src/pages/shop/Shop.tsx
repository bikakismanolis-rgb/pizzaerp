import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { errMsg, supabase } from '../../lib/supabase'
import { callFunction } from '../../lib/edge'
import { fmtMoney, round } from '../../lib/format'
import {
  MODE_LABEL, phoneLooksValid, SOURCE_RE,
  type MenuExtra, type MenuItem, type OrderInput, type OrderMode, type OrderPayment, type OrderStatusInfo, type ShopMenu,
} from '../../lib/online'
import { Centered, ShopHeader, readStore, telHref, writeStore } from './shared'
import { Turnstile } from './Turnstile'

/**
 * Η σελίδα του μαγαζιού για τον πελάτη (/s/:slug): μενού, καλάθι (με extras
 * ανά πίτσα), στοιχεία, πληρωμή (μετρητά, κάρτα στην πόρτα, online).
 * Χωρίς λογαριασμό· τιμές, εκπτώσεις και έλεγχοι στη βάση. Με CAPTCHA ή
 * online πληρωμή η παραγγελία περνά από τον server (Edge Function
 * shop-checkout). ?src=bag (QR σακούλας κλπ): από πού ήρθε.
 */

interface CartLine { key: string; item_id: string; qty: number; note: string; extras: string[] }

interface Customer { name: string; phone: string; address: string; mode: OrderMode; payment: OrderPayment }

const CUSTOMER_KEY = 'pizza-shop.customer'
const cartKey = (slug: string) => `pizza-shop.cart.${slug}`
export const lastOrderKey = (slug: string) => `pizza-shop.last.${slug}`
const sourceKey = (slug: string) => `pizza-shop.src.${slug}`
const digits = (p: string) => p.replace(/\D/g, '').replace(/^(00)?30(?=\d{10}$)/, '')

const emptyCustomer: Customer = { name: '', phone: '', address: '', mode: 'delivery', payment: 'cash' }

const newKey = () => Math.random().toString(36).slice(2, 10)

/** Καλάθι από το sessionStorage (και από την παλιά μορφή { item_id: { qty, note } }) */
function loadCart(slug: string): CartLine[] {
  const v = readStore<unknown>('session', cartKey(slug), [])
  if (Array.isArray(v)) return v.filter((l) => l && typeof l.item_id === 'string' && l.qty > 0).map((l) => ({ extras: [], note: '', ...l }))
  if (v && typeof v === 'object') {
    return Object.entries(v as Record<string, { qty: number; note?: string }>)
      .filter(([, l]) => l?.qty > 0).map(([item_id, l]) => ({ key: newKey(), item_id, qty: l.qty, note: l.note ?? '', extras: [] }))
  }
  return []
}

export function Shop() {
  const { slug = '' } = useParams()
  const [params] = useSearchParams()
  const nav = useNavigate()
  const [menu, setMenu] = useState<ShopMenu | null | undefined>(undefined)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [cart, setCart] = useState<CartLine[]>(() => loadCart(slug))
  const [step, setStep] = useState<'menu' | 'checkout'>('menu')
  const [cust, setCust] = useState<Customer>(() => ({ ...emptyCustomer, ...readStore<Partial<Customer>>('local', CUSTOMER_KEY, {}) }))
  const [notes, setNotes] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [picking, setPicking] = useState<MenuItem | null>(null)
  const [captcha, setCaptcha] = useState<string | null>(null)
  const captchaReset = useRef<() => void>(() => {})
  const last = readStore<{ token: string; no: number } | null>('local', lastOrderKey(slug), null)
  // κάρτα επιβράβευσης από την τελευταία παραγγελία της συσκευής (με το token της)
  const [prev, setPrev] = useState<{ phone: string; count: number } | null>(null)

  // QR σακούλας / φυλλάδιο: κρατιέται για όλη την επίσκεψη
  useEffect(() => {
    const src = (params.get('src') ?? '').toLowerCase()
    if (SOURCE_RE.test(src)) writeStore('session', sourceKey(slug), src)
  }, [params, slug])

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
  const lastToken = last?.token
  const asked = useRef<string | null>(null)
  useEffect(() => {
    if (step !== 'checkout' || !lastToken || !menu?.loyalty_every || asked.current === lastToken) return
    asked.current = lastToken
    const phone = readStore<Partial<Customer>>('local', CUSTOMER_KEY, {}).phone ?? ''
    supabase.rpc('order_status', { p_token: lastToken }).then(({ data }) => {
      const l = (data as OrderStatusInfo | null)?.loyalty
      if (l && phone) setPrev({ phone: digits(phone), count: Number(l.count) })
    })
  }, [step, lastToken, menu?.loyalty_every])

  // τρόποι πληρωμής του μαγαζιού (βάση χωρίς 0006: μετρητά και κάρτα)
  const payments = useMemo(() => {
    const out: OrderPayment[] = []
    if (!menu) return out
    if (menu.pay_cash !== false) out.push('cash')
    if (menu.pay_card_door !== false) out.push('card')
    if (menu.pay_online) out.push('online')
    return out
  }, [menu])

  // ό,τι δεν υποστηρίζει το μαγαζί → το άλλο
  useEffect(() => {
    if (!menu) return
    if (cust.mode === 'delivery' && !menu.delivery) setCust((c) => ({ ...c, mode: 'pickup' }))
    if (cust.mode === 'pickup' && !menu.pickup) setCust((c) => ({ ...c, mode: 'delivery' }))
    if (payments.length && !payments.includes(cust.payment)) setCust((c) => ({ ...c, payment: payments[0] }))
  }, [menu, cust.mode, cust.payment, payments])

  const byId = useMemo(() => new Map((menu?.items ?? []).map((i) => [i.id, i])), [menu])
  const extraById = useMemo(() => new Map((menu?.extras ?? []).map((x) => [x.id, x])), [menu])
  // ό,τι δεν υπάρχει πια στο μενού φεύγει από το καλάθι (και τα extras που έφυγαν)
  const lines = cart
    .filter((l) => l.qty > 0 && byId.has(l.item_id))
    .map((l) => {
      const item = byId.get(l.item_id)!
      const extras = item.extras_ok ? l.extras.map((x) => extraById.get(x)).filter((x): x is MenuExtra => !!x) : []
      const unit = item.price + extras.reduce((s, x) => s + x.price, 0)
      return { ...l, item, extrasFull: extras, unit, total: round(l.qty * unit) }
    })
  const count = lines.reduce((s, l) => s + l.qty, 0)
  const itemsTotal = round(lines.reduce((s, l) => s + l.total, 0))
  const fee = menu && cust.mode === 'delivery' ? Number(menu.delivery_fee) : 0
  // έκπτωση που ξέρουμε σίγουρα (επιβράβευση από την κάρτα)· την τελική τη βγάζει η βάση
  const loyaltyNow = !!menu?.loyalty_every && !!prev && prev.phone === digits(cust.phone)
    && (prev.count + 1) % Number(menu.loyalty_every) === 0
  const discount = loyaltyNow ? round(itemsTotal * Number(menu!.loyalty_pct) / 100) : 0
  const welcomeMaybe = !!menu?.welcome_pct && !last
  const total = round(itemsTotal - discount + fee)
  const belowMin = !!menu && itemsTotal < Number(menu.min_order)
  const extrasOn = (it: MenuItem) => !!it.extras_ok && (menu?.extras?.length ?? 0) > 0

  const qtyOf = (id: string) => cart.filter((l) => l.item_id === id).reduce((s, l) => s + l.qty, 0)
  const addLine = (item_id: string, qty = 1, extras: string[] = [], note = '') => setCart((c) => {
    const same = c.find((l) => l.item_id === item_id && l.note === note && l.extras.join() === [...extras].sort().join())
    if (same) return c.map((l) => (l === same ? { ...l, qty: Math.min(50, l.qty + qty) } : l))
    return [...c, { key: newKey(), item_id, qty, note, extras: [...extras].sort() }]
  })
  const setLineQty = (key: string, qty: number) =>
    setCart((c) => (qty <= 0 ? c.filter((l) => l.key !== key) : c.map((l) => (l.key === key ? { ...l, qty: Math.min(50, qty) } : l))))
  const setLineNote = (key: string, note: string) => setCart((c) => c.map((l) => (l.key === key ? { ...l, note } : l)))

  const groups = useMemo(() => {
    const out: { cat: string; items: MenuItem[] }[] = []
    for (const it of menu?.items ?? []) {
      const cat = it.category?.trim() || 'Μενού'
      const g = out.find((x) => x.cat === cat)
      if (g) g.items.push(it); else out.push({ cat, items: [it] })
    }
    return out
  }, [menu])

  const needServer = !!menu?.captcha_site_key || cust.payment === 'online'

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!menu) return
    setError(null)
    if (cust.name.trim().length < 2) { setError('Γράψε το όνομά σου.'); return }
    if (!phoneLooksValid(cust.phone)) { setError('Γράψε ένα σωστό τηλέφωνο (10 ψηφία).'); return }
    if (cust.mode === 'delivery' && cust.address.trim().length < 5) { setError('Γράψε τη διεύθυνση για τη διανομή.'); return }
    if (menu.captcha_site_key && !captcha) { setError('Τσέκαρε το «δεν είμαι ρομπότ» παραπάνω.'); return }
    const order: OrderInput = {
      name: cust.name.trim(),
      phone: cust.phone.trim(),
      mode: cust.mode,
      address: cust.mode === 'delivery' ? cust.address.trim() : null,
      payment: cust.payment,
      notes: notes.trim() || null,
      source: readStore<string | null>('session', sourceKey(slug), null),
      lines: lines.map((l) => ({ item_id: l.item.id, qty: l.qty, note: l.note.trim() || null, extras: l.extrasFull.map((x) => x.id) })),
    }
    setSending(true)
    try {
      let r: { token: string; order_no: number; redirect?: string }
      if (needServer) {
        r = await callFunction('shop-checkout', { slug, order, captcha })
      } else {
        const { data, error: er } = await supabase.rpc('place_order', { p_slug: slug, p_order: order })
        if (er) throw new Error(errMsg(er))
        r = data as { token: string; order_no: number }
      }
      writeStore('local', CUSTOMER_KEY, cust)
      writeStore('local', lastOrderKey(slug), { token: r.token, no: r.order_no })
      // και κατευθείαν στο storage: με τη μετάβαση η σελίδα φεύγει πριν γραφτεί το άδειο καλάθι
      writeStore('session', cartKey(slug), [])
      setCart([])
      setPrev(null)
      asked.current = null
      if (r.redirect) {
        // πληρωμή στον πάροχο (ή στη δοκιμαστική σελίδα)· γυρίζει στη σελίδα της παραγγελίας
        window.location.assign(r.redirect)
        return
      }
      nav(`/s/${slug}/o/${r.token}`)
    } catch (er) {
      const msg = er instanceof Error ? er.message : String(er)
      setError(msg)
      captchaReset.current()
      setCaptcha(null)
      if (/διαθέσιμο|δεν δέχεται/.test(msg)) load()
    } finally {
      setSending(false)
    }
  }

  if (loadError && menu === undefined) {
    return <Centered>
      <p className="mb-3">{loadError}</p>
      <button className="btn-primary" onClick={load}>Ξανά</button>
    </Centered>
  }
  if (menu === undefined) return <Centered>Φόρτωση...</Centered>
  if (menu === null) return <Centered>Δεν βρέθηκε το κατάστημα. Έλεγξε τη διεύθυνση.</Centered>

  const payLabel = (p: OrderPayment) => p === 'cash' ? 'Μετρητά'
    : p === 'card' ? (cust.mode === 'delivery' ? 'Κάρτα στην πόρτα' : 'Κάρτα στο ταμείο')
    : 'Online τώρα'

  return (
    <div className="min-h-screen bg-stone-100 pb-28">
      <ShopHeader name={menu.name} phone={menu.phone} open={menu.open} />
      <div className="max-w-2xl mx-auto px-4">
        {menu.note && <p className="text-sm text-stone-600 mt-3">{menu.note}</p>}
        {!menu.open && (
          <div className="rounded-md bg-amber-50 border border-amber-200 text-amber-900 text-sm px-3 py-2 mt-3">
            Αυτή τη στιγμή δεν δεχόμαστε online παραγγελίες.
            {menu.phone && <> Πάρε μας τηλέφωνο: <a className="underline font-medium" href={telHref(menu.phone)}>{menu.phone}</a></>}
          </div>
        )}
        {step === 'menu' && (menu.welcome_pct || menu.loyalty_every) && (
          <div className="rounded-md bg-emerald-50 border border-emerald-200 text-emerald-900 text-sm px-3 py-2 mt-3 grid gap-0.5">
            {menu.welcome_pct && !last && <div>🎁 <b>−{Number(menu.welcome_pct)}%</b> στην πρώτη σου απευθείας παραγγελία</div>}
            {menu.loyalty_every && <div>⭐ Κάθε <b>{menu.loyalty_every}η</b> παραγγελία <b>−{Number(menu.loyalty_pct)}%</b></div>}
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
                    const mine = lines.filter((l) => l.item_id === it.id)
                    const plain = !extrasOn(it) ? mine[0] : undefined
                    return (
                      <div key={it.id} className="p-3">
                        <div className="flex items-start gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="font-medium">{it.name}</div>
                            {it.description && <div className="text-sm text-stone-500">{it.description}</div>}
                            <div className="text-sm font-semibold mt-1 tabular-nums">{fmtMoney(it.price)}</div>
                          </div>
                          {plain ? (
                            <Stepper label={it.name} qty={plain.qty} onChange={(q) => setLineQty(plain.key, q)} />
                          ) : (
                            <button type="button" className="btn-primary h-11 shrink-0" disabled={!menu.open}
                              onClick={() => (extrasOn(it) ? setPicking(it) : addLine(it.id))}>
                              + Προσθήκη{qtyOf(it.id) > 0 ? ` (${qtyOf(it.id)})` : ''}
                            </button>
                          )}
                        </div>
                        {plain && (
                          <input className="input mt-2" maxLength={100} value={plain.note} onChange={(e) => setLineNote(plain.key, e.target.value)}
                            placeholder="Σημείωση (π.χ. χωρίς κρεμμύδι)" aria-label={`Σημείωση για ${it.name}`} />
                        )}
                        {extrasOn(it) && mine.length > 0 && (
                          <ul className="mt-2 grid gap-1">
                            {mine.map((l) => (
                              <li key={l.key} className="flex items-center gap-2 rounded-md bg-stone-50 px-2 py-1 text-sm">
                                <span className="flex-1 min-w-0">
                                  {l.extrasFull.length ? '+ ' + l.extrasFull.map((x) => x.name).join(', ') : 'Χωρίς extra'}
                                  {l.note && <span className="text-stone-500"> · {l.note}</span>}
                                </span>
                                <Stepper small label={it.name} qty={l.qty} onChange={(q) => setLineQty(l.key, q)} />
                              </li>
                            ))}
                          </ul>
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
                  <li key={l.key} className="py-1.5 flex gap-2">
                    <span className="tabular-nums w-8">{l.qty}×</span>
                    <span className="flex-1">
                      {l.item.name}
                      {l.extrasFull.length > 0 && <span className="text-stone-600"> + {l.extrasFull.map((x) => x.name).join(', ')}</span>}
                      {l.note.trim() && <span className="text-stone-500"> ({l.note.trim()})</span>}
                    </span>
                    <span className="tabular-nums">{fmtMoney(l.total)}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="card p-4 grid gap-3">
              {menu.delivery && menu.pickup && (
                <Choice label="Τρόπος" value={cust.mode} options={(['delivery', 'pickup'] as const).map((m) => ({
                  value: m, text: MODE_LABEL[m] + (m === 'delivery' && Number(menu.delivery_fee) > 0 ? ` (+${fmtMoney(menu.delivery_fee)})` : ''),
                }))} onChange={(m) => setCust({ ...cust, mode: m })} />
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
              {payments.length > 1 && (
                <Choice label="Πληρωμή" value={cust.payment} options={payments.map((p) => ({ value: p, text: payLabel(p) }))}
                  onChange={(p) => setCust({ ...cust, payment: p })} />
              )}
              {payments.length === 1 && <p className="text-sm text-stone-600">Πληρωμή: {payLabel(payments[0])}.</p>}
              {cust.payment === 'online' && (
                <p className="text-xs text-stone-500 -mt-1">
                  Με κάρτα, Apple Pay, Google Pay ή IRIS, στη σελίδα ασφαλούς πληρωμής. Αν το μαγαζί δεν μπορέσει να την ετοιμάσει, τα χρήματα επιστρέφονται.
                  {menu.pay_test && <b className="text-amber-800"> Δοκιμαστική λειτουργία: δεν χρεώνεται τίποτα.</b>}
                </p>
              )}
              {menu.captcha_site_key && (
                <Turnstile siteKey={menu.captcha_site_key} onToken={setCaptcha} resetRef={captchaReset} />
              )}
            </div>

            <div className="card p-4 text-sm grid gap-1">
              <div className="flex justify-between"><span>Προϊόντα</span><span className="tabular-nums">{fmtMoney(itemsTotal)}</span></div>
              {discount > 0 && (
                <div className="flex justify-between text-emerald-800">
                  <span>⭐ Επιβράβευση −{Number(menu.loyalty_pct)}% ({menu.loyalty_every}η παραγγελία)</span><span className="tabular-nums">−{fmtMoney(discount)}</span>
                </div>
              )}
              {fee > 0 && <div className="flex justify-between"><span>Μεταφορικά</span><span className="tabular-nums">{fmtMoney(fee)}</span></div>}
              <div className="flex justify-between text-base font-semibold"><span>Σύνολο</span><span className="tabular-nums">{fmtMoney(total)}</span></div>
              {welcomeMaybe && (
                <div className="text-emerald-800 text-xs mt-1">
                  🎁 Αν είναι η πρώτη σου παραγγελία από αυτό το τηλέφωνο, έχεις −{Number(menu.welcome_pct)}% στα προϊόντα (θα το δεις στην επιβεβαίωση{cust.payment === 'online' ? ' και στην πληρωμή' : ''}).
                </div>
              )}
              {belowMin && <div className="text-amber-800 mt-1">Η ελάχιστη παραγγελία είναι {fmtMoney(menu.min_order)}.</div>}
            </div>

            {error && <div role="alert" className="rounded-md bg-red-50 border border-red-200 text-red-800 text-sm px-3 py-2">{error}</div>}
            <button className="btn-primary h-14 text-base" disabled={sending || !menu.open || belowMin || lines.length === 0}>
              {sending ? 'Αποστολή...' : cust.payment === 'online' ? `Πληρωμή · ${fmtMoney(total)}` : `Στείλε την παραγγελία · ${fmtMoney(total)}`}
            </button>
            <p className="text-xs text-stone-500 text-center -mt-2">
              Το μαγαζί τη βλέπει αμέσως και σου λέει σε πόση ώρα θα είναι έτοιμη. Τα στοιχεία σου πάνε μόνο στο μαγαζί,
              για την παραγγελία (<Link className="underline" to={`/s/${slug}/privacy`}>απόρρητο</Link>).
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

      {picking && (
        <ExtrasPicker item={picking} extras={menu.extras ?? []} onClose={() => setPicking(null)}
          onAdd={(qty, extras, note) => { addLine(picking.id, qty, extras, note); setPicking(null) }} />
      )}
    </div>
  )
}

function Stepper({ label, qty, onChange, small = false }: { label: string; qty: number; onChange: (q: number) => void; small?: boolean }) {
  const b = small ? 'h-9 w-9 text-lg' : 'h-11 w-11 text-xl'
  return (
    <div className="flex items-center gap-1 shrink-0">
      <button type="button" className={`btn-secondary p-0 ${b}`} aria-label={`Ένα λιγότερο ${label}`} onClick={() => onChange(qty - 1)}>−</button>
      <span className="w-8 text-center font-semibold tabular-nums" aria-live="polite">{qty}</span>
      <button type="button" className={`btn-secondary p-0 ${b}`} aria-label={`Ένα ακόμα ${label}`} onClick={() => onChange(qty + 1)}>+</button>
    </div>
  )
}

function Choice<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; text: string }[]; onChange: (v: T) => void }) {
  return (
    <div>
      <span className="label">{label}</span>
      <div className={'grid gap-2 ' + (options.length >= 3 ? 'grid-cols-1 sm:grid-cols-3' : 'grid-cols-2')} role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button key={o.value} type="button" role="radio" aria-checked={value === o.value}
            className={'min-h-12 rounded-md border text-sm font-medium px-2 ' + (value === o.value ? 'bg-red-700 text-white border-red-700' : 'bg-white border-stone-300')}
            onClick={() => onChange(o.value)}>
            {o.text}
          </button>
        ))}
      </div>
    </div>
  )
}

/** «Θέλεις κάτι extra;»: ποσότητα, extras, σημείωση */
function ExtrasPicker({ item, extras, onAdd, onClose }: {
  item: MenuItem; extras: MenuExtra[]; onAdd: (qty: number, extras: string[], note: string) => void; onClose: () => void
}) {
  const [qty, setQty] = useState(1)
  const [chosen, setChosen] = useState<string[]>([])
  const [note, setNote] = useState('')
  const unit = item.price + extras.filter((x) => chosen.includes(x.id)).reduce((s, x) => s + x.price, 0)
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-end sm:items-center justify-center" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-label={item.name} className="bg-white w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl p-4 max-h-[90vh] overflow-y-auto"
        onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-3 mb-3">
          <div className="flex-1">
            <div className="text-lg font-semibold">{item.name}</div>
            {item.description && <div className="text-sm text-stone-500">{item.description}</div>}
          </div>
          <button className="btn-ghost px-2 py-1" onClick={onClose} aria-label="Κλείσιμο">✕</button>
        </div>
        <div className="text-sm font-medium mb-1">Θέλεις κάτι extra;</div>
        <div className="grid gap-1 mb-3">
          {extras.map((x) => (
            <label key={x.id} className="flex items-center gap-3 rounded-md border border-stone-200 px-3 py-2">
              <input type="checkbox" className="h-5 w-5" checked={chosen.includes(x.id)}
                onChange={(e) => setChosen((c) => (e.target.checked ? [...c, x.id] : c.filter((y) => y !== x.id)))} />
              <span className="flex-1">{x.name}</span>
              <span className="tabular-nums text-sm">+{fmtMoney(x.price)}</span>
            </label>
          ))}
        </div>
        <input className="input mb-3" maxLength={100} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Σημείωση (π.χ. χωρίς κρεμμύδι)" />
        <div className="flex items-center gap-3">
          <Stepper label={item.name} qty={qty} onChange={(q) => setQty(Math.max(1, Math.min(50, q)))} />
          <button className="btn-primary h-12 flex-1 text-base" onClick={() => onAdd(qty, chosen, note.trim())}>
            Πρόσθεσε · {fmtMoney(round(qty * unit))}
          </button>
        </div>
      </div>
    </div>
  )
}
