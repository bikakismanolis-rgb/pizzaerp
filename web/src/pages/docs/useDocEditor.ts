import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useCompanyId } from '../../context/CompanyContext'
import { useMaster } from '../../context/MasterData'
import { useToast } from '../../components/ui'
import { errMsg } from '../../lib/supabase'
import { createDraft, deleteDraft, loadDoc, postDoc, unpostDoc, updateDraft, replaceLines, type LineInput } from '../../lib/docs'
import type { Doc, DocLine, DocType } from '../../lib/types'

interface Options {
  docType: DocType
  isNew: boolean
  id?: string
  /** πεδία κεφαλίδας για νέο πρόχειρο */
  initialFields: () => Partial<Doc>
}

/**
 * Κοινή λογική για τους editors παραστατικών: φόρτωση, αποθήκευση πρόχειρου,
 * καταχώρηση/ακύρωση. Ο κάθε editor δίνει buildFields() και buildLines().
 */
export function useDocEditor({ docType, isNew, id, initialFields }: Options) {
  const companyId = useCompanyId()
  const nav = useNavigate()
  const toast = useToast()
  const { refresh: refreshMaster } = useMaster()
  const [doc, setDoc] = useState<Doc | null>(null)
  const [lines, setLines] = useState<DocLine[]>([])
  const [loading, setLoading] = useState(!isNew)
  const [saving, setSaving] = useState(false)
  const [posting, setPosting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (isNew || !id) { setLoading(false); return }
    let alive = true
    loadDoc(id).then(({ doc, lines }) => {
      if (!alive) return
      setDoc(doc); setLines(lines); setLoading(false)
    }).catch((e) => { if (alive) { setError(errMsg(e)); setLoading(false) } })
    return () => { alive = false }
  }, [id, isNew])

  /** Αποθηκεύει (δημιουργεί ή ενημερώνει) πρόχειρο. Επιστρέφει το id ή null σε λάθος. */
  const saveDraft = useCallback(async (fields: Partial<Doc>, docLines: LineInput[], opts?: { silent?: boolean; navigate?: boolean }): Promise<string | null> => {
    setSaving(true); setError(null)
    try {
      let docId = doc?.id
      if (!docId) {
        docId = await createDraft(companyId, docType, { ...initialFields(), ...fields })
      } else {
        await updateDraft(docId, fields)
      }
      await replaceLines(companyId, docId, docLines)
      const fresh = await loadDoc(docId)
      setDoc(fresh.doc); setLines(fresh.lines)
      if (!opts?.silent) toast.ok('Αποθηκεύτηκε')
      if (opts?.navigate && isNew) nav(`/docs/${docType}/${docId}`, { replace: true })
      return docId
    } catch (e) {
      setError(errMsg(e)); toast.err(errMsg(e)); return null
    } finally { setSaving(false) }
  }, [companyId, docType, doc, initialFields, isNew, nav, toast])

  const post = useCallback(async (fields: Partial<Doc>, docLines: LineInput[]) => {
    setPosting(true); setError(null)
    try {
      const docId = await (async () => {
        let d = doc?.id
        if (!d) d = await createDraft(companyId, docType, { ...initialFields(), ...fields })
        else await updateDraft(d, fields)
        await replaceLines(companyId, d, docLines)
        return d
      })()
      await postDoc(docId)
      await refreshMaster()
      const fresh = await loadDoc(docId)
      setDoc(fresh.doc); setLines(fresh.lines)
      toast.ok('Καταχωρήθηκε')
      if (isNew) nav(`/docs/${docType}/${docId}`, { replace: true })
    } catch (e) { setError(errMsg(e)); toast.err(errMsg(e)) } finally { setPosting(false) }
  }, [companyId, docType, doc, initialFields, isNew, nav, refreshMaster, toast])

  const unpost = useCallback(async () => {
    if (!doc) return
    setPosting(true); setError(null)
    try {
      await unpostDoc(doc.id)
      await refreshMaster()
      const fresh = await loadDoc(doc.id)
      setDoc(fresh.doc); setLines(fresh.lines)
      toast.ok('Η καταχώρηση ακυρώθηκε')
    } catch (e) { setError(errMsg(e)); toast.err(errMsg(e)) } finally { setPosting(false) }
  }, [doc, refreshMaster, toast])

  const remove = useCallback(async () => {
    if (!doc) return
    try {
      await deleteDraft(doc.id)
      toast.ok('Διαγράφηκε')
      nav(`/docs/${docType}`)
    } catch (e) { setError(errMsg(e)); toast.err(errMsg(e)) }
  }, [doc, docType, nav, toast])

  return { doc, lines, loading, saving, posting, error, setError, saveDraft, post, unpost, remove, companyId }
}
