import { describe, expect, test } from 'vitest'
import { parseOrderVoice } from './orderVoice'

describe('αποδοχή', () => {
  test.each([
    ['δεκτή', null, null],
    ['Δεκτή η 12', 12, null],
    ['δεκτή η δώδεκα σε μισή ώρα', 12, 30],
    ['δέξου την 12 σε είκοσι λεπτά', 12, 20],
    ['δεκτή σε 20 λεπτά', null, 20],
    ['δεκτή η 3 σε 45', 3, 45],
    ['δεκτή σε ένα τέταρτο', null, 15],
    ['δεκτή σε μία ώρα', null, 60],
    ['δεκτή σε ενάμιση ώρα', null, 90],
    ['αποδοχή της 7 σε τρία τέταρτα', 7, 45],
    ['δεκτή 12 20', 12, 20],
    ['δεκτή #14', 14, null],
    ['εντάξει, δεκτή η 5, σε 25 λεπτά, ευχαριστώ', 5, 25],
  ])('%s', (text, pick, minutes) => {
    expect(parseOrderVoice(text)).toEqual({ kind: 'accept', pick, minutes })
  })

  test('η πρώτη / η τελευταία', () => {
    expect(parseOrderVoice('δεκτή η πρώτη σε 20')).toEqual({ kind: 'accept', pick: 'first', minutes: 20 })
    expect(parseOrderVoice('δέξου την τελευταία')).toEqual({ kind: 'accept', pick: 'last', minutes: null })
  })

  test('χρόνος εκτός ορίων: χωρίς χρόνο', () => {
    expect(parseOrderVoice('δεκτή σε 500 λεπτά')).toEqual({ kind: 'accept', pick: null, minutes: null })
  })
})

describe('απόρριψη, έφυγε', () => {
  test('απόρριψη με λόγο', () => {
    expect(parseOrderVoice('απόρριψε την 5 γιατί είμαστε γεμάτοι')).toEqual({ kind: 'reject', pick: 5, reason: 'Είμαστε γεμάτοι' })
    expect(parseOrderVoice('απόρριψη')).toEqual({ kind: 'reject', pick: null, reason: null })
  })
  test.each([
    ['έφυγε η 12', 12, false],
    ['έφυγε', null, false],
    ['παραδόθηκε η τρία', 3, false],
    ['έφυγαν όλες', null, true],
    ['βγήκε η 8', 8, false],
  ])('%s', (text, pick, all) => {
    expect(parseOrderVoice(text)).toEqual({ kind: 'done', pick, all })
  })
})

describe('άνοιγμα, κλείσιμο, ανάγνωση, σταμάτα', () => {
  test.each([
    ['άνοιξε τις παραγγελίες', 'open'],
    ['ανοίγουμε το site', 'open'],
    ['άνοιξε', 'open'],
    ['κλείσε τις παραγγελίες', 'close'],
    ['κλείσε το σάιτ', 'close'],
    ['κλείσε', 'close'],
  ])('%s', (text, kind) => {
    expect(parseOrderVoice(text)?.kind).toBe(kind)
  })
  test('ανάγνωση', () => {
    expect(parseOrderVoice('διάβασε')).toEqual({ kind: 'read', pick: null })
    expect(parseOrderVoice('ξαναπές την 12')).toEqual({ kind: 'read', pick: 12 })
    expect(parseOrderVoice('τι παραγγελίες έχουμε;')).toEqual({ kind: 'read', pick: null })
    expect(parseOrderVoice('διάβασε τις παραγγελίες', { strict: true })).toEqual({ kind: 'read', pick: null })
  })
  test('σταμάτα', () => {
    expect(parseOrderVoice('σταμάτα')).toEqual({ kind: 'stop' })
    expect(parseOrderVoice('σταμάτα', { strict: true })).toBeNull()
  })
})

describe('δεν είναι εντολή παραγγελίας', () => {
  test.each([
    'κλείσε τη μέρα',
    'κλείσε την απογραφή',
    'efood δύο μαργαρίτες',
    'ήρθαν δέκα σακιά αλεύρι',
    '',
    'καλημέρα',
  ])('%s', (text) => {
    expect(parseOrderVoice(text)).toBeNull()
  })

  // στο «Πες το» ακούγονται και πωλήσεις / αγορές: μόνο καθαρές φράσεις
  test.each([
    'δεχτήκαμε 10 σακιά αλεύρι',
    'έφυγαν 2 μαργαρίτες',
    'κλείσε',
    'άνοιξε',
    'διάβασε',
    'έφυγε',
    'κλείσε τη μέρα',
    'πούλησα στο ξενοδοχείο 60 σπέσιαλ',
  ])('strict: %s', (text) => {
    expect(parseOrderVoice(text, { strict: true })).toBeNull()
  })

  test.each([
    ['δεκτή η 12 σε 20 λεπτά', 'accept'],
    ['δέξου την παραγγελία', 'accept'],
    ['απόρριψε την 5', 'reject'],
    ['έφυγε η 12', 'done'],
    ['έφυγαν όλες οι παραγγελίες', 'done'],
    ['κλείσε τις παραγγελίες', 'close'],
    ['άνοιξε το site', 'open'],
    ['έχουμε παραγγελίες;', 'read'],
  ])('strict: %s', (text, kind) => {
    expect(parseOrderVoice(text, { strict: true })?.kind).toBe(kind)
  })
})
