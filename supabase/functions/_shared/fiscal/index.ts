import { testFiscal } from './test.ts'
import type { FiscalProvider } from './types.ts'

export * from './types.ts'

/**
 * Οι πάροχοι που υπάρχουν. Για τον πάροχο της επιχείρησης: νέο αρχείο με
 * το API του (βλ. types.ts) και μία γραμμή εδώ. Στη βάση: fiscal_settings.provider
 * = το name του. («manual» δεν είναι εδώ: γράφεται με το χέρι, χωρίς server.)
 */
const PROVIDERS: Record<string, FiscalProvider> = {
  [testFiscal.name]: testFiscal,
}

export function fiscalProvider(name: string): FiscalProvider | null {
  return PROVIDERS[name] ?? null
}

export const fiscalProviders = (): { name: string; label: string }[] =>
  Object.values(PROVIDERS).map((p) => ({ name: p.name, label: p.label }))
