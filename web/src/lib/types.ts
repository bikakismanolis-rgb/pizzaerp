export type ItemType = 'raw' | 'semi' | 'finished'
export type DocType = 'purchase' | 'sale' | 'production' | 'stocktake' | 'receipt' | 'payment'
export type DocStatus = 'draft' | 'posted'
export type Channel = 'wholesale' | 'efood' | 'wolt' | 'box' | 'phone' | 'store'
export type LineRole = 'item' | 'output' | 'input'

export interface Company {
  id: string
  name: string
  vat_no: string | null
  address: string | null
  phone: string | null
}

export interface Item {
  id: string
  company_id: string
  code: string
  name: string
  item_type: ItemType
  category: string | null
  unit: string
  vat_rate: number
  sale_price: number
  avg_cost: number
  make_to_order: boolean
  pack_name: string | null
  pack_qty: number | null
  min_stock: number | null
  is_active: boolean
  notes: string | null
  /** άλλα ονόματα με τα οποία το λένε (για τις φωνητικές εντολές) */
  aliases: string[]
}

export interface Partner {
  id: string
  company_id: string
  code: string
  name: string
  is_customer: boolean
  is_supplier: boolean
  vat_no: string | null
  phone: string | null
  email: string | null
  address: string | null
  city: string | null
  notes: string | null
  is_active: boolean
  /** άλλα ονόματα με τα οποία τον λένε (για τις φωνητικές εντολές) */
  aliases: string[]
}

export interface PartnerPrice {
  id: string
  company_id: string
  partner_id: string
  item_id: string
  price: number
}

export interface Bom {
  id: string
  company_id: string
  item_id: string
  name: string
  output_qty: number
  is_default: boolean
  is_active: boolean
  notes: string | null
}

export interface BomLine {
  id: string
  company_id: string
  bom_id: string
  line_no: number
  component_item_id: string
  qty: number
  notes: string | null
}

export interface Doc {
  id: string
  company_id: string
  doc_type: DocType
  doc_no: number
  doc_date: string
  status: DocStatus
  partner_id: string | null
  channel: Channel | null
  bom_id: string | null
  source_doc_id: string | null
  is_auto: boolean
  /** ανοιχτό πρόχειρο που γεμίζει σταδιακά (μετρητής ημέρας, απογραφή σε εξέλιξη) */
  is_running: boolean
  ref_no: string | null
  amount: number | null
  total_net: number
  total_vat: number
  total_gross: number
  notes: string | null
  created_at: string
  posted_at: string | null
}

export interface DocLine {
  id: string
  company_id: string
  doc_id: string
  line_no: number
  role: LineRole
  item_id: string
  qty: number
  unit_price: number
  discount_pct: number
  vat_rate: number
  net: number
  vat: number
  gross: number
  unit_cost: number | null
  total_cost: number | null
  expected_qty: number | null
  diff_qty: number | null
  diff_value: number | null
  notes: string | null
}

export interface StockBalance {
  item_id: string
  company_id: string
  code: string
  name: string
  item_type: ItemType
  category: string | null
  unit: string
  avg_cost: number
  min_stock: number | null
  is_active: boolean
  make_to_order: boolean
  on_hand: number
  stock_value: number
  below_min: boolean
}

export interface PartnerBalance {
  partner_id: string
  company_id: string
  code: string
  name: string
  is_customer: boolean
  is_supplier: boolean
  is_active: boolean
  customer_balance: number
  supplier_balance: number
}

export interface DocListRow extends Doc {
  partner_name: string | null
  line_count: number
  produced_item_name: string | null
}
