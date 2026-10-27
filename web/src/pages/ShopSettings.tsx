import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useCompany } from '../context/CompanyContext'
import { useMaster } from '../context/MasterData'
import { errMsg, supabase } from '../lib/supabase'
import { fmtMoney, round, toNum } from '../lib/format'
import { grossPrice, PAY_PROVIDER_LABEL, shopUrl, slugify, slugValid, SOURCES, type OnlineShop, type PayProvider } from '../lib/online'
import { loadShop } from '../lib/orders/orderActions'
import { qrSvg } from '../lib/qr'
import { ErrorBox, Field, NumInput, PageTitle, Spinner, useToast } from '../components/ui'
import { SecretField, useSecretNames } from '../components/Secrets'

/**
 * Ρυθμίσεις του site: διεύθυνση, στοιχεία, διανομή / παραλαβή, ποια είδη
 * φαίνονται, QR για τις σακούλες, πληρωμές (μετρητά, κάρτα, online με
 * Viva ή Stripe) και CAPTCHA. Τις αλλάζει μόνο ο ιδιοκτήτης (RLS).
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

  // είδη για το site: έτοιμα, ενεργά (όχι υπηρεσίες, π.χ. μεταφορικά)
  const finished = useMemo(() => items.filter((i) => i.item_type === 'finished' && i.is_active && !i.is_service), [items])
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

  // QR ανά πηγή (?src=bag κλπ): η μηνιαία σύνοψη δείχνει από πού ήρθαν οι παραγγελίες
  const [qrSource, setQrSource] = useState(SOURCES[0].value)
  const printFlyer = () => {
    if (!shop || shop === 'missing') return
    const src = SOURCES.find((x) => x.value === qrSource) ?? SOURCES[0]
    const url = `${shopUrl(shop.slug)}?src=${src.value}`
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))
    const perk = shop.welcome_pct ? `<div class="perk">−${Number(shop.welcome_pct)}% στην πρώτη σου απευθείας παραγγελία</div>` : ''
    const card = `
      <div class="card">
        <div class="title">${esc(shop.title)}</div>
        <div class="big">${esc(src.flyer)}</div>
        ${perk}
        <div class="qr">${qrSvg(url)}</div>
        <div class="url">${esc(shopUrl(shop.slug).replace(/^https?:\/\//, ''))}</div>
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
        .perk { font-size: 14pt; font-weight: 800; color: #047857; margin-bottom: 2mm; }
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
                  <select className="input w-auto" value={qrSource} onChange={(e) => setQrSource(e.target.value)} aria-label="Για πού είναι τα QR">
                    {SOURCES.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
                  </select>
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
                  <Link to={`/items/${i.id}`} className="flex-1 hover:underline">
                    {i.name}{i.is_extra && <span className="badge bg-sky-100 text-sky-800 ml-1">extra</span>}
                  </Link>
                  <span className="text-stone-500">{i.category ?? ''}</span>
                  <span className="tabular-nums w-20 text-right">{fmtMoney(grossPrice(i.sale_price, i.vat_rate))}</span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-stone-500 mt-2">
              Τιμές με ΦΠΑ, όπως τις βλέπει ο πελάτης. Περιγραφή για το site γράφεις στο κάθε είδος.
              Extra (π.χ. «Extra μοτσαρέλα»): είδος με «Είναι extra» τσεκαρισμένο· ο πελάτης το διαλέγει πάνω στις πίτσες που φτιάχνονται κατά παραγγελία.
            </p>
          </div>

          {shop && 'welcome_pct' in shop && company && (
            <RewardsCard shop={shop} companyId={company.id} onSaved={(row) => { setShop(row); setForm(toForm(row)) }} />
          )}

          {shop && shop.pay_provider !== undefined && company && (
            <PayCard shop={shop} companyId={company.id} onSaved={(row) => { setShop(row); setForm(toForm(row)) }} />
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------
// Πληρωμές και CAPTCHA (0006)
// ---------------------------------------------------------------------
const PROVIDERS: PayProvider[] = ['none', 'test', 'viva', 'stripe']
const fnUrl = (name: string) => `${String(import.meta.env.VITE_SUPABASE_URL ?? '').replace(/\/$/, '')}/functions/v1/${name}`

function PayCard({ shop, companyId, onSaved }: { shop: OnlineShop; companyId: string; onSaved: (s: OnlineShop) => void }) {
  const toast = useToast()
  const { names, reload } = useSecretNames(companyId)
  const [cash, setCash] = useState(shop.pay_cash !== false)
  const [door, setDoor] = useState(shop.pay_card_door !== false)
  const [prov, setProv] = useState<PayProvider>(shop.pay_provider ?? 'none')
  const [live, setLive] = useState(!!shop.pay_live)
  const [captcha, setCaptcha] = useState(shop.captcha_site_key ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const missing = prov === 'viva' ? ['viva_client_id', 'viva_client_secret', 'viva_merchant_id', 'viva_api_key'].filter((n) => !names[n])
    : prov === 'stripe' ? ['stripe_secret_key', 'stripe_webhook_secret'].filter((n) => !names[n]) : []

  const save = async () => {
    setError(null)
    if (!cash && !door && prov === 'none') { setError('Άφησε έναν τουλάχιστον τρόπο πληρωμής.'); return }
    const key = captcha.trim()
    if (key && !/^[A-Za-z0-9_-]{8,100}$/.test(key)) { setError('Το Site Key του Turnstile δεν μοιάζει σωστό (π.χ. 0x4AAAAAAA...).'); return }
    if (key && !names.turnstile_secret) { setError('Βάλε πρώτα και το Secret Key του Turnstile (από κάτω), αλλιώς δεν θα περνάει καμία παραγγελία.'); return }
    setBusy(true)
    const { data, error: er } = await supabase.from('online_shop')
      .update({ pay_cash: cash, pay_card_door: door, pay_provider: prov, pay_live: live, captcha_site_key: key || null })
      .eq('company_id', companyId).select('*')
    setBusy(false)
    if (er) { setError(errMsg(er)); return }
    const row = (data ?? [])[0] as OnlineShop | undefined
    if (!row) { setError('Μόνο ο ιδιοκτήτης αλλάζει τις πληρωμές.'); return }
    onSaved(row)
    toast.ok('Αποθηκεύτηκαν οι πληρωμές')
  }

  const copy = (t: string) => { void navigator.clipboard?.writeText(t).then(() => toast.ok('Αντιγράφηκε')) }
  const webhook = `${fnUrl('payments-webhook')}?provider=${prov}&company=${companyId}`

  return (
    <div className="card p-4 grid gap-3">
      <h2 className="font-semibold">Πληρωμές</h2>
      <ErrorBox text={error} />
      <label className="text-sm flex items-center gap-2"><input type="checkbox" checked={cash} onChange={(e) => setCash(e.target.checked)} /> Μετρητά (στην πόρτα / στο ταμείο)</label>
      <label className="text-sm flex items-center gap-2"><input type="checkbox" checked={door} onChange={(e) => setDoor(e.target.checked)} /> Κάρτα στην πόρτα (POS του διανομέα)</label>

      <div>
        <span className="label">Online πληρωμή με κάρτα / IRIS</span>
        <div className="grid gap-1">
          {PROVIDERS.map((p) => (
            <label key={p} className="text-sm flex items-center gap-2">
              <input type="radio" name="pay-provider" checked={prov === p} onChange={() => setProv(p)} /> {PAY_PROVIDER_LABEL[p]}
            </label>
          ))}
        </div>
      </div>

      {prov === 'test' && (
        <p className="text-xs text-amber-800">
          Δοκιμαστική: ο πελάτης βλέπει μια σελίδα «Πλήρωσε (δοκιμή)» αντί για κάρτα. Για να δεις όλη τη ροή (πληρωμή, απόρριψη, επιστροφή) πριν ανοίξεις λογαριασμό. Μην την αφήσεις ανοιχτή για πελάτες.
        </p>
      )}

      {(prov === 'viva' || prov === 'stripe') && (
        <div className="grid gap-3 rounded-md bg-stone-50 p-3">
          <label className="text-sm flex items-center gap-2">
            <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
            Πραγματικές πληρωμές {live ? '' : <span className="text-stone-500">(τώρα: δοκιμαστικός λογαριασμός {prov === 'viva' ? 'demo' : 'test mode'})</span>}
          </label>
          {prov === 'viva' && (
            <>
              <p className="text-xs text-stone-600">
                Viva → Settings → API Access. Στην πηγή πληρωμών (Sales → Online Payments → Websites/Apps) βάλε Success URL και Failure URL:{' '}
                <code className="break-all">{window.location.origin}/pay/viva</code>{' '}
                <button type="button" className="underline" onClick={() => copy(`${window.location.origin}/pay/viva`)}>αντιγραφή</button>.
                Webhooks «Transaction Payment Created» και «Transaction Failed»: <code className="break-all">{webhook}</code>{' '}
                <button type="button" className="underline" onClick={() => copy(webhook)}>αντιγραφή</button>.
              </p>
              <SecretField companyId={companyId} name="viva_client_id" label="Smart Checkout Client ID" saved={names.viva_client_id} onSaved={reload} />
              <SecretField companyId={companyId} name="viva_client_secret" label="Smart Checkout Client Secret" saved={names.viva_client_secret} onSaved={reload} />
              <SecretField companyId={companyId} name="viva_merchant_id" label="Merchant ID" saved={names.viva_merchant_id} onSaved={reload} />
              <SecretField companyId={companyId} name="viva_api_key" label="API Key" help="Για τα webhooks και τις επιστροφές χρημάτων." saved={names.viva_api_key} onSaved={reload} />
              <SecretField companyId={companyId} name="viva_source_code" label="Κωδικός πηγής (προαιρετικό)" help="Αν δεν μπει: η Default." saved={names.viva_source_code} onSaved={reload} />
            </>
          )}
          {prov === 'stripe' && (
            <>
              <p className="text-xs text-stone-600">
                Stripe → Developers → API keys (Secret key, sk_...). Webhook (Developers → Webhooks) για «checkout.session.completed», «checkout.session.async_payment_succeeded», «checkout.session.async_payment_failed» και «checkout.session.expired»:{' '}
                <code className="break-all">{webhook}</code> <button type="button" className="underline" onClick={() => copy(webhook)}>αντιγραφή</button>, και το Signing secret (whsec_...) εδώ.
              </p>
              <SecretField companyId={companyId} name="stripe_secret_key" label="Secret key (sk_...)" saved={names.stripe_secret_key} onSaved={reload} />
              <SecretField companyId={companyId} name="stripe_webhook_secret" label="Webhook signing secret (whsec_...)" saved={names.stripe_webhook_secret} onSaved={reload} />
            </>
          )}
          {missing.length > 0 && <p className="text-xs text-red-800">Λείπουν κλειδιά: χωρίς αυτά η online πληρωμή δεν ξεκινά.</p>}
        </div>
      )}

      <div className="grid gap-2 border-t border-stone-200 pt-3">
        <span className="font-medium text-sm">«Δεν είμαι ρομπότ» (Cloudflare Turnstile, δωρεάν)</span>
        <p className="text-xs text-stone-600">Προαιρετικό: σταματά ψεύτικες παραγγελίες από bots. Φτιάξε widget στο dash.cloudflare.com → Turnstile για τη διεύθυνση του site και βάλε τα δύο κλειδιά.</p>
        <Field label="Site Key (δημόσιο)">
          <input className="input font-mono" value={captcha} onChange={(e) => setCaptcha(e.target.value.trim())} placeholder="0x4AAAAAAA..." />
        </Field>
        <SecretField companyId={companyId} name="turnstile_secret" label="Secret Key" saved={names.turnstile_secret} onSaved={reload} />
      </div>

      <div className="flex justify-end"><button className="btn-primary" disabled={busy} onClick={save}>Αποθήκευση πληρωμών</button></div>
      <p className="text-xs text-stone-500">
        Οι online πληρωμές και το CAPTCHA θέλουν τις Edge Functions ανεβασμένες στο Supabase (βλ. README). Τα κλειδιά δεν φαίνονται ποτέ ξανά στον browser.
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------
// Επιβράβευση: καλωσόρισμα και κάθε Ν-οστή παραγγελία (0006)
// ---------------------------------------------------------------------
function RewardsCard({ shop, companyId, onSaved }: { shop: OnlineShop; companyId: string; onSaved: (s: OnlineShop) => void }) {
  const toast = useToast()
  const [welcome, setWelcome] = useState(shop.welcome_pct ? String(Number(shop.welcome_pct)) : '')
  const [every, setEvery] = useState(shop.loyalty_every ? String(shop.loyalty_every) : '')
  const [pct, setPct] = useState(shop.loyalty_pct ? String(Number(shop.loyalty_pct)) : '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    setError(null)
    const w = welcome.trim() === '' ? null : round(toNum(welcome), 1)
    const e = every.trim() === '' ? null : Math.round(toNum(every))
    const p = pct.trim() === '' ? null : round(toNum(pct), 1)
    if (w !== null && (w < 1 || w > 50)) { setError('Το καλωσόρισμα θέλει από 1% ως 50% (ή κενό για καθόλου).'); return }
    if ((e === null) !== (p === null)) { setError('Για επιβράβευση γράψε και κάθε πόσες παραγγελίες και πόσο %.'); return }
    if (e !== null && (e < 2 || e > 50)) { setError('Κάθε 2 ως 50 παραγγελίες.'); return }
    if (p !== null && (p < 1 || p > 50)) { setError('Η επιβράβευση θέλει από 1% ως 50%.'); return }
    setBusy(true)
    const { data, error: er } = await supabase.from('online_shop')
      .update({ welcome_pct: w, loyalty_every: e, loyalty_pct: p }).eq('company_id', companyId).select('*')
    setBusy(false)
    if (er) { setError(errMsg(er)); return }
    const row = (data ?? [])[0] as OnlineShop | undefined
    if (!row) { setError('Μόνο ο ιδιοκτήτης αλλάζει την επιβράβευση.'); return }
    onSaved(row)
    toast.ok('Αποθηκεύτηκε η επιβράβευση')
  }

  return (
    <div className="card p-4 grid gap-3">
      <h2 className="font-semibold">Επιβράβευση πελατών</h2>
      <p className="text-xs text-stone-600">
        Για να προτιμούν το site από τις πλατφόρμες. Μετράει ανά τηλέφωνο, χωρίς λογαριασμό. Η έκπτωση είναι μόνο στα προϊόντα (όχι στα
        μεταφορικά) και γράφεται ως έκπτωση στη γραμμή της πώλησης και της απόδειξης. Κενό = καθόλου.
      </p>
      <ErrorBox text={error} />
      <Field label="Έκπτωση στην πρώτη απευθείας παραγγελία (%)">
        <NumInput value={welcome} onChange={setWelcome} min={0} placeholder="π.χ. 10" />
        <div className="text-xs text-stone-500 mt-1">Γράφεται και στα QR που τυπώνεις για τις σακούλες.</div>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Κάθε πόσες παραγγελίες">
          <NumInput value={every} onChange={setEvery} min={0} placeholder="π.χ. 5" />
        </Field>
        <Field label="Έκπτωση (%)">
          <NumInput value={pct} onChange={setPct} min={0} placeholder="π.χ. 20" />
        </Field>
      </div>
      {every && pct && <p className="text-sm text-emerald-800">Ο πελάτης βλέπει: «⭐ Κάθε {every}η παραγγελία −{pct}%», με κάρτα σφραγίδων στη σελίδα της παραγγελίας.</p>}
      <div className="flex justify-end"><button className="btn-primary" disabled={busy} onClick={save}>Αποθήκευση επιβράβευσης</button></div>
    </div>
  )
}
