import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Φωνή του κινητού: αναγνώριση ομιλίας (Web Speech API, el-GR) και ανάγνωση
 * φωναχτά (speechSynthesis). Τίποτα δεν φεύγει σε δικό μας API: ό,τι κάνει
 * ο browser / το κινητό.
 */

// Ελάχιστοι τύποι: το lib.dom δεν έχει το SpeechRecognition
interface RecAlternative { readonly transcript: string }
interface RecResult { readonly isFinal: boolean; readonly length: number; readonly [i: number]: RecAlternative }
interface RecResultList { readonly length: number; readonly [i: number]: RecResult }
interface RecEvent extends Event { readonly resultIndex: number; readonly results: RecResultList }
interface RecErrorEvent extends Event { readonly error: string; readonly message?: string }
interface Rec {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  start(): void
  stop(): void
  abort(): void
  onstart: (() => void) | null
  onresult: ((e: RecEvent) => void) | null
  onerror: ((e: RecErrorEvent) => void) | null
  onend: (() => void) | null
}
type RecCtor = new () => Rec

function recCtor(): RecCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { SpeechRecognition?: RecCtor; webkitSpeechRecognition?: RecCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

/** Υποστηρίζει ο browser αναγνώριση ομιλίας; */
export const speechRecognitionSupported = (): boolean => recCtor() !== null

/** Μήνυμα για τον χρήστη ανά κωδικό σφάλματος (null = να μη φανεί τίποτα) */
function recErrorText(code: string): string | null {
  switch (code) {
    case 'aborted': return null
    case 'no-speech': return 'Δεν άκουσα τίποτα. Πάτα το μικρόφωνο και μίλα αμέσως.'
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Δεν υπάρχει άδεια για το μικρόφωνο. Δώσε άδεια στον browser (λουκέτο δίπλα στη διεύθυνση → Μικρόφωνο) ή γράψε στο κουτί.'
    case 'network': return 'Η αναγνώριση φωνής θέλει internet. Έλεγξε τη σύνδεση ή γράψε στο κουτί.'
    case 'audio-capture': return 'Δεν βρέθηκε μικρόφωνο.'
    case 'language-not-supported': return 'Η συσκευή δεν αναγνωρίζει ελληνικά. Χρησιμοποίησε το μικρόφωνο του πληκτρολογίου.'
    default: return 'Η αναγνώριση φωνής απέτυχε (' + code + '). Δοκίμασε ξανά.'
  }
}

/**
 * Ενώνει τα τελικά αποτελέσματα. Το Chrome σε Android συχνά στέλνει το ίδιο
 * κείμενο σωρευτικά ("τρεις", "τρεις μαργαρίτες"): κρατάμε το μεγαλύτερο.
 */
function joinFinals(parts: string[]): string {
  const xs = parts.map((p) => p.trim()).filter(Boolean)
  if (xs.length <= 1) return xs[0] ?? ''
  const low = xs.map((x) => x.toLowerCase())
  const cumulative = low.every((x, i) => i === 0 || x.startsWith(low[i - 1]) || low[i - 1].startsWith(x))
  if (cumulative) return xs.reduce((a, b) => (b.length >= a.length ? b : a))
  return xs.join(' ')
}

export interface ListenOptions {
  /** καλείται μία φορά στο τέλος με ό,τι ακούστηκε (όχι αν δεν ακούστηκε τίποτα) */
  onFinal?: (text: string) => void
  /** καλείται στο τέλος σε κάθε περίπτωση (και με κενό κείμενο) */
  onEnd?: (text: string) => void
  /** χωρίς μήνυμα σφάλματος (π.χ. αυτόματη εκκίνηση χωρίς πάτημα) */
  quiet?: boolean
}

/**
 * Αναγνώριση μίας φράσης (single utterance, όπως θέλει το Chrome σε Android):
 * start() → ζωντανό interim κείμενο → τελικό transcript → onFinal.
 */
export function useSpeechRecognition(lang = 'el-GR') {
  const [supported] = useState(speechRecognitionSupported)
  const [listening, setListening] = useState(false)
  const [interim, setInterim] = useState('')
  const [transcript, setTranscript] = useState('')
  const [error, setError] = useState<string | null>(null)
  const recRef = useRef<Rec | null>(null)
  const timerRef = useRef<number | undefined>(undefined)

  const detach = (rec: Rec) => {
    rec.onstart = null; rec.onresult = null; rec.onerror = null; rec.onend = null
  }

  const stop = useCallback(() => {
    try { recRef.current?.stop() } catch { /* ήδη σταματημένο */ }
  }, [])

  const abort = useCallback(() => {
    const rec = recRef.current
    if (!rec) return
    detach(rec)
    try { rec.abort() } catch { /* ignore */ }
    recRef.current = null
    window.clearTimeout(timerRef.current)
    setListening(false)
    setInterim('')
  }, [])

  const start = useCallback((opts: ListenOptions = {}): boolean => {
    const Ctor = recCtor()
    if (!Ctor) {
      if (!opts.quiet) setError('Ο browser δεν υποστηρίζει αναγνώριση φωνής. Πάτα το μικρόφωνο του πληκτρολογίου και μίλα στο κουτί.')
      return false
    }
    cancelSpeech()
    // ό,τι άκουγε πριν, κόβεται
    if (recRef.current) {
      detach(recRef.current)
      try { recRef.current.abort() } catch { /* ignore */ }
    }
    const rec = new Ctor()
    rec.lang = lang
    rec.continuous = false
    rec.interimResults = true
    rec.maxAlternatives = 1
    recRef.current = rec

    let finals: string[] = []
    let lastInterim = ''
    let errCode: string | null = null

    rec.onstart = () => setListening(true)
    rec.onresult = (e) => {
      const f: string[] = []
      let int = ''
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i]
        const t = r[0]?.transcript ?? ''
        if (r.isFinal) f.push(t); else int += t
      }
      finals = f
      lastInterim = int.trim()
      setInterim([joinFinals(f), lastInterim].filter(Boolean).join(' '))
    }
    rec.onerror = (e) => {
      errCode = e.error
      const msg = recErrorText(e.error)
      if (msg && !opts.quiet) setError(msg)
    }
    rec.onend = () => {
      window.clearTimeout(timerRef.current)
      if (recRef.current === rec) recRef.current = null
      setListening(false)
      setInterim('')
      // αν σταμάτησε με το χέρι πριν το τελικό, κρατάμε το interim
      const text = (joinFinals(finals) || (errCode ? '' : lastInterim)).trim()
      if (text) {
        setTranscript(text)
        opts.onFinal?.(text)
      } else if (!errCode && !opts.quiet) {
        setError(recErrorText('no-speech'))
      }
      opts.onEnd?.(text)
    }

    setError(null)
    setInterim('')
    try {
      rec.start()
    } catch {
      recRef.current = null
      if (!opts.quiet) setError('Δεν ξεκίνησε το μικρόφωνο. Δοκίμασε ξανά.')
      return false
    }
    setListening(true)
    // ασφάλεια: κάποιες συσκευές δεν τελειώνουν ποτέ μόνες τους
    window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => { try { rec.stop() } catch { /* ignore */ } }, 15000)
    return true
  }, [lang])

  useEffect(() => () => {
    window.clearTimeout(timerRef.current)
    const rec = recRef.current
    if (rec) { detach(rec); try { rec.abort() } catch { /* ignore */ } }
  }, [])

  const clearError = useCallback(() => setError(null), [])
  /** ακούει αυτή τη στιγμή; (χωρίς να περιμένει render) */
  const active = useCallback(() => recRef.current !== null, [])

  return { supported, listening, interim, transcript, error, start, stop, abort, clearError, active }
}

