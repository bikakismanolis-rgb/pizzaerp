import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useCompany } from '../context/CompanyContext'
import { useMaster } from '../context/MasterData'
import { errMsg, supabase } from '../lib/supabase'
import { fmtMoney, round, toNum } from '../lib/format'
import { grossPrice, shopUrl, slugify, slugValid, type OnlineShop } from '../lib/online'
import { loadShop } from '../lib/orders/orderActions'
import { qrSvg } from '../lib/qr'
import { ErrorBox, Field, NumInput, PageTitle, Spinner, useToast } from '../components/ui'

/**
 * Ρυθμίσεις του site: διεύθυνση, στοιχεία, διανομή / παραλαβή, ποια είδη
 * φαίνονται, QR για τις σακούλες. Τις αλλάζει μόνο ο ιδιοκτήτης (RLS).
 */

interface Form {
  slug: string
  title: string
  phone: string
  note: string
  delivery: boolean
  pickup: boolean
  delivery_fee: string
  min_order: string
  closes_at: string
  compare_fee_pct: string
}

const toForm = (s: OnlineShop): Form => ({
  slug: s.slug, title: s.title, phone: s.phone ?? '', note: s.note ?? '', delivery: s.delivery, pickup: s.pickup,
  delivery_fee: String(s.delivery_fee ?? 0), min_order: String(s.min_order ?? 0), closes_at: (s.closes_at ?? '23:30').slice(0, 5),
  compare_fee_pct: s.compare_fee_pct == null ? '' : String(s.compare_fee_pct),
})

function friendly(msg: string): string {
  if (/online_shop_slug/.test(msg) && /duplicate|unique/i.test(msg)) return 'Αυτή τη διεύθυνση την έχει ήδη άλλο μαγαζί. Διάλεξε άλλη.'
  if (/online_shop_slug_check/.test(msg)) return 'Η διεύθυνση θέλει μόνο λατινικά πεζά, αριθμούς και παύλες (3 έως 40).'
  if (/row-level security/.test(msg)) return 'Μόνο ο ιδιοκτήτης αλλάζει τις ρυθμίσεις του site.'
  return msg
}

