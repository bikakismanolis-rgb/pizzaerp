import { describe, expect, test } from 'vitest'
import { addMonths, allocateOverhead, monthAcc, monthLabel, monthShare, parseOverheadVoice, type SaleRow } from './overhead'

describe('φωνή γενικών εξόδων', () => {
  test.each([
    ['ρεύμα 320', 'Ρεύμα', 320],
    ['ΔΕΗ 320,50', 'Ρεύμα', 320.5],
    ['μισθοί δύο χιλιάδες τετρακόσια', 'Μισθοί', 2400],
    ['ενοίκιο οκτακόσια ευρώ', 'Ενοίκιο', 800],
    ['το γκάζι ήταν 150', 'Αέριο / καύσιμα φούρνου', 150],
    ['προμήθεια efood 640', 'Προμήθειες efood / Wolt', 640],
    ['λογιστής 120', 'Λογιστής', 120],
  ])('%s', (text, category, amount) => {
    expect(parseOverheadVoice(text)).toEqual({ category, amount })
  })

  test('χωρίς ποσό ή χωρίς κατηγορία: τίποτα', () => {
    expect(parseOverheadVoice('ρεύμα')).toBeNull()
    expect(parseOverheadVoice('320')).toBeNull()
    expect(parseOverheadVoice('ρεύμα 320 και νερό 40')).toBeNull()
  })
})

test('μήνες', () => {
  expect(addMonths('2026-11-01', -1)).toBe('2026-10-01')
  expect(addMonths('2026-01-01', -1)).toBe('2025-12-01')
  expect(addMonths('2026-12-01', 1)).toBe('2027-01-01')
  expect(monthLabel('2026-10-01')).toBe('Οκτώβριος 2026')
  expect(monthAcc('2026-10-01', '2026-11-01')).toBe('Οκτώβριο')
  expect(monthAcc('2025-12-01', '2026-01-01')).toBe('Δεκέμβριο 2025')
  expect(monthAcc('2026-05-01', '2026-11-01')).toBe('Μάιο')
})

test('τρέχων μήνας: τα έξοδα ως σήμερα', () => {
  expect(monthShare('2026-11-01', '2026-11-03')).toEqual({ days: 3, of: 30, share: 0.1 })
  expect(monthShare('2026-10-01', '2026-11-03')).toEqual({ days: 31, of: 31, share: 1 })
  expect(monthShare('2026-02-01', '2026-02-14').of).toBe(28)
})

describe('καθαρό κέρδος ανά είδος', () => {
  // 100 μαργαρίτες (υλικά 2,00), 50 σπέσιαλ (υλικά 3,00), 80 αναψυκτικά (0,60)
  const sales: SaleRow[] = [
    { item_id: 'm', item_name: 'Μαργαρίτα', qty: 60, net: 480, cogs: 120 },
    { item_id: 'm', item_name: 'Μαργαρίτα', qty: 40, net: 320, cogs: 80 },
    { item_id: 's', item_name: 'Σπέσιαλ', qty: 50, net: 525, cogs: 150 },
    { item_id: 'c', item_name: 'Αναψυκτικό', qty: 80, net: 129, cogs: 48 },
  ]
  const pizzas = new Set(['m', 's'])

  test('ίσα ανά τεμάχιο: μόνο σε όσα έχουν συνταγή', () => {
    const r = allocateOverhead(sales, 1500, 'units', pizzas)
    const m = r.rows.find((x) => x.item_id === 'm')!
    const s = r.rows.find((x) => x.item_id === 's')!
    const c = r.rows.find((x) => x.item_id === 'c')!
    expect(m.overhead).toBe(1000) // 100 από τις 150 πίτσες
    expect(s.overhead).toBe(500)
    expect(c.overhead).toBe(0)
    expect(m.profit).toBe(800 - 200 - 1000)
    expect(r.overhead).toBe(1500)
    expect(r.unallocated).toBe(0)
    expect(r.profit).toBe(1454 - 398 - 1500)
  })

  test('ανάλογα με τα υλικά: και τα αναψυκτικά παίρνουν μερίδιο', () => {
    const r = allocateOverhead(sales, 1000, 'material', pizzas)
    const sum = r.rows.reduce((t, x) => t + x.overhead, 0)
    expect(Math.round(sum * 100) / 100).toBe(1000)
    expect(r.rows.find((x) => x.item_id === 'c')!.overhead).toBeCloseTo(1000 * 48 / 398, 1)
  })

  test('τα λεπτά της στρογγυλοποίησης δεν χάνονται', () => {
    const r = allocateOverhead([
      { item_id: 'a', item_name: 'Α', qty: 1, net: 10, cogs: 1 },
      { item_id: 'b', item_name: 'Β', qty: 1, net: 10, cogs: 1 },
      { item_id: 'c', item_name: 'Γ', qty: 1, net: 10, cogs: 1 },
    ], 100, 'units', new Set(['a', 'b', 'c']))
    expect(r.rows.reduce((t, x) => t + x.overhead, 0)).toBeCloseTo(100, 10)
  })

  test('χωρίς πωλήσεις: τα έξοδα μένουν χωρίς είδος', () => {
    const r = allocateOverhead([], 800, 'units', pizzas)
    expect(r.unallocated).toBe(800)
    expect(r.profit).toBe(-800)
  })
})
