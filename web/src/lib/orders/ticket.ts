import { fmtMoney } from '../format'
import { clock, DISCOUNT_LABEL, fmtPhone, MODE_LABEL, nestLines, readyAt, type OnlineOrder } from '../online'

/**
 * Δελτίο κουζίνας για εκτυπωτή 80mm (ή A4): μεγάλος αριθμός, είδη με τα
 * extras τους, διανομή, πληρωμή. Εσωτερικό χαρτί, όχι παραστατικό.
 */

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))

type TicketOrder = Pick<OnlineOrder, 'order_no' | 'created_at' | 'mode' | 'payment' | 'pay_status' | 'customer_name' | 'phone'
  | 'address' | 'notes' | 'total' | 'delivery_fee' | 'discount' | 'discount_pct' | 'discount_kind' | 'accepted_at' | 'ready_minutes'
  | 'online_order_line'>

export function ticketHtml(o: TicketOrder, shop: string): string {
  const at = readyAt(o)
  const paid = o.payment === 'online' && o.pay_status === 'paid'
  const pay = paid ? 'ΠΛΗΡΩΜΕΝΗ ONLINE' : o.payment === 'card' ? `ΚΑΡΤΑ: ${fmtMoney(o.total)}` : `ΜΕΤΡΗΤΑ: ${fmtMoney(o.total)}`
  const lines = nestLines(o.online_order_line).map((l) => `
    <div class="ln"><b>${l.qty}×</b> ${esc(l.name)}</div>
    ${l.extras.map((x) => `<div class="ex">+ ${esc(x.name)}</div>`).join('')}
    ${l.note ? `<div class="note">» ${esc(l.note)}</div>` : ''}`).join('')
  return `<!doctype html><html lang="el"><head><meta charset="utf-8"><title>#${o.order_no}</title>
<style>
  @page { size: 80mm auto; margin: 3mm; }
  body { font-family: system-ui, sans-serif; width: 74mm; margin: 0; color: #000; font-size: 11pt; }
  .shop { text-align: center; font-size: 10pt; }
  .no { text-align: center; font-size: 34pt; font-weight: 800; line-height: 1.1; margin: 1mm 0; }
  .meta { text-align: center; font-size: 10pt; }
  .mode { text-align: center; font-size: 14pt; font-weight: 700; border: 2px solid #000; margin: 2mm 0; padding: 1mm; }
  hr { border: 0; border-top: 1px dashed #000; margin: 2mm 0; }
  .ln { font-size: 13pt; margin-top: 1mm; }
  .ex { font-size: 12pt; padding-left: 7mm; font-weight: 600; }
  .note { font-size: 11pt; padding-left: 7mm; font-style: italic; }
  .pay { text-align: center; font-size: 13pt; font-weight: 800; margin-top: 2mm; }
  .small { font-size: 9pt; text-align: center; margin-top: 2mm; }
</style></head><body>
  <div class="shop">${esc(shop)}</div>
  <div class="no">#${o.order_no}</div>
  <div class="meta">${clock(o.created_at)}${at ? ` · έτοιμη ${clock(at)}` : ''}</div>
  <div class="mode">${o.mode === 'delivery' ? 'ΔΙΑΝΟΜΗ' : MODE_LABEL.pickup.toUpperCase()}</div>
  <div><b>${esc(o.customer_name)}</b> · ${esc(fmtPhone(o.phone))}</div>
  ${o.address ? `<div>${esc(o.address)}</div>` : ''}
  <hr>${lines}
  ${o.notes ? `<hr><div class="note">📝 ${esc(o.notes)}</div>` : ''}
  <hr>
  ${Number(o.discount) > 0 && o.discount_kind ? `<div>Έκπτωση ${DISCOUNT_LABEL[o.discount_kind]} ${Number(o.discount_pct)}%: −${fmtMoney(o.discount)}</div>` : ''}
  ${Number(o.delivery_fee) > 0 ? `<div>Μεταφορικά: ${fmtMoney(o.delivery_fee)}</div>` : ''}
  <div class="pay">${pay}</div>
  <div class="small">Δελτίο κουζίνας · δεν είναι παραστατικό</div>
</body></html>`
}

/** Τύπωμα χωρίς νέο παράθυρο (κρυφό iframe) */
export function printHtml(html: string): void {
  const f = document.createElement('iframe')
  f.setAttribute('aria-hidden', 'true')
  f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0'
  document.body.appendChild(f)
  const w = f.contentWindow
  if (!w) { f.remove(); return }
  w.document.open()
  w.document.write(html)
  w.document.close()
  const go = () => {
    w.focus()
    w.print()
    window.setTimeout(() => f.remove(), 1000)
  }
  if (w.document.readyState === 'complete') window.setTimeout(go, 50)
  else w.addEventListener('load', go, { once: true })
}

const PRINT_KEY = 'pizza-erp.orders-print'
/** Τύπωμα στην αποδοχή, ανά συσκευή (το tablet της κουζίνας έχει εκτυπωτή, το κινητό όχι) */
export const autoPrintOn = (): boolean => { try { return localStorage.getItem(PRINT_KEY) === '1' } catch { return false } }
export const setAutoPrint = (v: boolean): void => { try { localStorage.setItem(PRINT_KEY, v ? '1' : '0') } catch { /* ignore */ } }
