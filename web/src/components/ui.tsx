import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'

// ---------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------
type ToastKind = 'ok' | 'err' | 'info'
interface Toast { id: number; kind: ToastKind; text: string }
interface ToastApi { ok: (t: string) => void; err: (t: string) => void; info: (t: string) => void }

const ToastCtx = createContext<ToastApi | null>(null)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const seq = useRef(0)
  const push = useCallback((kind: ToastKind, text: string) => {
    const id = ++seq.current
    setToasts((t) => [...t, { id, kind, text }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'err' ? 8000 : 3500)
  }, [])
  const api: ToastApi = {
    ok: (t) => push('ok', t),
    err: (t) => push('err', t),
    info: (t) => push('info', t),
  }
  return (
    <ToastCtx.Provider value={api}>
      {children}
      {/* σε κινητό πάνω, κάτω από την μπάρα με το μενού (για να μην κρύβει μικρόφωνο /
          κουμπιά κάτω), σε desktop κάτω δεξιά. Κλείνει με πάτημα. */}
      <div className="fixed z-50 flex flex-col gap-2 top-14 inset-x-2 md:inset-x-auto md:top-auto md:bottom-4 md:right-4 md:max-w-sm pointer-events-none">
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.kind === 'err' ? 'alert' : 'status'}
            title="Πάτα για κλείσιμο"
            onClick={() => setToasts((ts) => ts.filter((x) => x.id !== t.id))}
            className={
              'rounded-md px-4 py-3 text-sm shadow-lg text-white pointer-events-auto cursor-pointer flex items-start gap-3 ' +
              (t.kind === 'ok' ? 'bg-emerald-700' : t.kind === 'err' ? 'bg-red-700' : 'bg-stone-800')
            }
          >
            <span className="flex-1">{t.text}</span>
            <span aria-hidden="true" className="opacity-70 leading-5">✕</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}

export function useToast() {
  const v = useContext(ToastCtx)
  if (!v) throw new Error('useToast outside ToastProvider')
  return v
}

// ---------------------------------------------------------------------
// Βασικά στοιχεία
// ---------------------------------------------------------------------
export function Field({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <label className="label">{label}</label>
      {children}
    </div>
  )
}

export function PageTitle({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
      <h1 className="text-xl font-semibold">{title}</h1>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  )
}

export function Spinner({ text = 'Φόρτωση...' }: { text?: string }) {
  return <div className="text-sm text-stone-500 py-6 text-center">{text}</div>
}

export function ErrorBox({ text }: { text: string | null }) {
  if (!text) return null
  return <div className="rounded-md bg-red-50 border border-red-200 text-red-800 text-sm px-3 py-2 mb-3">{text}</div>
}

export function Empty({ text = 'Δεν υπάρχουν εγγραφές.' }: { text?: string }) {
  return <div className="text-sm text-stone-500 py-8 text-center">{text}</div>
}

export function Badge({ className = '', children }: { className?: string; children: ReactNode }) {
  return <span className={'badge ' + className}>{children}</span>
}

// ---------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------
export function Modal({ open, title, onClose, children, wide = false }: {
  open: boolean; title: string; onClose: () => void; children: ReactNode; wide?: boolean
}) {
  useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/40 p-4 overflow-y-auto" onMouseDown={onClose}>
      <div
        className={'card w-full mt-8 ' + (wide ? 'max-w-3xl' : 'max-w-lg')}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-stone-200">
          <h2 className="font-semibold">{title}</h2>
          <button className="btn-ghost px-2 py-1" onClick={onClose} aria-label="Κλείσιμο">✕</button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  )
}

export function Confirm({ open, title, text, onYes, onNo, danger = false }: {
  open: boolean; title: string; text: string; onYes: () => void; onNo: () => void; danger?: boolean
}) {
  return (
    <Modal open={open} title={title} onClose={onNo}>
      <p className="text-sm mb-4">{text}</p>
      <div className="flex justify-end gap-2">
        <button className="btn-secondary" onClick={onNo}>Άκυρο</button>
        <button className={danger ? 'btn-danger' : 'btn-primary'} onClick={onYes}>Ναι</button>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------
// Αριθμητικό input (δέχεται και κόμμα)
// ---------------------------------------------------------------------
export function NumInput({ value, onChange, className = '', disabled, step = 'any', min, placeholder, autoFocus }: {
  value: number | string; onChange: (v: string) => void; className?: string; disabled?: boolean;
  step?: string; min?: number; placeholder?: string; autoFocus?: boolean
}) {
  return (
    <input
      type="number"
      inputMode="decimal"
      step={step}
      min={min}
      className={'input num ' + className}
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      autoFocus={autoFocus}
      onChange={(e) => onChange(e.target.value)}
      onFocus={(e) => e.target.select()}
    />
  )
}

// ---------------------------------------------------------------------
// Εικονίδιο μικροφώνου
// ---------------------------------------------------------------------
export function MicIcon({ className = 'h-6 w-6' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v4" />
    </svg>
  )
}
