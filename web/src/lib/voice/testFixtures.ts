import type { Item, ItemType, Partner } from '../types'
import type { InterpretContext } from './types'

/**
 * Κατάλογος δοκιμών (μόνο για τα tests του interpreter): ρεαλιστική πιτσαρία.
 */

let n = 0
function item(
  name: string, type: ItemType, unit: string,
  extra: Partial<Item> = {},
): Item {
  n++
  const prefix = type === 'raw' ? 'ΠΥ' : type === 'semi' ? 'ΗΜ' : 'ΠΡ'
  return {
    id: `i-${String(n).padStart(2, '0')}`,
    company_id: 'c1',
    code: `${prefix}-${String(n).padStart(3, '0')}`,
    name,
    item_type: type,
    category: null,
    unit,
    vat_rate: 13,
    sale_price: 0,
    avg_cost: 0,
    make_to_order: false,
    pack_name: null,
    pack_qty: null,
    min_stock: null,
    is_active: true,
    notes: null,
    aliases: [],
    ...extra,
  }
}

function partner(id: string, name: string, customer: boolean, supplier: boolean, extra: Partial<Partner> = {}): Partner {
  return {
    id,
    company_id: 'c1',
    code: id.toUpperCase(),
    name,
    is_customer: customer,
    is_supplier: supplier,
    vat_no: null,
    phone: null,
    email: null,
    address: null,
    city: null,
    notes: null,
    is_active: true,
    aliases: [],
    ...extra,
  }
}

export const ITEMS = {
  flour: item('Αλεύρι', 'raw', 'kg', { pack_name: 'σακί', pack_qty: 25, avg_cost: 0.6 }),
  water: item('Νερό', 'raw', 'L'),
  yeast: item('Μαγιά', 'raw', 'kg'),
  salt: item('Αλάτι', 'raw', 'kg'),
  oil: item('Ελαιόλαδο', 'raw', 'L'),
  mozz: item('Μοτσαρέλα', 'raw', 'kg'),
  sauce: item('Σάλτσα ντομάτας', 'raw', 'kg'),
  ham: item('Ζαμπόν', 'raw', 'kg'),
  bacon: item('Μπέικον', 'raw', 'kg'),
  salami: item('Πεπερόνι σαλάμι', 'raw', 'kg'),
  oregano: item('Ρίγανη', 'raw', 'g'),
  box: item('Κουτί πίτσας', 'raw', 'τεμ', { pack_name: 'κούτα', pack_qty: 100 }),
  dough250: item('Ζυμάρι 250γρ', 'semi', 'τεμ', { make_to_order: true }),
  dough400: item('Ζυμάρι 400γρ', 'semi', 'τεμ'),
  margarita: item('Μαργαρίτα', 'finished', 'τεμ', { make_to_order: true, sale_price: 7.0796 }),
  special: item('Special', 'finished', 'τεμ', { make_to_order: true, sale_price: 8.8496, aliases: ['σπέσιαλ'] }),
  pepperoni: item('Πεπερόνι', 'finished', 'τεμ', { make_to_order: true }),
  hawaii: item('Χαβανέζα', 'finished', 'τεμ', { make_to_order: true }),
  carbonara: item('Καρμπονάρα', 'finished', 'τεμ', { make_to_order: true }),
  frozen: item('Special κατεψυγμένη 30εκ', 'finished', 'τεμ', { sale_price: 4.5 }),
  calzone: item('Καλτσόνε', 'finished', 'τεμ', { make_to_order: true, is_active: false }),
}

export const PARTNERS = {
  mill: partner('p-mill', 'Μύλος Α.Ε.', false, true, { aliases: ['μύλος'] }),
  dairy: partner('p-dairy', 'Τυροκομείο Κρήτης', false, true),
  asteria: partner('p-asteria', 'Ξενοδοχείο Αστέρια', true, false),
  hotelX: partner('p-hotelx', 'Ξενοδοχείο Χ', true, false),
  efood: partner('p-efood', 'efood', true, false),
  old: partner('p-old', 'Παλιός Προμηθευτής', false, true, { is_active: false }),
}

export const CTX: InterpretContext = {
  items: Object.values(ITEMS),
  partners: Object.values(PARTNERS),
  defaultChannel: 'store',
}

/** Κατάλογος ~200 ειδών για μέτρηση ταχύτητας */
export function bigContext(): InterpretContext {
  const extra: Item[] = []
  const words = ['Τυρί', 'Σαλάμι', 'Μανιτάρια', 'Πιπεριές', 'Κρεμμύδι', 'Ελιές', 'Ντομάτα', 'Ρόκα', 'Γκούντα', 'Παρμεζάνα',
    'Φέτα', 'Κοτόπουλο', 'Λουκάνικο', 'Τόνος', 'Καλαμπόκι', 'Ανανάς', 'Σκόρδο', 'Βασιλικός', 'Πάπρικα', 'Κρέμα']
  const kinds = ['φρέσκο', 'κατεψυγμένο', 'τριμμένο', 'σε φέτες', 'βιολογικό', 'light', 'extra', 'πικάντικο', 'γλυκό']
  for (const w of words) for (const k of kinds) extra.push(item(`${w} ${k}`, 'raw', 'kg'))
  return { ...CTX, items: [...CTX.items, ...extra] }
}
