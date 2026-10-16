import type { Item, ItemType, Partner } from '../types'

/**
 * Φωνητικές / γραπτές εντολές: κοινοί τύποι ανάμεσα στον "κατανοητή"
 * (interpreter) και στις οθόνες. Ο interpreter δεν γράφει τίποτα στη βάση,
 * μόνο προτείνει μια εντολή που ο χρήστης επιβεβαιώνει.
 */

/** Κανάλια λιανικής για τον μετρητή ημέρας */
export type TallyChannel = 'efood' | 'wolt' | 'box' | 'phone' | 'store'

export interface Candidate {
  id: string
  name: string
  /** 0..1, μεγαλύτερο = πιο πιθανό */
  score: number
}

/** Αναφορά σε είδος ή συναλλασσόμενο όπως ακούστηκε */
export interface EntityRef {
  /** η φράση όπως ακούστηκε (για εμφάνιση και για "να το θυμάμαι" ως alias) */
  heard: string
  /** το id όταν η αντιστοίχιση είναι σίγουρη, αλλιώς null */
  id: string | null
  /** έως 5 υποψήφιοι, κατά score φθίνουσα */
  candidates: Candidate[]
}

export interface QtyLine {
  item: EntityRef
  /** ποσότητα στη μονάδα του είδους (μετά από μετατροπή γρ->kg, σακί->kg κλπ) */
  qty: number
  /** π.χ. "10 σακιά", για εμφάνιση. Χωρίς heardQty και με qty 0 = δεν ακούστηκε ποσότητα */
  heardQty?: string
  /**
   * Μόνο στην απογραφή: 'add' = ειπώθηκε "άλλα / ακόμα / επιπλέον" (προστίθεται
   * σε ό,τι έχει ήδη μετρηθεί, π.χ. από άλλον χώρο), 'set' = ειπώθηκε διόρθωση
   * ("σύνολο / διόρθωσε / τελικά"). Χωρίς mode: αποφασίζει η οθόνη (αν υπάρχει
   * ήδη μέτρηση ρωτάει, με προεπιλογή την πρόσθεση).
   */
  mode?: 'add' | 'set'
}

export interface PricedLine extends QtyLine {
  /** τιμή ανά μονάδα είδους, χωρίς ΦΠΑ. null = δεν ειπώθηκε */
  unitPrice: number | null
}

export type Command =
  /** πώληση λιανικής: προστίθεται στον μετρητή της ημέρας για το κανάλι */
  | { kind: 'sale_tally'; channel: TallyChannel; channelHeard: boolean; lines: QtyLine[] }
  /** πώληση σε πελάτη (χονδρική): νέο παραστατικό */
  | { kind: 'sale'; partner: EntityRef; lines: PricedLine[] }
  | { kind: 'purchase'; partner: EntityRef; lines: PricedLine[]; refNo: string | null }
  | { kind: 'production'; item: EntityRef; qty: number }
  /** μετρήσεις απογραφής: γράφονται στην ανοιχτή απογραφή της ημέρας */
  | { kind: 'stocktake'; lines: QtyLine[] }
  | { kind: 'receipt'; partner: EntityRef; amount: number }
  | { kind: 'payment'; partner: EntityRef; amount: number }
  | {
      kind: 'new_item'
      itemType: ItemType
      name: string
      unit: string
      vatRate: number
      /** γενική τιμή πώλησης χωρίς ΦΠΑ */
      salePrice: number | null
      makeToOrder: boolean
      packName: string | null
      packQty: number | null
    }
  | {
      kind: 'new_partner'
      name: string
      isCustomer: boolean
      isSupplier: boolean
      phone: string | null
      vatNo: string | null
      city: string | null
    }
  /** αντικαθιστά τη συνταγή του είδους: για outputQty τεμάχια χρειάζονται lines */
  | { kind: 'recipe'; item: EntityRef; outputQty: number; lines: QtyLine[] }
  /** γενική τιμή πώλησης είδους (αποθηκεύεται χωρίς ΦΠΑ) */
  | { kind: 'item_price'; item: EntityRef; netPrice: number; heardGross: boolean }
  /** ειδική τιμή πελάτη (χωρίς ΦΠΑ) */
  | { kind: 'partner_price'; partner: EntityRef; item: EntityRef; netPrice: number }
  /** κλείσιμο (καταχώρηση) των σημερινών πωλήσεων λιανικής */
  /** δική τους φράση: "όταν λέω «οικογενειακή» εννοώ «μεγάλη μαργαρίτα»" */
  | { kind: 'new_phrase'; phrase: string; meaning: string }
  | { kind: 'close_day' }
  /** καταχώρηση της ανοιχτής απογραφής */
  | { kind: 'close_stocktake' }
  /** αναίρεση της τελευταίας ενέργειας */
  | { kind: 'undo' }
  | { kind: 'query_stock'; item: EntityRef }
  | { kind: 'query_balance'; partner: EntityRef }
  | { kind: 'query_today' }
  | { kind: 'help' }
  | { kind: 'unknown' }

export type CommandKind = Command['kind']

export interface Interpretation {
  /** το αρχικό κείμενο */
  text: string
  command: Command
  /** 0..1 συνολική βεβαιότητα */
  confidence: number
  /** προειδοποιήσεις στα ελληνικά για τον χρήστη (π.χ. "Δεν ακούστηκε τιμή για Αλεύρι") */
  issues: string[]
}

export interface InterpretContext {
  /** όλα τα είδη της εταιρείας (ο interpreter κοιτάει μόνο τα ενεργά) */
  items: Item[]
  partners: Partner[]
  /** κανάλι όταν δεν ειπώθηκε (επιλογή του χρήστη στην οθόνη) */
  defaultChannel: TallyChannel
  /**
   * Δικές τους φράσεις ("όταν λέω Χ εννοώ Υ"). Ο interpreter αντικαθιστά τη
   * φράση με τη σημασία της πριν καταλάβει την πρόταση.
   */
  phrases?: VoicePhraseRule[]
}

export interface VoicePhraseRule {
  phrase: string
  meaning: string
}

/**
 * Ό,τι "καταλαβαίνει" μια φράση. Σήμερα είναι τοπικός parser με κανόνες
 * (localInterpreter, χωρίς API). Αργότερα μπορεί να μπει μοντέλο μέσω API ή
 * δικό σας AI: αρκεί να υλοποιεί αυτό το interface και να επιστρέφει
 * Interpretation με τα ίδια σχήματα.
 */
export interface Interpreter {
  interpret(text: string, ctx: InterpretContext): Interpretation | Promise<Interpretation>
}
