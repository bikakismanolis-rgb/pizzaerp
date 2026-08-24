import { supabase } from './supabase'
import type { Doc, DocLine, DocType } from './types'

export interface FullDoc {
  doc: Doc
  lines: DocLine[]
}

export async function loadDoc(id: string): Promise<FullDoc> {
  const { data: doc, error } = await supabase.from('doc').select('*').eq('id', id).single()
  if (error) throw error
  const { data: lines, error: e2 } = await supabase.from('doc_line').select('*').eq('doc_id', id).order('line_no')
  if (e2) throw e2
  return { doc: doc as Doc, lines: (lines ?? []) as DocLine[] }
}

/** Δημιουργεί πρόχειρο παραστατικό και επιστρέφει το id */
export async function createDraft(companyId: string, docType: DocType, fields: Partial<Doc>): Promise<string> {
  const { data, error } = await supabase
    .from('doc')
    .insert({ company_id: companyId, doc_type: docType, status: 'draft', ...fields })
    .select('id')
    .single()
  if (error) throw error
  return (data as { id: string }).id
}

export async function updateDraft(id: string, fields: Partial<Doc>): Promise<void> {
  const { error } = await supabase.from('doc').update(fields).eq('id', id)
  if (error) throw error
}

export interface LineInput {
  line_no: number
  role?: 'item' | 'output' | 'input'
  item_id: string
  qty: number
  unit_price?: number
  discount_pct?: number
  vat_rate?: number
  notes?: string | null
}

/** Αντικαθιστά όλες τις γραμμές ενός πρόχειρου παραστατικού */
export async function replaceLines(companyId: string, docId: string, lines: LineInput[]): Promise<void> {
  const { error: ed } = await supabase.from('doc_line').delete().eq('doc_id', docId)
  if (ed) throw ed
  if (lines.length === 0) return
  const { error: ei } = await supabase.from('doc_line').insert(
    lines.map((l) => ({
      company_id: companyId,
      doc_id: docId,
      line_no: l.line_no,
      role: l.role ?? 'item',
      item_id: l.item_id,
      qty: l.qty,
      unit_price: l.unit_price ?? 0,
      discount_pct: l.discount_pct ?? 0,
      vat_rate: l.vat_rate ?? 0,
      notes: l.notes ?? null,
    })),
  )
  if (ei) throw ei
}

export async function postDoc(id: string): Promise<void> {
  const { error } = await supabase.rpc('post_document', { p_doc: id })
  if (error) throw error
}

export async function unpostDoc(id: string): Promise<void> {
  const { error } = await supabase.rpc('unpost_document', { p_doc: id })
  if (error) throw error
}

export async function deleteDraft(id: string): Promise<void> {
  const { error } = await supabase.from('doc').delete().eq('id', id)
  if (error) throw error
}

export async function explodeBom(id: string): Promise<void> {
  const { error } = await supabase.rpc('explode_bom', { p_doc: id })
  if (error) throw error
}
