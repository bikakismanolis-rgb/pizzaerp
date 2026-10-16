import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { Doc, DocType } from '../../lib/types'
import { DOC_TYPE_LABEL, STATUS_LABEL, docCode } from '../../lib/labels'
import { Badge, Confirm, PageTitle } from '../../components/ui'
import { fmtDateTime } from '../../lib/format'

/** Ανοιχτό πρόχειρο (πωλήσεις ημέρας / απογραφή σε εξέλιξη): μόνο προβολή + ενέργειες */
export interface RunningActions {
  /** π.χ. "οι πωλήσεις ημέρας efood" */
  what: string
  onPost: () => void
  onDetach: () => void
}

/** Κοινή κεφαλίδα + κουμπιά ενεργειών για κάθε παραστατικό */
export function DocShell({ docType, doc, isNew, saving, posting, canSave, onSave, onPost, onUnpost, onDelete, running, children }: {
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
  running?: RunningActions | null
  children: ReactNode
}) {
  const posted = doc?.status === 'posted'
  const title = isNew ? `Νέα/ο ${DOC_TYPE_LABEL[docType].toLowerCase()}` : `${DOC_TYPE_LABEL[docType]} ${doc ? docCode(docType, doc.doc_no) : ''}`
  const [ask, setAsk] = useState<'post' | 'detach' | 'delete' | null>(null)
  const busy = saving || posting
  return (
    <div>
      <PageTitle title={title}>
        <Link to={`/docs/${docType}`} className="btn-secondary">Λίστα</Link>
        {running ? (
          <>
            <button className="btn-secondary" onClick={() => setAsk('detach')} disabled={busy}>Χειροκίνητη επεξεργασία</button>
            <button className="btn-danger" onClick={() => setAsk('delete')} disabled={busy}>Διαγραφή</button>
            <button className="btn-primary" onClick={() => setAsk('post')} disabled={busy}>{posting ? 'Καταχώρηση...' : 'Καταχώρηση τώρα'}</button>
          </>
        ) : (
          <>
            {!posted && <button className="btn-secondary" onClick={onSave} disabled={busy || !canSave}>Αποθήκευση πρόχειρου</button>}
            {!posted && !isNew && <button className="btn-danger" onClick={onDelete} disabled={busy}>Διαγραφή</button>}
            {!posted && <button className="btn-primary" onClick={onPost} disabled={busy || !canSave}>{posting ? 'Καταχώρηση...' : 'Καταχώρηση'}</button>}
            {posted && <button className="btn-danger" onClick={onUnpost} disabled={posting}>Ακύρωση καταχώρησης</button>}
          </>
        )}
      </PageTitle>

      {doc && (
        <div className="mb-3 flex items-center gap-3 text-sm">
          <Badge className={posted ? 'bg-emerald-100 text-emerald-800' : 'bg-stone-200 text-stone-700'}>{STATUS_LABEL[doc.status]}</Badge>
          {running && <Badge className="bg-amber-100 text-amber-800">σε εξέλιξη</Badge>}
          {posted && doc.posted_at && <span className="text-stone-500">Καταχωρήθηκε {fmtDateTime(doc.posted_at)}</span>}
          {doc.is_auto && <span className="text-stone-500">Αυτόματο παραστατικό</span>}
        </div>
      )}

      {children}

      {running && (
        <Confirm
          open={ask !== null}
          danger={ask === 'delete'}
          title={ask === 'post' ? 'Καταχώρηση τώρα' : ask === 'detach' ? 'Χειροκίνητη επεξεργασία' : 'Διαγραφή'}
          text={ask === 'post'
            ? `Να καταχωρηθούν ${running.what} όπως είναι αυτή τη στιγμή στη βάση;`
            : ask === 'detach'
              ? `Γίνεται κανονικό πρόχειρο για να αλλάξεις τιμές ή γραμμές και σταματά να γεμίζει. Ό,τι προστεθεί από εδώ και πέρα (Πες το, Πωλήσεις ημέρας) πάει σε νέο. Να γίνει;`
              : `Να διαγραφούν ${running.what}; Χάνονται όλες οι γραμμές.`}
          onYes={() => { const a = ask; setAsk(null); if (a === 'post') running.onPost(); else if (a === 'detach') running.onDetach(); else onDelete() }}
          onNo={() => setAsk(null)}
        />
      )}
    </div>
  )
}
