import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import type { Doc, DocType } from '../../lib/types'
import { toNum, today } from '../../lib/format'
import { ErrorBox, Field, NumInput, Spinner } from '../../components/ui'
import { PartnerPicker } from '../../components/Pickers'
import type { LineInput } from '../../lib/docs'
import { useDocEditor } from './useDocEditor'
import { DocShell } from './DocShell'

/** Είσπραξη (από πελάτη) ή Πληρωμή (σε προμηθευτή): ποσό + συναλλασσόμενος */
export function PaymentDoc({ docType }: { docType: DocType }) {
  const { id } = useParams()
  const isNew = !id || id === 'new'
  const isReceipt = docType === 'receipt'

  const ed = useDocEditor({ docType, isNew, id, initialFields: () => ({ doc_date: today() }) })
  const { doc, loading, saving, posting } = ed
  const posted = doc?.status === 'posted'

  const [date, setDate] = useState(today())
  const [partnerId, setPartnerId] = useState<string | null>(null)
  const [amount, setAmount] = useState('')
  const [refNo, setRefNo] = useState('')
  const [notes, setNotes] = useState('')

  useEffect(() => {
    if (!doc) return
    setDate(doc.doc_date); setPartnerId(doc.partner_id); setAmount(doc.amount ? String(doc.amount) : ''); setRefNo(doc.ref_no ?? ''); setNotes(doc.notes ?? '')
  }, [doc?.id, doc?.status])

  const canSave = !!partnerId && toNum(amount) > 0
  const buildFields = (): Partial<Doc> => ({ doc_date: date, partner_id: partnerId, amount: toNum(amount), ref_no: refNo.trim() || null, notes: notes.trim() || null })
  const buildLines = (): LineInput[] => []

  if (loading) return <Spinner />

  return (
    <DocShell docType={docType} doc={doc} isNew={isNew} saving={saving} posting={posting} canSave={canSave}
      onSave={() => ed.saveDraft(buildFields(), buildLines(), { navigate: true })}
      onPost={() => ed.post(buildFields(), buildLines())}
      onUnpost={ed.unpost} onDelete={ed.remove}>
      <ErrorBox text={ed.error} />
      <div className="card p-4 grid gap-3 sm:grid-cols-2 max-w-2xl">
        <Field label="Ημερομηνία"><input type="date" className="input" value={date} disabled={posted} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label={isReceipt ? 'Πελάτης' : 'Προμηθευτής'}>
          <PartnerPicker kind={isReceipt ? 'customer' : 'supplier'} value={partnerId} disabled={posted} onChange={setPartnerId} />
        </Field>
        <Field label="Ποσό"><NumInput value={amount} disabled={posted} onChange={setAmount} min={0} /></Field>
        <Field label="Αριθμός παραστατικού (προαιρετικό)"><input className="input" value={refNo} disabled={posted} onChange={(e) => setRefNo(e.target.value)} /></Field>
        <Field label="Σημειώσεις" className="sm:col-span-2"><textarea className="input" rows={2} value={notes} disabled={posted} onChange={(e) => setNotes(e.target.value)} /></Field>
      </div>
    </DocShell>
  )
}