// ---------------------------------------------------------------------
// Ανάγνωση φωναχτά
// ---------------------------------------------------------------------
export const ttsSupported = (): boolean =>
  typeof window !== 'undefined' && 'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance !== 'undefined'

let voicesWait: Promise<void> | null = null
/** Οι φωνές φορτώνουν ασύγχρονα (ειδικά στο Chrome): περιμένουμε λίγο */
function voicesReady(): Promise<void> {
  if (window.speechSynthesis.getVoices().length > 0) return Promise.resolve()
  if (!voicesWait) {
    voicesWait = new Promise((res) => {
      const ss = window.speechSynthesis
      const done = () => { ss.removeEventListener('voiceschanged', done); res() }
      ss.addEventListener('voiceschanged', done)
      window.setTimeout(done, 800)
    })
  }
  return voicesWait
}

function pickVoice(lang: string): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices()
  const l = lang.toLowerCase().replace('_', '-')
  const base = l.split('-')[0]
  const norm = (v: SpeechSynthesisVoice) => v.lang.toLowerCase().replace('_', '-')
  return (
    voices.find((v) => norm(v) === l && v.localService) ??
    voices.find((v) => norm(v) === l) ??
    voices.find((v) => norm(v).startsWith(base)) ??
    null
  )
}

let finishCurrent: ((completed: boolean) => void) | null = null
// κάθε speak/cancel ακυρώνει ό,τι περίμενε τις φωνές για να μιλήσει
let speakSeq = 0

