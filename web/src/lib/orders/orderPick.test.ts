import { describe, expect, test } from 'vitest'
import { pickOrder, readText } from './orderPick'
import { clock, grossPrice, orderSpeech, slugify, slugValid, phoneLooksValid, fmtPhone } from '../online'
import type { OnlineOrder } from '../online'

const DAY = '2026-10-27'
const ord = (no: number, status: OnlineOrder['status'], extra: Partial<OnlineOrder> = {}) => ({
  id: `id-${no}-${extra.order_date ?? DAY}`, order_no: no, order_date: DAY, status, mode: 'delivery' as const,
  address: 'Ικάρου 12', payment: 'cash' as const, notes: null, total: 10,
  online_order_line: [{ name: 'Μαργαρίτα', qty: 2, note: null }],
  ...extra,
})

describe('ποια παραγγελία', () => {
  const orders = [ord(11, 'accepted'), ord(12, 'new'), ord(13, 'new'), ord(14, 'rejected')]

  test('με αριθμό', () => {
    expect(pickOrder(orders, 12, 'new', 'δεκτή', DAY).order?.order_no).toBe(12)
    expect(pickOrder(orders, 11, 'new', 'δεκτή', DAY).error).toBe('Η 11 έχει ήδη γίνει δεκτή.')
    expect(pickOrder(orders, 14, 'new', 'δεκτή', DAY).error).toBe('Η 14 έχει απορριφθεί.')
    expect(pickOrder(orders, 99, 'new', 'δεκτή', DAY).error).toBe('Δεν βρίσκω παραγγελία 99 σήμερα.')
  })
  test('χωρίς αριθμό: μόνο αν είναι μία', () => {
    expect(pickOrder(orders, null, 'new', 'δεκτή', DAY).error).toBe('Ποια; Περιμένουν οι 12 και 13. Πες «δεκτή η 12».')
    expect(pickOrder(orders, null, 'accepted', 'έφυγε', DAY).order?.order_no).toBe(11)
    expect(pickOrder([ord(1, 'done')], null, 'accepted', 'έφυγε', DAY).error).toBe('Δεν υπάρχει παραγγελία σε ετοιμασία.')
  })
  test('η πρώτη / η τελευταία', () => {
    expect(pickOrder(orders, 'first', 'new', 'δεκτή', DAY).order?.order_no).toBe(12)
    expect(pickOrder(orders, 'last', 'new', 'δεκτή', DAY).order?.order_no).toBe(13)
  })
  test('ίδιος αριθμός χθες και σήμερα: η σημερινή', () => {
    const two = [ord(3, 'new', { order_date: '2026-10-26' }), ord(3, 'new')]
    expect(pickOrder(two, 3, 'new', 'δεκτή', DAY).order?.order_date).toBe(DAY)
  })
})

describe('ανάγνωση', () => {
  test('νέες: όλη η παραγγελία', () => {
    expect(readText([ord(12, 'new', { notes: 'κουδούνι Παπαδάκη' })], null, DAY))
      .toBe('Νέα παραγγελία 12. Μαργαρίτα 2. Διανομή, Ικάρου 12. Μετρητά. Σημείωση: κουδούνι Παπαδάκη.')
  })
  test('καμία νέα', () => {
    expect(readText([ord(11, 'accepted'), ord(10, 'accepted')], null, DAY)).toBe('Δεν υπάρχουν νέες παραγγελίες. Σε ετοιμασία οι 11 και 10.')
    expect(readText([], null, DAY)).toBe('Δεν υπάρχουν παραγγελίες που περιμένουν.')
  })
  test('συγκεκριμένη', () => {
    expect(readText([ord(11, 'accepted')], 11, DAY)).toBe('Η 11: Μαργαρίτα 2. Έχει ήδη γίνει δεκτή.')
  })
  test('παραλαβή με κάρτα, σημείωση γραμμής', () => {
    expect(orderSpeech({ order_no: 4, mode: 'pickup', address: null, payment: 'card', notes: null, total: 9,
      online_order_line: [{ name: 'Πεπερόνι', qty: 1, note: 'χωρίς κρεμμύδι' }, { name: 'Μαργαρίτα', qty: 3, note: null }] }))
      .toBe('Νέα παραγγελία 4. Πεπερόνι 1 (χωρίς κρεμμύδι), Μαργαρίτα 3. Παραλαβή από το μαγαζί. Πληρωμή με κάρτα.')
  })
})

describe('τιμές και ώρες όπως η βάση', () => {
  test('τιμή με ΦΠΑ: στρογγύλευση όπως το round() της βάσης', () => {
    expect(grossPrice(10.5, 13)).toBe(11.87)
    expect(grossPrice(8, 13)).toBe(9.04)
    expect(grossPrice(1.61, 24)).toBe(2)
    expect(grossPrice(0, 24)).toBe(0)
  })
  test('ώρα Ελλάδας ανεξάρτητα από τη ζώνη της συσκευής', () => {
    expect(clock('2026-10-27T21:30:00Z')).toBe('23:30')
    expect(clock('2026-07-01T18:05:00Z')).toBe('21:05')
  })
})

describe('site και τηλέφωνα', () => {
  test('διεύθυνση από το όνομα', () => {
    expect(slugify('Πιτσαρία Η Γωνιά')).toBe('pitsaria-i-gonia')
    expect(slugify('  Pizza Χ & Ψ!! ')).toBe('pizza-ch-ps')
    expect(slugify('Ωραία Θέα')).toBe('oraia-thea')
    expect(slugValid('pitsaria-i-gonia')).toBe(true)
    expect(slugValid('ab')).toBe(false)
    expect(slugValid('με-ελληνικά')).toBe(false)
    expect(slugValid('-pizza')).toBe(false)
  })
  test('τηλέφωνα', () => {
    expect(phoneLooksValid('694 123 4567')).toBe(true)
    expect(phoneLooksValid('2810-123456')).toBe(true)
    expect(phoneLooksValid('+44 7700 900123')).toBe(true)
    expect(phoneLooksValid('12345')).toBe(false)
    expect(phoneLooksValid('1941234567')).toBe(false)
    expect(fmtPhone('6941234567')).toBe('694 123 4567')
    expect(fmtPhone('+447700900123')).toBe('+447700900123')
  })
})
