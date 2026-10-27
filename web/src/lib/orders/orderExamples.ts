import type { OrderVoiceCommand } from './orderVoice'

/**
 * Φράσεις για τις online παραγγελίες: στον οδηγό (docs/pes-to-odigos.html,
 * κελιά class="osay") και στα tests. Δουλεύουν και στην οθόνη «Παραγγελίες»
 * και στο «Πες το» (strict).
 */
export interface OrderExample { say: string; does: string; expect: OrderVoiceCommand }

export const ORDER_EXAMPLES: OrderExample[] = [
  { say: 'δεκτή η 12 σε 20 λεπτά', does: 'Αποδοχή της 12. Ο πελάτης βλέπει πότε θα είναι έτοιμη.', expect: { kind: 'accept', pick: 12, minutes: 20 } },
  { say: 'δεκτή η 12 σε μισή ώρα', does: 'Το ίδιο, σε 30 λεπτά.', expect: { kind: 'accept', pick: 12, minutes: 30 } },
  { say: 'δέξου την παραγγελία', does: 'Αποδοχή, αν περιμένει μόνο μία, με τον χρόνο που διάλεξες την τελευταία φορά.', expect: { kind: 'accept', pick: null, minutes: null } },
  { say: 'απόρριψε την 12 γιατί είμαστε γεμάτοι', does: 'Απόρριψη. Ο πελάτης βλέπει τον λόγο· δεν γράφεται τίποτα στην αποθήκη.', expect: { kind: 'reject', pick: 12, reason: 'Είμαστε γεμάτοι' } },
  { say: 'έφυγε η 12', does: 'Η 12 έφυγε με τον διανομέα (ή την πήρε ο πελάτης).', expect: { kind: 'done', pick: 12, all: false } },
  { say: 'έφυγαν όλες οι παραγγελίες', does: 'Όσες ήταν σε ετοιμασία, έφυγαν.', expect: { kind: 'done', pick: null, all: true } },
  { say: 'διάβασε τις παραγγελίες', does: 'Διαβάζει φωναχτά όσες περιμένουν απάντηση.', expect: { kind: 'read', pick: null } },
  { say: 'έχουμε παραγγελίες;', does: 'Το ίδιο: λέει τι περιμένει και τι ετοιμάζεται.', expect: { kind: 'read', pick: null } },
  { say: 'κλείσε τις παραγγελίες', does: 'Κλείνει το site τώρα (π.χ. γέμισε ο φούρνος). Κλείνει και μόνο του στην ώρα κλεισίματος.', expect: { kind: 'close' } },
  { say: 'άνοιξε τις παραγγελίες', does: 'Ανοίγει το site ως την ώρα κλεισίματος.', expect: { kind: 'open' } },
]
