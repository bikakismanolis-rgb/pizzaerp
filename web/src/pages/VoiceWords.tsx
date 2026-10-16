import { useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useCompanyId } from '../context/CompanyContext'
import { useMaster } from '../context/MasterData'
import type { Item, Partner, VoicePhrase } from '../lib/types'
import type { InterpretContext, TallyChannel, VoicePhraseRule } from '../lib/voice/types'
import { interpret } from '../lib/voice/interpret'
import { describe } from '../lib/voice/describe'
import { applyPhrases, phraseKey } from '../lib/voice/normalize'
import { addAlias, deletePhrase, removeAlias, savePhrase, voiceError } from '../lib/voice/actions'
import { phraseProblem, phrasesMatchPlural, pluralOffer } from '../lib/voiceRules'
import { ITEM_TYPE_LABEL, TALLY_CHANNELS } from '../lib/labels'
import { Confirm, PageTitle, Spinner, useToast } from '../components/ui'

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ς/g, 'σ').replace(/\s+/g, ' ').trim()

function defaultChannel(): TallyChannel {
  try {
    const c = localStorage.getItem('pizza-erp.channel') as TallyChannel | null
    if (c && TALLY_CHANNELS.includes(c)) return c
  } catch { /* ignore */ }
  return 'efood'
}

type Entity = { kind: 'item'; row: Item } | { kind: 'partner'; row: Partner }

/** Πώς πιάνονται οι φράσεις (ο πληθυντικός θέλει δική του, αν δεν τον πιάνει ο interpreter) */
const PHRASE_HINT = phrasesMatchPlural()
  ? 'Πιάνει ολόκληρες λέξεις και τον πληθυντικό τους, με ή χωρίς τόνους και κεφαλαία. Η μεγαλύτερη φράση πιάνει πρώτη.'
  : 'Πιάνει ολόκληρες λέξεις όπως τις γράφεις, με ή χωρίς τόνους και κεφαλαία: ο πληθυντικός («οικογενειακές») θέλει δική του φράση. Η μεγαλύτερη φράση πιάνει πρώτη.'

const entityKey = (e: Entity) => `${e.kind}:${e.row.id}`
const entitySub = (e: Entity) => (e.kind === 'item'
  ? ITEM_TYPE_LABEL[e.row.item_type]
  : e.row.is_customer && e.row.is_supplier ? 'Πελάτης & προμηθευτής' : e.row.is_customer ? 'Πελάτης' : 'Προμηθευτής')

/**
 * «Λέξεις & φράσεις»: ό,τι έχει μάθει το «Πες το» για το πώς τα λέτε.
 * Δικές σας φράσεις ("όταν λέω Χ εννοώ Υ") και άλλα ονόματα ειδών /
 * πελατών / προμηθευτών, με κουτί δοκιμής.
 */
