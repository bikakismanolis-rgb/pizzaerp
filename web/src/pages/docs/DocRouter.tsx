import { useParams } from 'react-router-dom'
import type { DocType } from '../../lib/types'
import { TradeDoc } from './TradeDoc'
import { ProductionDoc } from './ProductionDoc'
import { StocktakeDoc } from './StocktakeDoc'
import { PaymentDoc } from './PaymentDoc'

/** Επιλέγει τον σωστό editor ανάλογα με τον τύπο παραστατικού στο URL */
export function DocRouter() {
  const { type } = useParams<{ type: DocType }>()
  switch (type) {
    case 'purchase':
    case 'sale':
      return <TradeDoc key={type} docType={type} />
    case 'production':
      return <ProductionDoc />
    case 'stocktake':
      return <StocktakeDoc />
    case 'receipt':
    case 'payment':
      return <PaymentDoc key={type} docType={type} />
    default:
      return <div className="text-sm text-stone-500">Άγνωστος τύπος παραστατικού.</div>
  }
}