export interface SpeakOptions { lang?: string; rate?: number; pitch?: number; volume?: number }

/**
 * Διαβάζει φωναχτά. Επιλύεται όταν τελειώσει: true αν διαβάστηκε ως το τέλος
 * (ή δεν υποστηρίζεται), false αν κόπηκε (cancelSpeech, νέο speak, μικρόφωνο).
 */
export function speak(text: string, opts: SpeakOptions = {}): Promise<boolean> {
  if (!ttsSupported() || !text.trim()) return Promise.resolve(true)
  const lang = opts.lang ?? 'el-GR'
  const seq = ++speakSeq
  const run = () => new Promise<boolean>((resolve) => {
    if (seq !== speakSeq) { resolve(false); return }
    const ss = window.speechSynthesis
    finishCurrent?.(false)
    ss.cancel()
    const u = new SpeechSynthesisUtterance(text)
    const voice = pickVoice(lang)
    u.lang = voice?.lang ?? lang
    try { if (voice) u.voice = voice } catch { /* μένει η προεπιλεγμένη φωνή της γλώσσας */ }
    u.rate = opts.rate ?? 1.05
    u.pitch = opts.pitch ?? 1
    u.volume = opts.volume ?? 1
    let done = false
    const finish = (completed: boolean) => {
      if (done) return
      done = true
      window.clearTimeout(guard)
      if (finishCurrent === finish) finishCurrent = null
      resolve(completed)
    }
    // ασφάλεια: σε κάποιους browsers το onend δεν έρχεται ποτέ
    const guard = window.setTimeout(() => finish(true), 2500 + text.length * 100)
    u.onend = () => finish(true)
    u.onerror = (e) => finish(!(e && (e.error === 'canceled' || e.error === 'interrupted')))
    finishCurrent = finish
    try { ss.speak(u) } catch { finish(true) }
  })
  // αν οι φωνές είναι ήδη έτοιμες, μιλάμε συγχρόνως (κρατάει το "άγγιγμα" του χρήστη σε iOS)
  if (window.speechSynthesis.getVoices().length > 0) return run()
  return voicesReady().then(run)
}

/** Σταματά ό,τι διαβάζεται τώρα (και ό,τι περιμένει να διαβαστεί) */
export function cancelSpeech(): void {
  speakSeq++
  if (!ttsSupported()) return
  window.speechSynthesis.cancel()
  finishCurrent?.(false)
}
