import { Link } from 'react-router-dom'
import type { Doc, DocType } from '../../lib/types'
import { DOC_TYPE_LABEL, STATUS_LABEL, docCode } from '../../lib/labels'
import { Badge, PageTitle } from '../../components/ui'
import { fmtDateTime } from '../../lib/format'
import type { ReactNode } from 'react'

/** Κοινή κεφαλίδα + κουμπιά ενεργειών για κάθε παραστατικό */
export function DocShell({ docType, doc, isNew, saving, posting, canSave, onSave, onPost, onUnpost, onDelete, children }: {
  docType: DocType
  doc: Doc | null
  isNew: boolean
  saving: boolean
  posting: boolean
  canSave: boolean
  onSave: () => void
  onPost: () => void
  onUnpost: () => void
  onDelete: () => void
  children: ReactNode
}) {
  const posted = doc?.status === 'posted'
  const title = isNew ? `Νέα/ο ${DOC_TYPE_LABEL[docType].toLowerCase()}` : `${DOC_TYPE_LABEL[docType]} ${doc ? docCode(docType, doc.doc_no) : ''}`
  return (
    <div>
      <PageTitle title={title}>
        <Link to={`/docs/${docType}`} className="btn-secondary">Λίστα</Link>
        {!posted && <button className="btn-secondary" onClick={onSave} disabled={saving || posting || !canSave}>Αποθήκευση πρόχειρου</button>}
        {!posted && !isNew && <button className="btn-danger" onClick={onDelete} disabled={saving || posting}>Διαγραφή</button>}
        {!posted && <button className="btn-primary" onClick={onPost} disabled={saving || posting || !canSave}>{posting ? 'Καταχώρηση...' : 'Καταχώρηση'}</button>}
        {posted && <button className="btn-danger" onClick={onUnpost} disabled={posting}>Ακύρωση καταχώρησης</button>}
      </PageTitle>

      {doc && (
        <div className="mb-3 flex items-center gap-3 text-sm">
          <Badge className={posted ? 'bg-emerald-100 text-emerald-800' : 'bg-stone-200 text-stone-700'}>{STATUS_LABEL[doc.status]}</Badge>
          {posted && doc.posted_at && <span className="text-stone-500">Καταχωρήθηκε {fmtDateTime(doc.posted_at)}</span>}
          {doc.is_auto && <span className="text-stone-500">Αυτόματο παραστατικό</span>}
        </div>
      )}

      {children}
    </div>
  )
}
