import { describe, expect, test } from 'vitest'
import { parseDriverVoice } from './driverVoice'
import { tileOf } from './map'

describe('φωνή διανομέα', () => {
  test.each([
    ['παραδόθηκε', { kind: 'delivered', no: null }],
    ['Παραδόθηκε η 12', { kind: 'delivered', no: 12 }],
    ['την παρέδωσα την δώδεκα', { kind: 'delivered', no: 12 }],
    ['την παίρνω η 12', { kind: 'take', no: 12 }],
    ['παίρνω την 5', { kind: 'take', no: 5 }],
    ['φεύγω με την επτά', { kind: 'take', no: 7 }],
    ['δεν την πήρα η 12', { kind: 'release', no: 12 }],
    ['διάβασε', { kind: 'read' }],
    ['ποια είναι η επόμενη', { kind: 'read' }],
  ])('%s', (text, cmd) => {
    expect(parseDriverVoice(text)).toEqual(cmd)
  })

  test('ό,τι δεν καταλαβαίνει: τίποτα (όχι λάθος παράδοση)', () => {
    expect(parseDriverVoice('')).toBeNull()
    expect(parseDriverVoice('καλημέρα')).toBeNull()
    expect(parseDriverVoice('δεν παραδόθηκε')).toBeNull()
  })
})

test('πλακίδιο χάρτη (Ηράκλειο, zoom 16)', () => {
  const t = tileOf(35.3387, 25.1442, 16)
  expect(t.x).toBe(37345)
  expect(t.y).toBe(25883)
  expect(t.px).toBeGreaterThanOrEqual(0)
  expect(t.px).toBeLessThan(256)
})
