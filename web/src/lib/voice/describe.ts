import type { InterpretContext, Interpretation } from './types'

// ΠΡΟΣΩΡΙΝΟ STUB: το αντικαθιστά η πραγματική υλοποίηση.
/** Ελληνική πρόταση για επιβεβαίωση (οθόνη + ανάγνωση φωναχτά) */
export function describe(interp: Interpretation, _ctx: InterpretContext): string {
  return interp.command.kind === 'unknown' ? 'Δεν κατάλαβα.' : interp.text
}

/** Ναι / όχι / άγνωστο, για φωνητική επιβεβαίωση */
export function parseYesNo(_text: string): 'yes' | 'no' | null {
  return null
}
