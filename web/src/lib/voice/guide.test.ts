import { describe, expect, it } from 'vitest'
import { EXAMPLES } from './examples'
import { ORDER_EXAMPLES } from '../orders/orderExamples'
import { DRIVER_EXAMPLES } from '../delivery/driverExamples'
import { parseDriverVoice } from '../delivery/driverVoice'
import guide from '../../../../docs/pes-to-odigos.html?raw'

/**
 * Ο οδηγός (docs/pes-to-odigos.html → .pdf) δείχνει μόνο ελεγμένες φράσεις:
 * κάθε φράση στα κελιά «λες / μαθαίνεις / μετά λες» και στα <q class="ph">
 * είναι παράδειγμα του examples.ts (που ελέγχει το examples.test.ts), και
 * κάθε παράδειγμα είναι στον οδηγό. Αν αλλάξει το examples.ts, ξαναφτιάχνεται
 * και ο οδηγός.
 */

const text = (html: string) => html
  .replace(/<[^>]+>/g, '')
  .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim()
  .replace(/^«(.*)»$/, '$1')

const cells = [...guide.matchAll(/<td class="(?:say|teach|use)">([\s\S]*?)<\/td>/g)].map((m) => text(m[1]))
const inline = [...guide.matchAll(/<q class="ph">([\s\S]*?)<\/q>/g)].map((m) => text(m[1]))
const says = new Set(EXAMPLES.flatMap((s) => s.items.map((x) => x.say)))

describe('οδηγός «Πες το»', () => {
  it('έχει φράσεις', () => {
    expect(cells.length).toBeGreaterThan(50)
  })

  it('κάθε φράση του οδηγού είναι ελεγμένο παράδειγμα', () => {
    const extra = [...cells, ...inline].filter((p) => !says.has(p))
    expect(extra).toEqual([])
  })

  it('κάθε παράδειγμα είναι στον οδηγό', () => {
    const shown = new Set(cells)
    const missing = [...says].filter((s) => !shown.has(s))
    expect(missing).toEqual([])
  })
})

// online παραγγελίες: δικός τους κατανοητής, δικά τους παραδείγματα
const orderCells = [...guide.matchAll(/<td class="osay">([\s\S]*?)<\/td>/g)].map((m) => text(m[1]))
const orderSays = new Set(ORDER_EXAMPLES.map((x) => x.say))

describe('οδηγός: online παραγγελίες', () => {
  it('ίδιες φράσεις με τα παραδείγματα (orderExamples.ts)', () => {
    expect(orderCells.length).toBeGreaterThan(5)
    expect(orderCells.filter((p) => !orderSays.has(p))).toEqual([])
    expect([...orderSays].filter((s) => !orderCells.includes(s))).toEqual([])
  })
})

// διανομείς: η φωνή στο κινητό τους
const driverCells = [...guide.matchAll(/<td class="dsay">([\s\S]*?)<\/td>/g)].map((m) => text(m[1]))
const driverSays = new Set(DRIVER_EXAMPLES.map((x) => x.say))

describe('οδηγός: διανομείς', () => {
  it('ίδιες φράσεις με τα παραδείγματα (driverExamples.ts)', () => {
    expect(driverCells.length).toBeGreaterThan(3)
    expect(driverCells.filter((p) => !driverSays.has(p))).toEqual([])
    expect([...driverSays].filter((s) => !driverCells.includes(s))).toEqual([])
  })
  it.each(DRIVER_EXAMPLES.map((x) => [x.say, x.expect] as const))('%s', (say, cmd) => {
    expect(parseDriverVoice(say)).toEqual(cmd)
  })
})
