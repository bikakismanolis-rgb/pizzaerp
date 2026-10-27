import type { PaymentProvider } from './types.ts'

/**
 * Δοκιμαστική πληρωμή: χωρίς κάρτα και χωρίς λεφτά. Ο πελάτης πηγαίνει σε
 * σελίδα του site με «Πλήρωσε» / «Αποτυχία». Για να δοκιμάσει το μαγαζί
 * όλη τη ροή πριν ανοίξει λογαριασμό σε Viva ή Stripe.
 */
export const testProvider: PaymentProvider = {
  name: 'test',

  createSession(o, ctx) {
    const ref = 'T-' + crypto.randomUUID()
    const q = new URLSearchParams({ ref, o: o.token, s: o.slug, a: o.total.toFixed(2) })
    return Promise.resolve({ ref, url: `${ctx.site}/pay/test?${q}` })
  },

  check(ref, params, _ctx, expected) {
    if (params.result === 'ok') return Promise.resolve({ state: 'paid', transactionId: 'TX-' + ref.slice(2, 10), amount: expected })
    if (params.result === 'fail') return Promise.resolve({ state: 'failed', error: 'Δοκιμαστική αποτυχία' })
    return Promise.resolve({ state: 'pending' })
  },

  webhook() {
    return Promise.resolve({ kind: 'ignore' })
  },

  refund() {
    return Promise.resolve()
  },
}