export function VoiceWords() {
  const companyId = useCompanyId()
  const { items, partners, phrases, ready, refresh, refreshPhrases } = useMaster()
  const toast = useToast()

  // νέα φράση
  const [newPhrase, setNewPhrase] = useState('')
  const [newMeaning, setNewMeaning] = useState('')
  const [adding, setAdding] = useState(false)
  // να μάθει και τον πληθυντικό, όταν προτείνεται
  const [addPlural, setAddPlural] = useState(true)
  // αλλαγή υπάρχουσας
  const [editId, setEditId] = useState<string | null>(null)
  const [editPhrase, setEditPhrase] = useState('')
  const [editMeaning, setEditMeaning] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)
  const [editPlural, setEditPlural] = useState(true)
  const [askDelete, setAskDelete] = useState<VoicePhrase | null>(null)
  // δοκιμή
  const [test, setTest] = useState('')
  // άλλα ονόματα
  const [search, setSearch] = useState('')

  const rules: VoicePhraseRule[] = useMemo(() => phrases.map((p) => ({ phrase: p.phrase, meaning: p.meaning })), [phrases])
  const draftOk = !phraseProblem(newPhrase, newMeaning)
  // «2 οικογενειακές»: ο πληθυντικός της νέας φράσης, αν δεν τον πιάνει ήδη
  const plural = useMemo(() => pluralOffer(newPhrase, newMeaning, rules), [newPhrase, newMeaning, rules])
  // στην αλλαγή: χωρίς την ίδια τη φράση που αλλάζει
  const editPluralOffer = useMemo(() => (editId
    ? pluralOffer(editPhrase, editMeaning, phrases.filter((p) => p.id !== editId).map((p) => ({ phrase: p.phrase, meaning: p.meaning })))
    : null), [editId, editPhrase, editMeaning, phrases])
  // η δοκιμή λογαριάζει και τη φράση που γράφεται (πριν αποθηκευτεί)
  const testRules = useMemo(
    // πρώτη: ίδια φράση με υπάρχουσα = η νέα σημασία (ο parser κρατά την πρώτη)
    () => (draftOk
      ? [{ phrase: newPhrase.trim(), meaning: newMeaning.trim() }, ...(plural && addPlural ? [{ phrase: plural, meaning: newMeaning.trim() }] : []), ...rules]
      : rules),
    [rules, draftOk, newPhrase, newMeaning, plural, addPlural],
  )
  const ctx: InterpretContext = useMemo(() => ({ items, partners, defaultChannel: defaultChannel(), phrases: testRules }), [items, partners, testRules])
  const tried = useMemo(() => {
    const t = test.trim()
    if (!t || !ready) return null
    const interp = interpret(t, ctx)
    // με τον κατάλογο: όπως το interpret (δεν κόβει μεγαλύτερα ονόματα, π.χ. «Ζυμάρι 400γρ»)
    const rewritten = applyPhrases(t, testRules, ctx)
    // χωρίς το «Να το περάσω;»: εδώ δεν περνάει τίποτα
    return { interp, rewritten: rewritten !== t ? rewritten : null, sentence: describe(interp, ctx).replace(/\s*Να [^.;]*;$/, '') }
  }, [test, ctx, testRules, ready])

  const sameAs = (phrase: string, exceptId?: string) => {
    const k = phraseKey(phrase)
    return k ? phrases.find((p) => p.id !== exceptId && phraseKey(p.phrase) === k) : undefined
  }

  const add = async () => {
    const why = phraseProblem(newPhrase, newMeaning)
    if (why) { toast.err(why); return }
    setAdding(true)
    try {
      const { row, old } = await savePhrase(companyId, newPhrase, newMeaning)
      let also = ''
      if (plural && addPlural) {
        try { also = ` και «${(await savePhrase(companyId, plural, newMeaning)).row.phrase}»` } catch (e) { toast.err(voiceError(e).message) }
      }
      await refreshPhrases()
      toast.ok(old ? `Άλλαξε: «${row.phrase}»${also} → «${row.meaning}» (πριν «${old.meaning}»)` : `Έμαθα: «${row.phrase}»${also} → «${row.meaning}»`)
      setNewPhrase(''); setNewMeaning(''); setAddPlural(true)
    } catch (e) { toast.err(voiceError(e).message) } finally { setAdding(false) }
  }

  const startEdit = (p: VoicePhrase) => { setEditId(p.id); setEditPhrase(p.phrase); setEditMeaning(p.meaning); setEditPlural(true) }

  const saveEdit = async () => {
    if (!editId) return
    const why = phraseProblem(editPhrase, editMeaning)
    if (why) { toast.err(why); return }
    setSavingEdit(true)
    try {
      await savePhrase(companyId, editPhrase, editMeaning, editId)
      // και ο πληθυντικός (νέος ή με την παλιά σημασία)
      let also = ''
      if (editPluralOffer && editPlural) {
        try { also = ` (και «${(await savePhrase(companyId, editPluralOffer, editMeaning)).row.phrase}»)` } catch (e) { toast.err(voiceError(e).message) }
      }
      await refreshPhrases()
      setEditId(null)
      toast.ok('Αποθηκεύτηκε' + also)
    } catch (e) { toast.err(voiceError(e).message) } finally { setSavingEdit(false) }
  }

  const remove = async (p: VoicePhrase) => {
    setAskDelete(null)
    try {
      await deletePhrase(p.id)
      await refreshPhrases()
      if (editId === p.id) setEditId(null)
      toast.ok(`Σβήστηκε η φράση «${p.phrase}»`)
    } catch (e) { toast.err(voiceError(e).message) }
  }

  // ---------------------------------------------------------------
  // Άλλα ονόματα
  // ---------------------------------------------------------------
  const all: Entity[] = useMemo(() => [
    ...items.map((row) => ({ kind: 'item' as const, row })),
    ...partners.map((row) => ({ kind: 'partner' as const, row })),
  ], [items, partners])

  const shown: Entity[] = useMemo(() => {
    const q = norm(search)
    const byName = (a: Entity, b: Entity) => a.row.name.localeCompare(b.row.name, 'el')
    if (!q) return all.filter((e) => (e.row.aliases ?? []).length > 0).sort(byName)
    return all
      .filter((e) => norm(e.row.name).includes(q) || norm(e.row.code).includes(q) || (e.row.aliases ?? []).some((a) => norm(a).includes(q)))
      .sort((a, b) => Number(b.row.is_active) - Number(a.row.is_active) || byName(a, b))
      .slice(0, 30)
  }, [all, search])

  /** Άλλο είδος / συναλλασσόμενος με το ίδιο όνομα ή άλλο όνομα (θα μπερδεύει) */
  const clash = (alias: string, self: Entity): Entity | undefined => {
    const k = norm(alias)
    return all.find((e) => entityKey(e) !== entityKey(self) && e.row.is_active &&
      (norm(e.row.name) === k || (e.row.aliases ?? []).some((a) => norm(a) === k)))
  }

  return (
    <div className="max-w-2xl mx-auto pb-24">
      <PageTitle title="Λέξεις & φράσεις">
        <Link to="/voice" className="btn-secondary h-11 inline-flex items-center">🎤 Πες το</Link>
      </PageTitle>
      <p className="text-sm text-stone-600 mb-3">
        Μάθε στο «Πες το» πώς τα λέτε εσείς. Μια <b>φράση</b> αλλάζει ό,τι λες πριν το καταλάβει
        (π.χ. «οικογενειακή» → «μεγάλη μαργαρίτα»). Ένα <b>άλλο όνομα</b> είναι ένας ακόμα τρόπος να πεις ένα είδος ή έναν πελάτη.
        Και με φωνή: «όταν λέω οικογενειακή εννοώ μεγάλη μαργαρίτα».
      </p>

      {!ready ? <Spinner /> : (
        <>
          {/* Δοκιμή */}
          <section className="card p-3 mb-3">
            <h2 className="font-semibold text-sm mb-2">Δοκίμασε</h2>
            <input className="input h-11 text-base" value={test} onChange={(e) => setTest(e.target.value)}
              placeholder="Γράψε ή υπαγόρευσε μια φράση…" aria-label="Φράση για δοκιμή" enterKeyHint="done" autoComplete="off" />
            {tried && (
              <div className="mt-2 flex flex-col gap-1 text-sm">
                {tried.rewritten && <div className="text-stone-600">Με τις φράσεις σας: «{tried.rewritten}»</div>}
                <div className={tried.interp.command.kind === 'unknown' ? 'text-amber-800' : 'text-stone-900 font-medium'}>{tried.sentence}</div>
                {tried.interp.issues.length > 0 && (
                  <ul className="text-xs text-amber-900 list-disc list-inside">{tried.interp.issues.map((x, i) => <li key={i}>{x}</li>)}</ul>
                )}
                <div className="text-xs text-stone-500">Μόνο δοκιμή: δεν γράφεται τίποτα.</div>
              </div>
            )}
          </section>

          {/* Δικές σας φράσεις */}
          <section className="card mb-3">
            <div className="px-3 pt-3 pb-2 flex items-baseline justify-between gap-2">
              <h2 className="font-semibold text-sm">Οι φράσεις σας</h2>
              <span className="text-xs text-stone-500">{phrases.length}</span>
            </div>
            <form className="px-3 pb-3 flex flex-col gap-2 border-b border-stone-200" onSubmit={(e) => { e.preventDefault(); add() }}>
              <PhraseFields phrase={newPhrase} meaning={newMeaning} onPhrase={setNewPhrase} onMeaning={setNewMeaning}
                placeholders={['π.χ. οικογενειακή', 'π.χ. μεγάλη μαργαρίτα']} />
              {newPhrase.trim() && sameAs(newPhrase) && (
                <div className="text-xs text-amber-800">Υπάρχει ήδη «{sameAs(newPhrase)!.phrase}» → «{sameAs(newPhrase)!.meaning}»: θα αλλάξει.</div>
              )}
              {plural && (
                <label className="flex items-center gap-3 text-sm min-h-[44px]">
                  <input type="checkbox" className="h-5 w-5 shrink-0" checked={addPlural} onChange={(e) => setAddPlural(e.target.checked)} />
                  <span>Και στον πληθυντικό: «{plural}»</span>
                </label>
              )}
              <button className="btn-primary h-11" disabled={adding || !newPhrase.trim() || !newMeaning.trim()}>
                {adding ? 'Αποθήκευση…' : 'Πρόσθεση φράσης'}
              </button>
            </form>
            {phrases.length === 0 ? (
              <p className="px-3 py-3 text-sm text-stone-500">
                Καμία φράση ακόμα. Π.χ. όταν λέω «το συνηθισμένο του ξενοδοχείου» εννοώ «πούλησα στο ξενοδοχείο Αστέρια 60 σπέσιαλ κατεψυγμένες».
              </p>
            ) : (
              <ul className="divide-y divide-stone-100">
                {phrases.map((p) => (
                  <li key={p.id} className="px-3 py-2">
                    {editId === p.id ? (
                      <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); saveEdit() }}>
                        <PhraseFields phrase={editPhrase} meaning={editMeaning} onPhrase={setEditPhrase} onMeaning={setEditMeaning} autoFocus />
                        {editPluralOffer && (
                          <label className="flex items-center gap-3 text-sm min-h-[44px]">
                            <input type="checkbox" className="h-5 w-5 shrink-0" checked={editPlural} onChange={(e) => setEditPlural(e.target.checked)} />
                            <span>Και στον πληθυντικό: «{editPluralOffer}»</span>
                          </label>
                        )}
                        <div className="flex gap-2">
                          <button type="button" className="btn-secondary h-11 flex-1" onClick={() => setEditId(null)} disabled={savingEdit}>Άκυρο</button>
                          <button className="btn-primary h-11 flex-[2]" disabled={savingEdit}>{savingEdit ? 'Αποθήκευση…' : 'Αποθήκευση'}</button>
                        </div>
                      </form>
                    ) : (
                      <div className="flex items-center gap-2">
                        <div className="flex-1 min-w-0 text-sm break-words">
                          <span className="text-stone-500">Όταν λέω </span><b>«{p.phrase}»</b>
                          <span className="text-stone-500"> εννοώ </span><span>«{p.meaning}»</span>
                        </div>
                        <button type="button" className="btn-ghost h-11 px-2 text-sm shrink-0" onClick={() => startEdit(p)}>Αλλαγή</button>
                        <button type="button" className="btn-ghost h-11 w-11 p-0 shrink-0" aria-label={`Σβήσιμο «${p.phrase}»`} onClick={() => setAskDelete(p)}>✕</button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <p className="px-3 py-2 text-xs text-stone-500 border-t border-stone-100">
              {PHRASE_HINT}
            </p>
          </section>

          {/* Άλλα ονόματα */}
          <section className="card mb-3">
            <div className="px-3 pt-3 pb-2">
              <h2 className="font-semibold text-sm">Άλλα ονόματα ειδών, πελατών, προμηθευτών</h2>
              <p className="text-xs text-stone-500 mt-0.5">Π.χ. η Μαργαρίτα είναι και «σκέτη», ο Μύλος Α.Ε. είναι και «μύλος».</p>
            </div>
            <div className="px-3 pb-2">
              <input className="input h-11 text-base" value={search} onChange={(e) => setSearch(e.target.value)}
                placeholder="Βρες είδος ή πελάτη…" aria-label="Αναζήτηση είδους ή συναλλασσόμενου" autoComplete="off" />
            </div>
            {shown.length === 0 ? (
              <p className="px-3 pb-3 text-sm text-stone-500">
                {search.trim() ? 'Δεν βρέθηκε.' : 'Κανένα άλλο όνομα ακόμα. Γράψε παραπάνω ένα είδος ή έναν πελάτη για να προσθέσεις.'}
              </p>
            ) : (
              <ul className="divide-y divide-stone-100 border-t border-stone-100">
                {shown.map((e) => (
                  <AliasRow key={entityKey(e)} entity={e} clash={clash} onChanged={refresh} />
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      <Confirm
        open={!!askDelete}
        danger
        title="Σβήσιμο φράσης"
        text={askDelete ? `Να σβηστεί η φράση «${askDelete.phrase}» → «${askDelete.meaning}»;` : ''}
        onYes={() => askDelete && remove(askDelete)}
        onNo={() => setAskDelete(null)}
      />
    </div>
  )
}

function PhraseFields({ phrase, meaning, onPhrase, onMeaning, placeholders, autoFocus }: {
  phrase: string; meaning: string; onPhrase: (v: string) => void; onMeaning: (v: string) => void
  placeholders?: [string, string]; autoFocus?: boolean
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-stone-500">Όταν λέω</span>
        <input className="input h-11 text-base" value={phrase} onChange={(e) => onPhrase(e.target.value)} placeholder={placeholders?.[0]}
          aria-label="Όταν λέω" maxLength={200} autoFocus={autoFocus} autoComplete="off" />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-stone-500">εννοώ</span>
        <input className="input h-11 text-base" value={meaning} onChange={(e) => onMeaning(e.target.value)} placeholder={placeholders?.[1]}
          aria-label="εννοώ" maxLength={200} autoComplete="off" />
      </label>
    </div>
  )
}

function AliasRow({ entity, clash, onChanged }: {
  entity: Entity
  clash: (alias: string, self: Entity) => Entity | undefined
  onChanged: () => Promise<void>
}) {
  const toast = useToast()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const aliases = entity.row.aliases ?? []

  const run = async (f: () => Promise<void>) => {
    setBusy(true)
    try { await f(); await onChanged() } catch (e) { toast.err(voiceError(e).message) } finally { setBusy(false) }
  }

  const add = () => run(async () => {
    const a = text.trim().replace(/\s+/g, ' ')
    if (!a) return
    const other = clash(a, entity)
    if (await addAlias(entity.kind, entity.row.id, a)) {
      setText('')
      toast.ok(`«${entity.row.name}»: και «${a}»`)
      if (other) toast.info(`Προσοχή: το «${a}» είναι και όνομα του «${other.row.name}». Θα ρωτάω ποιο εννοείς.`)
    } else {
      setText('')
      toast.info(`Το «${a}» το ξέρω ήδη για «${entity.row.name}».`)
    }
  })

  const remove = (a: string) => run(async () => {
    await removeAlias(entity.kind, entity.row.id, a)
  })

  return (
    <li className="px-3 py-2 flex flex-col gap-2">
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="font-medium">{entity.row.name}</span>
        <span className="text-xs text-stone-500">{entitySub(entity)}{!entity.row.is_active && ' · ανενεργό'}</span>
      </div>
      {aliases.length > 0 && (
        <div className="flex gap-2 flex-wrap">
          {aliases.map((a) => (
            <AliasChip key={a} onRemove={() => remove(a)} disabled={busy} label={a}>{a}</AliasChip>
          ))}
        </div>
      )}
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); add() }}>
        <input className="input h-11 text-base flex-1 min-w-0" value={text} onChange={(e) => setText(e.target.value)}
          placeholder="+ άλλο όνομα" aria-label={`Άλλο όνομα για ${entity.row.name}`} autoComplete="off" />
        <button className="btn-secondary h-11 px-4 shrink-0" disabled={busy || !text.trim()}>Πρόσθεση</button>
      </form>
    </li>
  )
}

function AliasChip({ children, onRemove, disabled, label }: { children: ReactNode; onRemove: () => void; disabled?: boolean; label: string }) {
  return (
    <span className="inline-flex items-center rounded-full border border-stone-300 bg-stone-50 pl-3 text-sm">
      {children}
      <button type="button" className="h-10 w-10 inline-flex items-center justify-center text-stone-500 active:text-red-700 disabled:opacity-40"
        aria-label={`Αφαίρεση «${label}»`} onClick={onRemove} disabled={disabled}>✕</button>
    </span>
  )
}
