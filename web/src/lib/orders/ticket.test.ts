import { describe, expect, test } from 'vitest'
import { ticketHtml } from './ticket'

const base = {
  order_no: 12, created_at: '2026-10-27T18:30:00Z', mode: 'delivery' as const, payment: 'cash' as const, pay_status: 'none' as const,
  customer_name: 'Γιώργος <b>', phone: '6941234567', address: 'Ικάρου 12', notes: 'κουδούνι Παπαδάκη', total: 24.27, delivery_fee: 2,
  discount: 2.42, discount_pct: 10, discount_kind: 'welcome' as const, accepted_at: '2026-10-27T18:31:00Z', ready_minutes: 30,
  online_order_line: [
    { id: 'a', order_id: 'o', line_no: 1, item_id: 'm', name: 'Μαργαρίτα', qty: 2, unit_price: 9.04, note: 'καλοψημένη', parent_line: null },
    { id: 'b', order_id: 'o', line_no: 2, item_id: 'x', name: 'Extra μοτσαρέλα', qty: 2, unit_price: 1.5, note: null, parent_line: 1 },
    { id: 'c', order_id: 'o', line_no: 3, item_id: 'k', name: 'Coca-Cola', qty: 1, unit_price: 2, note: null, parent_line: null },
  ],
}

describe('δελτίο κουζίνας', () => {
  test('αριθμός, είδη με extras, διανομή, μετρητά, έκπτωση', () => {
    const h = ticketHtml(base, 'Πιτσαρία Η Γωνιά')
    expect(h).toContain('#12')
    expect(h).toContain('ΔΙΑΝΟΜΗ')
    expect(h).toContain('<b>2×</b> Μαργαρίτα')
    expect(h).toContain('+ Extra μοτσαρέλα')
    expect(h).toContain('» καλοψημένη')
    expect(h).toContain('ΜΕΤΡΗΤΑ: 24,27')
    expect(h).toContain('Έκπτωση καλωσορίσματος 10%')
    expect(h).toContain('έτοιμη 21:01') // 18:31 UTC + 30' = 21:01 ώρα Ελλάδας
    expect(h).toContain('694 123 4567')
  })

  test('χωρίς HTML από τον πελάτη', () => {
    const h = ticketHtml(base, 'Π')
    expect(h).toContain('Γιώργος &lt;b&gt;')
    expect(h).not.toContain('Γιώργος <b>')
  })

  test('πληρωμένη online: ο διανομέας δεν εισπράττει', () => {
    const h = ticketHtml({ ...base, payment: 'online', pay_status: 'paid' }, 'Π')
    expect(h).toContain('ΠΛΗΡΩΜΕΝΗ ONLINE')
    expect(h).not.toContain('ΜΕΤΡΗΤΑ')
  })
})
