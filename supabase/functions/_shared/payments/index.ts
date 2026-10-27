import { HttpError } from '../http.ts'
import { stripeProvider } from './stripe.ts'
import { testProvider } from './test.ts'
import type { PaymentProvider } from './types.ts'
import { vivaProvider } from './viva.ts'

export * from './types.ts'

const PROVIDERS: Record<string, PaymentProvider> = { test: testProvider, viva: vivaProvider, stripe: stripeProvider }

export function provider(name: string): PaymentProvider {
  const p = PROVIDERS[name]
  if (!p) throw new HttpError(400, 'Άγνωστος πάροχος πληρωμών')
  return p
}
