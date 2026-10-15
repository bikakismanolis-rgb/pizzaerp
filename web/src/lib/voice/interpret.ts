import type { InterpretContext, Interpretation, Interpreter } from './types'

// ΠΡΟΣΩΡΙΝΟ STUB: το αντικαθιστά η πραγματική υλοποίηση του τοπικού parser.
export function interpret(text: string, _ctx: InterpretContext): Interpretation {
  return { text, command: { kind: 'unknown' }, confidence: 0, issues: [] }
}

export const localInterpreter: Interpreter = { interpret }
