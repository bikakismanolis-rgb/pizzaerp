import type { DriverCommand } from './driverVoice'

/** Φράσεις του διανομέα: στον οδηγό (κελιά class="dsay") και στα tests */
export interface DriverExample { say: string; does: string; expect: DriverCommand }

export const DRIVER_EXAMPLES: DriverExample[] = [
  { say: 'την παίρνω η 12', does: 'Παίρνεις την 12: φεύγει μαζί σου και ο πελάτης βλέπει ότι έρχεται.', expect: { kind: 'take', no: 12 } },
  { say: 'παραδόθηκε', does: 'Η παραγγελία που έχεις στον δρόμο παραδόθηκε (αν έχεις δύο, σε ρωτάει ποια).', expect: { kind: 'delivered', no: null } },
  { say: 'παραδόθηκε η 12', does: 'Η 12 παραδόθηκε· αν ήταν μετρητά, σου λέει πόσα κρατάς.', expect: { kind: 'delivered', no: 12 } },
  { say: 'δεν την πήρα η 12', does: 'Η 12 γυρίζει στις έτοιμες (π.χ. την πήρε άλλος).', expect: { kind: 'release', no: 12 } },
  { say: 'διάβασε', does: 'Διαβάζει φωναχτά πού πας και τι πληρώνει ο πελάτης.', expect: { kind: 'read' } },
]