export function ShopSettings() {
  const { company } = useCompany()
  const { items, refresh } = useMaster()
  const toast = useToast()
  const [shop, setShop] = useState<OnlineShop | null | 'missing' | undefined>(undefined)
  const [form, setForm] = useState<Form | null>(null)
  const [slugTouched, setSlugTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!company) return
    let alive = true
    loadShop(company.id).then((s) => {
      if (!alive) return
      setShop(s)
      if (s === 'missing') return
      if (s) { setForm(toForm(s)); setSlugTouched(true) }
      else {
        setForm({
          slug: slugify(company.name), title: company.name, phone: company.phone ?? '', note: '', delivery: true, pickup: true,
          delivery_fee: '0', min_order: '0', closes_at: '23:30', compare_fee_pct: '',
        })
      }
    }).catch((e) => { if (alive) setError(errMsg(e)) })
    return () => { alive = false }
  }, [company])

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f))

  // είδη για το site: έτοιμα, ενεργά
  const finished = useMemo(() => items.filter((i) => i.item_type === 'finished' && i.is_active), [items])
  const onlineCount = finished.filter((i) => i.online).length
  const noPrice = finished.filter((i) => i.online && !(Number(i.sale_price) > 0))

  const save = async (e: FormEvent) => {
    e.preventDefault()
    if (!form || !company) return
    setError(null)
    const slug = form.slug.trim().toLowerCase()
    if (!slugValid(slug)) { setError('Η διεύθυνση θέλει μόνο λατινικά πεζά, αριθμούς και παύλες (3 έως 40).'); return }
    if (!form.title.trim()) { setError('Γράψε το όνομα που βλέπει ο πελάτης.'); return }
    if (!form.delivery && !form.pickup) { setError('Διάλεξε διανομή, παραλαβή ή και τα δύο.'); return }
    const payload = {
      company_id: company.id,
      slug,
      title: form.title.trim(),
      phone: form.phone.trim() || null,
      note: form.note.trim() || null,
      delivery: form.delivery,
      pickup: form.pickup,
      delivery_fee: round(toNum(form.delivery_fee)),
      min_order: round(toNum(form.min_order)),
      closes_at: form.closes_at || '23:30',
      compare_fee_pct: form.compare_fee_pct.trim() === '' ? null : round(toNum(form.compare_fee_pct)),
    }
    setBusy(true)
    try {
      const q = shop
        ? supabase.from('online_shop').update(payload).eq('company_id', company.id).select('*')
        : supabase.from('online_shop').insert(payload).select('*')
      const { data, error: er } = await q
      if (er) throw er
      const row = (data ?? [])[0] as OnlineShop | undefined
      // update χωρίς δικαίωμα: καμία γραμμή, χωρίς σφάλμα
      if (!row) throw new Error('row-level security')
      setShop(row)
      setForm(toForm(row))
      toast.ok('Αποθηκεύτηκε')
    } catch (err) {
      setError(friendly(errMsg(err)))
    } finally {
      setBusy(false)
    }
  }

  const setOnline = async (ids: string[], online: boolean) => {
    if (ids.length === 0) return
    setBusy(true)
    const { error: er } = await supabase.from('item').update({ online }).in('id', ids)
    setBusy(false)
    if (er) { setError(errMsg(er)); return }
    await refresh()
  }

  const printFlyer = () => {
    if (!shop || shop === 'missing') return
    const url = shopUrl(shop.slug)
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))
    const card = `
      <div class="card">
        <div class="title">${esc(shop.title)}</div>
        <div class="big">Παράγγειλε απευθείας από εμάς</div>
        <div class="qr">${qrSvg(url)}</div>
        <div class="url">${esc(url.replace(/^https?:\/\//, ''))}</div>
        ${shop.phone ? `<div class="phone">📞 ${esc(shop.phone)}</div>` : ''}
      </div>`
    const w = window.open('', '_blank')
    if (!w) { toast.err('Ο browser μπλόκαρε το νέο παράθυρο. Επέτρεψε τα αναδυόμενα για εκτύπωση.'); return }
    w.document.write(`<!doctype html><html lang="el"><head><meta charset="utf-8"><title>QR ${esc(shop.title)}</title>
      <style>
        @page { size: A4; margin: 10mm; }
        body { font-family: system-ui, sans-serif; margin: 0; }
        .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6mm; }
        .card { border: 1px dashed #999; border-radius: 4mm; padding: 6mm; text-align: center; break-inside: avoid; }
        .title { font-size: 16pt; font-weight: 700; color: #b91c1c; }
        .big { font-size: 13pt; margin: 2mm 0 3mm; }
        .qr svg { width: 45mm; height: 45mm; }
        .url { font-size: 10pt; margin-top: 2mm; word-break: break-all; }
        .phone { font-size: 11pt; margin-top: 1mm; }
      </style></head><body><div class="grid">${card.repeat(4)}</div>
      <script>window.onload = function () { window.print() }</script></body></html>`)
    w.document.close()
  }

  if (shop === undefined && !error) return <Spinner />
  if (shop === 'missing') {
    return (
      <div>
        <PageTitle title="Ρυθμίσεις site" />
        <div className="card p-4 text-sm">Η βάση δεν έχει ακόμα τις online παραγγελίες. Χρειάζεται το <code>supabase/migrations/0005_online.sql</code> (βλ. README).</div>
      </div>
    )
  }
  if (!form) return <ErrorBox text={error} />

  const url = shopUrl(slugValid(form.slug) ? form.slug : '…')

  return (
    <div>
      <PageTitle title="Ρυθμίσεις site">
        <Link to="/orders" className="btn-secondary">Παραγγελίες</Link>
      </PageTitle>
      <ErrorBox text={error} />

      <div className="grid gap-4 lg:grid-cols-2">
        <form onSubmit={save} className="card p-4 grid gap-3 content-start sm:grid-cols-2">
          <Field label="Όνομα που βλέπει ο πελάτης" className="sm:col-span-2">
            <input className="input" maxLength={80} value={form.title} onChange={(e) => {
              set('title', e.target.value)
              if (!slugTouched) set('slug', slugify(e.target.value))
            }} />
          </Field>
          <Field label="Διεύθυνση (λατινικά, π.χ. pizza-gonia)" className="sm:col-span-2">
            <input className="input" maxLength={40} value={form.slug} onChange={(e) => { setSlugTouched(true); set('slug', e.target.value.toLowerCase().replace(/\s+/g, '-')) }} />
            <div className={'text-xs mt-1 break-all ' + (slugValid(form.slug) ? 'text-stone-500' : 'text-red-700')}>{url}</div>
          </Field>
          <Field label="Τηλέφωνο μαγαζιού">
            <input className="input" type="tel" maxLength={30} value={form.phone} onChange={(e) => set('phone', e.target.value)} />
          </Field>
          <Field label="Κλείνει αυτόματα στις">
            <input className="input" type="time" value={form.closes_at} onChange={(e) => set('closes_at', e.target.value)} />
          </Field>
          <Field label="Σημείωση για τον πελάτη (προαιρετικό)" className="sm:col-span-2">
            <input className="input" maxLength={300} value={form.note} onChange={(e) => set('note', e.target.value)} placeholder="π.χ. Διανομή στο κέντρο και στη Νέα Αλικαρνασσό" />
          </Field>
          <label className="text-sm flex items-center gap-2">
            <input type="checkbox" checked={form.delivery} onChange={(e) => set('delivery', e.target.checked)} /> Διανομή
          </label>
          <label className="text-sm flex items-center gap-2">
            <input type="checkbox" checked={form.pickup} onChange={(e) => set('pickup', e.target.checked)} /> Παραλαβή από το μαγαζί
          </label>
          <Field label="Μεταφορικά (€, με ΦΠΑ)">
            <NumInput value={form.delivery_fee} onChange={(v) => set('delivery_fee', v)} min={0} disabled={!form.delivery} />
          </Field>
          <Field label="Ελάχιστη παραγγελία (€)">
            <NumInput value={form.min_order} onChange={(v) => set('min_order', v)} min={0} />
          </Field>
          <Field label="Προμήθεια πλατφόρμας για σύγκριση (%)" className="sm:col-span-2">
            <NumInput value={form.compare_fee_pct} onChange={(v) => set('compare_fee_pct', v)} min={0} placeholder="π.χ. 30" />
            <div className="text-xs text-stone-500 mt-1">Μόνο για την αναφορά «τι γλίτωσες»· βάλε ό,τι γράφει η σύμβασή σου με efood / Wolt.</div>
          </Field>
          <div className="sm:col-span-2 flex justify-end">
            <button className="btn-primary" disabled={busy}>{shop ? 'Αποθήκευση' : 'Στήσε το site'}</button>
          </div>
        </form>

        <div className="grid gap-4 content-start">
          {shop && (
            <div className="card p-4 flex gap-4 items-start">
              <div className="w-32 shrink-0" dangerouslySetInnerHTML={{ __html: qrSvg(shopUrl(shop.slug)) }} aria-label="QR της σελίδας του μαγαζιού" />
              <div className="text-sm min-w-0">
                <div className="font-semibold mb-1">Η σελίδα σου</div>
                <a className="text-red-700 underline break-all" href={shopUrl(shop.slug)} target="_blank" rel="noreferrer">{shopUrl(shop.slug)}</a>
                <p className="text-stone-600 mt-2">Τύπωσε το QR και βάλ' το σε κάθε σακούλα που φεύγει από efood / Wolt: «την επόμενη φορά παράγγειλε απευθείας».</p>
                <div className="flex flex-wrap gap-2 mt-2">
                  <button className="btn-secondary" onClick={printFlyer}>Εκτύπωση QR (4 ανά σελίδα)</button>
                  <button className="btn-ghost" onClick={() => { void navigator.clipboard?.writeText(shopUrl(shop.slug)).then(() => toast.ok('Αντιγράφηκε')) }}>Αντιγραφή</button>
                </div>
              </div>
            </div>
          )}

          <div className="card p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
              <h2 className="font-semibold">Τι φαίνεται στο site ({onlineCount} από {finished.length})</h2>
              <button className="btn-secondary" disabled={busy}
                onClick={() => setOnline(finished.filter((i) => !i.online && Number(i.sale_price) > 0).map((i) => i.id), true)}>
                Όλα όσα έχουν τιμή
              </button>
            </div>
            {noPrice.length > 0 && <p className="text-xs text-amber-800 mb-2">Χωρίς τιμή δεν φαίνονται: {noPrice.map((i) => i.name).join(', ')}.</p>}
            {finished.length === 0 && <p className="text-sm text-stone-500">Δεν υπάρχουν έτοιμα προϊόντα ακόμα.</p>}
            <ul className="divide-y divide-stone-100 text-sm">
              {finished.map((i) => (
                <li key={i.id} className="py-1.5 flex items-center gap-2">
                  <input type="checkbox" checked={!!i.online} disabled={busy} onChange={(e) => setOnline([i.id], e.target.checked)} aria-label={`${i.name} στο site`} />
                  <Link to={`/items/${i.id}`} className="flex-1 hover:underline">{i.name}</Link>
                  <span className="text-stone-500">{i.category ?? ''}</span>
                  <span className="tabular-nums w-20 text-right">{fmtMoney(grossPrice(i.sale_price, i.vat_rate))}</span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-stone-500 mt-2">Τιμές με ΦΠΑ, όπως τις βλέπει ο πελάτης. Περιγραφή για το site γράφεις στο κάθε είδος.</p>
          </div>
        </div>
      </div>
    </div>
  )
}
