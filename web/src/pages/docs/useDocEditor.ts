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
  // αυξάνεται σε κάθε reload(): οι editors ξαναγεμίζουν τις γραμμές τους
  const [ver, setVer] = useState(0)

  useEffect(() => {
    if (isNew || !id) { setLoading(false); return }
    let alive = true
    loadDoc(id).then(({ doc, lines }) => {
      if (!alive) return
      setDoc(doc); setLines(lines); setLoading(false)
    }).catch((e) => { if (alive) { setError(errMsg(e)); setLoading(false) } })
    return () => { alive = false }
  }, [id, isNew])

  /** Ξαναφορτώνει το παραστατικό όπως είναι στη βάση */
  const reload = useCallback(async () => {
    if (!doc) return
    const fresh = await loadDoc(doc.id)
    setDoc(fresh.doc); setLines(fresh.lines); setVer((v) => v + 1)
  }, [doc])

  // ανοιχτό πρόχειρο (πωλήσεις ημέρας / απογραφή σε εξέλιξη): γεμίζει από άλλες
  // οθόνες και συσκευές, άρα ξαναφόρτωση όταν γυρνάμε στη σελίδα
  const runningOpen = !!doc?.is_running && doc.status === 'draft'
  useEffect(() => {
    if (!runningOpen) return
    const h = () => { if (document.visibilityState === 'visible') reload().catch(() => { /* ignore */ }) }
    window.addEventListener('focus', h)
    document.addEventListener('visibilitychange', h)
    return () => { window.removeEventListener('focus', h); document.removeEventListener('visibilitychange', h) }
  }, [runningOpen, reload])

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

  /**
   * Καταχώρηση ανοιχτού πρόχειρου όπως είναι στη βάση (χωρίς replaceLines:
   * η οθόνη μπορεί να δείχνει παλιές γραμμές, ενώ άλλες συσκευές προσθέτουν).
   */
  const postRunning = useCallback(async () => {
    if (!doc) return
    setPosting(true); setError(null)
    try {
      await postDoc(doc.id)
      await refreshMaster()
      await reload()
      toast.ok('Καταχωρήθηκε')
    } catch (e) { setError(errMsg(e)); toast.err(errMsg(e)) } finally { setPosting(false) }
  }, [doc, refreshMaster, reload, toast])

  /** Το ανοιχτό πρόχειρο γίνεται κανονικό (επεξεργάσιμο)· οι επόμενες προσθήκες πάνε σε νέο */
  const detachRunning = useCallback(async () => {
    if (!doc) return
    setSaving(true); setError(null)
    try {
      await updateDraft(doc.id, { is_running: false })
      await reload()
      toast.ok('Έγινε κανονικό πρόχειρο: μπορείς να το αλλάξεις')
    } catch (e) { setError(errMsg(e)); toast.err(errMsg(e)) } finally { setSaving(false) }
  }, [doc, reload, toast])

  const unpost = useCallback(async () => {
    if (!doc) return
    setPosting(true); setError(null)
    try {
      await unpostDoc(doc.id)
      await refreshMaster()
      const fresh = await loadDoc(doc.id)
      setDoc(fresh.doc); setLines(fresh.lines)
      // πωλήσεις ημέρας: ξαναγίνονται ανοιχτές (κλείνουν ξανά με «Κλείσιμο ημέρας» ή αυτόματα)
      toast.ok(fresh.doc.is_running ? 'Η καταχώρηση ακυρώθηκε: οι πωλήσεις ημέρας ξανάνοιξαν (σε εξέλιξη)' : 'Η καταχώρηση ακυρώθηκε')
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

  return { doc, lines, loading, saving, posting, error, setError, saveDraft, post, unpost, remove, companyId, ver, reload, runningOpen, postRunning, detachRunning }
}
