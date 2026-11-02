import { describe, expect, test } from 'vitest'
import { grossPrice, lineGross, loyaltyCard, sourceLabel } from './online'

describe('κάρτα επιβράβευσης', () => {
  test.each([
    // count, every → σφραγίδες, η επόμενη με έκπτωση, πόσες ακόμα
    [0, 3, 0, false, 3],
    [1, 3, 1, false, 2],
    [2, 3, 2, true, 1],
    [3, 3, 3, false, 3], // η 3η είχε την έκπτωση: γεμάτη κάρτα, ξανά από την αρχή
    [4, 3, 1, false, 2],
    [5, 5, 5, false, 5],
    [9, 5, 4, true, 1],
  ])('%i από %i', (count, every, filled, nextDiscount, left) => {
    expect(loyaltyCard(count, every)).toEqual({ filled, nextDiscount, left })
  })
})

test('πηγές', () => {
  expect(sourceLabel('bag')).toBe('Σακούλες (efood / Wolt)')
  expect(sourceLabel('')).toBe('Χωρίς QR')
  expect(sourceLabel('insta')).toBe('insta')
})

describe('lineGross / grossPrice: ίδια ποσά με τη βάση', () => {
  test('10,50 + 13%: 11,87 το ένα, 23,73 τα δύο (καθαρό 21,00 + ΦΠΑ 2,73)', () => {
    expect(grossPrice(10.5, 13)).toBe(11.87)
    expect(lineGross(1, 10.5, 13)).toBe(11.87)
    expect(lineGross(2, 10.5, 13)).toBe(23.73)
  })
  test('μηδέν και 24%', () => {
    expect(lineGross(0, 10.5, 13)).toBe(0)
    expect(lineGross(3, 4.03, 24)).toBe(14.99)
  })
})
