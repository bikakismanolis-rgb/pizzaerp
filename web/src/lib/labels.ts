import type { Channel, DocType, ItemType } from './types'
import type { TallyChannel } from './voice/types'

export const ITEM_TYPE_LABEL: Record<ItemType, string> = {
  raw: 'Πρώτη ύλη',
  semi: 'Ημιέτοιμο',
  finished: 'Έτοιμο προϊόν',
}

export const ITEM_TYPE_BADGE: Record<ItemType, string> = {
  raw: 'bg-amber-100 text-amber-800',
  semi: 'bg-sky-100 text-sky-800',
  finished: 'bg-emerald-100 text-emerald-800',
}

export const DOC_TYPE_LABEL: Record<DocType, string> = {
  purchase: 'Αγορά',
  sale: 'Πώληση',
  production: 'Παραγωγή',
  stocktake: 'Απογραφή',
  receipt: 'Είσπραξη',
  payment: 'Πληρωμή',
}

export const DOC_TYPE_LABEL_PLURAL: Record<DocType, string> = {
  purchase: 'Αγορές',
  sale: 'Πωλήσεις',
  production: 'Παραγωγές',
  stocktake: 'Απογραφές',
  receipt: 'Εισπράξεις',
  payment: 'Πληρωμές',
}

export const DOC_PREFIX: Record<DocType, string> = {
  purchase: 'ΑΓ',
  sale: 'ΠΩ',
  production: 'ΠΑ',
  stocktake: 'ΑΠ',
  receipt: 'ΕΙ',
  payment: 'ΠΛ',
}

/** «αρ. 7»: τα «ΠΩ-7» δεν τα καταλαβαίνει κανείς· το είδος το λέει πάντα η φράση γύρω */
export const docCode = (_t: DocType, no: number) => `αρ. ${no}`

/**
 * Τα «ΠΩ-7» / «ΑΠ-3» των μηνυμάτων της βάσης γίνονται «αρ. 7». Μόνο όσα
 * γράφει η βάση (αγορά, πώληση, παραγωγή, απογραφή): το «ΠΛ» είναι και σειρά
 * πιστωτικού λιανικής («ΠΛ-1»), που μένει όπως είναι.
 */
export const plainDocCodes = (msg: string) => msg.replace(/(^|[^Α-Ωα-ω])(?:ΑΓ|ΠΩ|ΠΑ|ΑΠ)-(\d+)/g, '$1αρ. $2')

export const CHANNEL_LABEL: Record<Channel, string> = {
  wholesale: 'Χονδρική',
  efood: 'efood',
  wolt: 'Wolt',
  box: 'box',
  phone: 'Τηλέφωνο',
  store: 'Μαγαζί',
  site: 'Site',
}

/** Κανάλια λιανικής (μετρητής ημέρας), με τη σειρά που εμφανίζονται */
export const TALLY_CHANNELS: TallyChannel[] = ['efood', 'wolt', 'box', 'phone', 'store']

export const MOVE_TYPE_LABEL: Record<string, string> = {
  purchase_in: 'Αγορά',
  sale_out: 'Πώληση',
  prod_consume: 'Ανάλωση',
  prod_output: 'Παραγωγή',
  stocktake_adj: 'Διόρθωση απογραφής',
}

/** Απλά λόγια: «πρόχειρο / καταχωρημένο» δεν τα λέει κανείς στο μαγαζί */
export const STATUS_LABEL: Record<string, string> = {
  draft: 'Δεν περάστηκε',
  posted: 'Περάστηκε ✓',
}

export const UNITS = ['τεμ', 'kg', 'g', 'L', 'ml']
export const VAT_RATES = [0, 6, 13, 24]

/** σημείωση των «Πωλήσεων ημέρας» (μετρητής, tally_add): μόνο αυτές μετράνε στα σύνολα ημέρας */
export const TALLY_NOTES = 'Πωλήσεις ημέρας'

/** Απογραφή «τη στιγμή που τη λες» (κάρτα του «Πες το», οθόνη απογραφής) */
export const COUNT_MOMENT = 'Η μέτρηση μετράει τη στιγμή που τη λες. Ό,τι πουληθεί ή φτιαχτεί μετά, μετράει για μετά. Όταν τελειώσεις, πες «τέλος απογραφής».'
