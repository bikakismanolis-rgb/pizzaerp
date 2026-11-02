import { useEffect } from 'react'

/**
 * Ειδοποίηση κουζίνας: «ντιν-ντιν-ντιν» χωρίς αρχείο ήχου (Web Audio), και
 * οθόνη που δεν σβήνει όσο είναι ανοιχτή η σελίδα (Wake Lock, όπου υπάρχει).
 * Οι browsers αφήνουν ήχο / φωνή μόνο αφού αγγίξει κάποιος τη σελίδα.
 */

type AudioCtor = new () => AudioContext
let ctx: AudioContext | null = null

function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor }
  const C = w.AudioContext ?? w.webkitAudioContext
  if (!C) return null
  if (!ctx) ctx = new C()
  return ctx
}

/** Ξεκλείδωμα ήχου μέσα σε άγγιγμα του χρήστη */
export function unlockAudio(): void {
  try { const a = audio(); if (a && a.state === 'suspended') void a.resume() } catch { /* ignore */ }
}

/** Τρία σύντομα «ντιν» (πιο δυνατά με loud: για υπενθύμιση) */
export function beep(times = 3, loud = false): void {
  try {
    const a = audio()
    if (!a) return
    if (a.state === 'suspended') void a.resume()
    const t0 = a.currentTime + 0.02
    for (let i = 0; i < times; i++) {
      const at = t0 + i * 0.28
      const o = a.createOscillator()
      const g = a.createGain()
      o.type = 'sine'
      o.frequency.value = i % 2 ? 1175 : 880
      o.connect(g)
      g.connect(a.destination)
      g.gain.setValueAtTime(0.0001, at)
      g.gain.exponentialRampToValueAtTime(loud ? 0.8 : 0.45, at + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.22)
      o.start(at)
      o.stop(at + 0.24)
    }
  } catch { /* χωρίς ήχο */ }
}

interface WakeLockSentinelLike { release(): Promise<void> }
interface WakeLockLike { request(type: 'screen'): Promise<WakeLockSentinelLike> }

/** Η οθόνη μένει αναμμένη όσο η σελίδα είναι ανοιχτή και ορατή */
export function useWakeLock(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    const wl = (navigator as unknown as { wakeLock?: WakeLockLike }).wakeLock
    if (!wl) return
    let lock: WakeLockSentinelLike | null = null
    let alive = true
    const get = async () => {
      if (document.visibilityState !== 'visible') return
      try {
        const l = await wl.request('screen')
        if (alive) lock = l; else void l.release()
      } catch { /* π.χ. χαμηλή μπαταρία */ }
    }
    void get()
    const h = () => { if (document.visibilityState === 'visible') void get() }
    document.addEventListener('visibilitychange', h)
    return () => {
      alive = false
      document.removeEventListener('visibilitychange', h)
      if (lock) void lock.release().catch(() => {})
    }
  }, [enabled])
}
