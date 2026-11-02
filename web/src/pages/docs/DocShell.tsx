import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { Doc, DocType } from '../../lib/types'
import { DOC_TYPE_LABEL, DOC_TYPE_LABEL_PLURAL, STATUS_LABEL, docCode } from '../../lib/labels'
import { Badge, Confirm, PageTitle } from '../../components/ui'
import { fmtDateTime } from '../../lib/format'

/** Ανοιχτό πρόχειρο (πωλήσεις ημέρας / απογραφή σε εξέλιξη): μόνο προβολή + ενέργειες */
export interface RunningActions {
  /** π.χ. "οι πωλήσεις ημέρας efood" */
  what: string
  onPost: () => void
  onDetach: () => void
}

/** Τίτλος νέου: «Νέα αγορά», όχι «Νέα/ο αγορά» */
export const NEW_DOC_TITLE: Record<DocType, string> = {
  purchase: 'Νέα αγορά', sale: 'Νέα πώληση', production: 'Νέα παραγωγή',
  stocktake: 'Νέα μέτρηση αποθήκης', receipt: 'Νέα είσπραξη', payment: 'Νέα πληρωμή',
}

type Ask = 'post' | 'detach' | 'delete' | 'unpost'

/**
 * Κοινή κεφαλίδα + κουμπιά για κάθε παραστατικό. Ένα μεγάλο κουμπί
 * («Πέρασέ το ✓») που μετράει στην αποθήκη και στα λεφτά· το «για αργότερα»
 * μικρό στο πλάι. Σβήσιμο και διόρθωση ρωτάνε πρώτα.
 */
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
  const title = isNew || !doc ? NEW_DOC_TITLE[docType] : `${DOC_TYPE_LABEL[docType]} ${docCode(docType, doc.doc_no)}`
  const [ask, setAsk] = useState<Ask | null>(null)
  const busy = saving || posting
  const what = running?.what ?? `αυτή η ${DOC_TYPE_LABEL[docType].toLowerCase()}`

  const confirmText: Record<Ask, { title: string; text: string; yes: string; danger?: boolean }> = {
    post: { title: 'Πέρασέ το τώρα', text: `Να περαστούν ${what} όπως είναι τώρα;`, yes: 'Ναι, πέρασέ το' },
    detach: {
      title: 'Αλλαγή με το χέρι',
      text: 'Σταματά να γεμίζει μόνο του, για να αλλάξεις τιμές ή γραμμές. Ό,τι πεις από εδώ και πέρα (Πες το, Πωλήσεις ημέρας) πάει σε καινούργιο. Να γίνει;',
      yes: 'Ναι, να το αλλάξω',
    },
    delete: { title: 'Σβήσιμο', text: `Να σβηστεί ${running ? running.what : 'αυτό'}; Χάνονται όλες οι γραμμές του.`, yes: "Ναι, σβήσ' το", danger: true },
    unpost: {
      title: 'Διόρθωση',
      text: 'Ανοίγει ξανά για να το διορθώσεις. Μέχρι να ξαναπατήσεις «Πέρασέ το», δεν μετράει στην αποθήκη ούτε στα λεφτά.',
      yes: 'Ναι, να το διορθώσω',
    },
  }
  const doAsk = (a: Ask) => {
    setAsk(null)
    if (a === 'post') running?.onPost()
    else if (a === 'detach') running?.onDetach()
    else if (a === 'delete') onDelete()
    else onUnpost()
  }
  const c = ask ? confirmText[ask] : null

  return (
    <div>
      <Link to={`/docs/${docType}`} className="inline-block text-red-700 underline mb-1">← {DOC_TYPE_LABEL_PLURAL[docType]}</Link>
      <PageTitle title={title}>
        {running ? (
          <>
            <button className="btn-primary text-base px-5" onClick={() => setAsk('post')} disabled={busy}>{posting ? 'Περνάει…' : 'Πέρασέ το τώρα ✓'}</button>
            <button className="btn-secondary" onClick={() => setAsk('detach')} disabled={busy}>Αλλαγή με το χέρι</button>
            <button className="btn-danger" onClick={() => setAsk('delete')} disabled={busy}>Σβήσε</button>
          </>
        ) : posted ? (
          <button className="btn-secondary" onClick={() => setAsk('unpost')} disabled={posting}>Διόρθωση</button>
        ) : (
          <>
            <button className="btn-primary text-base px-5" onClick={onPost} disabled={busy || !canSave}>{posting ? 'Περνάει…' : 'Πέρασέ το ✓'}</button>
            <button className="btn-secondary" onClick={onSave} disabled={busy || !canSave} title="Κρατιέται, αλλά δεν μετράει ακόμα">Για αργότερα</button>
            {!isNew && <button className="btn-danger" onClick={() => setAsk('delete')} disabled={busy}>Σβήσε</button>}
          </>
        )}
      </PageTitle>

      {doc ? (
        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          {running
            ? <Badge className="bg-amber-100 text-amber-800">Ανοιχτό: γεμίζει μόνο του</Badge>
            : <Badge className={posted ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-900'}>{STATUS_LABEL[doc.status]}</Badge>}
          {posted && doc.posted_at && <span className="text-stone-600">{fmtDateTime(doc.posted_at)}</span>}
          {!posted && !running && <span className="text-stone-600">Δεν μετράει μέχρι να πατήσεις «Πέρασέ το».</span>}
          {doc.is_auto && <span className="text-stone-600">Έγινε μόνο του</span>}
        </div>
      ) : (
        <p className="mb-3 text-sm text-stone-600">Γράψε τι έγινε και πάτα «Πέρασέ το». Αν δεν τελείωσες, «Για αργότερα».</p>
      )}

      {children}

      {c && (
        <Confirm open title={c.title} text={c.text} yes={c.yes} danger={c.danger}
          onYes={() => doAsk(ask!)} onNo={() => setAsk(null)} />
      )}
    </div>
  )
}
