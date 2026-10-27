import { describe, expect, test } from 'vitest'
import { loyaltyCard, sourceLabel } from './online'

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
